'use strict';

// Regras de estoque e pedidos.
//
// - O estoque físico (products.stock_units) é sempre em UNIDADES.
// - Pedidos "novo" e "confirmado" RESERVAM estoque: o cliente não consegue
//   pedir o que já está prometido para outro cliente.
// - Ao marcar o pedido como "separado" (saiu da câmara), é lançada a SAÍDA.
// - Cancelar um pedido que já teve saída lança o ESTORNO (volta ao estoque).

class BusinessError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const RESERVING_STATUSES = ['novo', 'confirmado'];

const TRANSITIONS = {
  novo: ['confirmado', 'separado', 'cancelado'],
  confirmado: ['separado', 'cancelado'],
  separado: ['entregue', 'cancelado'],
  entregue: [],
  cancelado: [],
};

const MANUAL_TYPES = {
  entrada: +1,
  ajuste: 0, // sinal informado pelo usuário
  perda: -1,
  transferencia_loja: -1,
  saida_avulsa: -1,
};

function createInventory(db) {
  const q = {
    product: db.prepare('SELECT * FROM products WHERE id = ?'),
    reserved: db.prepare(`
      SELECT COALESCE(SUM(oi.units_total), 0) AS units
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = ? AND o.status IN ('novo', 'confirmado') AND (? IS NULL OR o.id <> ?)`),
    setStock: db.prepare("UPDATE products SET stock_units = ?, updated_at = datetime('now') WHERE id = ?"),
    insertMovement: db.prepare(`
      INSERT INTO stock_movements (product_id, type, quantity, balance_after, order_id, document, note, created_by)
      VALUES (@product_id, @type, @quantity, @balance_after, @order_id, @document, @note, @created_by)`),
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    items: db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id'),
    insertOrder: db.prepare(`
      INSERT INTO orders (customer_id, notes, delivery_date, total_cents) VALUES (?, ?, ?, 0)`),
    insertItem: db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_type, quantity, units_per_box, units_total, price_cents, subtotal_cents)
      VALUES (@order_id, @product_id, @product_name, @unit_type, @quantity, @units_per_box, @units_total, @price_cents, @subtotal_cents)`),
    updateItemQty: db.prepare('UPDATE order_items SET quantity = ?, units_total = ?, subtotal_cents = ? WHERE id = ?'),
    deleteItem: db.prepare('DELETE FROM order_items WHERE id = ?'),
    updateTotal: db.prepare(
      'UPDATE orders SET total_cents = (SELECT COALESCE(SUM(subtotal_cents), 0) FROM order_items WHERE order_id = ?) WHERE id = ?',
    ),
  };

  function reservedUnits(productId, excludeOrderId = null) {
    return q.reserved.get(productId, excludeOrderId, excludeOrderId).units;
  }

  function availableUnits(productId, excludeOrderId = null) {
    const p = q.product.get(productId);
    if (!p) return 0;
    return p.stock_units - reservedUnits(productId, excludeOrderId);
  }

  // Lança uma movimentação. quantity com sinal (+ entra / - sai), em unidades.
  function move({ productId, type, quantity, orderId = null, document = null, note = null, user = null, allowNegative = false }) {
    if (!Number.isInteger(quantity) || quantity === 0) throw new BusinessError('Quantidade inválida.');
    const p = q.product.get(productId);
    if (!p) throw new BusinessError('Produto não encontrado.', 404);
    const balance = p.stock_units + quantity;
    if (balance < 0 && !allowNegative) {
      throw new BusinessError(`Estoque insuficiente de "${p.name}": há ${p.stock_units} un., saída de ${-quantity} un.`);
    }
    q.setStock.run(balance, productId);
    q.insertMovement.run({
      product_id: productId,
      type,
      quantity,
      balance_after: balance,
      order_id: orderId,
      document,
      note,
      created_by: user,
    });
    return balance;
  }

  // Lançamentos manuais do painel (entrada de nota, perdas, transferência p/ loja...).
  // lines: [{ product_id, units }] — units já em unidades (positivo), exceto ajuste (com sinal).
  const manualMovement = db.transaction(({ type, lines, document, note, user }) => {
    if (!(type in MANUAL_TYPES)) throw new BusinessError('Tipo de movimentação inválido.');
    if (!Array.isArray(lines) || lines.length === 0) throw new BusinessError('Nenhum item informado.');
    const results = [];
    for (const line of lines) {
      const units = Number(line.units);
      if (!Number.isInteger(units) || units === 0) throw new BusinessError('Quantidade inválida.');
      const sign = MANUAL_TYPES[type];
      const quantity = sign === 0 ? units : sign * Math.abs(units);
      const balance = move({ productId: Number(line.product_id), type, quantity, document, note, user });
      results.push({ product_id: Number(line.product_id), quantity, balance });
    }
    return results;
  });

  // Inventário: informa a contagem física e o sistema lança o ajuste da diferença.
  const inventoryCount = db.transaction(({ counts, note, user }) => {
    const results = [];
    for (const c of counts) {
      const counted = Number(c.counted_units);
      if (!Number.isInteger(counted) || counted < 0) throw new BusinessError('Contagem inválida.');
      const p = q.product.get(Number(c.product_id));
      if (!p) throw new BusinessError('Produto não encontrado.', 404);
      const diff = counted - p.stock_units;
      if (diff !== 0) {
        move({ productId: p.id, type: 'ajuste', quantity: diff, note: note || 'Inventário', user });
      }
      results.push({ product_id: p.id, before: p.stock_units, after: counted, diff });
    }
    return results;
  });

  function priceFor(p, unitType) {
    return unitType === 'caixa' ? p.box_price_cents : p.unit_price_cents;
  }

  // items: [{ product_id, unit_type: 'caixa'|'unidade', quantity }]
  const createOrder = db.transaction(({ customerId, items, notes, deliveryDate, minOrderCents = 0 }) => {
    if (!Array.isArray(items) || items.length === 0) throw new BusinessError('Seu carrinho está vazio.');

    const needByProduct = new Map();
    const lines = [];
    for (const it of items) {
      const p = q.product.get(Number(it.product_id));
      if (!p || !p.active) throw new BusinessError('Um dos produtos do carrinho não está mais disponível.');
      const unitType = it.unit_type === 'caixa' ? 'caixa' : 'unidade';
      if (unitType === 'caixa' && !p.sell_box) throw new BusinessError(`"${p.name}" não é vendido por caixa.`);
      if (unitType === 'unidade' && !p.sell_unit) throw new BusinessError(`"${p.name}" é vendido somente por caixa fechada.`);
      const quantity = Number(it.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100000) {
        throw new BusinessError(`Quantidade inválida para "${p.name}".`);
      }
      const upb = unitType === 'caixa' ? p.units_per_box : 1;
      const unitsTotal = quantity * upb;
      const price = priceFor(p, unitType);
      needByProduct.set(p.id, (needByProduct.get(p.id) || 0) + unitsTotal);
      lines.push({
        product: p,
        unit_type: unitType,
        quantity,
        units_per_box: p.units_per_box,
        units_total: unitsTotal,
        price_cents: price,
        subtotal_cents: price * quantity,
      });
    }

    for (const [productId, need] of needByProduct) {
      const available = availableUnits(productId);
      if (need > available) {
        const p = q.product.get(productId);
        throw new BusinessError(
          `Estoque insuficiente de "${p.name}": disponível ${Math.max(0, available)} un., pedido ${need} un.`,
          409,
        );
      }
    }

    const total = lines.reduce((s, l) => s + l.subtotal_cents, 0);
    if (minOrderCents > 0 && total < minOrderCents) {
      throw new BusinessError(`O pedido mínimo é de R$ ${(minOrderCents / 100).toFixed(2).replace('.', ',')}.`);
    }

    const orderId = Number(q.insertOrder.run(customerId, notes || null, deliveryDate || null).lastInsertRowid);
    for (const l of lines) {
      q.insertItem.run({
        order_id: orderId,
        product_id: l.product.id,
        product_name: l.product.name,
        unit_type: l.unit_type,
        quantity: l.quantity,
        units_per_box: l.units_per_box,
        units_total: l.units_total,
        price_cents: l.price_cents,
        subtotal_cents: l.subtotal_cents,
      });
    }
    q.updateTotal.run(orderId, orderId);
    return orderId;
  });

  // Admin ajusta quantidades de um pedido ainda não separado (atendimento parcial, etc.).
  // changes: [{ item_id, quantity }] — quantity 0 remove o item.
  const editOrderItems = db.transaction(({ orderId, changes }) => {
    const order = q.order.get(orderId);
    if (!order) throw new BusinessError('Pedido não encontrado.', 404);
    if (!RESERVING_STATUSES.includes(order.status)) {
      throw new BusinessError('Só é possível alterar itens de pedidos novos ou confirmados.');
    }
    const items = new Map(q.items.all(orderId).map((i) => [i.id, i]));
    for (const ch of changes) {
      const item = items.get(Number(ch.item_id));
      if (!item) throw new BusinessError('Item não pertence a este pedido.');
      const qty = Number(ch.quantity);
      if (!Number.isInteger(qty) || qty < 0) throw new BusinessError('Quantidade inválida.');
      if (qty === 0) {
        q.deleteItem.run(item.id);
        items.delete(item.id);
      } else {
        const upb = item.unit_type === 'caixa' ? item.units_per_box : 1;
        q.updateItemQty.run(qty, qty * upb, qty * item.price_cents, item.id);
        items.set(item.id, { ...item, quantity: qty, units_total: qty * upb });
      }
    }
    if (items.size === 0) throw new BusinessError('O pedido precisa ter ao menos um item. Para zerar, cancele o pedido.');
    const need = new Map();
    for (const i of items.values()) need.set(i.product_id, (need.get(i.product_id) || 0) + i.units_total);
    for (const [productId, units] of need) {
      const available = availableUnits(productId, orderId);
      if (units > available) {
        const p = q.product.get(productId);
        throw new BusinessError(`Estoque insuficiente de "${p.name}": disponível ${Math.max(0, available)} un.`, 409);
      }
    }
    q.updateTotal.run(orderId, orderId);
  });

  const changeStatus = db.transaction(({ orderId, status, user, adminNotes }) => {
    const order = q.order.get(orderId);
    if (!order) throw new BusinessError('Pedido não encontrado.', 404);
    if (!(TRANSITIONS[order.status] || []).includes(status)) {
      throw new BusinessError(`Não é possível mudar o pedido de "${order.status}" para "${status}".`);
    }
    const items = q.items.all(orderId);
    const doc = `Pedido #${orderId}`;

    if (status === 'separado' && !order.stock_deducted) {
      for (const it of items) {
        move({ productId: it.product_id, type: 'saida_pedido', quantity: -it.units_total, orderId, document: doc, user });
      }
      db.prepare('UPDATE orders SET stock_deducted = 1 WHERE id = ?').run(orderId);
    }
    if (status === 'cancelado' && order.stock_deducted) {
      for (const it of items) {
        move({ productId: it.product_id, type: 'estorno_pedido', quantity: it.units_total, orderId, document: doc, note: 'Cancelamento', user });
      }
      db.prepare('UPDATE orders SET stock_deducted = 0 WHERE id = ?').run(orderId);
    }

    const stampColumn = { confirmado: 'confirmed_at', separado: 'picked_at', entregue: 'delivered_at', cancelado: 'cancelled_at' }[status];
    db.prepare(`UPDATE orders SET status = ?, ${stampColumn} = datetime('now') WHERE id = ?`).run(status, orderId);
    if (status === 'separado' && !order.confirmed_at) {
      db.prepare("UPDATE orders SET confirmed_at = datetime('now') WHERE id = ?").run(orderId);
    }
    if (adminNotes !== undefined) db.prepare('UPDATE orders SET admin_notes = ? WHERE id = ?').run(adminNotes || null, orderId);
    return q.order.get(orderId);
  });

  return {
    reservedUnits,
    availableUnits,
    manualMovement,
    inventoryCount,
    createOrder,
    editOrderItems,
    changeStatus,
  };
}

module.exports = { createInventory, BusinessError, TRANSITIONS, RESERVING_STATUSES };

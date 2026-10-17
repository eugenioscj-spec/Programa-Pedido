'use strict';

// Regras de estoque, valor (custo médio ponderado móvel) e pedidos.
//
// - O estoque é guardado em UNIDADES (products.stock_units) e em VALOR a custo
//   (products.stock_value_cents). O custo médio é sempre derivado: valor ÷ unidades.
// - TODA alteração de estoque passa por move(), dentro de transação, e gera uma
//   linha imutável no kardex (stock_movements). Correção é sempre um estorno.
// - Pedidos "novo" e "confirmado" reservam estoque. A saída (venda B2B, CMV)
//   acontece na separação. Cancelar um pedido separado estorna cada saída.

const { MOVEMENT_TYPES } = require('./migrations');

class BusinessError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
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

const SUBTYPES = {
  bonificacao_cliente: 'Bonificação a cliente',
  amostra_degustacao: 'Amostra / degustação',
  consumo_interno: 'Consumo interno',
  outros: 'Outros',
};

const OUT_TYPES = ['transferencia', 'perda', 'saida_sem_venda'];

const brl = (c) => `R$ ${(Number(c) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
const isInt = (n) => Number.isInteger(n);

function createInventory(db) {
  const q = {
    product: db.prepare('SELECT * FROM products WHERE id = ?'),
    reserved: db.prepare(`
      SELECT COALESCE(SUM(oi.units_total), 0) AS units
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = ? AND o.status IN ('novo', 'confirmado') AND (? IS NULL OR o.id <> ?)`),
    setStock: db.prepare(`UPDATE products SET stock_units = ?, stock_value_cents = ?, has_cost = ?, updated_at = datetime('now')
      WHERE id = ?`),
    insertMovement: db.prepare(`
      INSERT INTO stock_movements (product_id, type, quantity, balance_after, unit_cost_cents, value_cents, value_after_cents,
        unit_price_cents, revenue_cents, order_id, location_id, reason_id, subtype, customer_id, supplier, document, note,
        reverses_movement_id, created_by, created_at)
      VALUES (@product_id, @type, @quantity, @balance_after, @unit_cost_cents, @value_cents, @value_after_cents,
        @unit_price_cents, @revenue_cents, @order_id, @location_id, @reason_id, @subtype, @customer_id, @supplier, @document, @note,
        @reverses_movement_id, @created_by, COALESCE(@created_at, datetime('now')))`),
    movement: db.prepare('SELECT * FROM stock_movements WHERE id = ?'),
    reversalOf: db.prepare('SELECT id FROM stock_movements WHERE reverses_movement_id = ?'),
    laterMovement: db.prepare('SELECT 1 FROM stock_movements WHERE product_id = ? AND id > ? LIMIT 1'),
    lastEntryCost: db.prepare(`SELECT value_cents * 1.0 / quantity AS c FROM stock_movements
      WHERE product_id = ? AND type = 'entrada' AND quantity > 0 AND value_cents IS NOT NULL ORDER BY id DESC LIMIT 1`),
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    items: db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id'),
    orderSales: db.prepare(`SELECT m.* FROM stock_movements m WHERE m.order_id = ? AND m.type = 'saida_pedido'
      AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id) ORDER BY m.id`),
    insertOrder: db.prepare(`
      INSERT INTO orders (customer_id, notes, delivery_date, total_cents, created_at)
      VALUES (?, ?, ?, 0, COALESCE(?, datetime('now')))`),
    insertItem: db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, unit_type, quantity, units_per_box, units_total, price_cents, subtotal_cents)
      VALUES (@order_id, @product_id, @product_name, @unit_type, @quantity, @units_per_box, @units_total, @price_cents, @subtotal_cents)`),
    updateItemQty: db.prepare('UPDATE order_items SET quantity = ?, units_total = ?, subtotal_cents = ? WHERE id = ?'),
    deleteItem: db.prepare('DELETE FROM order_items WHERE id = ?'),
    updateTotal: db.prepare(
      'UPDATE orders SET total_cents = (SELECT COALESCE(SUM(subtotal_cents), 0) FROM order_items WHERE order_id = ?) WHERE id = ?',
    ),
    location: db.prepare('SELECT * FROM locations WHERE id = ?'),
    reason: db.prepare('SELECT * FROM loss_reasons WHERE id = ?'),
    customer: db.prepare('SELECT id FROM customers WHERE id = ?'),
  };

  function reservedUnits(productId, excludeOrderId = null) {
    return q.reserved.get(productId, excludeOrderId, excludeOrderId).units;
  }

  function availableUnits(productId, excludeOrderId = null) {
    const p = q.product.get(productId);
    if (!p) return 0;
    return p.stock_units - reservedUnits(productId, excludeOrderId);
  }

  function getProduct(id) {
    const p = q.product.get(Number(id));
    if (!p) throw new BusinessError('Produto não encontrado.', 404);
    return p;
  }

  // Custo de referência por unidade para entradas sem nota (sobra, estorno sem valor original).
  function referenceUnitCost(p) {
    if (p.stock_units > 0) return p.stock_value_cents / p.stock_units;
    const last = q.lastEntryCost.get(p.id);
    return last ? last.c : 0;
  }

  // Valor (a custo) que uma saída de `units` unidades levaria agora. null se o produto não tem custo.
  function exitValue(p, units) {
    if (!p.has_cost) return null;
    if (units >= p.stock_units) return p.stock_value_cents;
    return Math.round((units * p.stock_value_cents) / p.stock_units);
  }

  // ÚNICA função que altera estoque. quantity com sinal (+ entra / − sai), em unidades.
  // valueCents: obrigatório em entrada/abertura_custo; opcional em estorno (valor original);
  // nos demais tipos é calculado pelo custo médio.
  function move(o) {
    if (!MOVEMENT_TYPES.includes(o.type)) throw new BusinessError('Tipo de movimentação inválido.');
    const p = getProduct(o.productId);
    const qty = o.quantity;
    const zeroQtyAllowed = o.type === 'abertura_custo' || (o.type === 'estorno' && o.clearsCost);
    if (!isInt(qty) || (qty === 0 && !zeroQtyAllowed)) throw new BusinessError('Quantidade inválida.');

    const units = p.stock_units + qty;
    if (units < 0) {
      throw new BusinessError(`Estoque insuficiente de "${p.name}": há ${p.stock_units} un., saída de ${-qty} un.`);
    }

    let value = null;
    let hasCostAfter = p.has_cost;
    const avg = p.stock_units > 0 ? p.stock_value_cents / p.stock_units : null;
    let unitCost = avg;

    if (o.type === 'abertura_custo') {
      if (p.has_cost) throw new BusinessError(`"${p.name}" já tem custo.`);
      if (p.stock_units <= 0) throw new BusinessError(`"${p.name}" está sem estoque: o custo vem da próxima entrada.`);
      if (!isInt(o.valueCents) || o.valueCents < 0) throw new BusinessError('Custo inválido.');
      value = o.valueCents;
      unitCost = value / p.stock_units;
      hasCostAfter = 1;
    } else if (o.type === 'entrada') {
      if (!p.has_cost && p.stock_units > 0) {
        throw new BusinessError(`"${p.name}" tem estoque sem custo. Informe o custo inicial antes da entrada.`);
      }
      if (!isInt(o.valueCents) || o.valueCents < 0) throw new BusinessError('Custo inválido.');
      value = o.valueCents;
      unitCost = value / qty;
      hasCostAfter = 1;
    } else if (p.has_cost) {
      if (o.type === 'estorno' && o.valueCents !== undefined && o.valueCents !== null) {
        value = o.valueCents; // estorno devolve o MESMO valor do lançamento original
      } else if (qty < 0) {
        value = -exitValue(p, -qty);
      } else {
        unitCost = referenceUnitCost(p);
        value = Math.round(qty * unitCost);
      }
      // Saída que zera as unidades leva o valor restante inteiro: nada de centavo fantasma.
      if (units === 0) value = -p.stock_value_cents;
      if (o.clearsCost) hasCostAfter = 0;
    }

    const valueAfter = hasCostAfter ? p.stock_value_cents + (value ?? 0) : 0;
    if (valueAfter < 0) {
      throw new BusinessError(`O valor do estoque de "${p.name}" ficaria negativo (${brl(valueAfter)}). Faça um ajuste de inventário.`);
    }
    if (units === 0 && valueAfter !== 0) throw new BusinessError(`Saldo inconsistente em "${p.name}".`);

    q.setStock.run(units, valueAfter, hasCostAfter, p.id);
    const info = q.insertMovement.run({
      product_id: p.id,
      type: o.type,
      quantity: qty,
      balance_after: units,
      unit_cost_cents: unitCost === null || unitCost === undefined ? null : Math.round(unitCost * 10000) / 10000,
      value_cents: value,
      value_after_cents: hasCostAfter ? valueAfter : null,
      unit_price_cents: o.unitPriceCents ?? null,
      revenue_cents: o.revenueCents ?? null,
      order_id: o.orderId ?? null,
      location_id: o.locationId ?? null,
      reason_id: o.reasonId ?? null,
      subtype: o.subtype ?? null,
      customer_id: o.customerId ?? null,
      supplier: o.supplier ?? null,
      document: o.document ?? null,
      note: o.note ?? null,
      reverses_movement_id: o.reversesId ?? null,
      created_by: o.user ?? null,
      created_at: o.at ?? null,
    });
    return { id: Number(info.lastInsertRowid), product_id: p.id, quantity: qty, value_cents: value, balance: units, value_after_cents: valueAfter };
  }

  const lineValue = (p, units, costCents, costPer) => (
    costPer === 'caixa' ? Math.round((units * costCents) / p.units_per_box) : units * costCents
  );

  // Entrada de mercadoria (nota do fornecedor).
  // lines: [{ product_id, units, cost_cents, cost_per: 'caixa'|'unidade', opening_cost_cents?, opening_cost_per? }]
  const receive = db.transaction(({ lines, document, supplier, note, user, at }) => {
    if (!Array.isArray(lines) || lines.length === 0) throw new BusinessError('Nenhum item informado.');
    const prepared = lines.map((l) => {
      const p = getProduct(l.product_id);
      const units = Number(l.units);
      if (!isInt(units) || units <= 0) throw new BusinessError(`Quantidade inválida para "${p.name}".`);
      const cost = Number(l.cost_cents);
      if (!isInt(cost) || cost < 0) throw new BusinessError(`Informe o custo de "${p.name}".`);
      const per = l.cost_per === 'caixa' ? 'caixa' : 'unidade';
      return { p, units, value: lineValue(p, units, cost, per), line: l };
    });
    if (prepared.some((x) => x.value === 0) && !note) {
      throw new BusinessError('Entrada com custo zero (ex.: bonificação) precisa de observação.');
    }
    const results = [];
    for (const { p, units, value, line } of prepared) {
      const fresh = q.product.get(p.id);
      if (!fresh.has_cost && fresh.stock_units > 0) {
        // Estoque antigo sem custo: valoriza pelo custo informado ou, se não informado, pelo custo desta nota.
        const informed = line.opening_cost_cents !== undefined && line.opening_cost_cents !== null && line.opening_cost_cents !== '';
        const openingValue = informed
          ? lineValue(fresh, fresh.stock_units, Number(line.opening_cost_cents), line.opening_cost_per === 'caixa' ? 'caixa' : 'unidade')
          : Math.round((fresh.stock_units * value) / units);
        if (!isInt(openingValue) || openingValue < 0) throw new BusinessError(`Custo inicial inválido para "${p.name}".`);
        results.push(move({
          productId: p.id, type: 'abertura_custo', quantity: 0, valueCents: openingValue, user, at,
          document, note: informed ? 'Custo inicial informado na entrada' : `Custo inicial pelo custo da nota${document ? ` ${document}` : ''}`,
        }));
      }
      results.push(move({ productId: p.id, type: 'entrada', quantity: units, valueCents: value, supplier: supplier || null, document, note, user, at }));
    }
    return results;
  });

  // Saídas manuais da câmara: transferência p/ loja, perda (com motivo) ou saída sem venda (com subtipo).
  const dispatch = db.transaction(({ type, lines, locationId, reasonId, subtype, customerId, document, note, user, at, noteThresholdCents = 0 }) => {
    if (!OUT_TYPES.includes(type)) throw new BusinessError('Tipo de saída inválido.');
    if (!Array.isArray(lines) || lines.length === 0) throw new BusinessError('Nenhum item informado.');
    const extra = {};
    if (type === 'transferencia') {
      const loc = locationId && q.location.get(Number(locationId));
      if (!loc || loc.kind !== 'loja' || !loc.active) throw new BusinessError('Escolha a loja de destino.');
      extra.locationId = loc.id;
    } else if (type === 'perda') {
      const reason = reasonId && q.reason.get(Number(reasonId));
      if (!reason || !reason.active) throw new BusinessError('Escolha o motivo da perda.');
      if (reason.requires_note && !note) throw new BusinessError(`O motivo "${reason.name}" precisa de observação.`);
      extra.reasonId = reason.id;
    } else {
      if (!SUBTYPES[subtype]) throw new BusinessError('Escolha o tipo da saída sem venda.');
      extra.subtype = subtype;
      if (customerId) {
        if (!q.customer.get(Number(customerId))) throw new BusinessError('Cliente não encontrado.');
        extra.customerId = Number(customerId);
      }
    }
    const results = [];
    let total = 0;
    for (const l of lines) {
      const p = getProduct(l.product_id);
      const units = Number(l.units);
      if (!isInt(units) || units <= 0) throw new BusinessError(`Quantidade inválida para "${p.name}".`);
      const r = move({
        productId: p.id, type, quantity: -units, document, note, user, at, ...extra,
        // transferência guarda o preço de varejo do dia, para valorizar o que foi para a loja
        unitPriceCents: type === 'transferencia' ? (p.retail_price_cents ?? p.unit_price_cents) : null,
      });
      total += -(r.value_cents ?? 0);
      results.push(r);
    }
    if (noteThresholdCents > 0 && total > noteThresholdCents && !note) {
      throw new BusinessError(`Saídas acima de ${brl(noteThresholdCents)} precisam de observação (esta: ${brl(total)}).`);
    }
    return results;
  });

  // Inventário: informa a contagem física e o sistema lança a sobra ou a divergência.
  const inventoryCount = db.transaction(({ counts, note, user, at }) => {
    const results = [];
    for (const c of counts) {
      const counted = Number(c.counted_units);
      if (!isInt(counted) || counted < 0) throw new BusinessError('Contagem inválida.');
      const p = getProduct(c.product_id);
      const diff = counted - p.stock_units;
      if (diff !== 0) {
        move({
          productId: p.id, type: diff > 0 ? 'sobra_inventario' : 'divergencia_inventario', quantity: diff,
          note: note || 'Inventário', user, at,
        });
      }
      results.push({ product_id: p.id, before: p.stock_units, after: counted, diff });
    }
    return results;
  });

  // Custo inicial de produto com saldo e sem custo: valoriza o saldo sem mudar as unidades.
  const openingCost = db.transaction(({ productId, costCents, costPer, note, user, at }) => {
    const p = getProduct(productId);
    const cost = Number(costCents);
    if (!isInt(cost) || cost < 0) throw new BusinessError('Custo inválido.');
    return move({
      productId: p.id, type: 'abertura_custo', quantity: 0, valueCents: lineValue(p, p.stock_units, cost, costPer),
      note: note || 'Custo inicial', user, at,
    });
  });

  // Estorno de um lançamento: devolve unidades e o MESMO valor do original.
  function reverseMovement({ movementId, reason, user, at, fromOrderCancel = false }) {
    const orig = q.movement.get(Number(movementId));
    if (!orig) throw new BusinessError('Movimentação não encontrada.', 404);
    if (!reason) throw new BusinessError('Informe o motivo do estorno.');
    if (orig.type === 'estorno') throw new BusinessError('Um estorno não pode ser estornado. Faça um novo lançamento.');
    if (orig.type === 'saida_pedido' && !fromOrderCancel) {
      throw new BusinessError(`Esta saída é do pedido #${orig.order_id}. Para desfazer, cancele o pedido.`);
    }
    if (q.reversalOf.get(orig.id)) throw new BusinessError('Esta movimentação já foi estornada.');
    if (orig.type === 'abertura_custo' && q.laterMovement.get(orig.product_id, orig.id)) {
      throw new BusinessError('Já houve movimentações depois deste custo inicial. Corrija com um ajuste de inventário.');
    }
    return move({
      productId: orig.product_id,
      type: 'estorno',
      quantity: -orig.quantity,
      valueCents: orig.value_cents === null ? undefined : -orig.value_cents,
      clearsCost: orig.type === 'abertura_custo',
      reversesId: orig.id,
      orderId: orig.order_id,
      locationId: orig.location_id,
      reasonId: orig.reason_id,
      subtype: orig.subtype,
      customerId: orig.customer_id,
      unitPriceCents: orig.unit_price_cents,
      revenueCents: orig.revenue_cents === null ? null : -orig.revenue_cents,
      document: orig.document,
      note: reason,
      user,
      at,
    });
  }
  const reverse = db.transaction(reverseMovement);

  function priceFor(p, unitType) {
    return unitType === 'caixa' ? p.box_price_cents : p.unit_price_cents;
  }

  // Quais produtos do carrinho NÃO temos na quantidade pedida (só ids, sem revelar o estoque).
  function unavailableProducts(items) {
    const need = new Map();
    for (const it of Array.isArray(items) ? items : []) {
      const p = q.product.get(Number(it.product_id));
      const quantity = Number(it.quantity);
      if (!p || !isInt(quantity) || quantity <= 0) continue;
      const units = quantity * (it.unit_type === 'caixa' ? p.units_per_box : 1);
      need.set(p.id, (need.get(p.id) || 0) + units);
    }
    return [...need].filter(([id, units]) => units > availableUnits(id)).map(([id]) => id);
  }

  // items: [{ product_id, unit_type: 'caixa'|'unidade', quantity }]
  const createOrder = db.transaction(({ customerId, items, notes, deliveryDate, minOrderCents = 0, at }) => {
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
      if (!isInt(quantity) || quantity <= 0 || quantity > 100000) {
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

    // O cliente nunca vê quanto temos: só a recusa, sem números.
    const short = [...needByProduct].filter(([productId, need]) => need > availableUnits(productId)).map(([productId]) => productId);
    if (short.length) {
      const names = short.map((id) => `"${q.product.get(id).name}"`).join(', ');
      throw new BusinessError(
        `Não temos a quantidade pedida de ${names} no momento. Diminua a quantidade ou fale com a loja.`,
        409,
        { unavailable: short },
      );
    }

    const total = lines.reduce((s, l) => s + l.subtotal_cents, 0);
    if (minOrderCents > 0 && total < minOrderCents) {
      throw new BusinessError(`O pedido mínimo é de ${brl(minOrderCents)}.`);
    }

    const orderId = Number(q.insertOrder.run(customerId, notes || null, deliveryDate || null, at || null).lastInsertRowid);
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
      if (!isInt(qty) || qty < 0) throw new BusinessError('Quantidade inválida.');
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

  const changeStatus = db.transaction(({ orderId, status, user, adminNotes, at }) => {
    const order = q.order.get(orderId);
    if (!order) throw new BusinessError('Pedido não encontrado.', 404);
    if (!(TRANSITIONS[order.status] || []).includes(status)) {
      throw new BusinessError(`Não é possível mudar o pedido de "${order.status}" para "${status}".`);
    }
    const doc = `Pedido #${orderId}`;

    if (status === 'separado' && !order.stock_deducted) {
      // Venda B2B reconhecida aqui: baixa a custo médio (CMV) e grava a receita praticada.
      for (const it of q.items.all(orderId)) {
        move({
          productId: it.product_id, type: 'saida_pedido', quantity: -it.units_total, orderId, customerId: order.customer_id,
          unitPriceCents: Math.round(it.subtotal_cents / it.units_total), revenueCents: it.subtotal_cents,
          document: doc, user, at,
        });
      }
      db.prepare('UPDATE orders SET stock_deducted = 1 WHERE id = ?').run(orderId);
    }
    if (status === 'cancelado' && order.stock_deducted) {
      for (const m of q.orderSales.all(orderId)) {
        reverseMovement({ movementId: m.id, reason: `Cancelamento do pedido #${orderId}`, user, at, fromOrderCancel: true });
      }
      db.prepare('UPDATE orders SET stock_deducted = 0 WHERE id = ?').run(orderId);
    }

    const stampColumn = { confirmado: 'confirmed_at', separado: 'picked_at', entregue: 'delivered_at', cancelado: 'cancelled_at' }[status];
    db.prepare(`UPDATE orders SET status = ?, ${stampColumn} = COALESCE(?, datetime('now')) WHERE id = ?`).run(status, at || null, orderId);
    if (status === 'separado' && !order.confirmed_at) {
      db.prepare("UPDATE orders SET confirmed_at = COALESCE(?, datetime('now')) WHERE id = ?").run(at || null, orderId);
    }
    if (adminNotes !== undefined) db.prepare('UPDATE orders SET admin_notes = ? WHERE id = ?').run(adminNotes || null, orderId);
    return q.order.get(orderId);
  });

  return {
    reservedUnits,
    availableUnits,
    unavailableProducts,
    exitValue,
    move: db.transaction(move),
    receive,
    dispatch,
    inventoryCount,
    openingCost,
    reverse,
    createOrder,
    editOrderItems,
    changeStatus,
  };
}

module.exports = { createInventory, BusinessError, TRANSITIONS, RESERVING_STATUSES, SUBTYPES, OUT_TYPES };

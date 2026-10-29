'use strict';

// Dados de TESTE: usados só pelo "Testar no Windows/Mac" (no próprio computador).
// Lançam estoque com custo de EXEMPLO — nunca use no sistema de verdade.
//
// - Banco novo: Catálogo Oggi 2026 (com fotos), dois clientes e ~45 dias de movimentações de
//   todos os tipos, para testar os relatórios.
// - Uma única vez por banco: algumas caixas de cada produto do catálogo que estiver sem caixa
//   disponível, para dar para comprar por caixa ou por unidade.

const { createInventory } = require('./inventory');
const { hashPassword } = require('./auth');
const { loadOggiCatalog } = require('./catalog');
const T = require('./time');

const BOXES = 5; // caixas de teste por produto

function seedTestData(db, { log = console.log } = {}) {
  const fresh = db.prepare('SELECT (SELECT COUNT(*) FROM products) + (SELECT COUNT(*) FROM stock_movements) AS n').get().n === 0;
  const stockLoaded = db.prepare("SELECT value FROM settings WHERE key = 'test_stock_loaded'").get();
  if (!fresh && stockLoaded) {
    log('Dados de teste já carregados.');
    return { fresh: false, topped: 0 };
  }

  const inv = createInventory(db);
  const today = T.localDate();
  const at = (daysAgo, hhmm) => T.localToUtc(`${T.addDays(today, -daysAgo)} ${hhmm}`);
  const user = 'Exemplo';

  let topped = 0;
  db.transaction(() => {
    loadOggiCatalog(db);
    const ins = db.prepare(`INSERT OR IGNORE INTO customers (cnpj, razao_social, nome_fantasia, contato, telefone, cidade, password_hash, status)
      VALUES (?, ?, ?, ?, ?, 'Sinop', ?, 'ativo')`);
    ins.run('11222333000181', 'Lanchonete Exemplo LTDA', 'Lanchonete Exemplo', 'Maria', '(66) 99999-0000', hashPassword('cliente123'));
    ins.run('11444777000161', 'Mercadinho Bom Preço LTDA', 'Mercadinho Bom Preço', 'João', '(66) 98888-1111', hashPassword('cliente123'));
    const customer = (cnpj) => db.prepare('SELECT id FROM customers WHERE cnpj = ?').get(cnpj).id;
    if (fresh) demoHistory(customer('11222333000181'), customer('11444777000161'));

    // Estoque de teste: algumas caixas de cada produto do catálogo sem caixa disponível.
    const lines = db.prepare("SELECT * FROM products WHERE sku LIKE 'OG26-%' AND active = 1 ORDER BY category, name").all()
      .filter((prod) => inv.availableUnits(prod.id) < prod.units_per_box)
      .map((prod) => ({
        product_id: prod.id, units: BOXES * prod.units_per_box, cost_per: 'caixa',
        cost_cents: Math.round(prod.unit_price_cents * 0.55 * prod.units_per_box), // custo de exemplo ≈ 55% do preço
      }));
    if (lines.length) inv.receive({ lines, document: 'Estoque de teste', supplier: 'Franqueadora Oggi', note: 'Estoque de teste (custo de exemplo)', user });
    topped = lines.length;
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('test_stock_loaded', '1')").run();
  })();

  function demoHistory(c1, c2) {
    const p = (name) => db.prepare('SELECT * FROM products WHERE name = ?').get(name);
    const loja = (name) => db.prepare('SELECT id FROM locations WHERE name = ?').get(name).id;
    const reason = (name) => db.prepare('SELECT id FROM loss_reasons WHERE name = ?').get(name).id;

    // Exemplos de código de barras (fictícios) para testar o leitor
    const codes = [
      ['Picolé Sensa Brigadeiro', '7890000000011', '17890000000018'],
      ['Picolé Frutos Morango', '7890000000028', '17890000000025'],
      ['Pote Seleções Flocos', '7890000000059', '17890000000056'],
    ];
    for (const [name, ean, dun] of codes) db.prepare('UPDATE products SET barcode = ?, box_barcode = ? WHERE name = ?').run(ean, dun, name);


    // custo de exemplo ≈ 55% do preço B2B, por caixa
    const boxCost = (prod, factor = 0.55) => Math.round(prod.unit_price_cents * factor * prod.units_per_box);
    const stocked = [
      ['Picolé Sensa Brigadeiro', 6], ['Picolé Sensa Clássico', 4], ['Picolé Frutos Morango', 5], ['Picolé Frutos Limão', 4],
      ['Picolé Disney Minnie Morango', 4], ['Picolé Delícia Chocolate', 3], ['Picolé Festa Melancia', 3], ['Pote Seleções Flocos', 10],
      ['Pote Tradicionais Napolitano', 8], ['Pote Duetto Frutas Vermelhas', 5], ['Top Sundae Chocolate', 4],
      ['Cone Giratto Crocante', 4], ['Açaí 200g Guaraná', 6],
    ];

    inv.receive({
      lines: stocked.map(([name, boxes]) => { const prod = p(name); return { product_id: prod.id, units: boxes * prod.units_per_box, cost_cents: boxCost(prod), cost_per: 'caixa' }; }),
      document: 'NF 1001', supplier: 'Franqueadora Oggi', user, at: at(45, '09:30'),
    });

    const order = (customerId, items, daysAgo, { cancel = false, stop } = {}) => {
      const orderId = inv.createOrder({
        customerId, at: at(daysAgo, '10:00'),
        items: items.map(([name, type, qty]) => ({ product_id: p(name).id, unit_type: type, quantity: qty })),
      });
      if (stop === 'novo') return orderId;
      inv.changeStatus({ orderId, status: 'confirmado', user, at: at(daysAgo, '11:00') });
      if (stop === 'confirmado') return orderId;
      inv.changeStatus({ orderId, status: 'separado', user, at: at(daysAgo, '15:00') });
      if (cancel) inv.changeStatus({ orderId, status: 'cancelado', user, at: at(daysAgo - 1, '09:00') });
      else inv.changeStatus({ orderId, status: 'entregue', user, at: at(daysAgo - 1, '08:00') });
      return orderId;
    };

    order(c1, [['Picolé Sensa Brigadeiro', 'caixa', 1], ['Picolé Frutos Morango', 'caixa', 2], ['Pote Seleções Flocos', 'unidade', 4]], 40);
    order(c2, [['Pote Tradicionais Napolitano', 'caixa', 2], ['Top Sundae Chocolate', 'caixa', 1], ['Açaí 200g Guaraná', 'caixa', 2]], 35);
    inv.dispatch({ type: 'transferencia', locationId: loja('Loja 1 - Centro'), lines: [{ product_id: p('Picolé Frutos Limão').id, units: 39 }, { product_id: p('Pote Seleções Flocos').id, units: 4 }], user, at: at(33, '08:15') });
    inv.dispatch({ type: 'perda', reasonId: reason('Descongelamento / quebra da cadeia de frio'), note: 'Freezer da porta desligou', lines: [{ product_id: p('Pote Duetto Frutas Vermelhas').id, units: 2 }], user, at: at(30, '18:40') });
    order(c1, [['Picolé Disney Minnie Morango', 'caixa', 1], ['Cone Giratto Crocante', 'caixa', 1]], 28, { cancel: true });

    // segunda nota, com custo um pouco maior (o custo médio muda)
    inv.receive({
      lines: ['Picolé Sensa Brigadeiro', 'Picolé Frutos Morango', 'Pote Seleções Flocos'].map((name) => {
        const prod = p(name); return { product_id: prod.id, units: 3 * prod.units_per_box, cost_cents: boxCost(prod, 0.58), cost_per: 'caixa' };
      }),
      document: 'NF 1042', supplier: 'Franqueadora Oggi', user, at: at(22, '09:10'),
    });
    // bonificação da franqueadora (custo zero, com observação)
    inv.receive({ lines: [{ product_id: p('Picolé Festa Melancia').id, units: 39, cost_cents: 0 }], document: 'NF 1042', supplier: 'Franqueadora Oggi', note: 'Bonificação da franqueadora', user, at: at(22, '09:12') });

    const tr = inv.dispatch({ type: 'transferencia', locationId: loja('Loja 1 - Centro'), lines: [{ product_id: p('Picolé Sensa Clássico').id, units: 20 }], user, at: at(20, '08:00') });
    inv.reverse({ movementId: tr[0].id, reason: 'Era para a Loja 2', user, at: at(20, '08:05') });
    inv.dispatch({ type: 'transferencia', locationId: loja('Loja 2'), lines: [{ product_id: p('Picolé Sensa Clássico').id, units: 20 }, { product_id: p('Picolé Delícia Chocolate').id, units: 39 }], user, at: at(20, '08:06') });

    order(c2, [['Picolé Sensa Brigadeiro', 'caixa', 2], ['Pote Seleções Flocos', 'caixa', 2], ['Picolé Festa Melancia', 'caixa', 1]], 15);
    inv.dispatch({ type: 'saida_sem_venda', subtype: 'amostra_degustacao', note: 'Degustação no Mercadinho', lines: [{ product_id: p('Pote Tradicionais Napolitano').id, units: 1 }], user, at: at(14, '16:00') });
    inv.dispatch({ type: 'saida_sem_venda', subtype: 'bonificacao_cliente', customerId: c1, lines: [{ product_id: p('Picolé Frutos Morango').id, units: 10 }], user, at: at(12, '10:30') });
    inv.dispatch({ type: 'perda', reasonId: reason('Vencimento'), lines: [{ product_id: p('Açaí 200g Guaraná').id, units: 3 }], user, at: at(10, '17:00') });

    // inventário: uma divergência (faltou) e uma sobra
    const dv = p('Picolé Frutos Morango');
    const sb = p('Top Sundae Chocolate');
    inv.inventoryCount({ counts: [{ product_id: dv.id, counted_units: dv.stock_units - 2 }, { product_id: sb.id, counted_units: sb.stock_units + 1 }], note: 'Inventário quinzenal', user, at: at(7, '07:30') });
    // produto com saldo e sem custo (como dado antigo) — para testar "Informar custo inicial"
    inv.inventoryCount({ counts: [{ product_id: p('Picolé Clássicos Brigadeiro').id, counted_units: 33 }], note: 'Estoque encontrado sem nota', user, at: at(7, '07:40') });

    order(c1, [['Picolé Sensa Brigadeiro', 'caixa', 1], ['Pote Duetto Frutas Vermelhas', 'unidade', 2]], 3);
    order(c2, [['Picolé Frutos Morango', 'caixa', 1], ['Açaí 200g Guaraná', 'unidade', 6]], 1, { stop: 'confirmado' });
    order(c1, [['Pote Seleções Flocos', 'caixa', 1], ['Picolé Festa Melancia', 'unidade', 20]], 0, { stop: 'novo' });
  }

  if (fresh) log('Dados de teste criados: Catálogo Oggi 2026 + 45 dias de movimentações de exemplo.');
  log(`Estoque de teste: ${BOXES} caixas de ${topped} produto(s) do catálogo.`);
  log('Clientes de teste → CNPJ 11.222.333/0001-81 ou 11.444.777/0001-61 · senha cliente123');
  return { fresh, topped };
}

module.exports = { seedTestData, BOXES };

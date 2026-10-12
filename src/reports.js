'use strict';

// Relatórios gerenciais. Todos os períodos são dias LOCAIS (America/Cuiaba),
// convertidos para UTC pelos helpers de time.js.
//
// Formato de saída (usado pela tela e pela exportação):
//   { title, subtitle, warnings: [], sections: [{ title, columns: [{ key, label, type }], rows: [], total }] }
// Tipos de coluna: text | int | units (usa row.upb) | money (centavos) | pct (0–1) | unitcost (centavos, com decimais)

const T = require('./time');
const { SUBTYPES } = require('./inventory');

const BUCKETS = {
  entrada: 'Entradas (compras)',
  abertura_custo: 'Custo inicial (valorização de saldo)',
  saida_pedido: 'Vendas B2B (a custo = CMV)',
  transferencia: 'Transferências para lojas',
  perda: 'Perdas registradas',
  saida_sem_venda: 'Saídas sem venda',
  sobra_inventario: 'Sobras de inventário',
  divergencia_inventario: 'Divergências de inventário',
  estorno: 'Estornos sem lançamento de origem',
};
const BUCKET_ORDER = Object.keys(BUCKETS);

const div = (a, b) => (b ? a / b : null);

function createReports(db) {
  // Tipo "efetivo": um estorno conta na mesma linha do lançamento que ele desfaz (com sinal oposto).
  const MOV_SELECT = `
    SELECT m.*, CASE WHEN m.type = 'estorno' AND o.type IS NOT NULL THEN o.type ELSE m.type END AS eff_type,
      ${T.sqlLocalMonth('m.created_at')} AS month, ${T.sqlLocalDate('m.created_at')} AS local_date,
      p.name AS product_name, p.category, p.units_per_box AS upb,
      l.name AS location_name, r.name AS reason_name,
      c.razao_social, c.nome_fantasia
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    LEFT JOIN stock_movements o ON o.id = m.reverses_movement_id
    LEFT JOIN locations l ON l.id = m.location_id
    LEFT JOIN loss_reasons r ON r.id = m.reason_id
    LEFT JOIN customers c ON c.id = m.customer_id`;

  const periodMovements = (from, to) => {
    const [start, end] = T.utcRange(from, to);
    return db.prepare(`${MOV_SELECT} WHERE m.created_at >= ? AND m.created_at < ? ORDER BY m.id`).all(start, end);
  };

  // Posição de cada produto ao FIM do dia local `date`, reconstruída pelo kardex.
  function positionRows(date) {
    const end = T.utcStartOfLocalDay(T.addDays(date, 1));
    return db.prepare(`
      SELECT p.id, p.name, p.category, p.units_per_box AS upb, p.unit_price_cents, p.retail_price_cents, p.active,
        COALESCE(m.balance_after, 0) AS units, m.value_after_cents AS value, m.id AS last_movement
      FROM products p
      LEFT JOIN stock_movements m ON m.id = (
        SELECT id FROM stock_movements WHERE product_id = p.id AND created_at < ? ORDER BY id DESC LIMIT 1)
      ORDER BY p.category, p.name`).all(end).map((r) => ({
      ...r,
      uncosted: r.units > 0 && r.value === null,
      value: r.units === 0 ? 0 : r.value,
    }));
  }

  // 1. Posição de estoque em uma data
  function position(date) {
    const rows = positionRows(date).filter((r) => r.units !== 0);
    const costed = rows.filter((r) => !r.uncosted);
    const uncosted = rows.filter((r) => r.uncosted);
    const productRows = costed.map((r) => ({
      name: r.name, category: r.category, upb: r.upb, units: r.units,
      avg: div(r.value, r.units), value: r.value,
      b2b: r.units * r.unit_price_cents, retail: r.units * (r.retail_price_cents ?? r.unit_price_cents),
    }));
    const byCat = new Map();
    for (const r of productRows) {
      const c = byCat.get(r.category) || { category: r.category, units: 0, value: 0, b2b: 0, retail: 0 };
      c.units += r.units; c.value += r.value; c.b2b += r.b2b; c.retail += r.retail;
      byCat.set(r.category, c);
    }
    const sum = (k) => productRows.reduce((s, r) => s + r[k], 0);
    const total = { name: 'Total', category: 'Total', units: sum('units'), value: sum('value'), b2b: sum('b2b'), retail: sum('retail') };
    const money = [
      { key: 'value', label: 'Valor a custo', type: 'money' },
      { key: 'b2b', label: 'Valor a preço B2B', type: 'money' },
      { key: 'retail', label: 'Valor a preço de varejo', type: 'money' },
    ];
    const sections = [
      {
        title: 'Por categoria',
        columns: [{ key: 'category', label: 'Categoria', type: 'text' }, { key: 'units', label: 'Unidades', type: 'int' }, ...money],
        rows: [...byCat.values()],
        total,
      },
      {
        title: 'Por produto',
        columns: [
          { key: 'name', label: 'Produto', type: 'text' }, { key: 'category', label: 'Categoria', type: 'text' },
          { key: 'units', label: 'Estoque', type: 'units' }, { key: 'avg', label: 'Custo médio/un', type: 'unitcost' }, ...money,
        ],
        rows: productRows,
        total,
      },
    ];
    if (uncosted.length) {
      sections.push({
        title: 'Produtos sem custo (valor desconhecido — fora dos totais em R$)',
        columns: [{ key: 'name', label: 'Produto', type: 'text' }, { key: 'units', label: 'Estoque', type: 'units' }],
        rows: uncosted.map((r) => ({ name: r.name, units: r.units, upb: r.upb })),
      });
    }
    return {
      title: 'Posição de estoque',
      subtitle: `Fim do dia ${date}. Preços B2B e de varejo atuais.`,
      warnings: uncosted.length ? [`${uncosted.length} produto(s) com saldo e sem custo. Informe o custo inicial em Estoque.`] : [],
      sections,
    };
  }

  // 2. Conciliação: inicial + entradas − saídas ± ajustes = final
  function reconciliation(from, to) {
    const initial = new Map(positionRows(T.addDays(from, -1)).map((r) => [r.id, r]));
    const final = new Map(positionRows(to).map((r) => [r.id, r]));
    const per = new Map();
    for (const m of periodMovements(from, to)) {
      const e = per.get(m.product_id) || { buckets: {}, nullValue: false };
      const b = e.buckets[m.eff_type] || (e.buckets[m.eff_type] = { units: 0, value: 0 });
      b.units += m.quantity;
      b.value += m.value_cents ?? 0;
      if (m.value_cents === null && m.quantity !== 0) e.nullValue = true;
      per.set(m.product_id, e);
    }

    const rows = [];
    const uncostedRows = [];
    const totals = { units: {}, value: {} };
    const add = (obj, k, v) => { obj[k] = (obj[k] || 0) + v; };
    for (const [id, fin] of final) {
      const ini = initial.get(id);
      const e = per.get(id) || { buckets: {}, nullValue: false };
      if (!ini.units && !fin.units && !per.has(id)) continue;
      const movUnits = Object.values(e.buckets).reduce((s, b) => s + b.units, 0);
      const movValue = Object.values(e.buckets).reduce((s, b) => s + b.value, 0);
      const base = { name: fin.name, upb: fin.upb, ini_units: ini.units, fin_units: fin.units, diff_units: ini.units + movUnits - fin.units };
      for (const k of BUCKET_ORDER) base[`u_${k}`] = e.buckets[k]?.units || 0;
      if (ini.uncosted || fin.uncosted || e.nullValue) {
        uncostedRows.push({ ...base, _class: base.diff_units ? 'danger' : undefined });
        continue;
      }
      const row = { ...base, ini_value: ini.value, fin_value: fin.value, diff_value: ini.value + movValue - fin.value };
      for (const k of BUCKET_ORDER) row[`v_${k}`] = e.buckets[k]?.value || 0;
      if (row.diff_units || row.diff_value) row._class = 'danger';
      rows.push(row);
      for (const k of ['ini_units', 'fin_units', 'diff_units', ...BUCKET_ORDER.map((b) => `u_${b}`)]) add(totals.units, k, row[k]);
      for (const k of ['ini_value', 'fin_value', 'diff_value', ...BUCKET_ORDER.map((b) => `v_${b}`)]) add(totals.value, k, row[k]);
    }

    // Quadro resumo (unidades e R$ a custo)
    const summaryRows = [
      { line: 'Estoque inicial', units: totals.units.ini_units || 0, value: totals.value.ini_value || 0 },
      ...BUCKET_ORDER.map((k) => ({ line: BUCKETS[k], units: totals.units[`u_${k}`] || 0, value: totals.value[`v_${k}`] || 0, key: k }))
        .filter((r) => r.units || r.value || ['entrada', 'saida_pedido', 'transferencia', 'perda', 'saida_sem_venda'].includes(r.key)),
      { line: '= Estoque final calculado', units: (totals.units.fin_units || 0) + (totals.units.diff_units || 0), value: (totals.value.fin_value || 0) + (totals.value.diff_value || 0) },
      { line: 'Estoque final (posição na data)', units: totals.units.fin_units || 0, value: totals.value.fin_value || 0 },
      { line: 'Diferença', units: totals.units.diff_units || 0, value: totals.value.diff_value || 0 },
    ];
    const diffRow = summaryRows[summaryRows.length - 1];
    if (diffRow.units || diffRow.value) diffRow._class = 'danger';

    // Detalhe por destino/motivo/subtipo
    const detail = new Map();
    for (const m of periodMovements(from, to)) {
      let label = null;
      if (m.eff_type === 'transferencia') label = `Transferência → ${m.location_name || '?'}`;
      else if (m.eff_type === 'perda') label = `Perda: ${m.reason_name || '?'}`;
      else if (m.eff_type === 'saida_sem_venda') label = `Sem venda: ${SUBTYPES[m.subtype] || m.subtype || '?'}`;
      if (!label) continue;
      const d = detail.get(label) || { line: label, units: 0, value: 0, nullValue: false };
      d.units += m.quantity;
      d.value += m.value_cents ?? 0;
      if (m.value_cents === null) d.nullValue = true;
      detail.set(label, d);
    }

    const bucketCols = (prefix, type) => BUCKET_ORDER
      .filter((k) => rows.concat(uncostedRows).some((r) => r[`${prefix}_${k}`]))
      .map((k) => ({ key: `${prefix}_${k}`, label: BUCKETS[k], type }));
    const warnings = [];
    if (diffRow.units || diffRow.value) warnings.push('A conciliação NÃO fecha: veja as linhas em vermelho.');
    if (uncostedRows.length) warnings.push(`${uncostedRows.length} produto(s) sem custo ou com histórico sem custo no período: aparecem só em unidades, à parte.`);

    const sections = [
      {
        title: 'Resumo (todos os produtos com custo)',
        columns: [{ key: 'line', label: '', type: 'text' }, { key: 'units', label: 'Unidades', type: 'int' }, { key: 'value', label: 'R$ a custo', type: 'money' }],
        rows: summaryRows,
      },
    ];
    if (detail.size) {
      sections.push({
        title: 'Saídas por destino, motivo e subtipo',
        columns: [{ key: 'line', label: '', type: 'text' }, { key: 'units', label: 'Unidades', type: 'int' }, { key: 'value', label: 'R$ a custo', type: 'money' }],
        rows: [...detail.values()],
      });
    }
    sections.push({
      title: 'Por produto — R$ a custo',
      columns: [
        { key: 'name', label: 'Produto', type: 'text' }, { key: 'ini_value', label: 'Inicial', type: 'money' },
        ...bucketCols('v', 'money'), { key: 'fin_value', label: 'Final', type: 'money' }, { key: 'diff_value', label: 'Diferença', type: 'money' },
      ],
      rows,
      total: { name: 'Total', ...totals.value },
    });
    sections.push({
      title: 'Por produto — unidades',
      columns: [
        { key: 'name', label: 'Produto', type: 'text' }, { key: 'ini_units', label: 'Inicial', type: 'int' },
        ...bucketCols('u', 'int'), { key: 'fin_units', label: 'Final', type: 'int' }, { key: 'diff_units', label: 'Diferença', type: 'int' },
      ],
      rows,
      total: { name: 'Total', ...totals.units },
    });
    if (uncostedRows.length) {
      sections.push({
        title: 'Sem custo / histórico sem custo (só unidades)',
        columns: [
          { key: 'name', label: 'Produto', type: 'text' }, { key: 'ini_units', label: 'Inicial', type: 'int' },
          ...bucketCols('u', 'int'), { key: 'fin_units', label: 'Final', type: 'int' }, { key: 'diff_units', label: 'Diferença', type: 'int' },
        ],
        rows: uncostedRows,
      });
    }
    return {
      title: 'Conciliação do estoque',
      subtitle: `${from} a ${to}. Estoque inicial + entradas − saídas ± ajustes = estoque final.`,
      warnings,
      sections,
      check: { units: diffRow.units, value: diffRow.value, total: summaryRows },
    };
  }

  // Agrupa movimentos por uma chave e soma unidades/valores.
  function group(movs, keyFn, labelFn, extra = () => ({})) {
    const map = new Map();
    for (const m of movs) {
      const k = keyFn(m);
      const g = map.get(k) || { label: labelFn(m), units: 0, cost: 0, revenue: 0, retail: 0, nullCost: false, ...extra(m) };
      g.units += -m.quantity;
      g.cost += -(m.value_cents ?? 0);
      g.revenue += m.revenue_cents ?? 0;
      g.retail += -m.quantity * (m.unit_price_cents ?? 0);
      if (m.value_cents === null) g.nullCost = true;
      map.set(k, g);
    }
    return [...map.values()];
  }

  const customerName = (m) => m.nome_fantasia || m.razao_social || 'Sem cliente';

  // 3. Vendas B2B
  function sales(from, to) {
    const movs = periodMovements(from, to).filter((m) => m.eff_type === 'saida_pedido');
    const finish = (rows) => rows.map((r) => ({
      ...r,
      cost: r.nullCost ? null : r.cost,
      margin: r.nullCost ? null : r.revenue - r.cost,
      margin_pct: r.nullCost ? null : div(r.revenue - r.cost, r.revenue),
    })).sort((a, b) => b.revenue - a.revenue);
    const cols = (first) => [
      { key: 'label', label: first, type: 'text' }, { key: 'units', label: 'Unidades', type: 'int' },
      { key: 'revenue', label: 'Receita', type: 'money' }, { key: 'cost', label: 'CMV', type: 'money' },
      { key: 'margin', label: 'Margem bruta', type: 'money' }, { key: 'margin_pct', label: 'Margem %', type: 'pct' },
    ];
    const total = finish(group(movs, () => 'all', () => 'Total'))[0] || { label: 'Total', units: 0, revenue: 0, cost: 0, margin: 0, margin_pct: null };
    const byMonth = finish(group(movs, (m) => m.month, (m) => m.month)).sort((a, b) => a.label.localeCompare(b.label));
    const warnings = movs.some((m) => m.value_cents === null) ? ['Há vendas de produtos sem custo: o CMV e a margem dessas linhas ficam em branco.'] : [];
    return {
      title: 'Vendas B2B',
      subtitle: `${from} a ${to}. Venda reconhecida na separação (saída da câmara). Cancelamentos já descontados.`,
      warnings,
      sections: [
        { title: 'Por cliente', columns: cols('Cliente'), rows: finish(group(movs, (m) => m.customer_id, customerName)), total },
        { title: 'Por produto', columns: cols('Produto'), rows: finish(group(movs, (m) => m.product_id, (m) => m.product_name)), total },
        { title: 'Por mês', columns: cols('Mês'), rows: byMonth, total },
      ],
      total,
    };
  }

  // 4. Perdas e divergências
  function losses(from, to) {
    const all = periodMovements(from, to);
    const entries = all.filter((m) => m.eff_type === 'entrada');
    const entryUnits = entries.reduce((s, m) => s + m.quantity, 0);
    const entryValue = entries.reduce((s, m) => s + (m.value_cents ?? 0), 0);
    const movs = all.filter((m) => m.eff_type === 'perda' || m.eff_type === 'divergencia_inventario');
    const reasonOf = (m) => (m.eff_type === 'divergencia_inventario' ? 'Divergência de inventário' : m.reason_name || 'Sem motivo');
    const finish = (rows) => rows.map((r) => ({
      ...r, cost: r.nullCost ? null : r.cost,
      pct_units: div(r.units, entryUnits), pct_value: r.nullCost ? null : div(r.cost, entryValue),
    })).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
    const cols = (first) => [
      { key: 'label', label: first, type: 'text' }, { key: 'units', label: 'Unidades', type: 'int' },
      { key: 'cost', label: 'R$ a custo', type: 'money' },
      { key: 'pct_units', label: '% das entradas (un)', type: 'pct' }, { key: 'pct_value', label: '% das entradas (R$)', type: 'pct' },
    ];
    const total = finish(group(movs, () => 'all', () => 'Total'))[0] || { label: 'Total', units: 0, cost: 0, pct_units: null, pct_value: null };
    return {
      title: 'Perdas e divergências',
      subtitle: `${from} a ${to}. Entradas no período: ${entryUnits} un.`,
      warnings: [],
      entries: { units: entryUnits, value: entryValue },
      sections: [
        { title: 'Por motivo', columns: cols('Motivo'), rows: finish(group(movs, reasonOf, reasonOf)), total },
        { title: 'Por produto', columns: cols('Produto'), rows: finish(group(movs, (m) => m.product_id, (m) => m.product_name)), total },
        { title: 'Por mês', columns: cols('Mês'), rows: finish(group(movs, (m) => m.month, (m) => m.month)).sort((a, b) => a.label.localeCompare(b.label)), total },
      ],
      total,
    };
  }

  // 5. Transferências para lojas
  function transfers(from, to) {
    const movs = periodMovements(from, to).filter((m) => m.eff_type === 'transferencia');
    const finish = (rows) => rows.map((r) => ({ ...r, cost: r.nullCost ? null : r.cost })).sort((a, b) => b.retail - a.retail);
    const cols = (first) => [
      { key: 'label', label: first, type: 'text' }, { key: 'units', label: 'Unidades', type: 'int' },
      { key: 'cost', label: 'R$ a custo', type: 'money' }, { key: 'retail', label: 'R$ a preço de varejo', type: 'money' },
    ];
    const total = finish(group(movs, () => 'all', () => 'Total'))[0] || { label: 'Total', units: 0, cost: 0, retail: 0 };
    return {
      title: 'Transferências para lojas',
      subtitle: `${from} a ${to}. Preço de varejo do dia da transferência.`,
      warnings: [],
      sections: [
        { title: 'Por loja', columns: cols('Loja'), rows: finish(group(movs, (m) => m.location_id, (m) => m.location_name || '?')), total },
        { title: 'Por produto', columns: cols('Produto'), rows: finish(group(movs, (m) => m.product_id, (m) => m.product_name)), total },
        { title: 'Por mês', columns: cols('Mês'), rows: finish(group(movs, (m) => m.month, (m) => m.month)).sort((a, b) => a.label.localeCompare(b.label)), total },
      ],
      total,
    };
  }

  // Números do painel inicial (mês local corrente).
  function dashboard() {
    const [from, to] = T.monthBounds(T.localMonth());
    const s = sales(from, to).total;
    const l = losses(from, to).total;
    const stock = db.prepare(`SELECT COALESCE(SUM(stock_value_cents), 0) AS cost, COALESCE(SUM(stock_units * unit_price_cents), 0) AS b2b,
      COALESCE(SUM(stock_units), 0) AS units FROM products`).get();
    const uncosted = db.prepare('SELECT COUNT(*) n FROM products WHERE stock_units > 0 AND has_cost = 0').get().n;
    return {
      month: { from, to, revenue: s.revenue, cmv: s.cost, margin: s.margin, margin_pct: s.margin_pct, units: s.units, losses_value: l.cost, losses_units: l.units },
      stock,
      uncosted,
    };
  }

  return { position, reconciliation, sales, losses, transfers, dashboard, positionRows };
}

module.exports = { createReports, BUCKETS };

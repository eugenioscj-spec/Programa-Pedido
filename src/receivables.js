'use strict';

// Pedido B2B entregue vira conta a receber no Financeiro (conta "Recebimento de clientes B2B",
// que só mexe no caixa: a receita da venda já entra na DRE pelo estoque).
// Vencimento: data da entrega + prazo do cliente (padrão da Config., hoje 30 dias) e mais
// 1 dia útil para o dinheiro cair na conta. Prazo 0 = à vista, no próprio dia.
// Cliente com prazo -1 (loja própria, ex.: Loja 2) não gera conta a receber.

const T = require('./time');

const RECEIVABLE_ACCOUNT = 'Recebimento de clientes B2B';

// Próximo dia útil DEPOIS de `date` (pula sábado e domingo; feriados ainda não entram).
function nextBusinessDay(date) {
  let d = T.addDays(date, 1);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = T.addDays(d, 1);
  return d;
}

function dueDate(delivered, days) {
  if (days <= 0) return delivered;
  return nextBusinessDay(T.addDays(delivered, days));
}

function createReceivables(db) {
  const defaultDays = () => {
    const v = Number(db.prepare("SELECT value FROM settings WHERE key = 'b2b_payment_days'").get()?.value);
    return Number.isInteger(v) && v >= 0 ? v : 30;
  };

  // Chamado quando o pedido passa para "entregue". Não duplica (um lançamento por pedido).
  function onDelivered(orderId, delivered = T.localDate()) {
    const o = db.prepare(`SELECT o.*, c.razao_social, c.nome_fantasia, c.payment_days FROM orders o
      JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(orderId);
    if (!o || o.status !== 'entregue' || o.total_cents <= 0) return null;
    const days = o.payment_days ?? defaultDays();
    if (days < 0) return null;
    const account = db.prepare('SELECT id FROM fin_accounts WHERE name = ?').get(RECEIVABLE_ACCOUNT);
    if (!account) return null;
    const info = db.prepare(`INSERT OR IGNORE INTO fin_entries (account_id, description, amount_cents, competence_date, due_date,
      counterparty, document, note, created_by, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Sistema', ?)`).run(
      account.id, `Pedido #${o.id}`, o.total_cents, delivered, dueDate(delivered, days),
      o.nome_fantasia || o.razao_social, `Pedido #${o.id}`, days ? `Prazo ${days} dias + 1 dia útil` : 'À vista', o.id,
    );
    return info.changes ? Number(info.lastInsertRowid) : null;
  }

  return { onDelivered, defaultDays };
}

module.exports = { createReceivables, nextBusinessDay, dueDate, RECEIVABLE_ACCOUNT };

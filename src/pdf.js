'use strict';

// PDF do pedido para o cliente (e para a loja): dados do cliente, itens, total e observações.
// Documento de conferência, sem valor fiscal.

const PDFDocument = require('pdfkit');
const T = require('./time');
const U = require('./util');

const BRAND = '#d6195b';
const MUTED = '#6e6578';
const LINE = '#e7e1ea';
const brl = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const STATUS = { novo: 'Recebido', confirmado: 'Confirmado', separado: 'Separado', entregue: 'Entregue', cancelado: 'Cancelado' };
// data/hora do banco (UTC) no fuso da loja
const localDateTime = (utc) => {
  const d = new Date(`${String(utc).replace(' ', 'T')}Z`);
  return d.toLocaleString('pt-BR', { timeZone: T.TZ_NAME, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const br = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');

function orderPdf(order, settings = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Pedido ${order.id}`, Author: settings.store_name || 'Oggi Sorvetes' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = 40;
    const width = doc.page.width - 80;

    // cabeçalho
    doc.rect(0, 0, doc.page.width, 78).fill(BRAND);
    doc.fill('#fff').font('Helvetica-Bold').fontSize(20).text(settings.store_name || 'Oggi Sorvetes', left, 22);
    doc.font('Helvetica').fontSize(10).text(settings.store_subtitle || 'Pedidos para empresas', left, 48);
    doc.font('Helvetica-Bold').fontSize(16).text(`Pedido #${order.id}`, left, 24, { width, align: 'right' });
    doc.font('Helvetica').fontSize(10).text(localDateTime(order.created_at), left, 48, { width, align: 'right' });

    // cliente e pedido
    let y = 100;
    doc.fill('#22182a').font('Helvetica-Bold').fontSize(11).text('Cliente', left, y);
    doc.text('Pedido', left + width / 2 + 10, y);
    doc.font('Helvetica').fontSize(10);
    const cust = [
      order.razao_social,
      order.nome_fantasia && order.nome_fantasia !== order.razao_social ? order.nome_fantasia : null,
      `${U.docLabel(order.cnpj)} ${U.formatDoc(order.cnpj)}`,
      [order.contato, order.telefone].filter(Boolean).join(' · ') || null,
      [order.endereco, order.cidade].filter(Boolean).join(' - ') || null,
    ].filter(Boolean);
    doc.text(cust.join('\n'), left, y + 16, { width: width / 2 - 10 });
    const info = [
      `Situação: ${STATUS[order.status] || order.status}`,
      order.delivery_date ? `Entrega desejada: ${br(order.delivery_date)}` : null,
      `Itens: ${order.items.length}`,
    ].filter(Boolean);
    doc.text(info.join('\n'), left + width / 2 + 10, y + 16, { width: width / 2 - 10 });
    y = Math.max(doc.y, y + 16 + cust.length * 13) + 18;

    // itens
    const cols = [
      { label: 'Produto', w: width * 0.44, align: 'left' },
      { label: 'Embalagem', w: width * 0.17, align: 'left' },
      { label: 'Qtd', w: width * 0.09, align: 'right' },
      { label: 'Preço', w: width * 0.14, align: 'right' },
      { label: 'Subtotal', w: width * 0.16, align: 'right' },
    ];
    const row = (cells, opts = {}) => {
      let x = left;
      const h = Math.max(...cells.map((c, i) => doc.heightOfString(String(c), { width: cols[i].w - 8 }))) + 10;
      if (y + h > doc.page.height - 90) { doc.addPage(); y = 40; }
      if (opts.head) doc.rect(left, y, width, h).fill('#faf8fb');
      doc.fill(opts.head ? MUTED : '#22182a').font(opts.head ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.head ? 9 : 10);
      cells.forEach((c, i) => { doc.text(String(c), x + 4, y + 5, { width: cols[i].w - 8, align: cols[i].align }); x += cols[i].w; });
      y += h;
      doc.moveTo(left, y).lineTo(left + width, y).strokeColor(LINE).lineWidth(1).stroke();
    };
    row(cols.map((c) => c.label), { head: true });
    for (const it of order.items) {
      row([
        it.product_name,
        it.unit_type === 'caixa' ? `Caixa c/ ${it.units_per_box} un` : 'Unidade',
        it.quantity,
        brl(it.price_cents),
        brl(it.subtotal_cents),
      ]);
    }
    y += 10;
    doc.fill('#22182a').font('Helvetica-Bold').fontSize(13).text(`Total: ${brl(order.total_cents)}`, left, y, { width, align: 'right' });
    y = doc.y + 16;

    if (order.notes) {
      doc.font('Helvetica-Bold').fontSize(10).text('Observações do cliente', left, y);
      doc.font('Helvetica').text(order.notes, left, doc.y + 2, { width });
      y = doc.y + 12;
    }
    doc.fill(MUTED).font('Helvetica').fontSize(9).text(
      'Disponibilidade e valores sujeitos à confirmação da loja. Documento de conferência, sem valor fiscal.'
        + (settings.whatsapp ? ` Dúvidas: WhatsApp ${settings.whatsapp}.` : ''),
      left, y, { width },
    );
    doc.end();
  });
}

module.exports = { orderPdf };

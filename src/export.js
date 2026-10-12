'use strict';

// Exporta um relatório (formato de reports.js) para .xlsx (uma aba por seção) ou .csv.

const ExcelJS = require('exceljs');

const MONEY_FMT = '"R$" #,##0.00;[Red]-"R$" #,##0.00';

function cellValue(col, row) {
  const v = row[col.key];
  if (v === null || v === undefined) return null;
  if (col.type === 'money' || col.type === 'unitcost') return v / 100;
  return v;
}

const brNumber = (n, decimals = 2) => n.toFixed(decimals).replace('.', ',');

function csvValue(col, row) {
  const v = row[col.key];
  if (v === null || v === undefined) return '';
  if (col.type === 'money') return brNumber(v / 100);
  if (col.type === 'unitcost') return brNumber(v / 100, 4);
  if (col.type === 'pct') return brNumber(v * 100, 1) + '%';
  return String(v);
}

async function exportReport(report, format, baseName) {
  if (format === 'csv') {
    const esc = (s) => (/[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [esc(report.title), esc(report.subtitle || '')];
    for (const w of report.warnings || []) lines.push(esc(`Atenção: ${w}`));
    for (const sec of report.sections) {
      lines.push('', esc(sec.title));
      lines.push(sec.columns.map((c) => esc(c.label)).join(';'));
      for (const r of sec.rows) lines.push(sec.columns.map((c) => esc(csvValue(c, r))).join(';'));
      if (sec.total) lines.push(sec.columns.map((c, i) => esc(i === 0 ? 'Total' : csvValue(c, sec.total))).join(';'));
    }
    return { buffer: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), filename: `${baseName}.csv`, type: 'text/csv' };
  }

  const wb = new ExcelJS.Workbook();
  const used = new Set();
  for (const sec of report.sections) {
    let name = sec.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Dados';
    for (let i = 2; used.has(name); i++) name = `${name.slice(0, 28)} ${i}`;
    used.add(name);
    const ws = wb.addWorksheet(name);
    ws.addRow([report.title]).font = { bold: true, size: 13 };
    ws.addRow([report.subtitle || '']);
    for (const w of report.warnings || []) ws.addRow([`Atenção: ${w}`]).font = { color: { argb: 'FFC62828' } };
    ws.addRow([sec.title]).font = { bold: true };
    const header = ws.addRow(sec.columns.map((c) => c.label));
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6195B' } };
    const addData = (row, bold) => {
      const r = ws.addRow(sec.columns.map((c) => cellValue(c, row)));
      sec.columns.forEach((c, i) => {
        const cell = r.getCell(i + 1);
        if (c.type === 'money') cell.numFmt = MONEY_FMT;
        if (c.type === 'unitcost') cell.numFmt = '"R$" #,##0.0000';
        if (c.type === 'pct') cell.numFmt = '0.0%';
      });
      if (bold) r.font = { bold: true };
      if (row._class === 'danger') r.font = { bold: true, color: { argb: 'FFC62828' } };
    };
    for (const row of sec.rows) addData(row, false);
    if (sec.total) addData({ ...sec.total, [sec.columns[0].key]: 'Total' }, true);
    sec.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.type === 'text' ? 34 : 16; });
  }
  return {
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
    filename: `${baseName}.xlsx`,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

module.exports = { exportReport };

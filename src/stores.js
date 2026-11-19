'use strict';

// Cadastro das lojas (a "ficha" de cada unidade): dados do negócio + ligações com CPlug, Rede e Itaú.
// É a base para a DRE por loja, o retorno do investimento e para abrir as próximas lojas sem programação.

const { BusinessError } = require('./inventory');
const U = require('./util');
const T = require('./time');

const STATUSES = ['planejada', 'obras', 'ativa', 'fechada'];
const digits = (x) => String(x || '').replace(/\D/g, '');

function createStores(db, accounts) {
  const cplugStores = () => db.prepare("SELECT id, external_id, name, cnpj, location_id FROM int_stores WHERE source = 'cplug' ORDER BY name").all();

  function list({ all = false } = {}) {
    const locs = db.prepare(`SELECT * FROM locations WHERE kind = 'loja' ${all ? '' : 'AND active = 1'} ORDER BY COALESCE(opened_at, '9999'), name`).all();
    return locs.map((l) => {
      const cplug = db.prepare("SELECT id, name, external_id FROM int_stores WHERE source = 'cplug' AND location_id = ?").get(l.id) || null;
      const pvs = db.prepare("SELECT external_id FROM int_stores WHERE source = 'rede' AND location_id = ? ORDER BY external_id").all(l.id).map((r) => r.external_id);
      const cash = accounts ? accounts.cashOf(l.id) : null;
      const months = l.opened_at && T.isDate(l.opened_at) ? Math.max(0, monthsBetween(l.opened_at, T.localDate())) : null;
      return {
        ...l, cplug, pvs, cash_account: cash ? cash.name : null, months_open: months,
        royalty_pct: l.royalty_bp === null || l.royalty_bp === undefined ? null : l.royalty_bp / 100,
        marketing_pct: l.marketing_bp === null || l.marketing_bp === undefined ? null : l.marketing_bp / 100,
        missing: missingFields(l, cplug, pvs),
      };
    });
  }

  function monthsBetween(a, b) {
    const [ya, ma, da] = a.split('-').map(Number); const [yb, mb, dbb] = b.split('-').map(Number);
    return (yb - ya) * 12 + (mb - ma) - (dbb < da ? 1 : 0);
  }

  function missingFields(l, cplug, pvs) {
    const m = [];
    if (!l.opened_at) m.push('inauguração');
    if (!l.area_m2) m.push('m²');
    if (l.rent_cents === null || l.rent_cents === undefined) m.push('aluguel');
    if (l.capex_cents === null || l.capex_cents === undefined) m.push('investimento');
    if (l.royalty_bp === null || l.royalty_bp === undefined) m.push('royalties');
    if (!cplug) m.push('loja do CPlug');
    if (!pvs.length) m.push('PV da Rede');
    if (!l.itau_account) m.push('conta Itaú');
    return m;
  }

  const money = (v) => {
    if (v === null || v === undefined || v === '') return null;
    let t = String(v).replace(/[R$\s]/g, '');
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); // "1.234,56" → "1234.56"
    const n = typeof v === 'number' ? v : Number(t);
    if (!Number.isFinite(n) || n < 0) throw new BusinessError('Valor inválido.');
    return Math.round(n * 100);
  };
  const pctBp = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.').replace('%', ''));
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new BusinessError('Percentual inválido.');
    return Math.round(n * 100);
  };
  const dateOrNull = (v) => {
    if (!v) return null;
    if (!T.isDate(String(v))) throw new BusinessError('Data inválida.');
    return String(v);
  };

  // Grava os dados da loja e as ligações. b = campos do formulário (valores em reais e %).
  const save = db.transaction((id, b, { create = false } = {}) => {
    const name = U.cleanText(b.name, 80);
    if (create && !name) throw new BusinessError('Informe o nome da loja.');
    let loc;
    if (create) {
      if (db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name)) throw new BusinessError('Já existe uma loja com esse nome.');
      const info = db.prepare("INSERT INTO locations (name, kind, description) VALUES (?, 'loja', ?)").run(name, U.cleanText(b.description, 200));
      loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(Number(info.lastInsertRowid));
      if (accounts) accounts.ensureCash(loc);
    } else {
      loc = db.prepare("SELECT * FROM locations WHERE id = ? AND kind = 'loja'").get(Number(id));
      if (!loc) throw new BusinessError('Loja não encontrada.', 404);
      if (name && name !== loc.name && db.prepare('SELECT 1 FROM locations WHERE name = ? AND id <> ?').get(name, loc.id)) throw new BusinessError('Já existe uma loja com esse nome.');
    }
    const status = b.status === undefined ? (loc.status || 'ativa') : String(b.status);
    if (!STATUSES.includes(status)) throw new BusinessError('Situação inválida.');
    const cnpj = b.cnpj === undefined ? loc.cnpj : (digits(b.cnpj) || null);
    if (cnpj && !U.isValidDoc(cnpj)) throw new BusinessError('CNPJ inválido.');
    const pick = (k, conv) => (b[k] === undefined ? loc[k === 'royalty_pct' ? 'royalty_bp' : k === 'marketing_pct' ? 'marketing_bp' : k] : conv(b[k]));
    db.prepare(`UPDATE locations SET name = ?, description = ?, cnpj = ?, address = ?, status = ?, opened_at = ?, closed_at = ?, area_m2 = ?,
      rent_cents = ?, capex_cents = ?, royalty_bp = ?, marketing_bp = ?, itau_account = ?, notes = ?, active = ? WHERE id = ?`).run(
      name || loc.name,
      b.description === undefined ? loc.description : U.cleanText(b.description, 200),
      cnpj,
      b.address === undefined ? loc.address : U.cleanText(b.address, 200),
      status,
      b.opened_at === undefined ? loc.opened_at : dateOrNull(b.opened_at),
      b.closed_at === undefined ? loc.closed_at : dateOrNull(b.closed_at),
      b.area_m2 === undefined ? loc.area_m2 : (b.area_m2 === '' || b.area_m2 === null ? null : Number(String(b.area_m2).replace(',', '.')) || null),
      pick('rent_cents', money),
      pick('capex_cents', money),
      pick('royalty_pct', pctBp),
      pick('marketing_pct', pctBp),
      b.itau_account === undefined ? loc.itau_account : (U.cleanText(b.itau_account, 30) || null),
      b.notes === undefined ? loc.notes : U.cleanText(b.notes, 1000),
      status === 'fechada' ? 0 : 1,
      loc.id,
    );
    // Ligação com o CPlug (uma loja do CPlug por loja nossa)
    if (b.cplug_store_id !== undefined) {
      db.prepare("UPDATE int_stores SET location_id = NULL WHERE source = 'cplug' AND location_id = ?").run(loc.id);
      if (b.cplug_store_id) {
        const s = db.prepare("SELECT * FROM int_stores WHERE id = ? AND source = 'cplug'").get(Number(b.cplug_store_id));
        if (!s) throw new BusinessError('Loja do CPlug não encontrada.');
        if (s.location_id && s.location_id !== loc.id) throw new BusinessError('Essa loja do CPlug já está ligada a outra loja.');
        db.prepare('UPDATE int_stores SET location_id = ? WHERE id = ?').run(loc.id, s.id);
      }
    }
    // PVs da Rede (um ou mais)
    if (b.pvs !== undefined) {
      const pvs = [...new Set(String(Array.isArray(b.pvs) ? b.pvs.join(',') : b.pvs || '').split(/[,;\s]+/).map(digits).filter(Boolean))];
      for (const pv of pvs) {
        const other = db.prepare("SELECT location_id FROM int_stores WHERE source = 'rede' AND external_id = ?").get(pv);
        if (other && other.location_id && other.location_id !== loc.id) throw new BusinessError(`O PV ${pv} já está ligado a outra loja.`);
      }
      db.prepare("UPDATE int_stores SET location_id = NULL WHERE source = 'rede' AND location_id = ?").run(loc.id);
      for (const pv of pvs) {
        db.prepare(`INSERT INTO int_stores (source, external_id, name, cnpj, location_id) VALUES ('rede', ?, ?, ?, ?)
          ON CONFLICT(source, external_id) DO UPDATE SET location_id = excluded.location_id`).run(pv, `Rede PV ${pv}`, cnpj, loc.id);
      }
    }
    return list({ all: true }).find((x) => x.id === loc.id);
  });

  return { list, save, cplugStores, STATUSES };
}

module.exports = { createStores, STATUSES };

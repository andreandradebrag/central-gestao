'use strict';
/* v164 (relatorios/feito_v164.md): saldo por lote e FEFO. O MESMO arquivo roda no servidor (ajuste164.js) e no navegador
   (patch146.py embute este texto em new_v164.js como V164L), para as duas contas darem igual.
   Movimento de produto com lote: lotes:[{lote,qtd,val,fab}] (qtd sem sinal na entrada, saída e transferência; com sinal no
   ajuste). Movimento sem lotes (o saldo de antes da v164) conta no lote "SEM-LOTE", sem validade: nenhuma quantidade muda.
   Estorno sem lotes usa os lotes do original (o sinal da quantidade do estorno desfaz). Local: almoxId do movimento, senão o
   almoxarifado padrão do produto; transferência tira do almoxId e põe no almoxDest com o mesmo lote e validade. */
const SEM = 'SEM-LOTE';
function calc(movs, prod, orig) {
  const pa = (prod && prod.almoxId) || '', out = new Map();
  const g = (alm, lote) => { const k = alm + '|' + lote; let o = out.get(k); if (!o) { o = { alm, lote, qtd: 0, val: '', fab: '', ent: [], sai: [], sem: lote === SEM }; out.set(k, o); } return o; };
  for (const m of movs) {
    if (!m) continue;
    const q = +m.qtd || 0;
    let ls = Array.isArray(m.lotes) && m.lotes.length ? m.lotes : null;
    if (!ls && m.estornoDe && orig) { const o = orig(m.estornoDe); if (o && Array.isArray(o.lotes) && o.lotes.length) ls = o.tipo === 'ajuste' ? o.lotes.map(x => Object.assign({}, x, { qtd: -(+x.qtd || 0) })) : o.lotes; }
    if (!ls) { if (!q) continue; ls = [{ lote: SEM, qtd: m.tipo === 'ajuste' ? q : Math.abs(q) }]; }
    const sg = m.tipo === 'ajuste' ? 1 : (q < 0 ? -1 : 1), loc = m.almoxId || pa;
    for (const l of ls) {
      const lq = (+l.qtd || 0) * sg, lote = String((l && l.lote) || SEM);
      if (m.tipo === 'transf') { const a = g(m.almoxId || pa, lote), b = g(m.almoxDest || '', lote); a.qtd -= lq; b.qtd += lq; if (l.val && !b.val) b.val = l.val; if (l.fab && !b.fab) b.fab = l.fab; a.sai.push(m.id); b.ent.push(m.id); continue; }
      const o = g(loc, lote);
      if (m.tipo === 'entrada') { o.qtd += lq; o.ent.push(m.id); }
      else if (m.tipo === 'saida') { o.qtd -= lq; o.sai.push(m.id); }
      else { o.qtd += lq; (lq >= 0 ? o.ent : o.sai).push(m.id); }
      if (l.val && !o.val && lq > 0) o.val = l.val;
      if (l.fab && !o.fab && lq > 0) o.fab = l.fab;
    }
  }
  for (const o of out.values()) o.qtd = Math.round(o.qtd * 10000) / 10000;
  return out;
}
/* FEFO: o lote que vence primeiro sai primeiro; vencido só quando vencidoOk (perda/descarte); SEM-LOTE e sem validade por último */
function fefo(saldos, alm, qtd, hoje, vencidoOk) {
  const ls = [...saldos.values()].filter(o => o.alm === (alm || '') && o.qtd > 1e-9 && (vencidoOk || !o.val || o.val >= hoje))
    .sort((a, b) => (a.sem - b.sem) || ((a.val ? 0 : 1) - (b.val ? 0 : 1)) || String(a.val).localeCompare(String(b.val)) || String(a.lote).localeCompare(String(b.lote)));
  let r = +qtd || 0; const alloc = [];
  for (const o of ls) { if (r <= 1e-9) break; const t = Math.min(r, o.qtd); alloc.push({ lote: o.lote, qtd: Math.round(t * 10000) / 10000, val: o.val || '' }); r -= t; }
  return { alloc, falta: Math.round(Math.max(0, r) * 10000) / 10000 };
}
/* validade calculada: dFab (ou a data da entrada) + dias de validade do produto */
function valCalc(prod, fab, data) {
  const d = +(prod && prod.diasValLote) || 0, b = String(fab || data || '').slice(0, 10);
  if (!(d > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return '';
  return new Date(Date.parse(b + 'T12:00:00Z') + d * 864e5).toISOString().slice(0, 10);
}
module.exports = { SEM, calc, fefo, valCalc };

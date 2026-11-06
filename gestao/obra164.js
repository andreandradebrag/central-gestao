'use strict';
/* v164 (relatorios/feito_v164.md): "Material na obra" — razão de material por obra, montado dos registros que já existem.
   O MESMO arquivo roda no servidor (ajuste164.js: encerramento da obra e GET /api/obra164/razao) e no navegador (patch146.py
   embute este texto em new_v164.js como V164O).
   Entra na obra: saída do estoque para a obra por separação ou romaneio (sepId/romId), recebimento direto na obra (rec164) e
   transferência vinda de outra obra (saída com mob164). Sai da obra: devolução de sobras ao almoxarifado (entrada com
   devObra/devObraId, a devolução ainda em conferência e o avariado que foi para a quarentena), transferência para outra obra (entrada com mob164), consumo
   declarado, descarte/perda na obra e devolução ao fornecedor (registros mob164). Estorno conta como o original, com o sinal
   trocado. Custo unitário de cada item = média ponderada das entradas na obra (o custo de cada envio). */
function classe(m, orig) {
  if (!m) return '';
  const o = m.estornoDe && orig ? orig(m.estornoDe) || m : m;
  if (o.tipo === 'saida' && o.mob164) return 'tin';
  if (o.tipo === 'entrada' && o.mob164) return 'tout';
  if (o.tipo === 'saida' && (o.sepId || o.romId || o.rec164)) return 'env';
  if (o.tipo === 'entrada' && (o.devObra || o.devObraId)) return 'dev';
  return '';
}
const SAI_MOB = { consumo: 'cons', descarte: 'desc', devforn: 'dforn', faltarom: 'falta' }; /* faltarom: faltou no recebimento do romaneio na obra */
/* movs: movimentos com projId da obra; devs: devoluções de sobras (devobra); mobs: registros mob164; custo(m): custo unitário */
function razao(projId, movs, devs, mobs, custo, orig) {
  const P = String(projId || ''), by = new Map();
  const g = pid => { let o = by.get(pid); if (!o) { o = { prodId: pid, env: 0, tin: 0, dev: 0, devPend: 0, quar: 0, tout: 0, cons: 0, desc: 0, dforn: 0, falta: 0, vEnt: 0, qEnt: 0, saldo: 0, cu: 0, envios: [], saidas: [] }; by.set(pid, o); } return o; };
  for (const m of movs || []) {
    if (!m || !m.prodId || String(m.projId || '') !== P) continue;
    const c = classe(m, orig); if (!c) continue;
    const o = g(m.prodId), q = +m.qtd || 0, cu = +(custo ? custo(m) : m.custoUnit) || 0;
    o[c] += q;
    if (c === 'env' || c === 'tin') { o.vEnt += q * cu; o.qEnt += q; o.envios.push({ movId: m.id, data: m.data || '', tipo: c, qtd: q, cu, sepId: m.sepId || '', romId: m.romId || '', rec164: m.rec164 || '', mob164: m.mob164 || '', pedId: m.pedId || '' }); }
    else o.saidas.push({ movId: m.id, data: m.data || '', tipo: c, qtd: q, cu, devObraId: m.devObraId || '', mob164: m.mob164 || '' });
  }
  for (const d of devs || []) {
    if (!d || String(d.projId || '') !== P || d.status === 'cancelado') continue;
    if (d.status === 'enviado') { for (const i of d.itens || []) if (i && i.prodId) g(i.prodId).devPend += +i.qtd || 0; continue; }
    /* recebida: o avariado em quarentena (ou aguardando a devolução ao fornecedor) já saiu da obra sem entrar no estoque */
    for (const i of d.itens || []) if (i && i.prodId && i.quar && (i.quar.st === 'quarentena' || i.quar.st === 'devforn')) g(i.prodId).quar += +i.quar.qtd || 0;
  }
  for (const x of mobs || []) {
    if (!x || x.cancelado) continue; const k = SAI_MOB[x.tipo]; if (!k || String(x.projId || '') !== P) continue;
    for (const i of x.itens || []) if (i && i.prodId) { const o = g(i.prodId); o[k] += +i.qtd || 0; o.saidas.push({ mob: x.id, data: x.data || '', tipo: k, qtd: +i.qtd || 0, cu: +i.cu || 0 }); }
  }
  const r4 = v => Math.round((+v || 0) * 10000) / 10000;
  for (const o of by.values()) {
    o.cu = o.qEnt > 1e-9 ? r4(o.vEnt / o.qEnt) : 0;
    o.saldo = r4(o.env + o.tin - o.dev - o.devPend - o.quar - o.tout - o.cons - o.desc - o.dforn - o.falta);
    ['env', 'tin', 'dev', 'devPend', 'quar', 'tout', 'cons', 'desc', 'dforn', 'falta'].forEach(k => { o[k] = r4(o[k]); });
    o.valor = Math.round(Math.max(0, o.saldo) * o.cu * 100) / 100;
  }
  return [...by.values()];
}
/* custo de cada movimento de um produto (a mesma conta do custo médio do navegador, stockAll) */
const wMov = t => t === 'entrada' ? 0 : t === 'ajuste' ? 1 : 2;
function custos(list) {
  const ls = list.slice().sort((a, b) => String(a.data).localeCompare(String(b.data)) || wMov(a.tipo) - wMov(b.tipo) || (a.ts || 0) - (b.ts || 0));
  let q = 0, c = 0; const out = new Map();
  for (const m of ls) {
    const mq = +m.qtd || 0;
    if (m.tipo === 'entrada') { const cu = +m.custoUnit || 0, nq = q + mq; c = q > 0 ? (nq > 1e-9 ? (q * c + mq * cu) / nq : c) : cu; q = nq; out.set(m.id, cu); }
    else if (m.tipo === 'saida') { if ((m.devFor || m.estornoDe || m.rec164 || m.mob164 || m.quar164) && +m.custoUnit > 0) { const cu = +m.custoUnit, nq = q - mq; out.set(m.id, cu); c = nq > 1e-9 ? Math.max(0, (q * c - mq * cu) / nq) : c; q = nq; } else { out.set(m.id, c); q -= mq; } }
    else if (m.tipo === 'transf') out.set(m.id, c); else { out.set(m.id, c); q += mq; }
  }
  return out;
}
module.exports = { classe, razao, custos };

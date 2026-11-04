/* v149 (relatorios/feito_v149_negoc.md): histórico de negociação de preços no mapa de cotação, garantido pelo servidor.
   Ligado em regras.js (antesGravar de cot/<id> e ped/<id>; antesExcluir de cot/<id>). Funções:
   1. cot: o histórico (lista negHist) só cresce. O que já está guardado fica como está (entrada removida volta, entrada
      alterada volta ao original: "recompõe", com auditoria COT_HIST_RECOMPOSTO). Entradas novas recebem quem gravou
      (por = conta) e srvEm. Preço ou frete que já têm histórico só mudam com rodada nova (senão 409). Rodada em que preço
      ou frete SOBE, correção de digitação e reabertura exigem observação (400). O "de" de cada rodada é recalculado aqui.
      Célula com preço e sem histórico ganha a proposta inicial (mapa de antes da v149 = "legado").
      Mapa fechado (pedidos gerados) não aceita rodada nem mudança de preço; volta para aberta só com entrada de
      reabertura com motivo e com os pedidos gerados cancelados (409).
   2. ped: pedido gerado da cotação guarda por item a proposta inicial (vIni), as rodadas (negRod), a última rodada
      (negRef/negPor) e o frete inicial (freteIni), sempre tirados da cotação gravada (o que o navegador mandar não vale).
   3. excluir cot com rodada ou reabertura: recusado (409); use Cancelar. */
'use strict';
const TIPOS = new Set(['inicial', 'inicialF', 'rodada', 'correcao', 'reabertura']);
const CAMPOS = ['frete', 'prazo', 'pgto'];
const num = v => v === '' || v == null || !isFinite(+v) ? null : +v;
const vazio = v => v === '' || v == null;
const H = d => Array.isArray(d && d.negHist) ? d.negHist : [];
const ehRod = e => !!e && (e.tipo === 'rodada' || e.tipo === 'correcao');
const r4 = v => Math.round((+v || 0) * 10000) / 10000;
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

/* valores correntes a partir do histórico, na ordem gravada */
function estado(hist) {
  const cel = new Map(), cnd = new Map(), ini = new Map(), iniF = new Map(), rods = new Map();
  for (const e of hist) {
    if (!e || !e.parcId && e.tipo !== 'reabertura') continue;
    if (e.tipo === 'inicial') { const k = e.parcId + '|' + e.k; if (!ini.has(k)) ini.set(k, e); cel.set(k, +e.preco); }
    else if (e.tipo === 'inicialF') { const k = e.parcId + '|' + e.campo; if (!iniF.has(k)) iniF.set(k, e); cnd.set(k, e.valor); }
    else if (ehRod(e)) {
      (rods.get(e.parcId) || rods.set(e.parcId, []).get(e.parcId)).push(e);
      (e.itens || []).forEach(x => { if (x && num(x.para) != null) cel.set(e.parcId + '|' + x.k, +x.para); });
      Object.keys(e.cond || {}).forEach(c => { const x = e.cond[c]; if (x) cnd.set(e.parcId + '|' + c, x.para); });
    }
  }
  return { cel, cnd, ini, iniF, rods };
}
/* células (fornecedor|item) → preço de um documento de cotação */
function celulas(d) {
  const m = new Map(), itens = Array.isArray(d && d.itens) ? d.itens : [], forn = Array.isArray(d && d.forn) ? d.forn : [], pr = Array.isArray(d && d.precos) ? d.precos : [];
  forn.forEach((f, j) => { if (!f || !f.parcId) return; itens.forEach((it, i) => { if (!it || !it.k) return; const p = num((pr[j] || [])[i]); if (p != null && p > 0) m.set(f.parcId + '|' + it.k, { p, desc: it.desc || '', parcId: f.parcId }); }); });
  return m;
}
/* assinatura do conteúdo de uma entrada (sem o que o próprio servidor carimba: quem, quando, "de" e correção do legado) */
const sig = e => JSON.stringify([e.tipo, e.parcId || '', e.k || '', e.campo || '', ehRod(e) ? (e.itens || []).map(x => [x && x.k, num(x && x.para)]) : 0, ehRod(e) ? Object.keys(e.cond || {}).sort().map(k => [k, e.cond[k] && e.cond[k].para]) : 0, String(e.obs || '').trim(), e.anexo && e.anexo.id || '']);
const fornDe = d => new Map((Array.isArray(d && d.forn) ? d.forn : []).filter(f => f && f.parcId).map(f => [f.parcId, f]));

module.exports = function (X) {
  const { doc, erro, igual } = X;
  const auditar = (...a) => { try { if (typeof X.auditar === 'function') X.auditar(...a); } catch (e) { } };

  function limpa(e, conta, agora) {
    const o = { id: str(e.id, 100), tipo: e.tipo, em: num(e.em) != null && +e.em > 0 && +e.em < agora + 600e3 ? +e.em : agora, por: conta ? conta.id : '', srvEm: agora };
    if (e.tipo !== 'reabertura') o.parcId = str(e.parcId, 80);
    if (e.tipo === 'inicial') { o.k = str(e.k, 80); o.preco = r4(e.preco); o.origem = str(e.origem || 'digitado', 30); if (e.legado) o.legado = true; }
    else if (e.tipo === 'inicialF') { o.campo = e.campo; o.valor = e.campo === 'pgto' ? str(e.valor, 120) : num(e.valor); o.origem = str(e.origem || 'digitado', 30); if (e.legado) o.legado = true; }
    else if (ehRod(e)) {
      o.n = Math.max(1, Math.round(+e.n || 1)); o.canal = str(e.canal, 30); o.obs = str(e.obs, 1000).trim(); if (e.auto) o.auto = true;
      o.itens = (Array.isArray(e.itens) ? e.itens : []).slice(0, 500).filter(x => x && typeof x.k === 'string').map(x => ({ k: str(x.k, 80), de: num(x.de), para: num(x.para) }));
      o.cond = {}; const c = e.cond && typeof e.cond === 'object' ? e.cond : {}; CAMPOS.forEach(k => { const x = c[k]; if (x && typeof x === 'object') o.cond[k] = { de: k === 'pgto' ? str(x.de, 120) : num(x.de), para: k === 'pgto' ? str(x.para, 120) : num(x.para) }; });
      o.totDe = num(e.totDe); o.totPara = num(e.totPara);
      if (e.anexo && typeof e.anexo === 'object' && typeof e.anexo.id === 'string') o.anexo = { id: str(e.anexo.id, 64), nome: str(e.anexo.nome, 120), ct: str(e.anexo.ct, 80), tam: +e.anexo.tam || 0 };
    } else if (e.tipo === 'reabertura') { o.obs = str(e.obs, 1000).trim(); o.pedIds = (Array.isArray(e.pedIds) ? e.pedIds : []).slice(0, 50).map(x => str(x, 80)); }
    return o;
  }

  function cot(conta, req, p, velho, novo) {
    const agora = Date.now(), old = H(velho), oldIds = new Map(old.filter(e => e && e.id).map(e => [e.id, e]));
    const veio = Array.isArray(novo.negHist) ? novo.negHist : [];
    let recompos = old.some(o => o && o.id && !veio.some(e => e && e.id === o.id));
    const novos = [];
    for (const e of veio) {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || e.id.length > 100) continue;
      const o = oldIds.get(e.id); if (o) { if (sig(o) !== sig(e)) recompos = true; continue; }
      if (!TIPOS.has(e.tipo) || novos.some(x => x.id === e.id)) continue;
      novos.push(limpa(e, conta, agora));
    }
    const merged = old.slice(), velC = celulas(velho), novC = celulas(novo), velF = fornDe(velho), novF = fornDe(novo);
    /* aplica as entradas novas em ordem, conferindo cada uma */
    let st = estado(merged);
    for (const e of novos) {
      if (e.tipo === 'inicial') {
        const key = e.parcId + '|' + e.k; if (!e.parcId || !e.k || st.cel.has(key)) continue; /* já tem proposta inicial: ignora */
        const v = velC.get(key), nv = novC.get(key);
        if (v && Math.abs(v.p - e.preco) > 1e-6) { e.preco = v.p; e.legado = true; e.origem = 'legado'; } /* mapa antigo: vale o preço guardado */
        else if (!v && nv && Math.abs(nv.p - e.preco) > 1e-6 && !novos.some(x => ehRod(x) && x.parcId === e.parcId && (x.itens || []).some(y => y.k === e.k))) e.preco = nv.p;
        if (!(e.preco > 0)) continue;
      } else if (e.tipo === 'inicialF') {
        if (!CAMPOS.includes(e.campo) || st.cnd.has(e.parcId + '|' + e.campo)) continue;
        const vf = velF.get(e.parcId); if (vf && !vazio(vf[e.campo]) && String(vf[e.campo]) !== String(e.valor)) { e.valor = e.campo === 'pgto' ? str(vf[e.campo], 120) : num(vf[e.campo]); e.legado = true; e.origem = 'legado'; }
      } else if (ehRod(e)) {
        let sobe = false;
        for (const x of e.itens) {
          if (!(x.para > 0)) return erro('Rodada de negociação com preço inválido (use valor maior que zero).', 400);
          const ant = st.cel.get(e.parcId + '|' + x.k); x.de = ant == null ? null : ant; if (ant != null && x.para > ant + 1e-6) sobe = true;
        }
        for (const k of Object.keys(e.cond)) {
          const x = e.cond[k]; if (k !== 'pgto' && (x.para == null || x.para < 0)) return erro('Rodada de negociação com ' + k + ' inválido.', 400);
          const ant = st.cnd.has(e.parcId + '|' + k) ? st.cnd.get(e.parcId + '|' + k) : (velF.get(e.parcId) || {})[k];
          x.de = vazio(ant) ? '' : (k === 'pgto' ? str(ant, 120) : num(ant)); if (k === 'frete' && x.para > (num(ant) || 0) + 1e-6) sobe = true;
        }
        if (e.tipo === 'correcao' && e.obs.length < 3) return erro('Correção de digitação no mapa de cotação: a observação é obrigatória.', 400);
        if (sobe && e.obs.length < 3) return erro('Na negociação o preço subiu em relação ao valor anterior: a observação é obrigatória.', 400);
        if (!e.itens.length && !Object.keys(e.cond).length && e.obs.length < 3) continue;
      } else if (e.tipo === 'reabertura') {
        if (e.obs.length < 3) return erro('Para reabrir o mapa de cotação, informe o motivo.', 400);
      }
      merged.push(e); st = estado(merged);
    }
    /* célula com preço e sem histórico: o servidor registra a proposta inicial (cliente antigo ou mapa de antes da v149) */
    for (const [key, x] of novC) {
      if (st.cel.has(key)) continue; const [parcId, k] = key.split('|'), v = velC.get(key);
      merged.push({ id: 'ini_' + parcId + '_' + k, tipo: 'inicial', parcId, k, preco: v ? v.p : x.p, origem: v ? 'legado' : 'servidor', legado: v ? true : undefined, em: agora, por: conta ? conta.id : '', srvEm: agora });
    }
    for (const [parcId, f] of novF) CAMPOS.forEach(c => {
      if (vazio(f[c]) || st.cnd.has(parcId + '|' + c) || merged.some(e => e.tipo === 'inicialF' && e.parcId === parcId && e.campo === c)) return;
      const vf = velF.get(parcId), v = vf && !vazio(vf[c]) ? vf[c] : f[c];
      merged.push({ id: 'inif_' + parcId + '_' + c, tipo: 'inicialF', parcId, campo: c, valor: c === 'pgto' ? str(v, 120) : num(v), origem: vf && !vazio(vf[c]) ? 'legado' : 'servidor', legado: vf && !vazio(vf[c]) ? true : undefined, em: agora, por: conta ? conta.id : '', srvEm: agora });
    });
    merged.forEach(e => { if (e && e.legado === undefined) delete e.legado; });
    st = estado(merged);
    /* preço ou frete com histórico só mudam com rodada */
    for (const [key, x] of novC) {
      const ult = st.cel.get(key);
      if (ult != null && Math.abs(ult - x.p) > 1e-6) return erro('O preço de “' + str(x.desc, 80) + '” já foi registrado na cotação: mude pelo botão Negociar (a mudança fica no histórico).', 409);
    }
    for (const [parcId, f] of novF) {
      const k = parcId + '|frete'; if (!st.cnd.has(k) || vazio(f.frete)) continue; const u = num(st.cnd.get(k));
      if (u != null && num(f.frete) != null && Math.abs(u - +f.frete) > 1e-6) return erro('O frete deste fornecedor já foi registrado na cotação: mude pela Nova rodada (a mudança fica no histórico).', 409);
    }
    /* mapa fechado: travado; reabrir só com motivo e com os pedidos cancelados */
    if (velho && velho.status === 'fechada') {
      const deNovo = merged.slice(old.length).filter(e => ehRod(e) || e.tipo === 'reabertura');
      if (novo.status === 'fechada' && deNovo.some(ehRod)) return erro('O mapa de cotação está fechado (pedidos gerados). Para negociar de novo, reabra o mapa.', 409);
      if (novo.status === 'aberta') {
        if (!deNovo.some(e => e.tipo === 'reabertura')) return erro('Para reabrir o mapa de cotação, use o botão Reabrir mapa (com o motivo, que fica no histórico).', 409);
        const ativos = (Array.isArray(velho.pedIds) ? velho.pedIds : []).map(id => doc('ped/' + id)).filter(x => x && x.status !== 'cancelado');
        if (ativos.length) return erro('Cancele antes os pedidos gerados por este mapa (nº ' + ativos.map(x => x.numero).join(', ') + '). A reabertura fica no histórico.', 409);
      }
    }
    if (merged.length > 5000) return erro('Histórico de negociação grande demais nesta cotação.', 413);
    if (merged.length || Array.isArray(novo.negHist) || old.length) novo.negHist = merged;
    if (recompos) auditar(conta, req, 'COT_HIST_RECOMPOSTO', p, null, { guardadas: old.length, recebidas: veio.length });
    return null;
  }

  function pedItem(pi, c, parcId) {
    const st = estado(H(c)), key = parcId + '|' + pi.cotK, ini = st.ini.get(key), rs = (st.rods.get(parcId) || []).filter(e => (e.itens || []).some(x => x.k === pi.cotK)), u = rs[rs.length - 1];
    if (!(c.itens || []).some(it => it && it.k === pi.cotK)) { ['cotK', 'vIni', 'negRod', 'negRef', 'negPor'].forEach(k => delete pi[k]); return; }
    if (ini) pi.vIni = +ini.preco; else delete pi.vIni;
    pi.negRod = rs.length; pi.negRef = u ? u.id : ''; pi.negPor = u ? u.por || '' : '';
  }
  function ped(conta, velho, novo) {
    const its = Array.isArray(novo.itens) ? novo.itens : [];
    const tira = () => { its.forEach(pi => { if (pi && typeof pi === 'object') ['cotK', 'vIni', 'negRod', 'negRef', 'negPor'].forEach(k => delete pi[k]); }); delete novo.freteIni; delete novo.negCot; };
    if (!novo.cotId) { tira(); return null; }
    const c = doc('cot/' + novo.cotId);
    if (!c) { /* cotação sumiu: mantém o que o servidor já tinha gravado */
      const vel = velho && Array.isArray(velho.itens) ? velho.itens : [];
      its.forEach(pi => { if (!pi || typeof pi !== 'object') return; const o = pi.cotK ? vel.find(x => x && x.cotK === pi.cotK) : null; ['vIni', 'negRod', 'negRef', 'negPor'].forEach(k => { if (o && o[k] !== undefined) pi[k] = o[k]; else delete pi[k]; }); if (!o) delete pi.cotK; });
      if (velho && velho.freteIni !== undefined) novo.freteIni = velho.freteIni; else delete novo.freteIni;
      if (velho && velho.negCot !== undefined) novo.negCot = velho.negCot; else delete novo.negCot;
      return null;
    }
    its.forEach(pi => { if (!pi || typeof pi !== 'object') return; if (typeof pi.cotK !== 'string' || !pi.cotK) { ['cotK', 'vIni', 'negRod', 'negRef', 'negPor'].forEach(k => delete pi[k]); return; } pedItem(pi, c, novo.parcId); });
    const st = estado(H(c)), fi = st.iniF.get(novo.parcId + '|frete');
    if (fi && num(fi.valor) != null && its.some(pi => pi && pi.cotK)) novo.freteIni = +fi.valor; else delete novo.freteIni;
    if (its.some(pi => pi && pi.cotK)) novo.negCot = { cotId: String(c.id || novo.cotId), numero: String(c.numero || '') }; else delete novo.negCot;
    return null;
  }

  function excluir(conta, velho) {
    if (H(velho).some(e => ehRod(e) || (e && e.tipo === 'reabertura'))) return erro('Cotação com negociação registrada não se exclui: use Cancelar (o histórico fica guardado).', 409);
    return null;
  }
  const NEGF = (c0, conta, req, p, velho, novo) => c0 === 'cot' ? cot(conta, req, p, velho, novo) : c0 === 'ped' ? ped(conta, velho, novo) : null;
  NEGF.excluir = excluir; NEGF.estado = estado;
  return NEGF;
};

#!/usr/bin/env node
'use strict';
/* Ponte de acesso (Central de Gestão v170): roda num mini PC ligado o tempo todo na rede de cada local (São Paulo, Tuiuti).
   - Liga PARA o servidor (HTTPS de saída; espera longa em /api/ponte170/sync), com o token desta ponte criado no sistema
     (Controle de acesso › Pontes e dispositivos). Nenhuma porta é aberta na empresa.
   - Fala com os controladores Intelbras CT 3000 da rede local pelo adaptador (adaptadores/intelbras-ct3000.js).
   - O servidor é a fonte da verdade: a ponte recebe as mudanças numeradas (cartões, horários, portas, feriados), aplica em
     cada controlador e responde o que aplicou e os erros. O que falhou é tentado de novo.
   - Eventos (liberado, negado, porta forçada, aberta demais, violação) vão para uma fila em disco (dados/fila.jsonl) com id
     próprio e só saem dela quando o servidor confirma: sem internet nada se perde, e o servidor nunca grava o mesmo id duas
     vezes. Os controladores continuam abrindo sem internet com a lista que já têm.
   - Comandos do servidor: abrir porta e "ler crachá" (o próximo crachá apresentado num leitor).
   Sem dependências: Node.js 18 ou mais novo. Configuração: .env (veja .env.example) e controladores.json.
   Uso: node ponte.js            (roda)
        node ponte.js --testar   (confere o servidor e cada controlador e sai) */
const fs = require('node:fs'), path = require('node:path');
const VERSAO = 'ponte-acesso 1.0 (v170)';
const criarCt = require('./adaptadores/intelbras-ct3000.js');

function lerEnv(arq) { const o = {}; try { fs.readFileSync(arq, 'utf8').split(/\r?\n/).forEach(l => { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !l.trim().startsWith('#')) o[m[1]] = m[2].replace(/^["']|["']$/g, ''); }); } catch (e) { } return o; }

function criarPonte(op) {
  op = Object.assign({ espera: 25, eventosS: 3, statusS: 60, log: (...a) => console.log(new Date().toISOString(), ...a) }, op || {});
  const URL0 = String(op.servidor || '').replace(/\/+$/, ''), TOKEN = String(op.token || ''), DIR = op.dados || path.join(__dirname, 'dados');
  const fetchSrv = op.fetchServidor || ((...a) => fetch(...a)), fetchCt = op.fetchControlador || ((...a) => fetch(...a));
  if (!/^https?:\/\//.test(URL0)) throw new Error('SERVIDOR_URL inválido.');
  if (!/^pa_[A-Za-z0-9_-]{20,80}$/.test(TOKEN)) throw new Error('PONTE_TOKEN inválido (copie o token mostrado no sistema).');
  if (/^http:\/\//.test(URL0) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL0) && !op.permitirHttp) throw new Error('Use https:// no SERVIDOR_URL (o token não pode trafegar sem criptografia).');
  fs.mkdirSync(DIR, { recursive: true });
  const ARQ_EST = path.join(DIR, 'estado.json'), ARQ_FILA = path.join(DIR, 'fila.jsonl');
  const est = Object.assign({ versao: 0, cache: {}, cursor: {} }, (() => { try { return JSON.parse(fs.readFileSync(ARQ_EST, 'utf8')); } catch (e) { return {}; } })());
  const salvaEst = () => { const t = ARQ_EST + '.tmp'; fs.writeFileSync(t, JSON.stringify(est)); fs.renameSync(t, ARQ_EST); };
  /* controladores: { disp (id no sistema), url, usuario, senha } */
  const cts = new Map();
  for (const c of op.controladores || []) cts.set(String(c.disp), { cfg: c, ad: criarCt({ url: c.url, usuario: c.usuario, senha: c.senha, fetch: fetchCt, timeoutMs: op.timeoutCt || 8000 }), online: null, erro: '', erros: [] });
  let parar = false, servidorOk = null; const leituras = [];
  const sonos = new Set(), pedidos = new Set();
  const dorme = ms => new Promise(r => { const f = () => { clearTimeout(t); sonos.delete(f); r(); }, t = setTimeout(f, ms); sonos.add(f); });
  function acordarEspera() { [...sonos].forEach(f => f()); [...pedidos].forEach(c => { try { c.abort(); } catch (e) { } }); }

  /* -------- fila de eventos em disco -------- */
  function filaLer() { try { return fs.readFileSync(ARQ_FILA, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } }
  function filaAcrescenta(evs) { if (evs.length) fs.appendFileSync(ARQ_FILA, evs.map(e => JSON.stringify(e)).join('\n') + '\n'); }
  function filaRegrava(evs) { const t = ARQ_FILA + '.tmp'; fs.writeFileSync(t, evs.map(e => JSON.stringify(e)).join('\n') + (evs.length ? '\n' : '')); fs.renameSync(t, ARQ_FILA); }

  async function srv(metodo, caminho, corpo, ms) {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms || 15000); pedidos.add(ctl);
    try {
      const r = await fetchSrv(URL0 + caminho, { method: metodo, headers: Object.assign({ authorization: 'Bearer ' + TOKEN, 'user-agent': VERSAO }, corpo !== undefined ? { 'content-type': 'application/json' } : {}), body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: ctl.signal });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { }
      if (r.status === 401) { const e = new Error('Token recusado pelo servidor (revogado?). Gere um token novo no sistema.'); e.revogado = true; throw e; }
      if (!r.ok) throw new Error('Servidor respondeu HTTP ' + r.status + (j && j.erro ? ': ' + j.erro : ''));
      servidorOk = true; return j || {};
    } catch (e) { servidorOk = false; throw e; } finally { clearTimeout(to); pedidos.delete(ctl); }
  }

  /* -------- sincronização (estado desejado) -------- */
  async function aplicar(r) {
    let falhou = false; const disps = {};
    for (const d of r.disps || []) if (!cts.has(d.id)) disps[d.id] = { online: false, erro: 'Controlador sem endereço no controladores.json desta ponte.', erros: [] };
    for (const [id, m] of Object.entries(r.mudancas || {})) {
      const c = cts.get(id); if (!c) { falhou = true; continue; }
      const cache = est.cache[id] = est.cache[id] || {};
      try { const x = await c.ad.aplicar(m, cache, !!r.completo); c.online = true; c.erro = ''; c.erros = x.erros; if (x.erros.length) { falhou = true; op.log('[' + id + '] erros ao aplicar:', x.erros.join(' | ')); } }
      catch (e) { c.online = false; c.erro = e.message; falhou = true; op.log('[' + id + '] falha ao aplicar:', e.message); }
    }
    for (const [id, c] of cts) disps[id] = { online: c.online !== false, erro: c.erro, erros: c.erros || [], ver: falhou ? est.versao : r.versao };
    if (!falhou) est.versao = r.versao; salvaEst();
    await srv('POST', '/api/ponte170/aplicado', { versao: est.versao, disps, programa: VERSAO }).catch(e => op.log('aplicado:', e.message));
    return !falhou;
  }
  async function comando(c) {
    const ct = cts.get(String(c.dados && c.dados.disp));
    const fim = (ok, extra) => srv('POST', '/api/ponte170/cmd', Object.assign({ id: c.id, ok }, extra || {})).catch(e => op.log('cmd:', e.message));
    if (!ct) return fim(false, { erro: 'controlador não está nesta ponte' });
    if (c.tipo === 'abrir') { try { await ct.ad.abrir(+c.dados.porta || 1); op.log('[' + c.dados.disp + '] porta ' + c.dados.porta + ' aberta pelo sistema'); return fim(true); } catch (e) { return fim(false, { erro: e.message }); } }
    if (c.tipo === 'ler') {
      const seg = Math.min(30, Math.max(1, +c.dados.seg || 30));
      const uid = await new Promise(res => { const w = { disp: String(c.dados.disp), porta: +c.dados.porta || 1, res, ate: Date.now() + seg * 1000 }; leituras.push(w); setTimeout(() => { const i = leituras.indexOf(w); if (i >= 0) { leituras.splice(i, 1); res(''); } }, seg * 1000); });
      return uid ? fim(true, { uid }) : fim(false, { erro: 'nenhum crachá apresentado' });
    }
    return fim(false, { erro: 'comando desconhecido' });
  }
  async function lacoSync() {
    let atraso = 2000;
    while (!parar) {
      try {
        const r = await srv('GET', '/api/ponte170/sync?desde=' + est.versao + '&espera=' + op.espera, undefined, (op.espera + 15) * 1000);
        atraso = 2000;
        for (const c of r.cmds || []) comando(c);
        const temMud = r.completo || Object.keys(r.mudancas || {}).length;
        if (temMud || r.versao !== est.versao) { const ok = await aplicar(r); if (!ok) await dorme(op.repetirMs || 10000); }
      } catch (e) {
        if (parar) break; op.log('sem servidor:', e.message); await dorme(atraso); atraso = Math.min(60000, atraso * 2);
      }
    }
  }
  /* -------- eventos -------- */
  async function lerControladores() {
    for (const [id, c] of cts) {
      try {
        const r = await c.ad.eventos(est.cursor[id]); c.online = true; if (c.erro && !/aplicar/.test(c.erro)) c.erro = '';
        const evs = r.eventos.map(e => Object.assign({}, e, { id: id + ':' + e.id, disp: id }));
        for (const e of evs) { const w = leituras.find(x => x.disp === id && x.porta === e.porta && e.uid && e.tipo === 'acesso'); if (w) { leituras.splice(leituras.indexOf(w), 1); e.leitura = true; w.res(e.uid); } }
        filaAcrescenta(evs); est.cursor[id] = r.cursor; salvaEst(); /* fila primeiro: se cair entre as duas gravações, o servidor descarta o repetido */
      } catch (e) { if (c.online !== false) op.log('[' + id + '] controlador sem resposta:', e.message); c.online = false; c.erro = e.message; }
    }
  }
  async function enviarFila() {
    let fila = filaLer(); if (!fila.length) return 0; let n = 0;
    while (fila.length && !parar) {
      const lote = fila.slice(0, 200), r = await srv('POST', '/api/ponte170/eventos', { eventos: lote });
      const ok = new Set(r.aceitos || []); if (!ok.size) break;
      fila = filaLer().filter(e => !ok.has(e.id)); filaRegrava(fila); n += ok.size;
    }
    return n;
  }
  async function lacoEventos() {
    let ultStatus = 0;
    while (!parar) {
      await lerControladores();
      try { await enviarFila(); } catch (e) { /* sem internet: a fila espera */ }
      if (Date.now() - ultStatus > op.statusS * 1000) { ultStatus = Date.now(); const disps = {}; for (const [id, c] of cts) disps[id] = { online: c.online !== false, erro: c.erro }; srv('POST', '/api/ponte170/status', { disps, programa: VERSAO }).catch(() => { }); }
      await dorme(leituras.length ? 700 : op.eventosS * 1000);
    }
  }
  async function testar() {
    const out = [];
    try { const r = await srv('GET', '/api/ponte170/sync?desde=' + 1e12 + '&espera=0'); out.push('Servidor: ok (ponte "' + (r.ponte && r.ponte.nome) + '", ' + (r.disps || []).length + ' controlador(es) no sistema)'); (r.disps || []).forEach(d => { if (!cts.has(d.id)) out.push('  ATENÇÃO: o controlador "' + d.nome + '" (' + d.id + ') não está no controladores.json'); }); }
    catch (e) { out.push('Servidor: FALHOU — ' + e.message); }
    for (const [id, c] of cts) { try { const i = await c.ad.info(); out.push('Controlador ' + id + ' (' + c.cfg.url + '): ok — ' + (i.deviceType || JSON.stringify(i).slice(0, 80))); } catch (e) { out.push('Controlador ' + id + ' (' + c.cfg.url + '): FALHOU — ' + e.message); } }
    return out;
  }
  let pSync = null, pEv = null;
  return {
    iniciar() { parar = false; op.log(VERSAO + ' — servidor ' + URL0 + ', ' + cts.size + ' controlador(es)'); pSync = lacoSync(); pEv = lacoEventos(); return this; },
    async parar() { parar = true; acordarEspera(); await Promise.race([Promise.all([pSync, pEv].filter(Boolean)), dorme(op.espera * 1000 + 3000)]); },
    testar, enviarFila, lerControladores, fila: filaLer, estado: () => est, status: () => ({ servidorOk, controladores: Object.fromEntries([...cts].map(([k, c]) => [k, { online: c.online, erro: c.erro }])) })
  };
}
module.exports = { criarPonte, lerEnv, VERSAO };

if (require.main === module) {
  const env = Object.assign({}, lerEnv(path.join(__dirname, '.env')), process.env);
  const arqCt = env.CONTROLADORES_ARQ || path.join(__dirname, 'controladores.json');
  let cts = []; try { cts = JSON.parse(fs.readFileSync(arqCt, 'utf8')); } catch (e) { console.error('Não consegui ler ' + arqCt + ': ' + e.message + ' (copie controladores.example.json)'); process.exit(1); }
  const p = criarPonte({ servidor: env.SERVIDOR_URL, token: env.PONTE_TOKEN, controladores: cts, dados: env.DADOS_DIR || path.join(__dirname, 'dados'), espera: +env.ESPERA_S || 25, eventosS: +env.EVENTOS_S || 3, permitirHttp: env.PERMITIR_HTTP === '1' });
  if (process.argv.includes('--testar')) p.testar().then(l => { l.forEach(x => console.log(x)); process.exit(l.some(x => /FALHOU/.test(x)) ? 1 : 0); });
  else { p.iniciar(); const sair = () => { p.parar().then(() => process.exit(0)); }; process.on('SIGINT', sair); process.on('SIGTERM', sair); }
}

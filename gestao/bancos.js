'use strict';
/* Extrato bancário automático — Banco do Brasil (API oficial de extratos) e Itaú/Caixa (Open Finance via Pluggy)
   O servidor busca os lançamentos de cada conta ligada e grava como linhas do extrato (coleção "extrato"),
   iguais às de um OFX importado: aparecem sozinhas na tela de Conciliação bancária.
   Credenciais só no ambiente da VPS. Na conta bancária do sistema ficam só dados não secretos:
   a fonte (bb | pluggy), agência e conta (BB) ou o id da conta no Open Finance (Pluggy). */
const https = require('node:https');
const fs = require('node:fs');
const E = process.env;
const BB = {
  id: (E.BB_CLIENT_ID || '').trim(), secret: (E.BB_CLIENT_SECRET || '').trim(), appKey: (E.BB_APP_KEY || '').trim(),
  oauth: E.BB_OAUTH_URL || 'https://oauth.bb.com.br/oauth/token',
  api: (E.BB_EXTRATO_URL || 'https://extratos.mtls.api.bb.com.br/v2').replace(/\/$/, ''),
  appParam: E.BB_APPKEY_PARAM || 'gw-dev-app-key', scope: E.BB_SCOPE || 'extrato-info',
  cert: E.BB_CERT_PATH || '', certSenha: E.BB_CERT_SENHA || ''
};
const PL = { id: (E.PLUGGY_CLIENT_ID || '').trim(), secret: (E.PLUGGY_CLIENT_SECRET || '').trim(), api: (E.PLUGGY_API_URL || 'https://api.pluggy.ai').replace(/\/$/, ''), widget: E.PLUGGY_CONNECT_JS || 'https://cdn.pluggy.ai/pluggy-connect/v2.8.2/pluggy-connect.js' };
const INTERVALO = Math.max(30, +E.BANCOS_INTERVALO_MIN || 180), DIAS = Math.min(90, Math.max(1, +E.BANCOS_DIAS || 30));
const bbOk = () => !!(BB.id && BB.secret && BB.appKey), plOk = () => !!(PL.id && PL.secret);

module.exports = function (ctx) {
  const { q, db, avisarDoc, json, lerJson, NIV } = ctx;
  const cfgGet = db.prepare('SELECT v FROM cfg WHERE k=?'), cfgPut = db.prepare('INSERT INTO cfg(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  const est = () => { try { const r = cfgGet.get('bancos'); return r ? JSON.parse(r.v) : {}; } catch (e) { return {}; } };
  const salvaEst = o => cfgPut.run('bancos', JSON.stringify(o));
  const col = c => q.colGet.all(c).map(r => Object.assign({ id: r.id }, JSON.parse(r.data))).filter(r => !r._del);
  const docGet = p => { const r = q.docGet.get(p); return r ? JSON.parse(r.data) : null; };
  const docPut = (p, data) => { const seg = p.split('/'), ts = Date.now(); data.ts = data.ts || ts; q.docPut.run(p, seg.slice(0, -1).join('/'), seg[seg.length - 1], JSON.stringify(data), ts); avisarDoc('set', p, data, ts); };
  const uid = () => require('node:crypto').randomBytes(12).toString('hex');
  let pfx = null; try { if (BB.cert && fs.existsSync(BB.cert)) pfx = fs.readFileSync(BB.cert); } catch (e) { }

  /* requisição HTTPS com certificado opcional (o BB exige certificado na conexão: mTLS) */
  function req(url, op) {
    op = op || {};
    return new Promise((ok, falha) => {
      const u = new URL(url), body = op.body == null ? null : (typeof op.body === 'string' ? op.body : JSON.stringify(op.body));
      const o = { method: op.method || 'GET', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers: Object.assign({ Accept: 'application/json' }, op.headers || {}), timeout: 60000 };
      if (body != null) o.headers['Content-Length'] = Buffer.byteLength(body);
      if (op.pfx) { o.pfx = op.pfx; o.passphrase = op.senha || ''; }
      const r = https.request(o, res => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { const t = Buffer.concat(ch).toString('utf8'); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { texto: t.slice(0, 1500) }; } if (res.statusCode >= 200 && res.statusCode < 300) ok(j); else falha({ st: 502, msg: 'Resposta ' + res.statusCode + ': ' + String((j && (j.message || j.error_description || j.error || (j.erros && j.erros[0] && j.erros[0].mensagem) || j.texto)) || '').slice(0, 300), bruto: j }); }); });
      r.on('timeout', () => r.destroy(new Error('tempo esgotado')));
      r.on('error', e => falha({ st: 502, msg: 'Sem resposta do banco (' + (e.message || e) + ').' }));
      if (body != null) r.write(body); r.end();
    });
  }
  const fmtBB = d => d.slice(8, 10) + d.slice(5, 7) + d.slice(0, 4);
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const deBB = v => { const s = String(v || '').padStart(8, '0'); if (!/^\d{8}$/.test(s) || s === '00000000') return ''; return s.slice(4, 8) + '-' + s.slice(2, 4) + '-' + s.slice(0, 2); };

  /* ---------- Banco do Brasil ---------- */
  let bbTok = { v: '', ate: 0 };
  async function bbToken() {
    if (bbTok.v && bbTok.ate > Date.now() + 60e3) return bbTok.v;
    const j = await req(BB.oauth, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(BB.id + ':' + BB.secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&scope=' + encodeURIComponent(BB.scope) });
    bbTok = { v: j.access_token, ate: Date.now() + (+j.expires_in || 600) * 1000 }; return bbTok.v;
  }
  async function bbLancamentos(conta, ini, fim) {
    const tok = await bbToken(), ag = String(conta.apiAg || '').replace(/\D/g, '').replace(/^0+/, ''), cc = String(conta.apiConta || '').replace(/\D/g, '').replace(/^0+/, '');
    if (!ag || !cc) throw { st: 400, msg: 'Informe agência e conta (sem o dígito) na conta "' + (conta.nome || '') + '".' };
    const out = []; let pag = 1;
    for (let i = 0; i < 50; i++) {
      const u = BB.api + '/conta-corrente/agencia/' + ag + '/conta/' + cc + '?' + BB.appParam + '=' + encodeURIComponent(BB.appKey) + '&dataInicioSolicitacao=' + fmtBB(ini) + '&dataFimSolicitacao=' + fmtBB(fim) + '&numeroPaginaSolicitacao=' + pag + '&quantidadeRegistroPaginaSolicitacao=200';
      const j = await req(u, { headers: { Authorization: 'Bearer ' + tok }, pfx, senha: BB.certSenha });
      (j && (j.listaLancamento || j.lancamentos) || []).forEach(l => {
        const data = deBB(l.dataLancamento || l.dataMovimento), desc = [l.textoDescricaoHistorico, l.textoInformacaoComplementar].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        if (!data || /^s\s?a\s?l\s?d\s?o/i.test(desc) || +l.codigoHistorico === 0) return;
        const v = Math.abs(+l.valorLancamento || 0) * (String(l.indicadorSinalLancamento || '').toUpperCase() === 'D' ? -1 : 1);
        if (!v) return;
        out.push({ data, valor: Math.round(v * 100) / 100, desc, fitid: 'bb' + [l.numeroDocumento, l.numeroLote, l.codigoHistorico].join('.'), tipo: v < 0 ? 'DEBIT' : 'CREDIT' });
      });
      const prox = +(j && j.numeroPaginaProximo) || 0; if (!prox || prox <= pag) break; pag = prox;
    }
    return { txs: out };
  }

  /* ---------- Open Finance (Pluggy) ---------- */
  let plKey = { v: '', ate: 0 };
  async function plApiKey() { if (plKey.v && plKey.ate > Date.now()) return plKey.v; const j = await req(PL.api + '/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { clientId: PL.id, clientSecret: PL.secret } }); plKey = { v: j.apiKey, ate: Date.now() + 100 * 60e3 }; return plKey.v; }
  const pl = async (path, op) => req(PL.api + path, Object.assign({}, op, { headers: Object.assign({ 'X-API-KEY': await plApiKey(), 'Content-Type': 'application/json' }, (op && op.headers) || {}) }));
  async function plLancamentos(conta, ini, fim) {
    if (!conta.apiAccountId) throw { st: 400, msg: 'Ligue a conta "' + (conta.nome || '') + '" a uma conta do Open Finance.' };
    const out = []; let page = 1, saldo = null;
    for (let i = 0; i < 40; i++) {
      const j = await pl('/transactions?accountId=' + encodeURIComponent(conta.apiAccountId) + '&from=' + ini + '&to=' + fim + '&pageSize=500&page=' + page);
      (j && j.results || []).forEach(t => {
        const a = Math.abs(+t.amount || 0), v = t.type ? (String(t.type).toUpperCase() === 'DEBIT' ? -a : a) : +t.amount || 0, data = String(t.date || '').slice(0, 10);
        if (!v || !data || String(t.status || '').toUpperCase() === 'PENDING') return;
        out.push({ data, valor: Math.round(v * 100) / 100, desc: String(t.description || t.descriptionRaw || '').replace(/\s+/g, ' ').trim(), fitid: 'pl' + t.id, tipo: v < 0 ? 'DEBIT' : 'CREDIT' });
      });
      if (!j || !j.totalPages || page >= j.totalPages) break; page++;
    }
    try { const a = await pl('/accounts/' + encodeURIComponent(conta.apiAccountId)); if (a && a.balance != null) saldo = +a.balance; } catch (e) { }
    return { txs: out, saldo };
  }

  /* ---------- gravação no extrato (igual à importação do OFX: sem duplicar) ---------- */
  function gravar(conta, r) {
    const have = new Set(col('extrato').filter(x => x.contaId === conta.id).map(x => x.key)); let n = 0, dup = 0;
    r.txs.forEach(t => { const key = t.fitid + '|' + t.data + '|' + t.valor; if (have.has(key)) { dup++; return; } have.add(key); const id = uid(); docPut('extrato/' + id, { id, contaId: conta.id, key, fitid: t.fitid, data: t.data, valor: t.valor, desc: t.desc, tipoOfx: t.tipo, status: 'pendente', lancId: '', origem: conta.apiProv === 'bb' ? 'api-bb' : 'open-finance' }); n++; });
    if (r.saldo != null) { const c = docGet('conta/' + conta.id); if (c) docPut('conta/' + conta.id, Object.assign(c, { ofxSaldo: Math.round(r.saldo * 100) / 100, ofxData: iso(Date.now()) })); }
    return { n, dup };
  }
  let rodando = false;
  async function sincronizar(alvo, dias) {
    if (rodando) return { ok: false, msg: 'Já há uma busca em andamento.' };
    rodando = true; const e = est(); e.contas = e.contas || {}; const res = [];
    try {
      const contas = col('conta').filter(c => (c.apiProv === 'bb' && bbOk()) || (c.apiProv === 'pluggy' && plOk())).filter(c => !alvo || c.id === alvo);
      for (const c of contas) {
        const fim = iso(Date.now()), ultimo = (e.contas[c.id] || {}).ate, ini = iso(Date.now() - (dias || (ultimo ? 5 : DIAS)) * 864e5);
        try { const r = c.apiProv === 'bb' ? await bbLancamentos(c, ini, fim) : await plLancamentos(c, ini, fim); const g = gravar(c, r); e.contas[c.id] = { em: Date.now(), ok: true, novas: g.n, ate: fim, erro: '' }; res.push({ conta: c.nome, ok: true, novas: g.n, repetidas: g.dup }); }
        catch (err) { e.contas[c.id] = Object.assign({}, e.contas[c.id] || {}, { em: Date.now(), ok: false, erro: err.msg || String(err.message || err) }); res.push({ conta: c.nome, ok: false, erro: e.contas[c.id].erro }); }
      }
      e.ultimo = Date.now(); salvaEst(e); return { ok: true, contas: res };
    } finally { rodando = false; }
  }
  if (bbOk() || plOk()) { setTimeout(() => sincronizar().catch(() => { }), 60e3); setInterval(() => sincronizar().catch(() => { }), INTERVALO * 60e3); }

  return async function rota(p, m, req0, res, conta, u) {
    if (!p.startsWith('/api/bancos/')) return false;
    if (NIV[conta.nivel] < NIV.admin) { json(res, 403, { erro: 'Apenas administradores.' }); return true; }
    const r = p.slice('/api/bancos/'.length);
    try {
      if (r === 'status') { const e = est(); json(res, 200, { bb: bbOk(), bbCert: !!pfx, pluggy: plOk(), intervaloMin: INTERVALO, widget: PL.widget, ultimo: e.ultimo || 0, contas: e.contas || {}, rodando }); return true; }
      if (r === 'sincronizar' && m === 'POST') { const b = await lerJson(req0); json(res, 200, await sincronizar(b.contaId || '', Math.min(90, +b.dias || 0) || 0)); return true; }
      if (r === 'bb/testar') { if (!bbOk()) throw { st: 503, msg: 'Credenciais do Banco do Brasil não configuradas (BB_CLIENT_ID, BB_CLIENT_SECRET, BB_APP_KEY).' }; await bbToken(); json(res, 200, { ok: true, certificado: !!pfx }); return true; }
      if (r === 'pluggy/connect-token' && m === 'POST') { if (!plOk()) throw { st: 503, msg: 'Credenciais da Pluggy não configuradas (PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET).' }; const b = await lerJson(req0); const j = await pl('/connect_token', { method: 'POST', body: b.itemId ? { itemId: b.itemId } : {} }); json(res, 200, { accessToken: j.accessToken }); return true; }
      if (r === 'pluggy/contas') { if (!plOk()) throw { st: 503, msg: 'Credenciais da Pluggy não configuradas.' }; const item = String(u.searchParams.get('itemId') || '').replace(/[^A-Za-z0-9-]/g, ''); if (!item) throw { st: 400, msg: 'Informe o item.' }; const j = await pl('/accounts?itemId=' + item); json(res, 200, (j.results || []).map(a => ({ id: a.id, nome: a.name || a.marketingName || '', numero: a.number || '', tipo: a.type || '', saldo: a.balance }))); return true; }
      json(res, 404, { erro: 'Rota não encontrada.' }); return true;
    } catch (e) { json(res, e.st || 500, { erro: e.msg || String(e.message || e) }); return true; }
  };
};

'use strict';
/* Central de Gestão — regras de negócio aplicadas pelo servidor (segurança)
   Antes, alçadas, dupla checagem bancária, competência fechada, assinaturas e anexos só eram conferidos no
   navegador. Aqui o servidor repete essas regras e carimba quem fez e quando:
   1. dados bancários de fornecedor: a troca vira pendência; só a rota de confirmação (Financeiro/Administrador,
      outra pessoa, com telefone e contato) aplica;
   2. aprovações (contas a pagar, pedidos, atos financeiros, comprovantes, horas extras, ajustes de inventário) só
      pela rota /api/aprovar, que calcula o nível pela alçada guardada em cfg e carimba por/em/IP;
   3. competência fechada travada no servidor; fechar e reabrir só pela rota, com motivo e carimbo;
   4. anexos ligados ao registro de origem; citação forjada no chat, na Minha área ou em pedidos não vale;
      exclusão vai para a lixeira, só pelo dono ou por quem enviou;
   5. leitura por módulo (perfis.json) e contas da folha com nome e valor ocultos para quem não é do RH/folha;
   7. trilha de auditoria gravada pelo servidor e consulta só para o dono;
   8. remessa CNAB com SHA-256 calculado pelo servidor e conferido no download;
   9. assinatura de EPI e ciência de holerite carimbadas pelo servidor e imutáveis;
   10. alertas por e-mail (troca bancária e reabertura de competência);
   11. veículos filtrados pelos locais da frota do usuário. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function (X) {
  const { db, q, json, lerJson, avisarDoc, perfilDe, perfilEm, NIV, EMAIL, ipDe, PERM, APP_URL, esc, pag, DATA, uid, cookies, SEG, SENS_RH, PERF_RH } = X;
  const pode = (...a) => X.pode(...a), perfilPermite = (...a) => X.perfilPermite(...a), podeVer = (...a) => X.podeVer(...a), gravacaoPermitida = (...a) => X.gravacaoPermitida(...a), veFuncCompleto = c => X.veFuncCompleto(c);
  const MODO_LEIT = (process.env.PERFIL_LEITURA || 'bloquear').toLowerCase() === 'avisar' ? 'avisar' : 'bloquear';
  const AUD_DIAS = Math.max(366, +process.env.AUDITORIA_DIAS || 400);
  const LIXO_DIAS = Math.max(1, +process.env.LIXO_ANEXOS_DIAS || 30);
  const ALERTAS = !/^(0|nao|não|false|desligado)$/i.test(String(process.env.ALERTAS_EMAIL || '1'));
  const ALERTAS_PARA = String(process.env.ALERTAS_EMAIL_PARA || '').split(/[,;\s]+/).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

  /* ---------------- tabelas ---------------- */
  db.exec(`CREATE TABLE IF NOT EXISTS auditoria(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, conta TEXT, ip TEXT, metodo TEXT, caminho TEXT, antes TEXT, depois TEXT);
CREATE INDEX IF NOT EXISTS auditoria_ts ON auditoria(ts);
CREATE INDEX IF NOT EXISTS auditoria_conta ON auditoria(conta, ts);
CREATE TABLE IF NOT EXISTS blobcit(blob TEXT NOT NULL, path TEXT NOT NULL, por TEXT, ts INTEGER, PRIMARY KEY(blob, path));
CREATE INDEX IF NOT EXISTS blobcit_path ON blobcit(path);`);
  for (const s of ['ALTER TABLE arquivos ADD COLUMN origem TEXT', 'ALTER TABLE arquivos ADD COLUMN lixo INTEGER', 'ALTER TABLE arquivos ADD COLUMN lixoPor TEXT', 'ALTER TABLE arquivos ADD COLUMN restrito INTEGER']) { try { db.exec(s); } catch (e) { } }
  fs.mkdirSync(path.join(DATA, 'blobs', 'lixo'), { recursive: true });
  const st = {
    aud: db.prepare('INSERT INTO auditoria(ts,conta,ip,metodo,caminho,antes,depois) VALUES(?,?,?,?,?,?,?)'),
    arq: db.prepare('SELECT * FROM arquivos WHERE id=?'),
    arqOrigem: db.prepare('UPDATE arquivos SET origem=? WHERE id=? AND origem IS NULL'),
    citIns: db.prepare('INSERT INTO blobcit(blob,path,por,ts) VALUES(?,?,?,?) ON CONFLICT(blob,path) DO NOTHING'),
    citDoPath: db.prepare('SELECT blob FROM blobcit WHERE path=?'),
    citDel: db.prepare('DELETE FROM blobcit WHERE blob=? AND path=?'),
    citDoBlob: db.prepare('SELECT path, por FROM blobcit WHERE blob=? LIMIT 500'),
    sessao: db.prepare('SELECT conta FROM sessoes WHERE token=? AND expira>?')
  };
  const doc = p => { const r = q.docGet.get(p); if (!r) return null; try { return JSON.parse(r.data); } catch (e) { return null; } };
  const docTs = p => { const r = q.docGet.get(p); return r ? r.ts : 0; };
  const col = c => q.colGet.all(c).map(r => { try { return Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { return null; } }).filter(Boolean);
  const cfgEmp = () => doc('cfg/empresa') || {};
  const ehDono = conta => !!conta && conta.nivel === 'owner';
  const perfW = conta => { if (!conta) return []; if (conta.nivel === 'owner') return '*'; const pr = PERM.perfis[perfilDe(conta)]; return pr ? pr.w : []; };
  const gravaGrupo = (conta, ...gs) => { const w = perfW(conta); return w === '*' || gs.some(g => w.includes(g)); };
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const ym = d => { const s = String(d || ''); return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : ''; };
  /* comparação estável (ordem das chaves e null/ausente não importam) */
  const est = v => { if (v === undefined || v === null) return 'null'; if (Array.isArray(v)) return '[' + v.map(est).join(',') + ']'; if (typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined && v[k] !== null).sort().map(k => JSON.stringify(k) + ':' + est(v[k])).join(',') + '}'; return JSON.stringify(v); };
  const igual = (a, b) => est(a) === est(b);
  const nomeConta = id => { const c = id && q.contaPorId.get(id); return c ? (c.nome || c.email || id) : (id || '—'); };
  const erro = (t, st) => ({ erro: t, st: st || 403 });
  const salvar = (p, data, conta, req, metodo, antes) => { const s = p.split('/'), ts = Date.now(); q.docPut.run(p, s.slice(0, -1).join('/'), s[s.length - 1], JSON.stringify(data), ts); avisarDoc('set', p, data, ts); auditar(conta, req, metodo || 'ROTA', p, antes, data); atualizarCitacoes(conta, p, data); return ts; };

  /* =====================================================================
     7. TRILHA DE AUDITORIA
     ===================================================================== */
  const SEGREDOS = /^(senha|senha2|atual|nova|codigo|rec|token|segredo|hash|totp|img)$/i;
  function limpar(o, n) {
    if (o == null) return o; if (typeof o !== 'object') return typeof o === 'string' && o.length > 2000 ? o.slice(0, 2000) + '…' : o;
    if ((n || 0) > 6) return '…'; if (Array.isArray(o)) return o.slice(0, 200).map(x => limpar(x, (n || 0) + 1));
    const r = {}; for (const k of Object.keys(o)) r[k] = SEGREDOS.test(k) ? (o[k] ? '(oculto)' : o[k]) : limpar(o[k], (n || 0) + 1); return r;
  }
  const txtAud = o => { if (o == null) return null; let t = JSON.stringify(limpar(o)); if (t.length > 65536) t = t.slice(0, 65536) + '…(cortado)'; return t; };
  function auditar(conta, req, metodo, caminho, antes, depois) {
    try {
      const priv = /^cm\/[^/]+\/(m|v)\//.test(String(caminho || '')); /* conteúdo do chat não vai para a auditoria */
      st.aud.run(Date.now(), conta ? (conta.id || conta) : null, req ? ipDe(req) : null, String(metodo || ''), String(caminho || '').slice(0, 400), priv ? (antes ? '"(mensagem)"' : null) : txtAud(antes), priv ? (depois ? '"(mensagem)"' : null) : txtAud(depois));
    } catch (e) { console.error('[auditoria]', e.message); }
  }
  /* rotas que não gravam documentos: login, duas etapas, contas, backup e anexos (o servidor registra ao terminar a resposta) */
  const ROTAS_AUD = [[/^\/setup$/, 'POST'], [/^\/login$/, 'POST'], [/^\/login\/codigo$/, 'POST'], [/^\/sair$/, '*'], [/^\/esqueci$/, 'POST'], [/^\/senha\//, 'POST'],
    [/^\/conta\/seguranca\//, 'POST'], [/^\/contas\/backups\//, 'GET'], [/^\/contas\//, 'POST'], [/^\/api\/contas/, 'POST'], [/^\/api\/admin\//, '*'], [/^\/api\/assets$/, 'POST']];
  function contaDaSessao(req, res) {
    let t = cookies(req).sid; const sc = res && res.getHeader && res.getHeader('set-cookie');
    const novo = [].concat(sc || []).map(String).find(x => /^sid=[^;]+/.test(x)); if (novo) t = novo.slice(4).split(';')[0];
    if (!t) return null; const r = st.sessao.get(SEG.sha(t), Date.now()); return r ? r.conta : null;
  }
  function auditarHttp(req, res, p, m) {
    try {
      if (!ROTAS_AUD.some(([re, mm]) => re.test(p) && (mm === '*' || mm === m))) return;
      let campos = null; if (req._corpo && req._corpo.length && /x-www-form-urlencoded|json/.test(String(req.headers['content-type'] || ''))) {
        const t = req._corpo.toString('utf8'); try { campos = /json/.test(req.headers['content-type']) ? JSON.parse(t) : Object.fromEntries(new URLSearchParams(t)); } catch (e) { campos = null; }
      }
      let conta = contaDaSessao(req, res), metodo = m;
      const loc = String(res.getHeader && res.getHeader('location') || ''), falhou = res.statusCode >= 400 || /[?&]e=1/.test(loc);
      if (p === '/login') { metodo = res.statusCode === 303 ? 'LOGIN' : res.statusCode === 200 ? 'LOGIN_SENHA_OK_PEDE_CODIGO' : 'LOGIN_FALHA'; if (!conta && campos && campos.email) { const c = q.contaPorEmail.get(String(campos.email).trim().slice(0, 254)); if (c) conta = c.id; } }
      else if (p === '/login/codigo') metodo = res.statusCode === 303 ? 'LOGIN_2FA' : 'LOGIN_2FA_FALHA';
      else if (p.startsWith('/conta/seguranca/')) metodo = '2FA_' + p.slice(17).toUpperCase() + (falhou ? '_FALHA' : '');
      else if (p === '/sair') metodo = 'SAIR';
      else if (p.startsWith('/contas/backups/')) metodo = 'BACKUP_DOWNLOAD';
      else if (p === '/contas/backup-agora') metodo = 'BACKUP_MANUAL';
      else if (falhou) metodo = m + '_FALHA';
      let msg = ''; try { msg = new URL(loc, 'http://x').searchParams.get('m') || ''; } catch (e) { }
      auditar(conta, req, metodo, p, null, { status: res.statusCode, campos: campos && typeof campos === 'object' ? limpar(campos) : undefined, msg: msg || undefined });
    } catch (e) { console.error('[auditoria]', e.message); }
  }
  setInterval(() => { try { db.prepare('DELETE FROM auditoria WHERE ts<?').run(Date.now() - AUD_DIAS * 864e5); } catch (e) { } purgarLixo(); }, 6 * 3600e3).unref();

  /* =====================================================================
     10. ALERTAS POR E-MAIL (dono e Financeiro)
     ===================================================================== */
  function destinatarios() {
    const em = new Set(ALERTAS_PARA);
    for (const c of q.contas.all()) if (c.ativo && c.email && c.nivel === 'owner') em.add(c.email);
    for (const r of q.colGet.all('usr')) { try { const u = JSON.parse(r.data); if (u && u.uid && u.ativo !== false && (u.perfil === 'financeiro')) { const c = q.contaPorId.get(u.uid); if (c && c.ativo && c.email) em.add(c.email); } } catch (e) { } }
    return [...em];
  }
  function alertar(assunto, linhas, req) {
    if (!ALERTAS) return;
    const para = destinatarios(), conf = EMAIL.configurado();
    auditar(null, req, 'ALERTA_EMAIL', assunto, null, { para, enviado: conf && para.length > 0, motivo: !conf ? 'SMTP não configurado' : !para.length ? 'sem destinatário' : undefined, linhas });
    if (!conf || !para.length) return;
    const m = EMAIL.modelo(assunto, linhas, 'Abrir o sistema', APP_URL, 'Alerta automático da Central de Gestão. Se você não reconhece esta ação, confira em Contas › Auditoria.');
    for (const p of para) EMAIL.enviar({ para: p, assunto: assunto + ' · Central de Gestão', texto: m.texto, html: m.html }).catch(e => { console.error('[alerta]', e.message); auditar(null, null, 'ALERTA_EMAIL_FALHA', assunto, null, { para: p, erro: e.message }); });
  }

  /* =====================================================================
     1. DADOS BANCÁRIOS (parc)
     ===================================================================== */
  const FIN_BK = ['banco', 'agencia', 'conta', 'contaTipo', 'pixTipo', 'pix'];
  const bk = o => { const r = {}; FIN_BK.forEach(k => { r[k] = String((o && o[k]) || '').trim(); }); return r; };
  const bkKey = o => FIN_BK.map(k => o[k] || '').join('|');
  const bkVazio = o => !['banco', 'agencia', 'conta', 'pix'].some(k => o[k]);
  const bkTxt = o => { const b = bk(o); return [b.banco, b.agencia ? 'ag. ' + b.agencia : '', b.conta ? 'conta ' + b.conta : '', b.pix ? 'PIX ' + b.pix : ''].filter(Boolean).join(' · ') || 'sem dados bancários'; };
  function regraParc(conta, req, velho, novo, ctx) {
    const ov = velho || {}, nb = bk(novo), ob = bk(ov);
    let desejo = null;
    if (bkKey(nb) !== bkKey(ob)) desejo = nb;
    else if (novo.bancoPend && typeof novo.bancoPend === 'object') { const pb = bk(novo.bancoPend); if (bkKey(pb) !== bkKey(bk(ov.bancoPend || {})) && bkKey(pb) !== bkKey(ob)) desejo = pb; }
    /* o que vale é o que o servidor tem: dados atuais, pendência e histórico */
    FIN_BK.forEach(k => { if (ov[k] !== undefined) novo[k] = ov[k]; else delete novo[k]; });
    ['bancoPend', 'bancoHist'].forEach(k => { if (ov[k] !== undefined) novo[k] = ov[k]; else delete novo[k]; });
    if (!desejo) return;
    if (bkVazio(desejo)) { /* apagar os dados bancários não desvia pagamento: vale na hora, com registro */
      if (!velho || bkVazio(ob)) return;
      FIN_BK.forEach(k => { novo[k] = ''; }); delete novo.bancoPend;
      novo.bancoHist = (ov.bancoHist || []).concat([{ antes: ob, depois: bk({}), pedidoPor: conta.id, pedidoEm: Date.now(), obs: 'Dados bancários removidos por ' + nomeConta(conta.id), res: 'removido', srv: 1 }]).slice(-20);
      return;
    }
    novo.bancoPend = Object.assign(desejo, { por: conta.id, em: Date.now(), ip: req ? ipDe(req) : '', srv: 1 });
    ctx.alertas.push(['Troca de dados bancários pedida', ['Foi pedida a troca dos dados bancários de ' + (novo.nome || ov.nome || 'um cadastro') + ' por ' + nomeConta(conta.id) + '.', 'Hoje: ' + bkTxt(ob) + '.', 'Pedido: ' + bkTxt(desejo) + '.', 'A troca só vale depois que outra pessoa do Financeiro confirmar por telefone. Enquanto isso, os pagamentos a este cadastro ficam bloqueados.']]);
  }
  function rotaBanco(acao, conta, req, b) {
    if (!perfilEm(conta, ['admin', 'financeiro'])) return erro('Só o Financeiro ou um administrador confirma dados bancários.');
    const p = 'parc/' + String(b.id || ''), velho = doc(p); if (!velho) return erro('Cadastro não encontrado.', 404);
    const pd = velho.bancoPend; if (!pd) return erro('Não há alteração pendente.', 409);
    const n = JSON.parse(JSON.stringify(velho)), agora = Date.now(), ip = ipDe(req);
    if (acao === 'recusar') {
      delete n.bancoPend;
      n.bancoHist = (velho.bancoHist || []).concat([{ antes: bk(velho), depois: bk(pd), pedidoPor: pd.por, pedidoEm: pd.em, confPor: conta.id, confEm: agora, ip, obs: 'Alteração recusada: ' + String(b.motivo || '').slice(0, 300), res: 'recusado', srv: 1 }]).slice(-20);
      salvar(p, n, conta, req, 'BANCO_RECUSAR', velho); return { ok: true, data: n, msg: 'Alteração recusada.' };
    }
    if (pd.por === conta.id) return erro('Quem pediu a alteração não pode confirmar. Outra pessoa precisa ligar para o fornecedor.');
    const tel = String(b.tel || '').trim().slice(0, 60), com = String(b.com || '').trim().slice(0, 120); if (!tel || !com) return erro('Informe o telefone usado e com quem falou.', 400);
    const quando = String(b.quando || '').slice(0, 20) || new Date(agora).toISOString().slice(0, 16);
    const txt = 'Confirmado por telefone em ' + quando.slice(8, 10) + '/' + quando.slice(5, 7) + '/' + quando.slice(0, 4) + (quando.length > 10 ? ' às ' + quando.slice(11, 16) : '') + ' com ' + com + ' (' + tel + ') por ' + nomeConta(conta.id);
    FIN_BK.forEach(k => { n[k] = pd[k] || ''; }); delete n.bancoPend;
    n.bancoHist = (velho.bancoHist || []).concat([{ antes: bk(velho), depois: bk(pd), pedidoPor: pd.por, pedidoEm: pd.em, confPor: conta.id, confEm: agora, ip, tel, com, quando, obs: txt, res: 'confirmado', srv: 1 }]).slice(-20);
    salvar(p, n, conta, req, 'BANCO_CONFIRMAR', velho);
    /* contas a pagar já aprovadas deste fornecedor: a aprovação é reaberta */
    let k = 0;
    for (const l of col('lanc')) {
      if (l.parcId !== velho.id && l.parcId !== b.id || l.tipo !== 'pagar' || l.pago || l.status === 'cancelado' || !(l.aprov || l.aprovParc)) continue;
      const x = Object.assign({}, l), ant = l; delete x.aprov; delete x.aprovParc; x.aprovReaberta = { em: agora, por: conta.id, motivo: 'dados bancários alterados', srv: 1 }; salvar('lanc/' + l.id, x, conta, req, 'APROVACAO_REABERTA', ant); k++;
    }
    alertar('Dados bancários de fornecedor alterados', ['Os dados bancários de ' + (velho.nome || 'um cadastro') + ' foram trocados.', 'Antes: ' + bkTxt(velho) + '.', 'Agora: ' + bkTxt(pd) + '.', 'Pedido por ' + nomeConta(pd.por) + '; ' + txt + '.' + (k ? ' ' + k + ' aprovação(ões) de pagamento reaberta(s).' : '')], req);
    return { ok: true, data: n, msg: txt + '.' + (k ? ' ' + k + ' aprovação(ões) de pagamento reaberta(s).' : '') };
  }

  /* =====================================================================
     1b. APROVAÇÕES
     ===================================================================== */
  const ALC_DEF = { n1: 5000, n2: 50000, frac: true };
  function alcadas() {
    const c = cfgEmp(), x = c.alcNiv || {}, n = Object.assign({}, ALC_DEF, x);
    ['ap1', 'ap2', 'ap3'].forEach(k => { if (!Array.isArray(n[k])) n[k] = []; });
    n.n1 = +n.n1 > 0 ? +n.n1 : ALC_DEF.n1; n.n2 = +n.n2 > n.n1 ? +n.n2 : Math.max(n.n1, ALC_DEF.n2); n.frac = n.frac !== false;
    n.aprov = Array.isArray(c.aprovadores) ? c.aprovadores : []; n.ped = +c.alcPed || 0; n.pag = +c.alcPag || 0; return n;
  }
  const pedItBruto = i => (+i.qtd || 0) * (+i.vUnit || 0), pedItDesc = i => r2(pedItBruto(i) * Math.min(100, Math.max(0, +i.pDesc || 0)) / 100);
  const pedItBase = i => r2(pedItBruto(i) - pedItDesc(i)), pedItTot = i => r2(pedItBase(i) + r2(pedItBase(i) * (+i.pIpi || 0) / 100) + (+i.vSt || 0));
  const pedTotal = p => r2((p.itens || []).reduce((s, i) => s + pedItTot(i), 0) + (+p.frete || 0) - (+p.descGeral || 0));
  function valorAlc(c, r) {
    if (c === 'ped') return pedTotal(r); const v = +r.valor || 0; if (c !== 'lanc' || r.tipo !== 'pagar' || !alcadas().frac || !r.parcId) return v;
    const k = String(r.venc || '').slice(0, 7); let s = 0;
    for (const l of col('lanc')) if (l.tipo === 'pagar' && l.status !== 'cancelado' && !l.transf && l.parcId === r.parcId && String(l.venc || '').slice(0, 7) === k) s += +l.valor || 0;
    return Math.max(v, r2(s));
  }
  const nivelDe = v => { const n = alcadas(); return v <= n.n1 ? 1 : v <= n.n2 ? 2 : 3; };
  function quemAprova(i) { const n = alcadas(); let u = []; for (let k = i; k <= 3; k++) u = u.concat(n['ap' + k] || []); u = [...new Set(u)]; if (!u.length) u = n.aprov.slice(); return u; }
  const NIV_NOME = ['', 'Nível 1 · gestor da área', 'Nível 2 · diretor', 'Nível 3 · dois aprovadores'];
  /* campos de aprovação: só mudam pela rota (ou nas transições livres listadas) */
  const PROT = { lanc: ['aprov', 'aprovParc', 'aprovReaberta'], ped: ['aprov', 'aprovParc'], aprovsol: ['status', 'aprov', 'aprovParc', 'usadoEm', 'usadoPor'], adtoit: ['status', 'aprovPor', 'aprovEm'], heaut: ['status', 'aprovPor', 'aprovEm', 'aprovObs', 'cancPor', 'cancEm'], invaj: ['status', 'aprPor', 'aprEm'] };
  const MSG_PROT = 'Aprovação só pelo botão Aprovar/Recusar: o servidor confere a alçada e registra quem decidiu.';
  function regraAprov(c, conta, req, velho, novo, ctx) {
    const campos = PROT[c]; if (!campos) return null;
    const agora = Date.now();
    if (!velho) { /* criação: nasce sem aprovação, com o autor carimbado pelo servidor */
      if (c === 'lanc' || c === 'ped') { if (novo.aprov && !(perfilEm(conta, ['admin']) && novo.aprov.por === 'omie')) delete novo.aprov; delete novo.aprovParc; delete novo.aprovReaberta; return null; }
      if (c === 'aprovsol') { if (novo.status && novo.status !== 'pendente') return erro(MSG_PROT); novo.status = 'pendente'; novo.por = conta.id; novo.em = agora; ['aprov', 'aprovParc', 'usadoEm', 'usadoPor'].forEach(k => delete novo[k]); return null; }
      if (c === 'adtoit') { if (novo.status && novo.status !== 'pendente') return erro(MSG_PROT); ['aprovPor', 'aprovEm'].forEach(k => delete novo[k]); return null; }
      if (c === 'heaut') { if (novo.status && novo.status !== 'pendente') return erro(MSG_PROT); novo.status = 'pendente'; novo.solPor = conta.id; novo.solEm = agora; ['aprovPor', 'aprovEm', 'aprovObs', 'cancPor', 'cancEm'].forEach(k => delete novo[k]); return null; }
      if (c === 'invaj') {
        novo.contPor = conta.id; novo.contEm = agora; delete novo.aprPor; delete novo.aprEm;
        if (novo.tipo === 'balanco') { novo.status = 'resumo'; return null; }
        if (novo.status === 'auto') { const lim = (() => { const v = cfgEmp().supInvLim; return v === '' || v == null || isNaN(+v) ? 300 : +v; })(); if (Math.abs(+novo.dif || 0) * (+novo.custo || 0) > lim + 1e-9) return erro('Ajuste acima do limite precisa de aprovação de outra pessoa.'); return null; }
        if (novo.status && novo.status !== 'pendente') return erro(MSG_PROT); novo.status = 'pendente'; return null;
      }
      return null;
    }
    /* contas e pedidos: mudou valor, fornecedor, vencimento ou conta → o servidor reabre a aprovação */
    if ((c === 'lanc' || c === 'ped') && (velho.aprov || velho.aprovParc) && !novo.pago) {
      const ks = c === 'lanc' ? ['parcId', 'venc', 'contaId'] : ['parcId'], tv = c === 'ped' ? pedTotal : (x => +x.valor || 0);
      if (ks.some(k => String(velho[k] || '') !== String(novo[k] || '')) || Math.abs(tv(velho) - tv(novo)) > 0.009) {
        delete novo.aprov; delete novo.aprovParc; novo.aprovReaberta = { em: agora, por: conta.id, motivo: 'alteração de valor, fornecedor, vencimento ou conta', srv: 1 };
        ctx.reaberta = true; return null;
      }
    }
    if (c === 'lanc' && !igual(velho.aprovReaberta, novo.aprovReaberta)) { if (velho.aprovReaberta !== undefined) novo.aprovReaberta = velho.aprovReaberta; else delete novo.aprovReaberta; }
    let livres = [];
    if (c === 'aprovsol' && velho.status === 'pendente' && novo.status === 'pendente' && (Math.abs((+velho.valor || 0) - (+novo.valor || 0)) > 0.009 || !igual(velho.dados, novo.dados))) { delete novo.aprovParc; livres = ['aprovParc']; } /* pedido mudou: a primeira assinatura cai */
    const mudou = campos.filter(k => !livres.includes(k) && !igual(velho[k], novo[k]));
    if (!mudou.length) return null;
    /* transições livres */
    if (c === 'aprovsol' && velho.status === 'aprovado' && novo.status === 'usado' && mudou.every(k => ['status', 'usadoEm', 'usadoPor'].includes(k))) { novo.usadoEm = agora; novo.usadoPor = conta.id; return null; }
    if (c === 'heaut' && novo.status === 'cancelada' && ['pendente', 'aprovada'].includes(velho.status) && mudou.every(k => ['status', 'cancPor', 'cancEm'].includes(k))) {
      if (velho.status === 'aprovada' && String(velho.data || '') < new Date(agora - 3 * 3600e3).toISOString().slice(0, 10)) return erro('Hora extra de dia passado não é cancelada: ela justifica as horas feitas.');
      novo.cancPor = conta.id; novo.cancEm = agora; return null;
    }
    return erro(MSG_PROT);
  }
  function rotaAprovar(conta, req, b) {
    const c = String(b.col || ''), id = String(b.id || ''), dec = b.dec === 'nao' ? 'nao' : 'sim', obs = String(b.obs || '').trim().slice(0, 500), p = c + '/' + id;
    if (!PROT[c] || !/^[\w\-.|~@+=]{1,200}$/.test(id)) return erro('Item inválido.', 400);
    if (!pode(conta, p, 'w') || !perfilPermite(conta, p, 'w')) return erro('Seu perfil não aprova este tipo de item.'); /* quem aprova é decidido pela alçada e pelas listas de cada tipo, abaixo */
    const velho = doc(p); if (!velho) return erro('Item não encontrado.', 404);
    const n = JSON.parse(JSON.stringify(velho)), agora = Date.now(), ip = ipDe(req), eu = conta.id, dono = ehDono(conta);
    const ex = b.extra && typeof b.extra === 'object' ? b.extra : {};
    let msg = dec === 'nao' ? 'Recusado.' : 'Aprovado.', parcial = false;
    if (c === 'lanc' || c === 'ped' || c === 'aprovsol') {
      if (c === 'aprovsol' && velho.status !== 'pendente') return erro('Este pedido já foi decidido.', 409);
      const v = c === 'aprovsol' ? (+velho.valor || 0) : valorAlc(c, velho), vp = c === 'ped' ? pedTotal(velho) : (+velho.valor || 0), nv = nivelDe(v), dois = nv === 3;
      if (!dono && !quemAprova(nv).includes(eu)) return erro('Este item é do ' + NIV_NOME[nv] + ': você não está entre os aprovadores desse nível.');
      const autor = c === 'aprovsol' ? (velho.por || velho.crBy || '') : (velho.crBy || '');
      if (autor && autor === eu && !dono) return erro('Quem lançou não pode aprovar o próprio lançamento.');
      const par = velho.aprovParc || null;
      if (dec !== 'nao' && par && par.por === eu) return erro('Você já deu a primeira aprovação. Falta a aprovação de outra pessoa.');
      if (dec === 'nao' && !obs) return erro('Explique o motivo da recusa.', 400);
      const ass = { por: eu, em: agora, ip, obs }; delete n.aprovParc;
      if (dec === 'nao') { n.aprov = { ok: false, por: eu, em: agora, ip, obs, valor: vp, valorAlc: v, nivel: nv, srv: 1 }; if (c === 'ped') n.status = 'cancelado'; if (c === 'aprovsol') n.status = 'recusado'; }
      else if (dois && !par) { n.aprovParc = Object.assign({ valor: vp, nivel: nv, srv: 1 }, ass); parcial = true; msg = 'Primeira aprovação registrada. Acima de ' + alcadas().n2.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) + ' falta a aprovação de outra pessoa.'; }
      else { n.aprov = { ok: true, por: eu, em: agora, ip, obs, valor: vp, valorAlc: v, nivel: nv, assin: (par ? [par] : []).concat([ass]), srv: 1 }; if (c === 'aprovsol') { n.status = 'aprovado'; msg = 'Aprovado. Quem pediu já pode concluir a operação.'; } }
      delete n.aprovReaberta;
    } else if (c === 'adtoit') {
      if (!gravaGrupo(conta, 'fin')) return erro('Só o Financeiro aprova comprovantes de prestação de contas.');
      if ((velho.status || 'pendente') !== 'pendente') return erro('Este comprovante já foi decidido.', 409);
      if (velho.crBy && velho.crBy === eu && !dono) return erro('Quem lançou o comprovante não pode aprová-lo.');
      if (dec === 'nao' && !obs) return erro('Informe o motivo.', 400);
      Object.assign(n, { status: dec === 'nao' ? 'recusado' : 'aprovado', aprovPor: eu, aprovEm: agora, aprovIp: ip });
      if (dec === 'nao') n.motivo = obs; else if (typeof ex.lancId === 'string') n.lancId = ex.lancId.slice(0, 60);
      msg = dec === 'nao' ? 'Comprovante recusado.' : 'Comprovante aprovado.';
    } else if (c === 'heaut') {
      if (velho.status !== 'pendente') return erro('Este pedido já foi tratado.', 409);
      const R = cfgEmp().rhx || {}, coord = Array.isArray(R.heCoord) ? R.heCoord : [], mat = ((cfgEmp().matFluxo || {}).aprov) || [];
      const ok = dono || (coord.length ? coord.includes(eu) : (mat.includes(eu) || gravaGrupo(conta, 'rh') || alcadas().aprov.includes(eu)));
      if (!ok) return erro('Só o coordenador aprova hora extra.');
      if (velho.solPor === eu && !dono) return erro('Quem pediu não aprova a própria hora extra.');
      if (dec === 'nao' && !obs) return erro('Informe o motivo da recusa.', 400);
      Object.assign(n, { status: dec === 'nao' ? 'recusada' : 'aprovada', aprovPor: eu, aprovEm: agora, aprovObs: obs.slice(0, 300), aprovIp: ip });
      msg = dec === 'nao' ? 'Hora extra recusada.' : 'Hora extra aprovada.';
    } else if (c === 'invaj') {
      if (velho.status !== 'pendente') return erro('Ajuste não está pendente.', 409);
      if (!gravaGrupo(conta, 'est', 'comp')) return erro('Seu perfil não aprova ajustes de estoque.');
      if (velho.contPor === eu) return erro('Quem registrou a contagem não pode aprovar o próprio ajuste. Peça a outra pessoa.');
      if (dec === 'nao' && !obs) return erro('Informe o motivo da recusa (ex.: recontar).', 400);
      Object.assign(n, { status: dec === 'nao' ? 'recusado' : 'aprovado', aprPor: eu, aprEm: agora, aprIp: ip, obs });
      if (dec !== 'nao' && typeof ex.movId === 'string') n.movId = ex.movId.slice(0, 60);
    }
    salvar(p, n, conta, req, dec === 'nao' ? 'RECUSAR' : 'APROVAR', velho);
    return { ok: true, data: n, msg, parcial };
  }

  /* =====================================================================
     3. COMPETÊNCIA FECHADA (mesmas regras de new_fis.js)
     ===================================================================== */
  const FZ_COLS = new Set(['lanc', 'notas', 'nfse', 'mov', 'fpag']);
  const FZ_META = new Set(['ts', 'cr', 'crBy', 'ed', 'edBy', 'hist', 'pub', 'pubEm', 'lido', 'lida', 'vistoEm']);
  const fzN = v => { const x = +v; return isFinite(x) ? Math.round(x * 100) / 100 : 0; };
  const fechados = () => { const s = new Set(); for (const f of col('ctbfech')) if (f.st === 'fechado' && /^\d{4}-\d{2}$/.test(String(f.mes || ''))) s.add(f.mes); return s; };
  function catMapa() { const m = new Map(); for (const c of col('cat')) if (c.nome && c.planoId) m.set(c.nome, c.planoId); return m; }
  function fzPegadas(c, r, cats) {
    const o = {}; if (!r) return o;
    const fzCat = n => { if (!n) return ''; const pl = cats().get(n); return pl ? 'pl:' + pl : String(n); };
    const LC = ['tipo', 'valor', 'retido', 'categoria', 'parcId', 'projId', 'rateio', 'guia', 'estoqueValor'], LP = ['pago', 'valorPago', 'contaId', 'juros', 'multa', 'descPago'], NUM = new Set(['valor', 'retido', 'estoqueValor', 'valorPago', 'juros', 'multa', 'descPago']);
    const fzV = (k, v) => k === 'categoria' ? fzCat(v) : NUM.has(k) ? fzN(v) : (v == null || v === false ? '' : v);
    if (c === 'lanc') {
      const canc = r.status === 'cancelado', comp = r.comp || ym(r.venc);
      if (comp) o[comp] = est(['c', canc ? 1 : 0].concat(LC.map(k => fzV(k, r[k]))));
      if (r.pago && !canc) { const m = ym(r.pago), s = est(['p', r.tipo || '', fzN(r.valor)].concat(LP.map(k => fzV(k, r[k])))); o[m] = o[m] ? o[m] + '|' + s : s; }
      return o;
    }
    let m = '';
    if (c === 'notas') { if (r.status === 'rascunho') return o; m = ym(r.emissao || r.data); }
    else if (c === 'nfse') { if (r.status === 'rascunho') return o; m = ym(r.emissaoReal || r.emissao); }
    else if (c === 'mov') m = ym(r.data);
    else if (c === 'fpag') m = String(r.comp || '').slice(0, 7);
    if (m) { const l = {}; Object.keys(r).sort().forEach(k => { if (FZ_META.has(k) || k[0] === '_' || k === 'id') return; let v = r[k]; if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) return; if (k === 'categoria') v = fzCat(v); else if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))) v = fzN(v); l[k] = v; }); o[m] = est(l); }
    return o;
  }
  function travaCompetencia(c, velho, novo) {
    if (!FZ_COLS.has(c)) return null; const Z = fechados(); if (!Z.size) return null;
    let cm = null; const cats = () => cm || (cm = catMapa());
    const a = fzPegadas(c, velho, cats), b = novo ? fzPegadas(c, novo, cats) : {};
    const ms = [...new Set(Object.keys(a).concat(Object.keys(b)))].filter(m => Z.has(m) && a[m] !== b[m]).sort();
    if (!ms.length) return null;
    return erro('A competência ' + ms.map(m => m.slice(5, 7) + '/' + m.slice(0, 4)).join(', ') + (ms.length > 1 ? ' estão fechadas' : ' está fechada') + '. Um administrador precisa reabrir em Fiscal › Fechamento e exportação, informando o motivo.', 409);
  }
  function rotaCompetencia(acao, conta, req, b) {
    const mes = String(b.mes || ''); if (!/^\d{4}-\d{2}$/.test(mes)) return erro('Competência inválida.', 400);
    const p = 'ctbfech/f' + mes, velho = doc(p), agora = Date.now(), ip = ipDe(req);
    if (acao === 'fechar') {
      if (!(ehDono(conta) || perfilEm(conta, ['admin']) || gravaGrupo(conta, 'ctb'))) return erro('Seu perfil não fecha competência.');
      const tot = b.tot && typeof b.tot === 'object' ? { deb: r2(b.tot.deb), res: r2(b.tot.res) } : (velho && velho.tot) || null;
      const n = Object.assign(velho ? JSON.parse(JSON.stringify(velho)) : { id: 'f' + mes }, { mes, st: 'fechado', em: agora, por: conta.id, ip, tot, srv: 1 });
      n.fechs = ((velho && velho.fechs) || []).concat([{ em: agora, por: conta.id, ip, motivo: String(b.motivo || '').slice(0, 300) || undefined, srv: 1 }]).slice(-50);
      salvar(p, n, conta, req, 'COMPETENCIA_FECHAR', velho); return { ok: true, data: n, msg: 'Competência ' + mes.slice(5) + '/' + mes.slice(0, 4) + ' fechada e travada.' };
    }
    if (!(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('Só um administrador (ou o dono) pode reabrir uma competência fechada.');
    if (!velho || velho.st !== 'fechado') return erro('Esta competência não está fechada.', 409);
    const mot = String(b.motivo || '').trim(); if (mot.length < 10) return erro('Explique o motivo da reabertura (pelo menos 10 caracteres).', 400);
    const n = Object.assign(JSON.parse(JSON.stringify(velho)), { st: 'reaberto', reabertoEm: agora });
    n.reab = (velho.reab || []).concat([{ em: agora, por: conta.id, ip, motivo: mot.slice(0, 500), fechadoEm: velho.em || 0, fechadoPor: velho.por || '', srv: 1 }]);
    salvar(p, n, conta, req, 'COMPETENCIA_REABRIR', velho);
    alertar('Competência reaberta', ['A competência ' + mes.slice(5) + '/' + mes.slice(0, 4) + ', fechada desde ' + new Date(velho.em || agora).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ', foi reaberta por ' + nomeConta(conta.id) + '.', 'Motivo: ' + mot.slice(0, 500), 'Enquanto estiver aberta, lançamentos, notas, NFS-e, estoque e holerites deste mês podem ser alterados. Feche de novo e reenvie à contabilidade.'], req);
    return { ok: true, data: n, msg: 'Competência reaberta. Avise a contabilidade.' };
  }

  /* =====================================================================
     8. REMESSA CNAB: SHA-256 do servidor
     ===================================================================== */
  const sha256 = t => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
  function regraRemessa(conta, velho, novo) {
    const IM = ['txt', 'hash', 'hashEm', 'hashPor', 'srvTotal', 'srvQtd', 'ids'];
    if (velho) { if (IM.some(k => !igual(velho[k], novo[k]))) return erro('O arquivo de uma remessa gerada não pode ser alterado. Cancele e gere outra.'); return null; }
    if (typeof novo.txt !== 'string' || !novo.txt) return erro('Remessa sem arquivo.', 400);
    const ids = Array.isArray(novo.ids) ? novo.ids.map(String) : [], bloq = [];
    let tot = 0;
    const A = alcadas();
    for (const id of ids) {
      const l = doc('lanc/' + id); if (!l) { bloq.push('título ' + id + ' não existe'); continue; }
      tot += +l.valor || 0; const p = l.parcId ? doc('parc/' + l.parcId) : null;
      if (l.pago) bloq.push((l.desc || id) + ': já pago');
      if (p && p.bancoPend) bloq.push((l.desc || id) + ': dados bancários de ' + (p.nome || '') + ' aguardam confirmação');
      if (A.pag > 0 && l.tipo === 'pagar' && l.status !== 'cancelado' && !l.transf && !l.adtoId && valorAlc('lanc', l) > A.pag && !(l.aprov && l.aprov.ok)) bloq.push((l.desc || id) + ': aguardando aprovação');
    }
    if (bloq.length) return erro('Remessa recusada pelo servidor: ' + bloq.slice(0, 5).join('; ') + '.', 409);
    Object.assign(novo, { hash: sha256(novo.txt), hashEm: Date.now(), hashPor: conta.id, srvTotal: r2(tot), srvQtd: ids.length, por: conta.id });
    return null;
  }
  function rotaRemessaArquivo(conta, req, res, id) {
    const p = 'remessa/' + id; if (!pode(conta, p, 'r') || !podeVer(conta, p, null, new Map())) return json(res, 403, { erro: 'Sem acesso.' });
    const r = doc(p); if (!r || !r.txt) return json(res, 404, { erro: 'Remessa não encontrada.' });
    if (!r.hash) return json(res, 409, { erro: 'Remessa gravada antes da conferência pelo servidor: gere de novo para ter o arquivo conferido.' });
    if (sha256(r.txt) !== r.hash) { auditar(conta, req, 'REMESSA_ADULTERADA', p, null, { hash: r.hash }); return json(res, 409, { erro: 'O arquivo desta remessa não confere com o gravado na geração (SHA-256). Não envie ao banco; gere outra remessa.' }); }
    auditar(conta, req, 'REMESSA_DOWNLOAD', p, null, { hash: r.hash, total: r.srvTotal, qtd: r.srvQtd });
    const b = Buffer.from(r.txt, 'utf8');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': b.length, 'content-disposition': 'attachment; filename="' + String(r.arquivo || 'remessa.txt').replace(/[^\w.\-]/g, '_') + '"', 'x-sha256': r.hash, 'x-total': String(r.srvTotal || ''), 'x-quantidade': String(r.srvQtd || ''), 'cache-control': 'no-store' });
    return res.end(b);
  }

  /* =====================================================================
     9. ASSINATURA DE EPI E CIÊNCIA DE HOLERITE
     ===================================================================== */
  function gravarImagemAssinatura(conta, img, origem) {
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(img || '')); if (!m) return null;
    const b = Buffer.from(m[2], 'base64'); if (!b.length || b.length > 1024 * 1024) return null;
    const id = uid(32).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(32, '0').slice(0, 32);
    fs.writeFileSync(path.join(DATA, 'blobs', id), b); q.arqNovo.run(id, 'image/' + m[1], b.length, conta ? conta.id : null, Date.now());
    db.prepare('UPDATE arquivos SET origem=?, restrito=1 WHERE id=?').run(origem, id); return id;
  }
  function regraAssinaturas(c, conta, velho, novo, p) {
    if (c === 'epi') {
      const va = velho ? velho.assin : null;
      if (!igual(va, novo.assin)) return erro('A assinatura da entrega de EPI só é registrada pelo botão Assinar ou pela confirmação do colaborador, e não pode ser alterada.');
    }
    if (c === 'fofi') {
      const vc = velho ? velho.ciencia : null;
      if (!igual(vc, novo.ciencia)) {
        const pdfV = velho && velho.pdf && velho.pdf.id, pdfN = novo.pdf && novo.pdf.id;
        if (novo.ciencia == null && vc && pdfV !== pdfN) { novo.cienciaHist = ((velho && velho.cienciaHist) || []).concat([vc]).slice(-10); return null; } /* holerite novo: precisa de nova ciência */
        return erro('A ciência do holerite é registrada pelo servidor quando o colaborador abre o PDF e não pode ser alterada.');
      }
      if (velho && velho.cienciaHist && !igual(velho.cienciaHist, novo.cienciaHist)) novo.cienciaHist = velho.cienciaHist;
    }
    if (c === 'pt' && /^pt\/[^/]+\/sl\/[^/]+$/.test(p)) { /* pedidos da Minha área: hora e conta de quem registrou */
      if (velho) { novo.srvEm = velho.srvEm; novo.srvPor = velho.srvPor; } else { novo.srvEm = Date.now(); novo.srvPor = conta.id; }
    }
    return null;
  }
  function rotaEpiAssinar(conta, req, b) {
    const p = 'epi/' + String(b.id || ''); if (!pode(conta, p, 'w') || !perfilPermite(conta, p, 'w') || !gravacaoPermitida(conta, p)) return erro('Seu perfil não registra entrega de EPI.');
    const e = doc(p); if (!e) return erro('Entrega não encontrada.', 404); if (e.assin) return erro('Esta entrega já está assinada.', 409);
    const anx = gravarImagemAssinatura(conta, b.img, p); if (!anx) return erro('Assinatura inválida.', 400);
    const n = Object.assign(JSON.parse(JSON.stringify(e)), { assinado: true, assin: { modo: 'tela', nome: String(b.nome || '').slice(0, 120), em: Date.now(), por: conta.id, ip: ipDe(req), anx, srv: 1 } });
    salvar(p, n, conta, req, 'EPI_ASSINAR', e); return { ok: true, data: n, msg: 'Assinatura registrada.' };
  }
  function rotaMinhaArea(conta, req, b) {
    if (!(ehDono(conta) || perfilEm(conta, ['admin', 'rh']))) return erro('Só o RH registra as confirmações da Minha área.');
    const uidc = String(b.uid || ''), sl = String(b.slId || ''); if (!/^[\w\-]{1,80}$/.test(uidc) || !/^[\w\-]{1,80}$/.test(sl)) return erro('Pedido inválido.', 400);
    const ps = 'pt/' + uidc + '/sl/' + sl, x = doc(ps); if (!x) return erro('Pedido não encontrado.', 404);
    const quando = +x.srvEm || docTs(ps), apaga = () => { q.docDel.run(ps); avisarDoc('del', ps, null, Date.now()); };
    const funcDe = fid => { const f = fid ? doc('func/' + fid) : null; return f && f.usrId === uidc ? f : null; };
    if (x.tipo === 'epiok') {
      const p = 'epi/' + String(x.epiId || ''), e = doc(p); const f = e && funcDe(e.funcId); if (!e || !f) { apaga(); return erro('A entrega não é deste colaborador.', 409); }
      if (e.assin) { apaga(); return { ok: true, data: e, msg: 'Já estava assinada.' }; }
      const n = Object.assign(JSON.parse(JSON.stringify(e)), { assinado: true, assin: { modo: 'minha_area', em: quando, uid: uidc, nome: f.nome || '', regEm: Date.now(), regPor: conta.id, srv: 1 } });
      salvar(p, n, conta, req, 'EPI_CONFIRMADO_MINHA_AREA', e); apaga(); return { ok: true, data: n };
    }
    if (x.tipo === 'holok') {
      const p = 'fofi/' + String(x.holId || ''), r = doc(p); const f = r && funcDe(r.funcId); if (!r || !f) { apaga(); return erro('O holerite não é deste colaborador.', 409); }
      if (r.ciencia) { apaga(); return { ok: true, data: r }; }
      const n = Object.assign(JSON.parse(JSON.stringify(r)), { ciencia: { em: quando, uid: uidc, pdf: r.pdf && r.pdf.id || '', regEm: Date.now(), regPor: conta.id, srv: 1 } });
      salvar(p, n, conta, req, 'HOLERITE_CIENCIA', r); apaga(); return { ok: true, data: n };
    }
    return erro('Tipo de pedido não tratado aqui.', 400);
  }

  /* =====================================================================
     4. ANEXOS
     ===================================================================== */
  function idsCitados(data) {
    const s = new Set(); let n = 0;
    const vis = (o, d) => { if (n > 5000 || d > 8 || o == null) return; if (typeof o === 'string') { if (/^[a-z0-9]{32}$/.test(o)) s.add(o); return; } if (typeof o !== 'object') return; n++;
      if (Array.isArray(o)) { o.forEach(x => vis(x, d + 1)); return; }
      for (const k of Object.keys(o)) { const v = o[k]; if (k === 'id' && d > 0 && typeof v === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(v)) s.add(v); else vis(v, d + 1); } };
    vis(data, 0); return [...s].slice(0, 300);
  }
  function atualizarCitacoes(conta, p, data) {
    try {
      const ids = data ? idsCitados(data).filter(id => st.arq.get(id)) : [], tem = new Set(ids), agora = Date.now();
      for (const r of st.citDoPath.all(p)) if (!tem.has(r.blob)) st.citDel.run(r.blob, p);
      for (const id of ids) { const a = st.arq.get(id); if (!a.origem && conta && a.por === conta.id) st.arqOrigem.run(p, id); st.citIns.run(id, p, conta ? conta.id : null, agora); }
    } catch (e) { console.error('[anexos]', e.message); }
  }
  const AREAS = new Set(['cm', 'pt', 'usrreq']);
  const contaObj = id => id ? q.contaPorId.get(id) : null;
  const ehRhOuAdmin = id => { const c = contaObj(id); return !!c && (c.nivel === 'owner' || ['admin', 'rh'].includes(perfilDe(c))); };
  function citaAinda(p, id) { const r = q.docGet.get(p); return r && r.data.includes(id) ? r : null; }
  function blobPermitido(conta, a) {
    if (!conta) return false; if (conta.nivel === 'owner' || a.por === conta.id) return !a.lixo || conta.nivel === 'owner';
    if (a.lixo) return false;
    if (a.restrito && !PERF_RH.has(perfilDe(conta))) return false;
    const memo = new Map();
    if (a.origem) { const r = citaAinda(a.origem, a.id); if (r) { let d = null; try { d = JSON.parse(r.data); } catch (e) { } if (podeVer(conta, a.origem, d, memo)) return true; } }
    for (const c of st.citDoBlob.all(a.id)) {
      if (c.path === a.origem) continue; const c0 = c.path.split('/')[0];
      let valida = c.por === a.por;
      if (!valida && (c0 === 'pt' || c0 === 'usrreq') && ehRhOuAdmin(c.por)) valida = true; /* RH publicou na Minha área do colaborador */
      if (!valida) continue;
      const r = citaAinda(c.path, a.id); if (!r) continue; let d = null; try { d = JSON.parse(r.data); } catch (e) { }
      if (podeVer(conta, c.path, d, memo)) return true;
    }
    return false;
  }
  const SENS_ANX = c0 => SENS_RH.has(c0) || ['fofi', 'epi', 'pt', 'func', 'acid', 'adtoit', 'adto'].includes(c0);
  function servirBlob(conta, req, res, id) {
    const a = st.arq.get(id); const f = a && path.join(DATA, 'blobs', a.lixo ? 'lixo' : '', id);
    if (!a || !fs.existsSync(f) || !blobPermitido(conta, a)) { res.writeHead(404); res.end(); return; }
    if (a.por !== conta.id && a.origem && SENS_ANX(a.origem.split('/')[0])) auditar(conta, req, 'ANEXO_DOWNLOAD', '/_blob/' + id, null, { origem: a.origem, tipo: a.ct });
    const ct = String(a.ct || 'application/octet-stream').toLowerCase(), ok = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|video\/(mp4|webm)|audio\/[a-z0-9.+-]+)$/.test(ct);
    res.writeHead(200, { 'content-type': ok ? ct : 'application/octet-stream', 'content-length': a.tam, 'cache-control': 'private, no-store', 'content-disposition': ok ? 'inline' : 'attachment', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" });
    fs.createReadStream(f).pipe(res);
  }
  function listarAnexos(conta, res) {
    if (conta.nivel !== 'owner') return json(res, 403, { code: 'not_granted', erro: 'Só o dono lista todos os anexos.' });
    const l = db.prepare('SELECT * FROM arquivos WHERE lixo IS NULL ORDER BY criado DESC').all();
    return json(res, 200, { assets: l.map(a => ({ id: a.id, url: '/_blob/' + a.id, contentType: a.ct, sizeBytes: a.tam, createdAt: new Date(a.criado).toISOString(), origem: a.origem || null })), usage: { files: l.length, bytes: l.reduce((s, a) => s + a.tam, 0), maxFiles: 100000, maxBytes: 50 * 1024 ** 3 } });
  }
  function excluirAnexo(conta, req, res, id) {
    const a = st.arq.get(id); if (!a || a.lixo) return json(res, 200, { deleted: true });
    if (conta.nivel !== 'owner' && a.por !== conta.id) { auditar(conta, req, 'ANEXO_EXCLUIR_NEGADO', '/api/assets/' + id, null, { origem: a.origem }); return json(res, 403, { code: 'not_granted', erro: 'Só quem enviou o arquivo ou o dono pode excluí-lo.' }); }
    try { fs.renameSync(path.join(DATA, 'blobs', id), path.join(DATA, 'blobs', 'lixo', id)); } catch (e) { }
    db.prepare('UPDATE arquivos SET lixo=?, lixoPor=? WHERE id=?').run(Date.now(), conta.id, id);
    auditar(conta, req, 'ANEXO_EXCLUIR', '/api/assets/' + id, { id, ct: a.ct, tam: a.tam, origem: a.origem, por: a.por }, { lixeira: true, apagaEm: new Date(Date.now() + LIXO_DIAS * 864e5).toISOString().slice(0, 10) });
    return json(res, 200, { deleted: true, lixeira: true });
  }
  function restaurarAnexo(conta, req, id) {
    const a = st.arq.get(id); if (!a || !a.lixo) return false;
    try { fs.renameSync(path.join(DATA, 'blobs', 'lixo', id), path.join(DATA, 'blobs', id)); } catch (e) { }
    db.prepare('UPDATE arquivos SET lixo=NULL, lixoPor=NULL WHERE id=?').run(id); auditar(conta, req, 'ANEXO_RESTAURAR', '/api/assets/' + id, null, { id }); return true;
  }
  function purgarLixo() {
    try { const lim = Date.now() - LIXO_DIAS * 864e5; for (const a of db.prepare('SELECT id FROM arquivos WHERE lixo IS NOT NULL AND lixo<?').all(lim)) { try { fs.unlinkSync(path.join(DATA, 'blobs', 'lixo', a.id)); } catch (e) { } q.arqDel.run(a.id); db.prepare('DELETE FROM blobcit WHERE blob=?').run(a.id); auditar(null, null, 'ANEXO_EXPURGO', '/api/assets/' + a.id, null, { dias: LIXO_DIAS }); } } catch (e) { }
  }
  /* migração única: anexos antigos ganham o registro de origem e as citações legítimas (chat, Minha área, pedidos) */
  (function migrarAnexos() {
    if (db.prepare("SELECT v FROM cfg WHERE k='anx_origem_v1'").get()) return;
    try {
      db.exec('BEGIN');
      const refs = db.prepare("SELECT path, data, ts FROM docs WHERE data LIKE ? ESCAPE '\\' ORDER BY ts LIMIT 200");
      for (const a of db.prepare('SELECT * FROM arquivos').all()) {
        const rs = refs.all('%' + String(a.id).replace(/[\\%_]/g, '\\$&') + '%'); let origem = null;
        for (const r of rs) { const c0 = r.path.split('/')[0]; if (!AREAS.has(c0) && c0 !== 'lixo') { origem = origem || r.path; st.citIns.run(a.id, r.path, a.por, r.ts); } }
        for (const r of rs) {
          const s = r.path.split('/'), c0 = s[0]; if (!AREAS.has(c0)) continue;
          if (s[1] === a.por || ((c0 === 'pt' || c0 === 'usrreq') && ehRhOuAdmin(a.por))) { st.citIns.run(a.id, r.path, a.por, r.ts); origem = origem || r.path; }
        }
        if (origem) st.arqOrigem.run(origem, a.id);
      }
      db.prepare("INSERT OR REPLACE INTO cfg(k,v) VALUES('anx_origem_v1',?)").run(String(Date.now()));
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } console.error('[anexos] migração:', e.message); }
  })();
  /* migração única: imagem de assinatura de EPI sai do registro e vira anexo restrito */
  (function migrarAssinaturas() {
    if (db.prepare("SELECT v FROM cfg WHERE k='epi_assin_v1'").get()) return;
    try {
      for (const r of q.colGet.all('epi')) { let d; try { d = JSON.parse(r.data); } catch (e) { continue; } if (!d || !d.assin || !d.assin.img) continue;
        const anx = gravarImagemAssinatura(d.assin.por ? { id: d.assin.por } : null, d.assin.img, 'epi/' + r.id); d.assin = Object.assign({}, d.assin); delete d.assin.img; if (anx) d.assin.anx = anx;
        q.docPut.run('epi/' + r.id, 'epi', r.id, JSON.stringify(d), Date.now()); }
      db.prepare("INSERT OR REPLACE INTO cfg(k,v) VALUES('epi_assin_v1',?)").run(String(Date.now()));
    } catch (e) { console.error('[epi] migração:', e.message); }
  })();

  /* =====================================================================
     5 e 11. LEITURA POR MÓDULO, FOLHA EM CONTAS A PAGAR E VEÍCULOS POR LOCAL
     ===================================================================== */
  const LEIT_LIVRE = new Set(['cfg', 'usr', 'cm', 'pt', 'usrreq', 'lgpdc', 'implog', 'ctbfech']);
  const VEIC_COLS = new Set(['veic', 'vsai', 'vabas', 'vman', 'multa', 'mult', 'vrota', 'ventr']);
  const permLog = db.prepare('INSERT INTO perm_log(dia,conta,perfil,col,n,ult) VALUES(?,?,?,?,1,?) ON CONFLICT(dia,conta,col) DO UPDATE SET n=n+1, ult=excluded.ult, perfil=excluded.perfil');
  function leModulo(conta, c0) {
    const pf = perfilDe(conta), pr = PERM.perfis[pf]; if (!pr || pr.w === '*' || pr.r === '*') return true;
    const gs = (PERM.leitura && PERM.leitura[c0]) || PERM.colecoes[c0]; if (!gs || !gs.length) return true;
    return gs.some(g => pr.w.includes(g) || pr.r.includes(g));
  }
  function locaisPermitidos(conta, memo) {
    const k = 'locais:' + conta.id; if (memo && memo.has(k)) return memo.get(k);
    let r = null; const pf = perfilDe(conta), pr = PERM.perfis[pf];
    if (!(conta.nivel === 'owner' || (pr && pr.w === '*'))) {
      const ls = (cfgEmp().frotaLocais || []).filter(Boolean);
      if (ls.length) { const u = col('usr').find(x => x.uid === conta.id), fs_ = col('func').filter(x => x.usrId === conta.id); r = new Set([].concat(u && u.locaisVeic || [], ...fs_.map(f => f.locaisVeic || [])).filter(l => ls.includes(l))); }
    }
    if (memo) memo.set(k, r); return r;
  }
  function veicOk(conta, c0, data, memo) {
    const perm = locaisPermitidos(conta, memo); if (!perm) return true;
    if (c0 === 'veic') return !!(data && data.local && perm.has(data.local));
    if (!data || !data.veicId) return true;
    const k = 'veic:' + data.veicId; let v; if (memo && memo.has(k)) v = memo.get(k); else { v = doc('veic/' + data.veicId); if (memo) memo.set(k, v); }
    return !!(v && v.local && perm.has(v.local));
  }
  function podeLer(conta, p, data, memo) {
    if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return true;
    const c0 = p.split('/')[0];
    if (c0 === 'lixo') { if (!data || !data.col) return true; if (data.col === 'func' && !veFuncCompleto(conta)) return false; const pp = data.col + '/' + (data.rid || 'x'); return perfilPermite(conta, pp, 'r') && podeLer(conta, pp, data.rec || null, memo); }
    if (VEIC_COLS.has(c0) && !veicOk(conta, c0, data, memo)) return false;
    if (LEIT_LIVRE.has(c0) || leModulo(conta, c0)) return true;
    const k = 'plog:' + c0; if (!memo || !memo.has(k)) { if (memo) memo.set(k, 1); try { permLog.run(new Date().toISOString().slice(0, 10), conta.id, perfilDe(conta), 'leitura:' + c0, Date.now()); } catch (e) { } }
    return MODO_LEIT !== 'bloquear';
  }
  /* contas a pagar da folha por colaborador (salário líquido, pensão): nome e valor só para quem é do RH ou da folha */
  const ehLancFolha = d => !!d && (d.sens === 'rh' || (!!d.foFunc && /^fo\|/.test(String(d.foKey || ''))));
  const LANC_SENS = ['desc', 'valor', 'valorPago', 'foFunc', 'obs', 'foKey', 'juros', 'multa', 'descPago'];
  function veFolha(conta) {
    if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return true;
    const pf = perfilDe(conta), pr = PERM.perfis[pf]; if (!pr || pr.w === '*' || pr.r === '*') return true;
    return ['folha', 'rh'].some(g => pr.w.includes(g) || pr.r.includes(g));
  }
  function redigir(conta, p, data) {
    if (!data || !/^lanc\/[^/]+$/.test(p) || !ehLancFolha(data) || veFolha(conta)) return data;
    const o = {}; for (const k of Object.keys(data)) if (!LANC_SENS.includes(k)) o[k] = data[k];
    o.desc = 'Folha de pagamento (restrito ao RH e ao Financeiro)'; o._restrito = true; return o;
  }

  /* =====================================================================
     ENTRADA: regras antes de gravar ou excluir um documento
     ===================================================================== */
  const CFG_PROT = ['alcPed', 'alcPag', 'aprovadores', 'alcNiv', 'supInvLim'];
  function excecaoGravacao(conta, p, velho, novo, m) {
    /* RH gera as contas a pagar da folha oficial (só essas, e só enquanto não pagas) */
    if (m === 'DELETE' || !/^lanc\/[^/]+$/.test(p) || !gravaGrupo(conta, 'folha') || !novo) return false;
    const fo = d => d && /^fo\|/.test(String(d.foKey || '')) && d.tipo === 'pagar' && !d.pago && !d.aprov;
    if (!fo(novo) || (velho && !fo(velho))) return false;
    if (velho) { const LIVRE = new Set(['valor', 'venc', 'desc', 'status', 'obs', 'ts', 'ed', 'edBy', 'hist', 'sens']); for (const k of new Set(Object.keys(velho).concat(Object.keys(novo)))) if (!LIVRE.has(k) && !igual(velho[k], novo[k])) return false; if (novo.status && !['aberto', 'cancelado'].includes(novo.status)) return false; }
    return true;
  }
  function antesGravar(conta, p, velho, novo, req) {
    const s = p.split('/'), c0 = s[0], ctx = { alertas: [] };
    if (c0 === 'ctbfech') return erro('Fechar e reabrir competência só pelos botões de Fiscal › Fechamento (o servidor registra quem fez e o motivo).');
    /* autor carimbado pelo servidor */
    if (!AREAS.has(c0) && c0 !== 'cfg' && c0 !== 'usr') {
      if (velho) { if (velho.crBy !== undefined) novo.crBy = velho.crBy; else delete novo.crBy; if (velho.cr !== undefined) novo.cr = velho.cr; }
      else if (novo.crBy !== undefined || s.length === 2) { novo.crBy = conta.id; if (!novo.cr) novo.cr = Date.now(); }
    }
    if (c0 === 'cfg' && !(ehDono(conta) || perfilEm(conta, ['admin']))) { const v = velho || {}; const k = CFG_PROT.find(k => !igual(v[k], novo[k])); if (k) return erro('Alçadas e aprovadores só um administrador altera.'); }
    if (c0 === 'func' && s.length === 2 && !(ehDono(conta) || perfilEm(conta, ['admin']))) { const v = velho || {}; if (v.locaisVeic !== undefined) novo.locaisVeic = v.locaisVeic; else delete novo.locaisVeic; }
    /* quem não vê a conta da folha não muda nome nem valor */
    if (c0 === 'lanc' && velho && ehLancFolha(velho) && !veFolha(conta)) { LANC_SENS.forEach(k => { if (velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; }); delete novo._restrito; }
    if (c0 === 'parc' && s.length === 2) regraParc(conta, req, velho, novo, ctx);
    let e = regraAprov(c0, conta, req, velho, novo, ctx); if (e) return e;
    if (c0 === 'remessa' && s.length === 2) { e = regraRemessa(conta, velho, novo); if (e) return e; }
    e = regraAssinaturas(c0, conta, velho, novo, p); if (e) return e;
    if (s.length === 2) { e = travaCompetencia(c0, velho, novo); if (e) return e; }
    if (c0 === 'lanc' && !velho && novo.foFunc && /^fo\|/.test(String(novo.foKey || ''))) novo.sens = 'rh';
    return { data: novo, ctx };
  }
  function antesExcluir(conta, p, velho) {
    const s = p.split('/'), c0 = s[0];
    if (c0 === 'ctbfech') return erro('Competência fechada não se exclui; use Reabrir.');
    if (!velho) return null;
    if (s.length === 2) { const e = travaCompetencia(c0, velho, null); if (e) return e; }
    if (c0 === 'remessa' && velho.status !== 'cancelada' && !(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('Cancele a remessa em vez de excluir.');
    if (c0 === 'epi' && velho.assin && !(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('Entrega de EPI assinada não pode ser excluída.');
    return null;
  }
  function depois(conta, req, metodo, p, antes, depois_, v) {
    auditar(conta, req, metodo, p, antes, depois_);
    atualizarCitacoes(conta, p, depois_);
    if (v && v.ctx) for (const a of v.ctx.alertas) alertar(a[0], a[1], req);
  }

  /* =====================================================================
     ROTAS
     ===================================================================== */
  async function rota(p, m, req, res, conta, u) {
    const R = async fn => { const b = await lerJson(req); const r = fn(b); if (r.erro) return json(res, r.st || 403, { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : 'not_granted', erro: r.erro }); return json(res, 200, r); };
    if (m === 'POST' && (p === '/api/aprovar')) { await R(b => rotaAprovar(conta, req, b)); return true; }
    if (m === 'POST' && (p === '/api/fin/banco/confirmar' || p === '/api/fin/banco/recusar')) { await R(b => rotaBanco(p.endsWith('confirmar') ? 'confirmar' : 'recusar', conta, req, b)); return true; }
    if (m === 'POST' && (p === '/api/competencia/fechar' || p === '/api/competencia/reabrir')) { await R(b => rotaCompetencia(p.endsWith('fechar') ? 'fechar' : 'reabrir', conta, req, b)); return true; }
    if (m === 'POST' && p === '/api/epi/assinar') { await R(b => rotaEpiAssinar(conta, req, b)); return true; }
    if (m === 'POST' && p === '/api/minha-area/confirmar') { await R(b => rotaMinhaArea(conta, req, b)); return true; }
    const mr = p.match(/^\/api\/remessa\/([\w\-.|~@+=]{1,200})\/arquivo$/); if (mr && m === 'GET') { rotaRemessaArquivo(conta, req, res, mr[1]); return true; }
    if (p === '/contas/auditoria' && m === 'GET') { if (conta.nivel !== 'owner') { res.writeHead(303, { location: '/' }); res.end(); return true; } X.html(res, 200, pagAuditoria(conta, u)); return true; }
    if (p === '/contas/auditoria/anexo' && m === 'POST') {
      if (conta.nivel !== 'owner') { res.writeHead(303, { location: '/' }); res.end(); return true; }
      const f = Object.fromEntries(new URLSearchParams((await X.lerCorpo(req, 10000)).toString('utf8'))); const ok = restaurarAnexo(conta, req, String(f.id || '').replace(/[^A-Za-z0-9_-]/g, ''));
      res.writeHead(303, { location: '/contas/auditoria?m=' + encodeURIComponent(ok ? 'Anexo restaurado.' : 'Anexo não está na lixeira.') }); res.end(); return true;
    }
    return false;
  }
  function pagAuditoria(eu, u) {
    const g = k => String(u.searchParams.get(k) || '').trim();
    const f = { conta: g('conta'), cam: g('cam'), met: g('met'), de: g('de'), ate: g('ate'), pg: Math.max(0, +g('pg') || 0) };
    const w = [], a = [];
    if (f.conta) { w.push('conta=?'); a.push(f.conta); }
    if (f.cam) { w.push("caminho LIKE ? ESCAPE '\\'"); a.push('%' + f.cam.replace(/[\\%_]/g, '\\$&') + '%'); }
    if (f.met) { w.push('metodo LIKE ?'); a.push(f.met.toUpperCase() + '%'); }
    const dt = (s, fim) => { const t = Date.parse(s + 'T' + (fim ? '23:59:59.999' : '00:00:00') + '-03:00'); return isFinite(t) ? t : null; };
    if (f.de && dt(f.de)) { w.push('ts>=?'); a.push(dt(f.de)); } if (f.ate && dt(f.ate, 1)) { w.push('ts<=?'); a.push(dt(f.ate, 1)); }
    const wh = w.length ? ' WHERE ' + w.join(' AND ') : '', N = 200;
    const tot = db.prepare('SELECT count(*) AS n FROM auditoria' + wh).get(...a).n, ls = db.prepare('SELECT * FROM auditoria' + wh + ' ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?').all(...a, N, f.pg * N);
    const quando = t => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), cs = q.contas.all();
    const fmt = t => { if (!t) return ''; try { return esc(JSON.stringify(JSON.parse(t), null, 1)); } catch (e) { return esc(t); } };
    const qs = o => Object.entries(Object.assign({}, f, o)).filter(([k, v]) => v !== '' && v != null && !(k === 'pg' && !v)).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const lixo = db.prepare('SELECT * FROM arquivos WHERE lixo IS NOT NULL ORDER BY lixo DESC LIMIT 50').all();
    const msg = u.searchParams.get('m');
    return pag('Auditoria', '<nav><a class="btn" href="/">← Voltar ao sistema</a><a class="btn" href="/contas">Contas de acesso</a><a class="btn" href="/sair">Sair</a></nav><h1>Auditoria</h1><p class="sub">Tudo o que foi gravado ou excluído, entradas e falhas de login, ações de conta, duas etapas, downloads de anexos sensíveis, backups, aprovações e alertas. Gravado pelo servidor; guardado por ' + AUD_DIAS + ' dias. Só o dono vê esta página.</p>' + (msg ? '<div class="msg">' + esc(msg) + '</div>' : '') +
      '<div class="card"><form method="get" action="/contas/auditoria"><div class="row"><label>Pessoa<select name="conta"><option value="">Todas</option>' + cs.map(c => '<option value="' + esc(c.id) + '"' + (c.id === f.conta ? ' selected' : '') + '>' + esc(c.nome || c.email || c.id) + '</option>').join('') + '</select></label><label>Caminho contém<input name="cam" value="' + esc(f.cam) + '" placeholder="ex.: parc/, lanc/, /login"></label><label>Ação começa com<input name="met" value="' + esc(f.met) + '" placeholder="ex.: PUT, DELETE, LOGIN, APROVAR"></label></div><div class="row"><label>De<input type="date" name="de" value="' + esc(f.de) + '"></label><label>Até<input type="date" name="ate" value="' + esc(f.ate) + '"></label><div><button class="pri" type="submit">Filtrar</button> <a class="btn" href="/contas/auditoria">Limpar</a></div></div></form></div>' +
      '<div class="card"><h2>' + tot + ' registro(s)' + (tot > N ? ' · página ' + (f.pg + 1) + ' de ' + Math.ceil(tot / N) : '') + '</h2><div style="overflow-x:auto"><table><thead><tr><th>Quando</th><th>Pessoa</th><th>Endereço</th><th>Ação</th><th>Caminho</th><th>Detalhes</th></tr></thead><tbody>' +
      ls.map(r => '<tr><td style="white-space:nowrap">' + quando(r.ts) + '</td><td>' + esc(r.conta ? nomeConta(r.conta) : '—') + '</td><td>' + esc(r.ip || '') + '</td><td>' + esc(r.metodo) + '</td><td style="word-break:break-all">' + esc(r.caminho) + '</td><td>' + (r.antes || r.depois ? '<details><summary>ver</summary>' + (r.antes ? '<div class="sub">Antes</div><pre style="white-space:pre-wrap;max-width:520px;font-size:12px">' + fmt(r.antes) + '</pre>' : '') + (r.depois ? '<div class="sub">Depois</div><pre style="white-space:pre-wrap;max-width:520px;font-size:12px">' + fmt(r.depois) + '</pre>' : '') + '</details>' : '') + '</td></tr>').join('') +
      '</tbody></table></div>' + (tot > N ? '<p>' + (f.pg > 0 ? '<a class="btn" href="/contas/auditoria?' + qs({ pg: f.pg - 1 }) + '">← Mais recentes</a> ' : '') + ((f.pg + 1) * N < tot ? '<a class="btn" href="/contas/auditoria?' + qs({ pg: f.pg + 1 }) + '">Mais antigos →</a>' : '') + '</p>' : '') + '</div>' +
      '<div class="card"><h2>Lixeira de anexos</h2><p class="sub" style="margin:0 0 10px">Anexos excluídos ficam aqui por ' + LIXO_DIAS + ' dias e depois são apagados de vez.</p>' + (lixo.length ? '<table><thead><tr><th>Arquivo</th><th>Origem</th><th>Enviado por</th><th>Excluído</th><th></th></tr></thead><tbody>' + lixo.map(x => '<tr><td>' + esc(x.id) + '<div class="sub">' + esc(x.ct || '') + ' · ' + Math.round((x.tam || 0) / 1024) + ' KB</div></td><td>' + esc(x.origem || '—') + '</td><td>' + esc(nomeConta(x.por)) + '</td><td>' + quando(x.lixo) + '<div class="sub">por ' + esc(nomeConta(x.lixoPor)) + '</div></td><td><form method="post" action="/contas/auditoria/anexo"><input type="hidden" name="id" value="' + esc(x.id) + '"><button type="submit">Restaurar</button></form></td></tr>').join('') + '</tbody></table>' : '<p class="sub" style="margin:0">Vazia.</p>') + '</div>');
  }

  return { podeLer, redigir, antesGravar, antesExcluir, depois, excecaoGravacao, auditar, auditarHttp, rota, servirBlob, listarAnexos, excluirAnexo, MODO_LEIT };
};

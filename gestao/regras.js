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
   11. veículos filtrados pelos locais da frota do usuário.
   v111 (relatorios/processos_v2.md): conta a pagar acima da alçada só é baixada com aprovação válida (ou pela
   conciliação, como "pago sem aprovação"); remessa barra nota com divergência e empreiteiro com documentação pendente;
   decisões protegidas (divergência da nota, cancelamento de NFS-e, medições ao cliente e de empreiteiro, liberação da
   diretoria); senha de novo nas ações financeiras; folha oficial e ponto na trava; matriz de aprovadores com
   substitutos; aviso diário ao aprovador; dados bancários ocultos fora do Financeiro; link público da pesquisa de
   satisfação; prestação de contas pela Minha área. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function (X) {
  const { db, q, json, lerJson, avisarDoc, perfilDe, perfilEm, NIV, EMAIL, ipDe, PERM, APP_URL, esc, pag, DATA, uid, cookies, SEG, SENS_RH, PERF_RH } = X;
  const END = X.END || { reautenticado: () => true, exigirReauth: () => false };
  /* v114: papel do perfil (o Gestor de SST tem o papel 'sst') e definição do perfil (inclui os personalizados) */
  const papelDe = X.papelDe || (pf => pf), defDe = conta => (conta && PERM.perfis[perfilDe(conta)]) || null;
  const papelConta = conta => !conta ? '' : conta.nivel === 'owner' ? 'admin' : papelDe(perfilDe(conta));
  const veRh = c => X.veRh ? X.veRh(c) : PERF_RH.has(perfilDe(c));
  /* v114: perfil personalizado que grava o módulo g (com a opção pedida, quando houver) */
  const cuGrava = (conta, g, opc) => { const d = defDe(conta); return !!(d && d.custom && (d.w || []).includes(g) && (!opc || d[opc] === true)); };
  /* v114: grava a coleção c respeitando o "so" do perfil (o Almoxarife grava em Compras, mas não cotações) */
  const gravaCol = (conta, c) => { if (ehDono(conta)) return true; const pr = defDe(conta); if (!pr) return false; if (pr.w === '*') return true; const gs = PERM.colecoes[c] || []; return gs.some(g => (pr.w || []).includes(g) && !(pr.so && Array.isArray(pr.so[g]) && !pr.so[g].includes(c))); };
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
  /* v112: privacidade (auditoria só com campos alterados e dados protegidos, leitura de saúde, relatório do titular, IA) */
  const PRIV = require('./privacidade.js')({ db, q, perfilDe, NIV, ipDe });
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
  /* v112: só os campos alterados; CPF, dados bancários, salário e valores de folha e campos de saúde protegidos (hash) */
  function auditar(conta, req, metodo, caminho, antes, depois) {
    try {
      const priv = /^cm\/[^/]+\/(m|v)\//.test(String(caminho || '')); /* conteúdo do chat não vai para a auditoria */
      const [a, b] = priv ? [null, null] : PRIV.paraAuditoria(caminho, metodo, antes, depois);
      st.aud.run(Date.now(), conta ? (conta.id || conta) : null, req ? ipDe(req) : null, String(metodo || ''), String(caminho || '').slice(0, 400), priv ? (antes ? '"(mensagem)"' : null) : PRIV.corta(a), priv ? (depois ? '"(mensagem)"' : null) : PRIV.corta(b));
    } catch (e) { console.error('[auditoria]', e.message); }
  }
  PRIV.migrarAuditoria(); /* v112: registros antigos (documento inteiro) passam a ter só os campos alterados, protegidos */
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
  db.exec('CREATE TABLE IF NOT EXISTS alerta_fila(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, assunto TEXT, linhas TEXT)');
  function alertar(assunto, linhas, req, op) {
    if (!ALERTAS) return;
    if (op && op.resumo) { db.prepare('INSERT INTO alerta_fila(ts,assunto,linhas) VALUES(?,?,?)').run(Date.now(), String(assunto), JSON.stringify(linhas || [])); auditar(null, req, 'ALERTA_EMAIL_RESUMO_FILA', assunto, null, { linhas }); return; }
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
  /* v111: quem vê dados bancários (fornecedores e remessa): dono, Administrador, Diretoria e quem grava no Financeiro */
  function veBanco(conta) {
    if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return true;
    const pf = perfilDe(conta), pp = papelDe(pf); if (pp === 'admin' || pp === 'diretoria') return true;
    const pr = PERM.perfis[pf]; if (pr && pr.custom) return pr.banco === true; /* v114: perfil personalizado só com "ver dados bancários" */
    return !!pr && (pr.w === '*' || (pr.w || []).includes('fin'));
  }
  function regraParc(conta, req, velho, novo, ctx) {
    const ov = velho || {};
    /* quem não vê os dados bancários manda o cadastro sem eles: campo vazio = "não mexi" */
    if (velho && !veBanco(conta)) { FIN_BK.forEach(k => { if (novo[k] == null || novo[k] === '') { if (ov[k] !== undefined) novo[k] = ov[k]; else delete novo[k]; } }); delete novo._bancoOculto; delete novo._bancoPendente; }
    const nb = bk(novo), ob = bk(ov);
    let desejo = null;
    if (bkKey(nb) !== bkKey(ob)) desejo = nb;
    else if (novo.bancoPend && typeof novo.bancoPend === 'object') { const pb = bk(novo.bancoPend); if (bkKey(pb) !== bkKey(bk(ov.bancoPend || {})) && bkKey(pb) !== bkKey(ob)) desejo = pb; }
    /* o que vale é o que o servidor tem: dados atuais, pendência e histórico */
    FIN_BK.forEach(k => { if (ov[k] !== undefined) novo[k] = ov[k]; else delete novo[k]; });
    ['bancoPend', 'bancoHist'].forEach(k => { if (ov[k] !== undefined) novo[k] = ov[k]; else delete novo[k]; });
    /* v111: cliente não recebe pagamento: dados bancários de cliente valem direto (com histórico) */
    if (novo.tipo === 'cliente' && (!velho || ov.tipo === 'cliente')) {
      if (!desejo) return;
      FIN_BK.forEach(k => { novo[k] = desejo[k] || ''; }); delete novo.bancoPend;
      novo.bancoHist = (ov.bancoHist || []).concat([{ antes: ob, depois: bk(desejo), pedidoPor: conta.id, pedidoEm: Date.now(), obs: 'Dados bancários de cliente gravados direto (cliente não recebe pagamento)', res: 'cliente', srv: 1 }]).slice(-20);
      return;
    }
    /* virou fornecedor (ou "ambos") com dados de cliente nunca confirmados: passam a esperar a confirmação */
    if (velho && ov.tipo === 'cliente' && novo.tipo !== 'cliente' && !bkVazio(ob)) {
      FIN_BK.forEach(k => { novo[k] = ''; }); if (!desejo || bkVazio(desejo)) desejo = ob;
      novo.bancoPend = Object.assign(bk(desejo), { por: conta.id, em: Date.now(), ip: req ? ipDe(req) : '', srv: 1 });
      ctx.alertas.push(['Cliente virou fornecedor com dados bancários', ['O cadastro de ' + (novo.nome || ov.nome || '') + ' passou a ser de fornecedor por ' + nomeConta(conta.id) + '.', 'Dados: ' + bkTxt(desejo) + '.', 'Os pagamentos ficam bloqueados até outra pessoa do Financeiro confirmar por telefone.']]);
      return;
    }
    if (!desejo) return;
    if (bkVazio(desejo)) { /* apagar os dados bancários não desvia pagamento: vale na hora, com registro */
      if (!velho || bkVazio(ob)) return;
      FIN_BK.forEach(k => { novo[k] = ''; }); delete novo.bancoPend;
      novo.bancoHist = (ov.bancoHist || []).concat([{ antes: ob, depois: bk({}), pedidoPor: conta.id, pedidoEm: Date.now(), obs: 'Dados bancários removidos por ' + nomeConta(conta.id), res: 'removido', srv: 1 }]).slice(-20);
      return;
    }
    novo.bancoPend = Object.assign(desejo, { por: conta.id, em: Date.now(), ip: req ? ipDe(req) : '', srv: 1 });
    /* v111: cadastro novo de dados bancários vai para o resumo diário; troca de dados existentes avisa na hora */
    if (bkVazio(ob)) { ctx.alertas.push(['Cadastro de dados bancários', ['Novo cadastro de dados bancários de ' + (novo.nome || ov.nome || 'um fornecedor') + ' por ' + nomeConta(conta.id) + ': ' + bkTxt(desejo) + '.'], { resumo: true }]); return; }
    ctx.alertas.push(['Troca de dados bancários pedida', ['Foi pedida a troca dos dados bancários de ' + (novo.nome || ov.nome || 'um cadastro') + ' por ' + nomeConta(conta.id) + '.', 'Hoje: ' + bkTxt(ob) + '.', 'Pedido: ' + bkTxt(desejo) + '.', 'A troca só vale depois que outra pessoa do Financeiro confirmar por telefone. Enquanto isso, os pagamentos a este cadastro ficam bloqueados.']]);
  }
  function rotaBanco(acao, conta, req, b) {
    if (!perfilEm(conta, ['admin', 'financeiro']) && !cuGrava(conta, 'fin', 'banco')) return erro('Só o Financeiro ou um administrador confirma dados bancários.'); /* v114: ou personalizado que grava o Financeiro e vê dados bancários */
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
    if (!END.reautenticado(req)) return { reauth: true }; /* v111: confirmar dados bancários pede a senha de novo */
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
  const ALC_DEF = { n1: 10000, n2: 100000, frac: true }; /* v111: faixas para o porte da empresa (como o navegador) */
  function alcadas() {
    const c = cfgEmp(), x = c.alcNiv || {}, n = Object.assign({}, ALC_DEF, x);
    ['ap1', 'ap2', 'ap3'].forEach(k => { if (!Array.isArray(n[k])) n[k] = []; });
    n.n1 = +n.n1 > 0 ? +n.n1 : ALC_DEF.n1; n.n2 = +n.n2 > n.n1 ? +n.n2 : Math.max(n.n1, ALC_DEF.n2); n.frac = n.frac !== false;
    n.aprov = Array.isArray(c.aprovadores) ? c.aprovadores : []; n.ped = +c.alcPed || 0; n.pag = +c.alcPag || 0; return n;
  }
  const pedItBruto = i => (+i.qtd || 0) * (+i.vUnit || 0), pedItDesc = i => r2(pedItBruto(i) * Math.min(100, Math.max(0, +i.pDesc || 0)) / 100);
  const pedItBase = i => r2(pedItBruto(i) - pedItDesc(i)), pedItTot = i => r2(pedItBase(i) + r2(pedItBase(i) * (+i.pIpi || 0) / 100) + (+i.vSt || 0));
  const pedTotal = p => r2((p.itens || []).reduce((s, i) => s + pedItTot(i), 0) + (+p.frete || 0) - (+p.descGeral || 0));
  /* v111: a soma do mês por fornecedor vale só para lançamentos manuais; os que vêm de pedido, nota, medição, folha,
     adiantamento e os pagamentos obrigatórios (folha, guias, tributos) já têm a regra da origem */
  const lancManual = l => !['obrig', 'aprovHerdada', 'medempId', 'ctrempId', 'pedId', 'notaId', 'adtoId', 'foKey', 'folhaId', 'fpagId', 'guia', 'impLote'].some(k => l[k]);
  function valorAlc(c, r) {
    if (c === 'ped') return pedTotal(r); const v = +r.valor || 0; if (c !== 'lanc' || r.tipo !== 'pagar' || !alcadas().frac || !r.parcId || !lancManual(r)) return v;
    const k = String(r.venc || '').slice(0, 7); let s = 0;
    for (const l of col('lanc')) if (l.tipo === 'pagar' && l.status !== 'cancelado' && !l.transf && l.parcId === r.parcId && String(l.venc || '').slice(0, 7) === k && lancManual(l)) s += +l.valor || 0;
    return Math.max(v, r2(s));
  }
  const nivelDe = v => { const n = alcadas(); return v <= n.n1 ? 1 : v <= n.n2 ? 2 : 3; };
  /* v111: matriz única de aprovadores (cfg.aprovMatriz = {n1,n2,n3,diretoria,rh,compras}) e substitutos por período
     (cfg.aprovSubst = [{de,para,ini,fim,motivo}]), como aprovadoresDe() do navegador. Sem matriz, valem as listas antigas. */
  const lista = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
  const hojeSP = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  /* substitutos ativos (ini <= hoje <= fim) de quem está na base; de:'dono' vale para n1, n2 e diretoria; papeis:[...] limita */
  function comSubst(base, papel) {
    const h = hojeSP(), out = new Set(base), ss = cfgEmp().aprovSubst;
    for (const s of Array.isArray(ss) ? ss : []) {
      if (!s || !s.de || !s.para || (s.ini && String(s.ini) > h) || (s.fim && h > String(s.fim))) continue;
      if (Array.isArray(s.papeis) && s.papeis.length && papel && !s.papeis.includes(papel)) continue;
      if (base.includes(s.de) || (s.de === 'dono' && (!papel || ['n1', 'n2', 'diretoria'].includes(papel)))) out.add(String(s.para));
    }
    return [...out];
  }
  const matrizN = () => { const M = cfgEmp().aprovMatriz || {}; return ['n1', 'n2', 'n3'].some(k => lista(M[k]).length) ? M : null; };
  function aprovadoresDe(papel) {
    const c = cfgEmp(), M = c.aprovMatriz || {}, n = c.alcNiv || {};
    let base = lista(M[papel]);
    if (!base.length) {
      if (/^n[123]$/.test(papel)) base = lista(n['ap' + papel[1]]);
      else if (papel === 'diretoria') base = lista((c.rhx || {}).diretores);
      else if (papel === 'rh') base = lista((c.rhx || {}).heCoord);
      else if (papel === 'compras') base = lista((c.matFluxo || {}).aprov);
    }
    return comSubst(base, papel);
  }
  /* quem aprova o nível i: os aprovadores do nível e dos acima (com os substitutos ativos) */
  function quemAprova(i) {
    let u = []; for (let k = i; k <= 3; k++) u = u.concat(aprovadoresDe('n' + k)); u = [...new Set(u)];
    return u.length ? u : comSubst(alcadas().aprov, 'n' + i);
  }
  const ehDiretor = conta => !!conta && (ehDono(conta) || papelConta(conta) === 'diretoria' || !!((defDe(conta) || {}).custom && defDe(conta).aprovDir) || (aprovadoresDe('diretoria').length ? aprovadoresDe('diretoria') : comSubst(alcadas().aprov, 'diretoria')).includes(conta.id));
  const todosAprovadores = () => [...new Set(quemAprova(1).concat(comSubst(alcadas().aprov, 'n1')))];
  const NIV_NOME = ['', 'Nível 1 · gestor da área', 'Nível 2 · diretor', 'Nível 3 · dois aprovadores'];
  /* campos de aprovação: só mudam pela rota (ou nas transições livres listadas) */
  const PROT = { lanc: ['aprov', 'aprovParc', 'aprovReaberta'], ped: ['aprov', 'aprovParc'], aprovsol: ['status', 'aprov', 'aprovParc', 'usadoEm', 'usadoPor'], adtoit: ['status', 'aprovPor', 'aprovEm'], heaut: ['status', 'aprovPor', 'aprovEm', 'aprovObs', 'cancPor', 'cancEm'], invaj: ['status', 'aprPor', 'aprEm'] };
  const MSG_PROT = 'Aprovação só pelo botão Aprovar/Recusar: o servidor confere a alçada e registra quem decidiu.';
  function regraAprov(c, conta, req, velho, novo, ctx) {
    const campos = PROT[c]; if (!campos) return null;
    const agora = Date.now();
    if (!velho) { /* criação: nasce sem aprovação, com o autor carimbado pelo servidor */
      if (c === 'lanc' || c === 'ped') { if (novo.aprov && !(perfilEm(conta, ['admin']) && novo.aprov.por === 'omie' && !cfgEmp().omieCorte)) delete novo.aprov; delete novo.aprovParc; delete novo.aprovReaberta; return null; }
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
    if ((!PROT[c] && c !== 'notas') || !/^[\w\-.|~@+=]{1,200}$/.test(id)) return erro('Item inválido.', 400);
    if (!pode(conta, p, 'w') || !perfilPermite(conta, p, 'w')) return erro('Seu perfil não aprova este tipo de item.'); /* quem aprova é decidido pela alçada e pelas listas de cada tipo, abaixo */
    const velho = doc(p); if (!velho) return erro('Item não encontrado.', 404);
    const n = JSON.parse(JSON.stringify(velho)), agora = Date.now(), ip = ipDe(req), eu = conta.id, dono = ehDono(conta);
    const ex = b.extra && typeof b.extra === 'object' ? b.extra : {};
    let msg = dec === 'nao' ? 'Recusado.' : 'Aprovado.', parcial = false;
    if (c === 'notas') { /* v111: divergência da nota (comprador e gestor, pessoas diferentes, e não quem lançou a nota) */
      const papel = ex.papel === 'comp' || ex.papel === 'gest' ? ex.papel : ''; if (!papel) return erro('Informe o papel (comprador ou gestor).', 400);
      if (dec === 'nao') return erro('Para recusar a divergência, devolva a nota ao comprador ou cancele o lançamento.', 400);
      if (velho.crBy && velho.crBy === eu && !dono) return erro('Quem lançou a nota não aprova a divergência dela. Peça a outra pessoa.');
      if (papel === 'comp' && !gravaCol(conta, 'cot')) return erro('Só quem faz as compras (grava cotações) dá a aprovação do comprador.'); /* v114: o Almoxarife não aprova como comprador */
      if (papel === 'gest' && !podeGestorNota(conta, velho)) return erro('Esta aprovação é do solicitante da compra, de um aprovador das alçadas, da diretoria ou do dono.');
      if (papel === 'comp' && !obs) return erro('Explique por que a divergência pode ser aceita.', 400);
      const sig = typeof ex.sig === 'string' ? ex.sig.slice(0, 20000) : '', a0 = velho.confAprov && velho.confAprov.sig === sig ? velho.confAprov : { sig };
      if (a0[papel]) return erro('Esta aprovação já foi dada.', 409);
      const outro = a0[papel === 'comp' ? 'gest' : 'comp']; if (outro && outro.por === eu) return erro('As duas aprovações da divergência precisam ser de pessoas diferentes.');
      n.confAprov = Object.assign({}, a0, { sig, [papel]: carimbo(conta, req, { obs }) });
      if (confOk(n.confAprov)) { n.confPend = false; msg = 'Divergência aprovada pelas duas pessoas.'; } else msg = 'Aprovação registrada. Falta a ' + (papel === 'comp' ? 'do gestor' : 'do comprador') + '.';
    } else if (c === 'lanc' || c === 'ped' || c === 'aprovsol') {
      if (c === 'aprovsol' && velho.status !== 'pendente') return erro('Este pedido já foi decidido.', 409);
      const v = c === 'aprovsol' ? (+velho.valor || 0) : valorAlc(c, velho), vp = c === 'ped' ? pedTotal(velho) : (+velho.valor || 0), nv = c === 'lanc' && velho.obrig ? Math.min(2, nivelDe(v)) : nivelDe(v), dois = nv === 3; /* v111: pagamento obrigatório (folha, guias, tributos): nível até 2, um aprovador */
      if (!dono && !quemAprova(nv).includes(eu)) return erro('Este item é do ' + NIV_NOME[nv] + ': você não está entre os aprovadores desse nível.');
      const autor = c === 'aprovsol' ? (velho.por || velho.crBy || '') : (velho.crBy || '');
      if (autor && autor === eu && !dono) return erro('Quem lançou não pode aprovar o próprio lançamento.');
      const par = velho.aprovParc || null;
      if (dec !== 'nao' && par && par.por === eu) return erro('Você já deu a primeira aprovação. Falta a aprovação de outra pessoa.');
      if (dec === 'nao' && !obs) return erro('Explique o motivo da recusa.', 400);
      if (dec !== 'nao' && nv === 3 && !END.reautenticado(req)) return { reauth: true }; /* v111: aprovar no nível 3 pede a senha de novo */
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
     v111. BAIXA DE CONTA A PAGAR ACIMA DA ALÇADA (achado F1)
     Vale: aprovação registrada pela rota; aprovação herdada conferida (pedido aprovado ou medição aprovada, com o valor
     dentro do aprovado + tolerância cfg.aprovHerdTol %, padrão 2); pagamento obrigatório com um aprovador. Sem isso, o
     servidor recusa "pago", menos na conciliação (concExt = linha do extrato da mesma conta e do mesmo valor), que
     grava pagoSemAprov=true; e na importação do Omie pelo Administrador. Estorno é livre.
     ===================================================================== */
  const tolHerd = () => { const t = cfgEmp().supTolPreco; return (t === '' || t == null || !isFinite(+t) || +t < 0 ? 2 : +t) / 100; };
  function herancaOk(l) {
    const h = l && l.aprovHerdada; if (!h || typeof h !== 'object' || !h.id || !/^[\w\-.|~@+=]{1,200}$/.test(String(h.id))) return false;
    const soma = (k, v) => r2(col('lanc').filter(x => x.id !== l.id && x.status !== 'cancelado' && x.tipo === 'pagar' && String(x[k] || '') === String(v)).reduce((s, x) => s + (+x.valor || 0), 0) + (+l.valor || 0));
    if (h.tipo === 'ped') {
      const p = doc('ped/' + h.id); if (!p || !(p.aprov && p.aprov.ok) || p.status === 'cancelado') return false;
      if (l.parcId && p.parcId && l.parcId !== p.parcId) return false;
      const n = l.notaId ? doc('notas/' + l.notaId) : null; if (!n || n.pedId !== h.id || (n.confPend && !confOk(n.confAprov))) return false;
      return soma('notaId', l.notaId) <= (+p.aprov.valor || pedTotal(p)) * (1 + tolHerd()) + 0.01;
    }
    if (h.tipo === 'medemp') {
      const m = doc('medemp/' + h.id); if (!m || m.status !== 'aprovada' || (l.medempId && l.medempId !== h.id)) return false;
      const c = m.ctrId ? doc('ctremp/' + m.ctrId) : null; if (l.parcId && c && c.parcId && l.parcId !== c.parcId) return false;
      const fx = m.fixo || {}, teto = +fx.bruto || ((+fx.liq || 0) + (+fx.ret || 0) + (+fx.inss || 0) + (+fx.iss || 0));
      return !teto || soma('medempId', h.id) <= teto * (1 + tolHerd()) + 0.01;
    }
    if (h.tipo === 'ctr') { const c = doc('ctremp/' + h.id) || doc('ctr/' + h.id); if (!c || !(c.aprov && c.aprov.ok)) return false; return !(l.parcId && c.parcId && l.parcId !== c.parcId); }
    return false;
  }
  const aprovacaoValida = l => !!(l && ((l.aprov && l.aprov.ok) || (l.obrig && l.aprovParc) || herancaOk(l)));
  function precisaAprovPag(l) { const A = alcadas(); return A.pag > 0 && l.tipo === 'pagar' && l.status !== 'cancelado' && !l.transf && !l.adtoId && valorAlc('lanc', l) > A.pag; }
  function regraPago(conta, p, velho, novo) {
    const v = velho || {};
    /* pagoSemAprov é carimbado pelo servidor: ninguém põe nem tira por fora */
    ['pagoSemAprov', 'pagoSemAprovSrv'].forEach(k => { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; });
    if (v.pago && !novo.pago) { delete novo.pagoSemAprov; delete novo.pagoSemAprovSrv; return null; } /* estorno */
    if (!novo.pago || v.pago || novo.tipo !== 'pagar') return null;
    if (!precisaAprovPag(novo) || aprovacaoValida(novo)) return null;
    const id = p.split('/')[1];
    if (perfilEm(conta, ['admin']) && (novo.impLote || v.impLote) && /^o[0-9a-f]{11}$/.test(id)) return null; /* importação do Omie (Administrador) */
    if (novo.concExt) {
      const e = doc('extrato/' + String(novo.concExt)), vp = Math.abs(+novo.valorPago || +novo.valor || 0);
      const ids = e && Array.isArray(e.lancIds) ? e.lancIds.map(String) : null;
      const somaIds = ids && ids.includes(id) ? r2(ids.reduce((s, x) => s + (x === id ? vp : Math.abs(+((doc('lanc/' + x) || {}).valorPago) || +((doc('lanc/' + x) || {}).valor) || 0)), 0)) : null;
      const valorOk = e && (Math.abs(Math.abs(+e.valor || 0) - vp) <= 0.01 || (somaIds != null && Math.abs(Math.abs(+e.valor || 0) - somaIds) <= 0.05));
      if (e && e.contaId && novo.contaId && e.contaId === novo.contaId && valorOk && (!e.lancId || e.lancId === id || (ids && ids.includes(id)))) {
        novo.pagoSemAprov = true; novo.pagoSemAprovSrv = { por: conta.id, em: Date.now(), ext: String(novo.concExt), valor: r2(vp), srv: 1 }; return null;
      }
      return erro('A linha do extrato informada não confere com esta conta (outra conta bancária, outro valor ou já conciliada com outro título). Baixa recusada pelo servidor.', 409);
    }
    return erro('Conta a pagar acima da alçada sem aprovação: o servidor não aceita a baixa. Aprove em Início › Aprovações. Se o pagamento já saiu pelo banco, concilie pela linha do extrato (fica registrado como "pago sem aprovação").', 409);
  }

  /* =====================================================================
     v111. DECISÕES PROTEGIDAS (achados S2, C1, I2): quem lança não aprova e o servidor carimba quem decidiu.
     Os nomes dos campos são os das telas (new_sup.js, new_fis.js, medições); a gravação continua sendo a comum:
     - notas.confAprov {sig, comp, gest}: comprador (módulo de compras) e gestor (aprovador das alçadas, diretoria
       ou quem pediu a compra), pessoas diferentes; uma aprovação gravada não muda; confPend só cai com as duas;
     - nfse.canc {st:'pendente'|'aprovado'|'recusado'}: decide o Financeiro, e não quem pediu; NFS-e emitida só
       vira cancelada com o pedido aprovado;
     - medemp (medição de empreiteiro): aguardando → aprovada/recusada por Financeiro aprovador ou diretoria, nunca por
       quem enviou; med (medição ao cliente): rascunho → aprovada por outra pessoa (contratos ou diretoria);
     - docLib (liberação da diretoria, em medemp e lanc): só a diretoria, com justificativa.
     ===================================================================== */
  const carimbo = (conta, req, extra) => Object.assign({ por: conta.id, em: Date.now(), ip: req ? ipDe(req) : '', srv: 1 }, extra || {});
  function regraDocLib(conta, req, velho, novo) {
    const a = velho ? velho.docLib : undefined, b = novo.docLib;
    if (igual(a, b) || b == null) return null; /* tirar a liberação só restringe */
    if (a && typeof b === 'object' && String(a.just || '') === String(b.just || '')) { novo.docLib = a; return null; } /* cópia antiga do navegador */
    if (!ehDiretor(conta)) return erro('Só a diretoria libera medição ou pagamento de empreiteiro com documentação pendente.');
    const just = String((b && b.just) || '').trim(); if (just.length < 10) return erro('Escreva a justificativa da diretoria (ao menos 10 caracteres).', 400);
    novo.docLib = carimbo(conta, req, { just: just.slice(0, 500), pend: Array.isArray(b.pend) ? b.pend.slice(0, 60).map(x => String(x).slice(0, 200)) : [] });
    return null;
  }
  const confOk = a => !!(a && a.comp && a.gest && a.comp.por && a.gest.por && a.comp.por !== a.gest.por);
  function podeGestorNota(conta, n) {
    if (ehDiretor(conta) || todosAprovadores().includes(conta.id)) return true;
    const p = n && n.pedId ? doc('ped/' + n.pedId) : null, sc = p && p.scId ? doc('sc/' + p.scId) : null;
    return !!(sc && sc.crBy && sc.crBy === conta.id);
  }
  /* a aprovação da divergência só entra pela rota /api/aprovar (col:'notas', extra:{papel, sig}); por gravação comum,
     só se aceita apagar (nova conferência da nota) ou a cópia antiga do navegador */
  function regraNotaConf(conta, req, velho, novo) {
    const v = velho || {}, a = v.confAprov || null, b = novo.confAprov || null;
    if (!igual(a, b) && b) {
      const mesma = a && typeof b === 'object' && b.sig === a.sig && ['comp', 'gest'].every(k => (!b[k] && !a[k]) || (b[k] && a[k] && b[k].por === a[k].por));
      if (!mesma) return erro('A aprovação da divergência da nota só é registrada pelo botão Aprovar (o servidor confere o papel e a pessoa).');
      novo.confAprov = a;
    }
    if (v.confPend === true && novo.confPend === undefined) novo.confPend = true;
    if (v.confPend === true && novo.confPend === false && !confOk(novo.confAprov)) {
      const reconf = ['itens', 'pedId', 'xmlVinc', 'recebId', 'chave', 'parcId'].some(k => !igual(v[k], novo[k]));
      if (!reconf) return erro('A nota tem divergência aguardando aprovação: ela só sai da pendência com as duas aprovações (Suprimentos › Conferência).');
    }
    return null;
  }
  function regraNfseCanc(conta, req, velho, novo) {
    const v = velho || {}, a = v.canc || null, b = novo.canc || null;
    if (!igual(a, b)) {
      if (b && b.st === 'pendente' && (!a || a.st !== 'pendente')) { novo.canc = Object.assign({}, b, carimbo(conta, req)); ['decPor', 'decEm', 'decObs', 'decIp', 'decSrv'].forEach(k => delete novo.canc[k]); }
      else if (a && a.st === 'pendente' && b && (b.st === 'aprovado' || b.st === 'recusado')) {
        if (!(perfilEm(conta, ['admin', 'financeiro', 'diretoria']) || gravaGrupo(conta, 'fin'))) return erro('Só o Financeiro aprova o cancelamento de NFS-e.');
        if (a.por && a.por === conta.id) return erro('Quem pediu o cancelamento não pode aprovar. Outra pessoa do Financeiro precisa decidir.');
        const obs = String(b.decObs || '').trim(); if (b.st === 'recusado' && obs.length < 5) return erro('Explique por que o pedido foi recusado.', 400);
        novo.canc = Object.assign({}, a, { st: b.st, decPor: conta.id, decEm: Date.now(), decIp: req ? ipDe(req) : '', decObs: obs.slice(0, 500), decSrv: 1 });
      }
      else if (a && a.st === 'pendente' && !b) { /* pedido retirado */ }
      else if (a && b && a.st === b.st && (a.por || '') === (b.por || '')) novo.canc = a; /* cópia antiga do navegador: vale a do servidor */
      else return erro('O pedido de cancelamento da NFS-e só muda pelos botões Pedir, Aprovar e Recusar.');
    }
    if (v.status === 'emitida' && novo.status === 'cancelada' && !(novo.canc && novo.canc.st === 'aprovado')) return erro('NFS-e emitida só é cancelada com o pedido aprovado por outra pessoa do Financeiro.');
    return null;
  }
  function regraPedFech(conta, req, velho, novo) {
    const v = velho || {}, KEEP = ['porPed', 'emPed', 'porConf', 'emConf'], manter = () => KEEP.forEach(k => { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; });
    if (novo.st === 'pedido' && v.st !== 'pedido') { manter(); novo.porPed = conta.id; novo.emPed = Date.now(); novo.porConf = ''; novo.emConf = 0; return null; }
    if (v.st === 'pedido' && (novo.st === 'confirmado' || novo.st === 'devolvido')) {
      if (!ehDiretor(conta)) return erro('Só um diretor confirma ou devolve o pedido de fechamento.');
      if (v.porPed === conta.id) return erro('Quem pediu o fechamento não pode confirmá-lo nem devolvê-lo.');
      manter(); if (novo.st === 'confirmado') { novo.porConf = conta.id; novo.emConf = Date.now(); } return null;
    }
    if (novo.st === 'confirmado' && v.st !== 'confirmado') return erro('O fechamento só é confirmado a partir de um pedido.');
    manter(); return null;
  }
  function regraGo(conta, req, velho, novo) {
    const a = (velho || {}).goAprov, b = novo.goAprov;
    if (igual(a, b) || b == null) return null;
    if (a && b && a.ok === b.ok && (+a.preco || 0) === (+b.preco || 0) && (+a.custo || 0) === (+b.custo || 0)) { novo.goAprov = a; return null; }
    if (!ehDiretor(conta)) return erro('Só a diretoria decide o go/no-go da proposta.');
    novo.goAprov = Object.assign({}, b, carimbo(conta, req)); return null;
  }
  function regraMedemp(conta, req, velho, novo) {
    const v = velho || {}, vs = v.status || '', ns = novo.status || '', agora = Date.now();
    const manter = () => ['enviadoPor', 'enviadoEm', 'aprovPor', 'aprovEm', 'aprovIp'].forEach(k => { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; });
    if (ns === 'aguardando' && vs !== 'aguardando') { manter(); novo.enviadoPor = conta.id; novo.enviadoEm = agora; return null; }
    if (vs === 'aguardando' && (ns === 'aprovada' || ns === 'recusada')) {
      if (!(ehDiretor(conta) || (gravaGrupo(conta, 'fin') && todosAprovadores().includes(conta.id)))) return erro('Seu perfil não aprova medição de empreiteiro (Financeiro na lista de aprovadores ou diretoria).');
      const autor = v.enviadoPor || v.crBy || ''; if (autor && autor === conta.id && !ehDono(conta)) return erro('Quem lançou a medição não pode aprová-la. Outra pessoa precisa decidir.');
      if (ns === 'recusada' && !String(novo.motivo || '').trim()) return erro('Informe o motivo da recusa.', 400);
      manter(); novo.aprovPor = conta.id; novo.aprovEm = agora; novo.aprovIp = req ? ipDe(req) : ''; return null;
    }
    if (ns === 'aprovada' && vs !== 'aprovada') return erro('A medição de empreiteiro só é aprovada depois de enviada (Aguardando aprovação), por outra pessoa.');
    manter(); return null;
  }
  function regraMedCli(conta, req, velho, novo) {
    const v = velho || {}, vs = v.status || '', ns = novo.status || '';
    if (velho) { if (v.lancPor !== undefined) novo.lancPor = v.lancPor; else delete novo.lancPor; } else novo.lancPor = conta.id; /* quem lançou: só na criação */
    { const a = v.empLib, b = novo.empLib; /* liberação acima do empenho: só a diretoria, com justificativa */
      if (!igual(a, b) && b != null) {
        if (a && String(a.just || '') === String(b.just || '')) novo.empLib = a;
        else { if (!ehDiretor(conta)) return erro('Só a diretoria libera medição acima do empenhado.'); const j = String(b.just || '').trim(); if (j.length < 15) return erro('Escreva a justificativa da liberação (ao menos 15 caracteres).', 400);
          novo.empLib = carimbo(conta, req, { ok: true, just: j.slice(0, 500), empenhado: +b.empenhado || 0, medido: +b.medido || 0 }); }
      } }
    if (ns === 'aprovada' && vs !== 'aprovada') {
      if (!velho && !ehDono(conta)) return erro('A medição ao cliente nasce em rascunho e é aprovada depois por outra pessoa.');
      if (!(ehDiretor(conta) || gravaGrupo(conta, 'ctr', 'dir'))) return erro('Seu perfil não aprova medição ao cliente.');
      const autor = v.lancPor || v.crBy || ''; if (autor && autor === conta.id && !ehDono(conta)) return erro('Quem lançou a medição não pode aprová-la. Peça a outra pessoa (coordenador ou diretor).');
      novo.aprovPor = conta.id; novo.aprovEm = Date.now(); novo.aprovIp = req ? ipDe(req) : ''; return null;
    }
    ['aprovPor', 'aprovEm', 'aprovIp'].forEach(k => { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; });
    return null;
  }

  /* =====================================================================
     3. COMPETÊNCIA FECHADA (mesmas regras de new_fis.js)
     ===================================================================== */
  const FZ_COLS = new Set(['lanc', 'notas', 'nfse', 'mov', 'fpag', 'fofi']); /* v111: folha oficial (holerite) também */
  const FZ_META = new Set(['ts', 'cr', 'crBy', 'ed', 'edBy', 'hist', 'pub', 'pubEm', 'lido', 'lida', 'vistoEm', 'ciencia', 'cienciaHist']);
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
    if (c === 'notas') { if (r.status === 'rascunho') return o; m = /^\d{4}-\d{2}$/.test(String(r.compEnt || '')) ? r.compEnt : ym(r.emissao || r.data); } /* v111: nota extemporânea entra no mês da data de entrada */
    else if (c === 'nfse') { if (r.status === 'rascunho') return o; m = ym(r.emissaoReal || r.emissao); }
    else if (c === 'mov') m = ym(r.data);
    else if (c === 'fpag' || c === 'fofi') m = String(r.comp || '').slice(0, 7);
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
  /* v111: ponto (marcações, ajustes e ponto importado da Sólides) travado pelo mês de Pessoal › Fontes do ponto
     (cfg.pfonte.trava) e pela competência fechada */
  const PONTO_MES = { ponto: r => String(r.data || '').slice(0, 7), pajuste: r => String(r.data || '').slice(0, 7), pmmes: r => String(r.ym || '').slice(0, 7) };
  function mesPontoTravado(m) {
    if (!/^\d{4}-\d{2}$/.test(m)) return false; const t = String((cfgEmp().pfonte || {}).trava || '');
    return (/^\d{4}-\d{2}$/.test(t) && m <= t) || fechados().has(m);
  }
  const semMeta = r => { if (!r) return null; const o = {}; Object.keys(r).forEach(k => { if (!FZ_META.has(k) && k[0] !== '_' && k !== 'v') o[k] = r[k]; }); return o; };
  function travaPonto(c, velho, novo) {
    const f = PONTO_MES[c]; if (!f) return null;
    const ms = [velho && f(velho), novo && f(novo)].filter(m => m && mesPontoTravado(m));
    if (!ms.length || (velho && novo && igual(semMeta(velho), semMeta(novo)))) return null;
    return erro('O ponto de ' + ms[0].slice(5, 7) + '/' + ms[0].slice(0, 4) + ' está travado (mês fechado em Pessoal › Fontes do ponto ou competência fechada). O RH muda a trava; a competência só um administrador reabre.', 409);
  }
  /* para a sincronização da Sólides (server.js): true = não gravar este pmmes; registra na auditoria */
  function pontoTravado(dp, txt) {
    let d; try { d = JSON.parse(txt); } catch (e) { return false; }
    const m = PONTO_MES.pmmes(d || {}); if (!mesPontoTravado(m)) return false;
    auditar(null, null, 'SOLIDES_IGNORADO_MES_FECHADO', dp, null, { ym: m, funcId: d.funcId || '', motivo: 'ponto do mês travado (Fontes do ponto ou competência fechada)' });
    return true;
  }
  function rotaCompetencia(acao, conta, req, b) {
    const mes = String(b.mes || ''); if (!/^\d{4}-\d{2}$/.test(mes)) return erro('Competência inválida.', 400);
    const p = 'ctbfech/f' + mes, velho = doc(p), agora = Date.now(), ip = ipDe(req);
    if (acao === 'fechar') {
      const fz = cfgEmp().fz || {}, duas = fz.fech2 !== false && fz.fech2 !== 'nao'; let pd = null;
      if (duas) { /* v111 (X2): o Financeiro pede (fzpedfech), um diretor diferente confirma */
        if (!ehDiretor(conta)) return erro('O fechamento é em duas etapas: o Financeiro pede e um diretor confirma (Fiscal › Fechamento e exportação).');
        pd = doc('fzpedfech/pf' + mes); if (!pd || pd.st !== 'pedido') return erro('Falta o pedido de fechamento de ' + mes.slice(5) + '/' + mes.slice(0, 4) + ' feito pelo Financeiro.', 409);
        if (pd.porPed === conta.id) return erro('Quem pediu o fechamento não pode confirmá-lo. Outro diretor precisa confirmar.');
      } else if (!(ehDono(conta) || perfilEm(conta, ['admin', 'diretoria']) || gravaGrupo(conta, 'ctb'))) return erro('Seu perfil não fecha competência.');
      const tot = b.tot && typeof b.tot === 'object' ? { deb: r2(b.tot.deb), res: r2(b.tot.res) } : (velho && velho.tot) || null;
      const n = Object.assign(velho ? JSON.parse(JSON.stringify(velho)) : { id: 'f' + mes }, { mes, st: 'fechado', em: agora, por: conta.id, ip, tot, srv: 1 }, pd ? { pedPor: pd.porPed, confPor: conta.id } : {});
      n.fechs = ((velho && velho.fechs) || []).concat([{ em: agora, por: conta.id, ip, motivo: String(b.motivo || '').slice(0, 300) || undefined, srv: 1 }]).slice(-50);
      salvar(p, n, conta, req, 'COMPETENCIA_FECHAR', velho); return { ok: true, data: n, msg: 'Competência ' + mes.slice(5) + '/' + mes.slice(0, 4) + ' fechada e travada.' };
    }
    if (!(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('Só um administrador (ou o dono) pode reabrir uma competência fechada.');
    if (!velho || velho.st !== 'fechado') return erro('Esta competência não está fechada.', 409);
    const mot = String(b.motivo || '').trim(); if (mot.length < 10) return erro('Explique o motivo da reabertura (pelo menos 10 caracteres).', 400);
    if (!END.reautenticado(req)) return { reauth: true }; /* v111: reabrir pede a senha de novo */
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
  /* v111 (S3/T1): empreiteiro com documentação pendente (tercsit, gravado pelo SST/RH) sem liberação da diretoria (docLib) */
  function empreiteiroPend(l) {
    const m = l.medempId ? doc('medemp/' + l.medempId) : null, ctrId = (m && m.ctrId) || l.ctrempId, c = ctrId ? doc('ctremp/' + ctrId) : null;
    if (l.retPendDe) return l.retLib && l.retLib.srv ? '' : 'retenção a liberar sem a liberação da diretoria'; /* v113 (A9) */
    if (!c || !c.parcId || (l.parcId && l.parcId !== c.parcId) || !l.parcId) return '';
    { const ep = empPend(c.parcId, c.projId); /* v113 (A9): FGTS e folha só com retenção; o resto, com a liberação */
      if (ep.ret.length && !retOk(m)) return 'empreiteiro com FGTS ou folha pendente (' + ep.ret.join(', ') + ') sem retenção na medição';
      if (retOk(m)) return ep.form.length && !(l.docLib || (m && m.docLib)) ? 'empreiteiro com documentação pendente (' + ep.form.slice(0, 2).join('; ') + ') sem liberação da diretoria' : ''; }
    const ts = [doc('tercsit/' + c.parcId + '_' + (c.projId || '')), doc('tercsit/' + c.parcId + '_')].filter(x => x && x.sit === 'pend');
    if (!ts.length || l.docLib || (m && m.docLib)) return '';
    return 'empreiteiro com documentação pendente' + (Array.isArray(ts[0].pend) && ts[0].pend.length ? ' (' + ts[0].pend.slice(0, 2).map(String).join('; ') + ')' : '') + ' sem liberação da diretoria';
  }
  function regraRemessa(conta, velho, novo, req) {
    const IM = ['txt', 'hash', 'hashEm', 'hashPor', 'srvTotal', 'srvQtd', 'ids'];
    if (velho) { if (IM.some(k => !igual(velho[k], novo[k]))) return erro('O arquivo de uma remessa gerada não pode ser alterado. Cancele e gere outra.'); return null; }
    if (typeof novo.txt !== 'string' || !novo.txt) return erro('Remessa sem arquivo.', 400);
    if (req && !END.reautenticado(req)) return { reauth: true }; /* v111: gerar remessa pede a senha de novo */
    const ids = Array.isArray(novo.ids) ? novo.ids.map(String) : [], bloq = [];
    let tot = 0;
    for (const id of ids) {
      const l = doc('lanc/' + id); if (!l) { bloq.push('título ' + id + ' não existe'); continue; }
      tot += +l.valor || 0; const p = l.parcId ? doc('parc/' + l.parcId) : null;
      if (l.pago) bloq.push((l.desc || id) + ': já pago');
      if (p && p.bancoPend) bloq.push((l.desc || id) + ': dados bancários de ' + (p.nome || '') + ' aguardam confirmação');
      if (precisaAprovPag(l) && !aprovacaoValida(l)) bloq.push((l.desc || id) + ': aguardando aprovação');
      if (l.notaId) { const n = doc('notas/' + l.notaId); if (n && n.confPend && !confOk(n.confAprov)) bloq.push((l.desc || id) + ': NF ' + (n.numero || 's/n') + ' com divergência aguardando aprovação'); }
      { const ep = empreiteiroPend(l); if (ep) bloq.push((l.desc || id) + ': ' + ep); }
    }
    if (bloq.length) return erro('Remessa recusada pelo servidor: ' + bloq.slice(0, 5).join('; ') + '.', 409);
    Object.assign(novo, { hash: sha256(novo.txt), hashEm: Date.now(), hashPor: conta.id, srvTotal: r2(tot), srvQtd: ids.length, por: conta.id });
    return null;
  }
  function rotaRemessaArquivo(conta, req, res, id) {
    const p = 'remessa/' + id; if (!pode(conta, p, 'r') || !podeVer(conta, p, null, new Map())) return json(res, 403, { erro: 'Sem acesso.' });
    if (END.exigirReauth(req, res)) return; /* v111: baixar a remessa pede a senha de novo */
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
  /* v112 (J2, relatorios/feito_v112_J2.md): conteúdo canônico v1 da entrega de EPI, igual ao do navegador (epiHashBase) */
  const epiHashBase = e => JSON.stringify({ v: 1, epi: String(e.id || ''), colab: String(e.funcId || ''), entrega: String(e.entrega || ''), itens: [{ item: String(e.item || ''), ca: String(e.ca || ''), qtd: +e.qtd || 1, tam: String(e.tam || '') }] });
  const epiHash = e => crypto.createHash('sha256').update(epiHashBase(e), 'utf8').digest('hex');
  function rotaEpiAssinar(conta, req, b) {
    const p = 'epi/' + String(b.id || ''); if (!pode(conta, p, 'w') || !perfilPermite(conta, p, 'w') || !gravacaoPermitida(conta, p)) return erro('Seu perfil não registra entrega de EPI.');
    const e = doc(p); if (!e) return erro('Entrega não encontrada.', 404); if (e.assin) return erro('Esta entrega já está assinada.', 409);
    const anx = gravarImagemAssinatura(conta, b.img, p); if (!anx) return erro('Assinatura inválida.', 400);
    const hs = epiHash(e); if (b.hash && /^[0-9a-f]{64}$/.test(String(b.hash)) && b.hash !== hs) return erro('A entrega mudou depois de aberta para assinatura. Abra de novo e assine.', 409);
    const n = Object.assign(JSON.parse(JSON.stringify(e)), { assinado: true, assin: { modo: 'tela', nome: String(b.nome || '').slice(0, 120), em: Date.now(), por: conta.id, ip: ipDe(req), anx, srv: 1,
      hash: hs, hashAlg: 'SHA-256', hashV: 1, imgHash: crypto.createHash('sha256').update(String(b.img || ''), 'utf8').digest('hex'), disp: String(b.disp || '').slice(0, 120) } }); /* v112 (J2): hash do conteúdo, da imagem e o aparelho */
    salvar(p, n, conta, req, 'EPI_ASSINAR', e); return { ok: true, data: n, msg: 'Assinatura registrada.' };
  }
  function rotaMinhaArea(conta, req, b) {
    if (!(ehDono(conta) || perfilEm(conta, ['admin', 'rh']) || cuGrava(conta, 'rh', 'sensRh'))) return erro('Só o RH registra as confirmações da Minha área.'); /* v114: ou personalizado que grava RH com dados de RH */
    const uidc = String(b.uid || ''), sl = String(b.slId || ''); if (!/^[\w\-]{1,80}$/.test(uidc) || !/^[\w\-]{1,80}$/.test(sl)) return erro('Pedido inválido.', 400);
    const ps = 'pt/' + uidc + '/sl/' + sl, x = doc(ps); if (!x) return erro('Pedido não encontrado.', 404);
    const quando = +x.srvEm || docTs(ps), apaga = () => { q.docDel.run(ps); avisarDoc('del', ps, null, Date.now()); };
    const funcDe = fid => { const f = fid ? doc('func/' + fid) : null; return f && f.usrId === uidc ? f : null; };
    if (x.tipo === 'epiok') {
      const p = 'epi/' + String(x.epiId || ''), e = doc(p); const f = e && funcDe(e.funcId); if (!e || !f) { apaga(); return erro('A entrega não é deste colaborador.', 409); }
      if (e.assin) { apaga(); return { ok: true, data: e, msg: 'Já estava assinada.' }; }
      const n = Object.assign(JSON.parse(JSON.stringify(e)), { assinado: true, assin: { modo: 'minha_area', em: quando, uid: uidc, nome: f.nome || '', regEm: Date.now(), regPor: conta.id, srv: 1,
        hash: epiHash(e), hashAlg: 'SHA-256', hashV: 1, hashColab: /^[0-9a-f]{64}$/.test(String(x.hash || '')) ? x.hash : '', disp: String(x.disp || '').slice(0, 120) } });
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
  const ehRhOuAdmin = id => { const c = contaObj(id); return !!c && (c.nivel === 'owner' || ['admin', 'rh'].includes(papelConta(c))); };
  function citaAinda(p, id) { const r = q.docGet.get(p); return r && r.data.includes(id) ? r : null; }
  function blobPermitido(conta, a) {
    if (!conta) return false; if (conta.nivel === 'owner' || a.por === conta.id) return !a.lixo || conta.nivel === 'owner';
    if (a.lixo) return false;
    if (a.restrito && !veRh(conta)) return false;
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
  const SENS_ANX = c0 => SENS_RH.has(c0) || ['fofi', 'epi', 'pt', 'func', 'acid', 'adtoit', 'adto', 'tdoc'].includes(c0);
  function servirBlob(conta, req, res, id) {
    const a = st.arq.get(id); const f = a && path.join(DATA, 'blobs', a.lixo ? 'lixo' : '', id);
    if (!a || !fs.existsSync(f) || !blobPermitido(conta, a)) { res.writeHead(404); res.end(); return; }
    if (a.por !== conta.id && a.origem && SENS_ANX(a.origem.split('/')[0])) auditar(conta, req, 'ANEXO_DOWNLOAD', '/_blob/' + id, null, { origem: a.origem, tipo: a.ct });
    if (a.origem && PRIV.ehSaude(a.origem.split('/')[0])) PRIV.registrarLeitura(conta, req, 'anexo:' + a.origem.split('/')[0], [a.origem.split('/').slice(1).join('/') + '#' + id], 'anexo'); /* v112 */
    const ct = String(a.ct || 'application/octet-stream').toLowerCase(), ok = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|video\/(mp4|webm)|audio\/[a-z0-9.+-]+)$/.test(ct);
    res.writeHead(200, { 'content-type': ok ? ct : 'application/octet-stream', 'content-length': a.tam, 'cache-control': 'private, no-store', 'content-disposition': ok ? 'inline' : 'attachment', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" });
    fs.createReadStream(f).pipe(res);
  }
  function listarAnexos(conta, res) {
    if (conta.nivel !== 'owner') return json(res, 403, { code: 'not_granted', erro: 'Só o dono lista todos os anexos.' });
    const l = db.prepare('SELECT * FROM arquivos WHERE lixo IS NULL ORDER BY criado DESC').all();
    return json(res, 200, { assets: l.map(a => ({ id: a.id, url: '/_blob/' + a.id, contentType: a.ct, sizeBytes: a.tam, createdAt: new Date(a.criado).toISOString(), origem: a.origem || null })), usage: { files: l.length, bytes: l.reduce((s, a) => s + a.tam, 0), maxFiles: 100000, maxBytes: 50 * 1024 ** 3 } });
  }
  /* v112 (B4): o RH (e o Administrador) também apaga anexos de coleções de RH; o SST, os das coleções de SST.
     A coleção vem do registro de origem; sem origem, de todas as citações (todas precisam ser da área). */
  const RH_ANX = new Set([...SENS_RH, 'func', 'epi', 'fofi', 'foimp', 'cap', 'vaga', 'rsreq', 'integ', 'trein', 'tterc', 'tdoc']);
  const SST_ANX = new Set(['tterc', 'rhdoc', 'acid', 'ppp', 'rel', 'psicamp', 'epi', 'integ', 'trein']);
  function colsDoAnexo(a) { if (a.origem) return [a.origem.split('/')[0]]; return [...new Set(st.citDoBlob.all(a.id).map(c => c.path.split('/')[0]))]; }
  function areaApaga(conta, a) {
    if (!conta || NIV[conta.nivel] < NIV.admin) return '';
    const pf = papelConta(conta), cs = colsDoAnexo(a); if (!cs.length) return '';
    if (['admin', 'rh'].includes(pf) && cs.every(c => RH_ANX.has(c))) return pf;
    if (pf === 'sst' && cs.every(c => SST_ANX.has(c))) return pf; /* o Técnico de SST e os perfis personalizados não apagam anexos dos outros */
    return '';
  }
  function excluirAnexo(conta, req, res, id) {
    const a = st.arq.get(id); if (!a || a.lixo) return json(res, 200, { deleted: true });
    const area = conta.nivel !== 'owner' && a.por !== conta.id ? areaApaga(conta, a) : '';
    if (conta.nivel !== 'owner' && a.por !== conta.id && !area) { auditar(conta, req, 'ANEXO_EXCLUIR_NEGADO', '/api/assets/' + id, null, { origem: a.origem }); return json(res, 403, { code: 'not_granted', erro: 'Só quem enviou o arquivo, o RH (nos documentos de pessoal) ou o dono pode excluí-lo.' }); }
    try { fs.renameSync(path.join(DATA, 'blobs', id), path.join(DATA, 'blobs', 'lixo', id)); } catch (e) { }
    db.prepare('UPDATE arquivos SET lixo=?, lixoPor=? WHERE id=?').run(Date.now(), conta.id, id);
    auditar(conta, req, 'ANEXO_EXCLUIR', '/api/assets/' + id, { id, ct: a.ct, tam: a.tam, origem: a.origem, por: a.por }, { lixeira: true, apagaEm: new Date(Date.now() + LIXO_DIAS * 864e5).toISOString().slice(0, 10), pelaArea: area || undefined });
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
  const LEIT_LIVRE = new Set(['cfg', 'usr', 'cm', 'pt', 'usrreq', 'lgpdc', 'implog', 'ctbfech', 'aptid', 'tercsit', 'moapr', 'aptlib', 'perfc']); /* v114: definições dos perfis personalizados (sem dado pessoal; o app de cada pessoa precisa delas); v113: liberações do SST (sem dado de saúde: só nome, obra, validade e motivo técnico); v111: resumos sem dado sensível, para toda a Equipe */
  const VEIC_COLS = new Set(['veic', 'vsai', 'vabas', 'vman', 'multa', 'mult', 'vrota', 'ventr']);
  const permLog = db.prepare('INSERT INTO perm_log(dia,conta,perfil,col,n,ult) VALUES(?,?,?,?,1,?) ON CONFLICT(dia,conta,col) DO UPDATE SET n=n+1, ult=excluded.ult, perfil=excluded.perfil');
  /* v115.2: faturamento (notas de saída e NFS-e) só para quem lê o financeiro, Fiscal, Comercial, Administrador e Diretoria */
  function veFaturamento(conta) {
    if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return true;
    const pf = perfilDe(conta), pp = papelDe(pf); if (['admin', 'diretoria', 'fiscal', 'comercial', 'financeiro'].includes(pp)) return true;
    const pr = PERM.perfis[pf]; if (!pr) return false; if (pr.w === '*') return true;
    const gs = ['fin', 'ctb']; return gs.some(g => (pr.w || []).includes(g) || (Array.isArray(pr.r) && pr.r.includes(g)));
  }
  function leModulo(conta, c0) {
    const pf = perfilDe(conta), pr = PERM.perfis[pf]; if (!pr || pr.w === '*' || pr.r === '*') return true;
    const gs = (PERM.leitura && PERM.leitura[c0]) || PERM.colecoes[c0]; if (!gs || !gs.length) return true;
    return gs.some(g => pr.w.includes(g) || pr.r.includes(g));
  }
  function locaisPermitidos(conta, memo) {
    const k = 'locais:' + conta.id; if (memo && memo.has(k)) return memo.get(k);
    let r = null; const pf = perfilDe(conta), pr = PERM.perfis[pf];
    if (!(conta.nivel === 'owner' || (pr && (pr.w === '*' || pr.frotaTodos)))) { /* v111: frotaTodos (Administrador, Diretoria, Financeiro e RH) vê todos os locais */
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
  /* v112 (B3/B10): checklist mensal dos empreiteiros (tdoc: CND, folha e guias dos empregados do empreiteiro) e os anexos
     dele só para Financeiro, RH, SST, Administrador e Diretoria (e Leitura completa, que já lê os dados de RH).
     O resumo tercsit continua na leitura livre. */
  const TDOC_LE = new Set(['admin', 'financeiro', 'rh', 'sst', 'ssttec', 'diretoria', 'leituratotal']), TDOC_GRAVA = new Set(['admin', 'financeiro', 'rh', 'sst', 'ssttec']);
  /* v114: perfil personalizado pelo módulo "Documentos mensais dos empreiteiros" (empdoc) */
  const cuEmpdoc = (conta, modo) => { const d = defDe(conta); return !!(d && d.custom && ((d.w || []).includes('empdoc') || (modo === 'r' && (d.r || []).includes('empdoc')))); };
  const tdocLe = conta => !conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin ? !!conta && conta.nivel === 'owner' : (TDOC_LE.has(papelConta(conta)) || cuEmpdoc(conta, 'r'));
  const tdocGrava = conta => !!conta && (conta.nivel === 'owner' || (NIV[conta.nivel] >= NIV.admin && (TDOC_GRAVA.has(papelConta(conta)) || cuEmpdoc(conta, 'w'))));
  /* v115 (relatorios/feito_v115_P0.md): leitura parcial de uma coleção financeira (perfis.json › leituraParcial, gerado por
     gen_perm.js). Quem não lê o módulo financeiro, mas tem o módulo indicado, lê só os registros que o predicado aceita:
     folha = contas da folha oficial geradas pelo RH; cnq = contas do custo da não qualidade (Qualidade). Vale também para
     os perfis personalizados, pelo módulo. */
  const PARCIAL = { folha: d => ehLancFolha(d) || /^fo\|/.test(String((d && d.foKey) || '')), cnq: d => !!(d && d.cnqCol && d.cnqId) };
  function leParcial(conta, c0, data) {
    const par = PERM.leituraParcial && PERM.leituraParcial[c0]; if (!par || !data) return false;
    const pr = PERM.perfis[perfilDe(conta)]; if (!pr) return false; const tem = g => (pr.w || []).includes(g) || (Array.isArray(pr.r) && pr.r.includes(g));
    return Object.entries(par).some(([g, k]) => tem(g) && PARCIAL[k] && PARCIAL[k](data));
  }
  /* v115: lê o financeiro da empresa (contas a pagar e a receber inteiras): dono, Administrador, Diretoria, Financeiro, Fiscal e
     o personalizado com um módulo financeiro. Usado para tirar valores dos avisos e o resultado do mês fechado. */
  const leFin = conta => !!conta && (conta.nivel === 'owner' || leModulo(conta, 'lanc'));
  function podeLer(conta, p, data, memo) {
    if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return true;
    const c0 = p.split('/')[0];
    if (c0 === 'lixo') { if (!data || !data.col) return true; if (data.col === 'func' && !veFuncCompleto(conta)) return false; const pp = data.col + '/' + (data.rid || 'x'); return perfilPermite(conta, pp, 'r') && podeLer(conta, pp, data.rec || null, memo); }
    if (VEIC_COLS.has(c0) && !veicOk(conta, c0, data, memo)) return false;
    if ((c0 === 'nfse' || (c0 === 'notas' && data && data.tipo === 'saida')) && !veFaturamento(conta)) return false; /* v115.2 */
    if (c0 === 'tdoc' && !tdocLe(conta)) return false; /* v112: vale também com PERFIL_LEITURA=avisar */
    if (c0 === 'rhdoc' && data && soNr(conta) && !docNr(data)) return false; /* v114: o Técnico de SST não vê ASO nem os outros documentos */
    if (LEIT_LIVRE.has(c0) || leModulo(conta, c0)) return true;
    if (leParcial(conta, c0, data)) return true; /* v115: RH só as contas da folha; Qualidade só as do custo da não qualidade */
    const k = 'plog:' + c0; if (!memo || !memo.has(k)) { if (memo) memo.set(k, 1); try { permLog.run(new Date().toISOString().slice(0, 10), conta.id, perfilDe(conta), 'leitura:' + c0, Date.now()); } catch (e) { } }
    return MODO_LEIT !== 'bloquear';
  }
  /* contas a pagar da folha por colaborador (salário líquido, pensão): nome e valor só para quem é do RH ou da folha */
  const ehLancFolha = d => !!d && (d.sens === 'rh' || (!!d.foFunc && /^fo\|/.test(String(d.foKey || ''))));
  const LANC_SENS = ['desc', 'valor', 'valorPago', 'foFunc', 'obs', 'foKey', 'juros', 'multa', 'descPago'];
  function veFolha(conta) {
    if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return true;
    const pf = perfilDe(conta), pr = PERM.perfis[pf]; if (!pr || pr.w === '*' || pr.r === '*') return true;
    if (pr.custom && !pr.sensRh) return false; /* v114: personalizado só vê a conta da folha com "ver dados de RH e salários" */
    return ['folha', 'rh'].some(g => pr.w.includes(g) || pr.r.includes(g));
  }
  function redigir(conta, p, data) {
    if (data && !veBanco(conta)) { /* v111: dados bancários e arquivo da remessa só para Financeiro, Administrador e Diretoria */
      if (/^parc\/[^/]+$/.test(p)) { const o = Object.assign({}, data); let tinha = false; FIN_BK.concat(['bancoHist']).forEach(k => { if (o[k] != null && o[k] !== '' && !(Array.isArray(o[k]) && !o[k].length)) tinha = true; delete o[k]; }); if (o.bancoPend) { o._bancoPendente = true; tinha = true; } delete o.bancoPend; if (tinha) o._bancoOculto = true; return o; }
      if (/^remessa\/[^/]+$/.test(p)) { const o = Object.assign({}, data); delete o.txt; o._restrito = true; return o; }
      if (/^lixo\/[^/]+$/.test(p) && data.col === 'parc' && data.rec) { const o = Object.assign({}, data, { rec: Object.assign({}, data.rec) }); FIN_BK.concat(['bancoPend', 'bancoHist']).forEach(k => delete o.rec[k]); return o; }
    }
    if (data && /^ctbfech\/[^/]+$/.test(p) && data.tot && conta && !leFin(conta)) { /* v115: o mês fechado é de leitura livre (trava), mas o resultado (DRE) só para o Financeiro */
      const o = Object.assign({}, data); delete o.tot; o._restrito = true; return o; }
    if (!data || !/^lanc\/[^/]+$/.test(p) || !ehLancFolha(data) || veFolha(conta)) return data;
    const o = {}; for (const k of Object.keys(data)) if (!LANC_SENS.includes(k)) o[k] = data[k];
    o.desc = 'Folha de pagamento (restrito ao RH e ao Financeiro)'; o._restrito = true; return o;
  }

  /* =====================================================================
     v111. PRESTAÇÃO DE CONTAS PELA MINHA ÁREA (caminho do agente B, relatorios/feito_v111_B.md)
     pt/<uid>/fa/adto: resumo gravado pelo Financeiro; o colaborador só lê.
     pt/<uid>/pc/<id>: comprovante do colaborador, carimbado pelo servidor (srvEm/srvPor), para um adiantamento em aberto
     dele; depois de tratado (st) fica só leitura para ele; o Financeiro muda só st, adtoitId, motivo, procEm e procPor.
     adtoit criado a partir do comprovante (pc:{u,id}) leva crBy = colaborador (quem importou pode aprovar).
     ===================================================================== */
  const PC_FIN = ['st', 'adtoitId', 'motivo', 'procEm', 'procPor'];
  function regraMinhaAreaAdto(conta, req, s, velho, novo) {
    const u = s[1], ehFin = ehDono(conta) || gravaGrupo(conta, 'fin');
    if (s[2] === 'fa') return ehFin ? null : erro('Este resumo é gravado pelo Financeiro; o colaborador só consulta.');
    if (conta.id === u) {
      if (velho && velho.st) return erro('O Financeiro já tratou este comprovante: ele não pode mais ser alterado.');
      PC_FIN.forEach(k => { if (velho && velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; });
      const a = doc('adto/' + String(novo.adtoId || '')), f = a && a.funcId ? doc('func/' + a.funcId) : null;
      if (!a || !f || f.usrId !== u || ['encerrado', 'cancelado'].includes(a.status)) return erro('Escolha um adiantamento em aberto que seja seu.', 400);
      if (velho) { novo.srvEm = velho.srvEm; novo.srvPor = velho.srvPor; } else { novo.srvEm = Date.now(); novo.srvPor = conta.id; }
      novo.uid = u; return null;
    }
    if (!ehFin) return erro('Só o próprio colaborador e o Financeiro gravam comprovantes da Minha área.');
    if (!velho) return erro('O comprovante é enviado pelo próprio colaborador.', 404);
    for (const k of new Set(Object.keys(velho).concat(Object.keys(novo)))) if (!PC_FIN.includes(k) && !igual(velho[k], novo[k])) { if (velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; }
    if (novo.st != null && !['importado', 'recusado'].includes(novo.st)) return erro('Situação inválida.', 400);
    if (novo.st && !igual(velho.st, novo.st)) { if (novo.st === 'recusado' && !String(novo.motivo || '').trim()) return erro('Informe o motivo da recusa.', 400); novo.procPor = conta.id; novo.procEm = Date.now(); }
    return null;
  }
  function regraAdtoitPc(novo) {
    const pc = novo.pc; if (!pc || typeof pc !== 'object') return null;
    const u = String(pc.u || ''), id = String(pc.id || ''); if (!/^[\w\-]{1,80}$/.test(u) || !/^[\w\-.]{1,80}$/.test(id)) return erro('Comprovante inválido.', 400);
    const d = doc('pt/' + u + '/pc/' + id);
    if (!d || d.st || String(d.adtoId || '') !== String(novo.adtoId || '') || Math.abs((+d.valor || 0) - (+novo.valor || 0)) > 0.009) return erro('O comprovante da Minha área não confere (não existe, já foi tratado ou tem outro adiantamento ou valor).', 409);
    novo.crBy = u; return null;
  }

  /* =====================================================================
     v111. AVISO DIÁRIO AO APROVADOR E RESUMO DIÁRIO DE CADASTROS BANCÁRIOS
     AVISO_APROVADORES=0 desliga; AVISO_APROVADORES_HORA (padrão 8, horário de Brasília); AVISO_APROVADORES_HORAS
     (pendente há mais de, padrão 24). ALERTAS_RESUMO_HORA (padrão 8) para o resumo dos cadastros bancários novos.
     ===================================================================== */
  const AVISO_APROV = !/^(0|nao|não|false|desligado)$/i.test(String(process.env.AVISO_APROVADORES || '1'));
  const hrEnv = (k, d) => { const v = process.env[k]; return v === undefined || v === '' || !isFinite(+v) ? d : Math.min(23, Math.max(0, +v)); };
  const HORA_AVISO = hrEnv('AVISO_APROVADORES_HORA', 8), HORA_RESUMO = hrEnv('ALERTAS_RESUMO_HORA', 8), HORAS_PEND = Math.max(1, +process.env.AVISO_APROVADORES_HORAS || 24);
  const cfgK = k => { const r = db.prepare('SELECT v FROM cfg WHERE k=?').get(k); return r ? r.v : ''; }, cfgSet = (k, v) => db.prepare('INSERT OR REPLACE INTO cfg(k,v) VALUES(?,?)').run(k, String(v));
  const quandoBR = t => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const moeda = v => (+v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  function contasQueGravam(g) { const out = []; for (const u of col('usr')) { if (!u.uid || u.ativo === false) continue; const pr = PERM.perfis[u.perfil]; if (pr && (pr.w === '*' || (pr.w || []).includes(g))) out.push(u.uid); } return out; }
  const donos = () => q.contas.all().filter(c => c.ativo && c.nivel === 'owner').map(c => c.id);
  function enviarResumo() {
    const ls = db.prepare('SELECT * FROM alerta_fila ORDER BY id').all(); if (!ls.length) return { itens: 0 };
    const linhas = ['Cadastros novos de dados bancários desde o último resumo (' + ls.length + '). Cada um só vale depois que outra pessoa do Financeiro confirmar por telefone (Financeiro › Fornecedores).'];
    ls.forEach(r => { let l = []; try { l = JSON.parse(r.linhas); } catch (e) { } linhas.push('• ' + quandoBR(r.ts) + ': ' + (l[0] || r.assunto)); });
    db.prepare('DELETE FROM alerta_fila WHERE id<=?').run(ls[ls.length - 1].id);
    alertar('Resumo diário: cadastros de dados bancários', linhas, null);
    return { itens: ls.length };
  }
  function pendenciasAprovacao() {
    const lim = Date.now() - HORAS_PEND * 3600e3, A = alcadas(), itens = [];
    const desde = (r, p) => Math.max(+r.cr || 0, +(r.aprovReaberta && r.aprovReaberta.em) || 0, +r.enviadoEm || 0, +r.solEm || 0) || docTs(p);
    const add = (quem, tipo, desc, valor, d, fora, fin) => { if (!d || d > lim) return; const f = (fora || []).filter(Boolean); itens.push({ quem: [...new Set(quem)].filter(u => !f.includes(u)), tipo, desc: String(desc || '').slice(0, 160), valor, desde: d, fin: !!fin }); };
    for (const l of col('lanc')) if (!l.pago && !l.aprov && precisaAprovPag(l) && !aprovacaoValida(l)) add(quemAprova(l.obrig ? Math.min(2, nivelDe(valorAlc('lanc', l))) : nivelDe(valorAlc('lanc', l))), 'Conta a pagar', l.desc, +l.valor, desde(l, 'lanc/' + l.id), [l.crBy, l.aprovParc && l.aprovParc.por], true);
    if (A.ped > 0) for (const p of col('ped')) if (!p.aprov && p.status !== 'cancelado' && pedTotal(p) > A.ped) add(quemAprova(nivelDe(pedTotal(p))), 'Pedido de compra', 'Pedido ' + (p.numero || p.id), pedTotal(p), desde(p, 'ped/' + p.id), [p.crBy]);
    for (const x of col('aprovsol')) if (x.status === 'pendente') add(quemAprova(nivelDe(+x.valor || 0)), 'Pedido de aprovação', (x.tipo || '') + ' ' + (x.chave || ''), +x.valor || 0, +x.em || desde(x, 'aprovsol/' + x.id), [x.por], true);
    for (const x of col('heaut')) if (x.status === 'pendente') add(aprovadoresDe('rh').length ? aprovadoresDe('rh') : contasQueGravam('rh'), 'Hora extra', (x.data || '') + ' · ' + (x.horas || '') + ' h · ' + (x.motivo || ''), null, desde(x, 'heaut/' + x.id), [x.solPor]);
    for (const x of col('adtoit')) if ((x.status || 'pendente') === 'pendente') add(contasQueGravam('fin'), 'Comprovante de adiantamento', x.desc || x.id, +x.valor || 0, desde(x, 'adtoit/' + x.id), [x.crBy], true);
    for (const x of col('invaj')) if (x.status === 'pendente') add(aprovadoresDe('compras').length ? aprovadoresDe('compras') : contasQueGravam('comp'), 'Ajuste de inventário', x.prodId || x.id, +x.valor || 0, +x.contEm || desde(x, 'invaj/' + x.id), [x.contPor]);
    for (const x of col('medemp')) if (x.status === 'aguardando') add(todosAprovadores().concat(aprovadoresDe('diretoria')), 'Medição de empreiteiro', 'Medição nº ' + (x.numero || ''), (x.fixo && x.fixo.bruto) || null, desde(x, 'medemp/' + x.id), [x.enviadoPor]);
    for (const x of col('nfse')) if (x.status === 'emitida' && x.canc && x.canc.st === 'pendente') add(contasQueGravam('fin'), 'Cancelamento de NFS-e', 'NFS-e ' + (x.numOficial || x.numero || ''), null, +x.canc.em || desde(x, 'nfse/' + x.id), [x.canc.por]);
    for (const x of col('notas')) if (x.confPend && !confOk(x.confAprov)) add(contasQueGravam('comp').concat(todosAprovadores()), 'Divergência de nota', 'NF ' + (x.numero || 's/n'), null, desde(x, 'notas/' + x.id), []);
    return itens;
  }
  function avisarAprovadores() {
    const itens = pendenciasAprovacao(), por = new Map();
    for (const it of itens) { const q2 = it.quem.length ? it.quem : donos(); for (const u of q2) { if (!por.has(u)) por.set(u, []); por.get(u).push(it); } }
    const conf = EMAIL.configurado(), out = [];
    for (let [u, its] of por) {
      const c = q.contaPorId.get(u); if (!c || !c.ativo) continue;
      /* v115: quem não lê o financeiro (aprovador fora do Financeiro) recebe o tipo e a data, sem descrição nem valor */
      const semFin = !leFin(c) && its.some(i => i.fin); if (semFin) its = its.map(i => i.fin ? Object.assign({}, i, { desc: 'detalhes no sistema', valor: null }) : i);
      const linhas = ['Você tem ' + its.length + ' item(ns) aguardando a sua aprovação há mais de ' + HORAS_PEND + ' horas:'].concat(its.slice(0, 60).map(i => '• ' + i.tipo + ': ' + i.desc + (i.valor != null ? ' · ' + moeda(i.valor) : '') + ' · desde ' + quandoBR(i.desde)), its.length > 60 ? ['… e mais ' + (its.length - 60) + '.'] : [], ['Abra Início › Aprovações. Se você estiver ausente, peça ao administrador para indicar um substituto por período.'], semFin ? ['Seu perfil não abre contas a pagar: peça ao administrador um perfil com o Financeiro em consulta ou a saída da matriz de aprovação.'] : []);
      const enviado = conf && !!c.email;
      auditar(null, null, 'ALERTA_EMAIL_APROVADOR', 'aprovacoes', null, { para: c.email || '', conta: u, itens: its.length, enviado, motivo: !conf ? 'SMTP não configurado' : !c.email ? 'sem e-mail' : undefined });
      if (enviado) { const m = EMAIL.modelo('Aprovações pendentes', linhas, 'Abrir as aprovações', APP_URL, 'Aviso diário da Central de Gestão.'); EMAIL.enviar({ para: c.email, assunto: 'Aprovações pendentes (' + its.length + ') · Central de Gestão', texto: m.texto, html: m.html }).catch(e => auditar(null, null, 'ALERTA_EMAIL_FALHA', 'aprovacoes', null, { para: c.email, erro: e.message })); }
      out.push({ id: u, nome: c.nome || c.email || u, itens: its.length, enviado });
    }
    return { pendentes: itens.length, aprovadores: out };
  }
  setInterval(() => {
    try {
      const h = hojeSP(), hr = new Date(Date.now() - 3 * 3600e3).getUTCHours();
      if (ALERTAS && hr >= HORA_RESUMO && cfgK('alerta_resumo_dia') !== h) { cfgSet('alerta_resumo_dia', h); enviarResumo(); }
      if (AVISO_APROV && hr >= HORA_AVISO && cfgK('aviso_aprov_dia') !== h) { cfgSet('aviso_aprov_dia', h); avisarAprovadores(); }
    } catch (e) { console.error('[avisos]', e.message); }
  }, 10 * 60e3).unref();

  /* =====================================================================
     v111. PESQUISA DE SATISFAÇÃO RESPONDIDA PELO CLIENTE (achado Q2): link de uso único, que expira
     (PESQUISA_LINK_DIAS, padrão 30). O servidor guarda só o hash do token (pesqlink/<sha256>) e grava a resposta
     na própria pesquisa (pesq/<id>), a mesma coleção do NPS em Qualidade › Satisfação do cliente.
     ===================================================================== */
  const PESQ_DIAS = () => Math.max(1, +process.env.PESQUISA_LINK_DIAS || 30);
  const limPesq = new Map();
  function rotaPesqLink(conta, req, b) {
    if (!(ehDono(conta) || gravaGrupo(conta, 'qual'))) return erro('Seu perfil não envia pesquisa de satisfação.');
    const id = String(b.id || ''); if (!/^[\w\-.|~@+=]{1,200}$/.test(id)) return erro('Pesquisa inválida.', 400);
    const pq = doc('pesq/' + id); if (!pq) return erro('Pesquisa não encontrada.', 404);
    if (pq.status === 'respondida') return erro('Esta pesquisa já foi respondida.', 409);
    for (const l of col('pesqlink')) if (l.pesqId === id && !l.usado && !l.revogado) salvar('pesqlink/' + l.id, Object.assign({}, l, { revogado: Date.now() }), conta, req, 'PESQUISA_LINK_TROCADO', l);
    const tok = crypto.randomBytes(24).toString('base64url'), h = sha256(tok), exp = Date.now() + PESQ_DIAS() * 864e5;
    salvar('pesqlink/' + h, { id: h, pesqId: id, criado: Date.now(), por: conta.id, expira: exp }, conta, req, 'PESQUISA_LINK', null);
    const n = Object.assign({}, pq, { linkEm: Date.now(), linkExpira: exp, enviadaEm: pq.enviadaEm || hojeSP() });
    salvar('pesq/' + id, n, conta, req, 'PESQUISA_LINK', pq);
    return { ok: true, url: APP_URL + '/pesquisa/' + tok, expira: exp, data: n };
  }
  const PAG_PESQ_JS = "(function(){var t=location.pathname.split('/').pop(),c=document.getElementById('c'),nota=null;function h(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[x];});}" +
    "function fim(m){c.innerHTML='<p style=\"font-size:17px\">'+h(m)+'</p>';}" +
    "fetch('/api/pub/pesquisa/'+t).then(function(r){return r.json();}).then(function(j){if(j.erro)return fim(j.erro);if(j.situacao==='respondida')return fim('Esta pesquisa já foi respondida. Obrigado!');if(j.situacao==='expirada')return fim('Este link expirou. Peça um novo a quem enviou.');" +
    "var b='';for(var i=0;i<=10;i++)b+='<button type=\"button\" class=\"n\" data-n=\"'+i+'\">'+i+'</button>';" +
    "c.innerHTML='<p class=\"sub\">'+h(j.empresa)+(j.ref?' · '+h(j.ref):'')+'</p><p style=\"font-size:17px\"><b>De 0 a 10, o quanto você recomendaria a '+h(j.empresa)+' a um amigo ou colega?</b></p><div class=\"ns\">'+b+'</div><div class=\"esc\"><span>0 = não recomendaria</span><span>10 = com certeza</span></div><label>Conte em uma frase o motivo da nota (opcional)<textarea id=\"com\" rows=\"4\" maxlength=\"1000\"></textarea></label><label>Seu nome (opcional)<input id=\"nome\" maxlength=\"100\"></label><button type=\"button\" id=\"env\" class=\"pri\" disabled>Enviar resposta</button><p id=\"err\" class=\"err\"></p>';" +
    "c.addEventListener('click',function(e){var x=e.target;if(x.dataset&&x.dataset.n!=null){nota=+x.dataset.n;[].forEach.call(c.querySelectorAll('.n'),function(y){y.className='n'+(y===x?' on':'');});document.getElementById('env').disabled=false;}" +
    "if(x.id==='env'&&nota!=null){x.disabled=true;fetch('/api/pub/pesquisa/'+t,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nota:nota,comentario:document.getElementById('com').value,nome:document.getElementById('nome').value})}).then(function(r){return r.json();}).then(function(j){if(j.ok)fim('Resposta registrada. Muito obrigado pela sua avaliação!');else{document.getElementById('err').textContent=j.erro||'Não foi possível enviar.';x.disabled=false;}},function(){document.getElementById('err').textContent='Sem conexão. Tente de novo.';x.disabled=false;});}});" +
    "},function(){fim('Não foi possível abrir a pesquisa agora. Tente mais tarde.');});})();";
  const PAG_PESQ_CSS = '.ns{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.n{width:44px;height:44px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--tx);font-size:16px;cursor:pointer}.n.on{background:var(--acc);color:#fff;border-color:var(--acc)}.esc{display:flex;justify-content:space-between;font-size:12px;color:var(--mut);margin-bottom:12px}.err{color:var(--neg)}';
  async function rotaPublica(p, m, req, res) {
    const mp = p.match(/^\/pesquisa\/([A-Za-z0-9_-]{32,64})$/), ma = p.match(/^\/api\/pub\/pesquisa\/([A-Za-z0-9_-]{32,64})$/);
    if (!mp && !ma) return false;
    if (mp) { X.html(res, 200, pag('Pesquisa de satisfação', '<style>' + PAG_PESQ_CSS + '</style><div class="card" style="max-width:560px;margin:30px auto"><h1>Pesquisa de satisfação</h1><div id="c"><p class="sub">Carregando…</p></div></div><script>' + PAG_PESQ_JS + '</script>'), { 'x-robots-tag': 'noindex' }); return true; }
    const ip = ipDe(req), lim = limPesq.get(ip) || { n: 0, ini: Date.now() }; if (Date.now() - lim.ini > 3600e3) { lim.n = 0; lim.ini = Date.now(); } lim.n++; limPesq.set(ip, lim);
    if (lim.n > 120) { json(res, 429, { erro: 'Muitas tentativas. Tente mais tarde.' }); return true; }
    const reg = doc('pesqlink/' + sha256(ma[1]));
    if (!reg) { await new Promise(r => setTimeout(r, 400)); json(res, 404, { erro: 'Pesquisa não encontrada. Confira o link recebido.' }); return true; }
    const pq = doc('pesq/' + reg.pesqId), e = cfgEmp();
    const respondida = !pq || !!reg.usado || pq.status === 'respondida', expirada = !!reg.revogado || reg.expira < Date.now();
    if (m === 'GET') { json(res, 200, { empresa: e.fantasia || e.razao || 'nossa empresa', ref: pq ? String(pq.ref || '').slice(0, 160) : '', situacao: respondida ? 'respondida' : expirada ? 'expirada' : 'aberta' }); return true; }
    if (m !== 'POST') { json(res, 405, { erro: 'Método não permitido.' }); return true; }
    if (respondida) { json(res, 409, { erro: 'Esta pesquisa já foi respondida. Obrigado!' }); return true; }
    if (expirada) { json(res, 410, { erro: 'Este link expirou. Peça um novo a quem enviou.' }); return true; }
    let b; try { b = JSON.parse((await X.lerCorpo(req, 20000)).toString('utf8') || '{}'); } catch (x) { json(res, 400, { erro: 'Dados inválidos.' }); return true; }
    const nota = Number(b.nota); if (!Number.isInteger(nota) || nota < 0 || nota > 10) { json(res, 400, { erro: 'Escolha uma nota de 0 a 10.' }); return true; }
    const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
    const n = Object.assign({}, pq, { status: 'respondida', nota, comentario: txt(b.comentario, 1000), respNome: txt(b.nome, 100), respEm: hojeSP(), enviadaEm: pq.enviadaEm || hojeSP(), regPor: 'cliente', viaLink: true, respLinkEm: Date.now() });
    salvar('pesq/' + reg.pesqId, n, null, req, 'PESQUISA_RESPONDIDA', pq);
    salvar('pesqlink/' + reg.id, Object.assign({}, reg, { usado: Date.now(), usadoIp: ip }), null, req, 'PESQUISA_LINK_USADO', reg);
    json(res, 200, { ok: true }); return true;
  }

  /* =====================================================================
     v113 (parecer jurídico A1, A8 e A9; relatorios/feito_v113.md)
     A1. Diário de obra e alocação (func.projId): colaborador ou terceiro inapto no resumo aptid (ASO, NR ou integração
         vencidos) só entra com liberação do SST (coleção aptlib: perfil SST ou administrador, justificativa técnica,
         validade curta, carimbada). Sem resumo: aviso (padrão) ou bloqueio, conforme cfg.j4.aptNi. Só as pessoas
         acrescentadas são conferidas (editar um diário antigo sem mexer no efetivo não trava).
     A9. Empreiteiro com FGTS ou folha pendente (tercsit): a medição só é aprovada com retenção (medemp.retJ4, carimbada);
         a conta "retenção a liberar" (lanc.retPendDe) só é paga com a liberação da diretoria (lanc.retLib), e a conta
         líquida não passa do líquido depois da retenção. A liberação da diretoria (docLib) não cobre FGTS ou folha.
     A8. Desligamento: CIPA eleita (mandato + 1 ano), retorno de acidente (12 meses após alta de afastamento acidentário
         > 15 dias), afastamento acidentário em curso, gestante (gravidez comunicada ou até 5 meses após o parto) e
         garantia cadastrada no colaborador exigem o parecer jurídico anexado.
     ===================================================================== */
  const J4_DEF = { aptBloq: true, aptIni: '', aptNi: 'aviso', libMaxDias: 1, retPct: 10, retem: { folha: true, gfgts: true, gdctf: false, crf: false, cnd: false, cndt: false } };
  const j4 = () => { const c = cfgEmp().j4 || {}; const r = Object.assign({}, J4_DEF, c, { retem: Object.assign({}, J4_DEF.retem, c.retem || {}) }); r.retem.folha = true; r.retem.gfgts = true; r.aptBloq = r.aptBloq !== false; r.retPct = Math.min(100, Math.max(1, +r.retPct || 10)); r.libMaxDias = Math.min(30, Math.max(1, Math.round(+r.libMaxDias || 1))); return r; };
  const addDias = (d, n) => { const x = new Date(String(d).slice(0, 10) + 'T12:00:00Z'); if (isNaN(x)) return ''; x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const diasEntre = (a, b) => Math.round((Date.parse(String(b).slice(0, 10) + 'T12:00:00Z') - Date.parse(String(a).slice(0, 10) + 'T12:00:00Z')) / 864e5);
  const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  /* v114: Técnico de SST (rhdocNr): em Documentos e ASO, só os certificados de NR */
  const docNr = d => /^NR-/.test(String((d && d.tipo) || ''));
  const soNr = conta => { if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return false; const d = defDe(conta); return !!(d && !d.custom && d.rhdocNr); };
  const ehSstAdm = conta => ehDono(conta) || perfilEm(conta, ['sst', 'ssttec', 'admin']) || !!((defDe(conta) || {}).custom && (defDe(conta).w || []).includes('sst')); /* v114: Gestor e Técnico de SST; personalizado que grava SST */
  /* ---- A1 ---- */
  function aptServ(fid, tid, pid) {
    const r = doc('aptid/' + (tid ? 't_' + tid : fid));
    if (!r) return { ni: true, motivos: [], nome: '' };
    const m = (Array.isArray(r.motivos) ? r.motivos : []).concat(pid && r.cli && Array.isArray(r.cli[pid]) ? r.cli[pid] : []).map(String);
    if (r.valAte && String(r.valAte) < hojeSP()) m.push('documento de SST venceu em ' + String(r.valAte).split('-').reverse().join('/'));
    return { ni: false, motivos: m, apto: !m.length, nome: r.nome || '' };
  }
  function aptLibValida(fid, tid, pid, data) {
    return col('aptlib').find(l => l && l.srv && !l.revogadaEm && (tid ? String(l.tercId || '') === tid : (!l.tercId && String(l.funcId || '') === fid)) && (!l.projId || l.projId === pid) && String(l.de || '') <= data && data <= String(l.ate || '')) || null;
  }
  /* devolve o erro (pessoas sem liberação) ou null; grava as liberações usadas em novo.aptLibsSrv */
  function aptConfere(lista, pid, data, onde) {
    const J = j4(), bloq = [], libs = [];
    for (const x of lista) {
      const a = aptServ(x.fid, x.tid, pid);
      if (a.ni ? J.aptNi !== 'bloquear' : a.apto) continue;
      const l = aptLibValida(x.fid, x.tid, pid, data);
      const nome = x.nome || a.nome || (x.fid ? ((doc('func/' + x.fid) || {}).nome || x.fid) : 'terceiro ' + x.tid);
      if (l) { libs.push({ funcId: x.fid || undefined, tercId: x.tid || undefined, libId: l.id, por: l.por, ate: l.ate }); continue; }
      bloq.push(nome + (a.ni ? ' (situação não informada pelo RH/SST)' : ' (' + a.motivos.slice(0, 3).join(', ') + ')'));
    }
    if (bloq.length) return { erro: erro(onde + ': ' + bloq.slice(0, 6).join('; ') + (bloq.length > 6 ? ' e mais ' + (bloq.length - 6) : '') + '. Com ASO, NR ou integração vencidos, só entra com a liberação do SST (CIPA e SST › Liberações de aptidão), com justificativa técnica.', 409) };
    return { libs };
  }
  function regraAptRdo(velho, novo) {
    const J = j4(); if (!J.aptBloq) return null;
    const data = dataOk(novo.data) ? novo.data : hojeSP(); if (J.aptIni && data < J.aptIni) return null;
    const pid = String(novo.projId || ''), mudou = !velho || velho.data !== novo.data || String(velho.projId || '') !== pid, ja = new Set(), vis = new Set(), L = [];
    if (!mudou) (Array.isArray(velho.efetivo) ? velho.efetivo : []).forEach(x => { if (x && x.tercId) ja.add('t:' + x.tercId); else if (x && x.funcId) ja.add(String(x.funcId)); });
    (Array.isArray(novo.efetivo) ? novo.efetivo : []).forEach(x => {
      if (!x) return; const tid = x.tercId ? String(x.tercId) : '', fid = tid ? '' : (x.funcId ? String(x.funcId) : ''); if (!tid && !fid) return;
      const k = tid ? 't:' + tid : fid; if (vis.has(k) || ja.has(k)) return; vis.add(k); L.push({ fid, tid, nome: tid ? (x.tercNome || '') : '' });
    });
    if (!L.length) { if (velho && velho.aptLibsSrv) novo.aptLibsSrv = velho.aptLibsSrv; else delete novo.aptLibsSrv; return null; }
    const r = aptConfere(L, pid, data, 'Diário recusado pelo servidor'); if (r.erro) return r.erro;
    novo.aptLibsSrv = ((velho && Array.isArray(velho.aptLibsSrv)) ? velho.aptLibsSrv : []).concat(r.libs).slice(-200); if (!novo.aptLibsSrv.length) delete novo.aptLibsSrv;
    return null;
  }
  function regraAptFunc(velho, novo) {
    const J = j4(); if (!J.aptBloq || !velho || !novo.projId || String(novo.projId) === String(velho.projId || '') || novo.status === 'desligado') return null;
    const data = hojeSP(); if (J.aptIni && data < J.aptIni) return null;
    const r = aptConfere([{ fid: String(novo.id || ''), tid: '', nome: novo.nome || '' }], String(novo.projId), data, 'Alocação na obra recusada pelo servidor');
    return r.erro || null;
  }
  function regraAptLib(conta, req, velho, novo) {
    if (!ehSstAdm(conta)) return erro('Só a Segurança do trabalho (perfil SST) ou um administrador libera colaborador com ASO, NR ou integração vencidos.');
    if (velho) { /* registrada não muda: só pode ser revogada */
      const livre = new Set(['revogadaEm', 'revogadaPor', 'revogMotivo', 'ts', 'ed', 'edBy', 'hist']);
      for (const k of new Set(Object.keys(velho).concat(Object.keys(novo)))) if (!livre.has(k) && !igual(velho[k], novo[k])) return erro('Liberação registrada não se altera. Revogue e registre outra.', 409);
      if (velho.revogadaEm) { ['revogadaEm', 'revogadaPor', 'revogMotivo'].forEach(k => { novo[k] = velho[k]; }); return null; }
      if (novo.revogadaEm) { novo.revogadaEm = Date.now(); novo.revogadaPor = conta.id; novo.revogMotivo = String(novo.revogMotivo || '').slice(0, 300); }
      return null;
    }
    const J = j4(), fid = String(novo.funcId || ''), tid = String(novo.tercId || '');
    if (!!fid === !!tid) return erro('Informe o colaborador ou o trabalhador terceiro da liberação.', 400);
    if (!dataOk(novo.de) || !dataOk(novo.ate) || novo.ate < novo.de) return erro('Informe o dia da liberação e a validade.', 400);
    if (diasEntre(novo.de, novo.ate) + 1 > J.libMaxDias) return erro('Validade acima do permitido (' + J.libMaxDias + ' dia(s); ajuste em Configurações).', 400);
    if ((defDe(conta) || {}).aptLibDia && !ehDono(conta) && !(novo.de === hojeSP() && novo.ate === hojeSP())) return erro('O Técnico de segurança do trabalho libera só para o dia de hoje. Liberação mais longa fica com o Gestor de SST.', 400); /* v114 */
    const just = String(novo.motivo || '').trim(); if (just.length < 20) return erro('Escreva a justificativa técnica do SST (ao menos 20 caracteres).', 400);
    const a = aptServ(fid, tid, String(novo.projId || ''));
    Object.assign(novo, carimbo(conta, req, { motivo: just.slice(0, 1000), pendSrv: a.ni ? ['situação não informada pelo RH/SST'] : a.motivos.slice(0, 20), perfil: perfilDe(conta) }));
    novo.pend = Array.isArray(novo.pend) ? novo.pend.slice(0, 20).map(x => String(x).slice(0, 200)) : [];
    delete novo.revogadaEm; delete novo.revogadaPor; delete novo.revogMotivo;
    return null;
  }
  /* ---- A9 ---- */
  const RET_KEYS = ['folha', 'gfgts', 'gdctf', 'crf', 'cndt', 'cnd'];
  function pendChave(t) {
    const s = String(t || '');
    if (/\bCRF\b/i.test(s)) return 'crf';
    if (/guia do fgts|\bfgts\b/i.test(s)) return 'gfgts';
    if (/folha/i.test(s)) return 'folha';
    if (/dctf|guia do inss/i.test(s)) return 'gdctf';
    if (/\bCNDT\b/i.test(s)) return 'cndt';
    if (/\bCND\b/i.test(s)) return 'cnd';
    return '';
  }
  function tercsitDe(parcId, projId) { return [doc('tercsit/' + parcId + '_' + (projId || '')), doc('tercsit/' + parcId + '_')].filter(x => x && x.sit === 'pend'); }
  /* pendências do empreiteiro: as que retêm (FGTS, folha e as marcadas) e as formais (liberáveis com justificativa) */
  function empPend(parcId, projId) {
    const J = j4(), ret = new Set(), form = [];
    for (const s of tercsitDe(parcId, projId)) {
      if (Array.isArray(s.pendK)) s.pendK.forEach(k => { if (J.retem[k]) ret.add(String(k)); });
      (Array.isArray(s.pend) ? s.pend : []).forEach(p => { const k = pendChave(p); if (k && J.retem[k]) ret.add(k); else form.push(String(p)); });
    }
    return { ret: [...ret], form: [...new Set(form)] };
  }
  function ctrDaMed(m) { const c = m && m.ctrId ? doc('ctremp/' + m.ctrId) : null; return c && c.parcId ? c : null; }
  const retOk = m => !!(m && m.retJ4 && m.retJ4.srv && +m.retJ4.valor > 0);
  function regraRetMed(conta, req, velho, novo) {
    const v = velho || {}, a = v.retJ4 || null, b = novo.retJ4 || null, vs = v.status || '', ns = novo.status || '';
    if (a && a.srv && (vs === 'aprovada' || vs === 'cancelada')) { /* depois da aprovação: não muda nem sai */
      if (!b || Math.abs((+b.valor || 0) - (+a.valor || 0)) > 0.005) return erro('A retenção da medição não pode ser alterada nem retirada depois da aprovação. O valor retido só é pago pela conta "retenção a liberar", com a liberação da diretoria.', 409);
      novo.retJ4 = a;
    } else if (b && !(a && igual(a, b))) {
      if (a && a.srv && Math.abs((+b.valor || 0) - (+a.valor || 0)) <= 0.005 && igual(a.keys, b.keys)) novo.retJ4 = a; /* cópia do navegador */
      else {
        if (!(ehDiretor(conta) || gravaGrupo(conta, 'fin'))) return erro('Só quem aprova a medição (Financeiro ou diretoria) registra a retenção.');
        const J = j4(), bruto = r2(b.bruto), liqA = r2(b.liqAntes), inf = Math.max(0, r2(b.informado)), val = r2(b.valor), pct = +b.pct || 0;
        if (!(bruto > 0) || !(val > 0)) return erro('Retenção sem valor.', 400);
        const minimo = Math.min(liqA > 0 ? liqA : Infinity, Math.max(inf, r2(bruto * J.retPct / 100)));
        if (pct + 1e-9 < J.retPct || val + 0.01 < minimo) return erro('Retenção abaixo do mínimo: o maior entre o valor informado das guias/folha pendentes e ' + J.retPct + '% do valor bruto da medição (' + minimo.toFixed(2) + ').', 409);
        if (liqA > 0 && val > liqA + 0.01) return erro('Retenção maior que o líquido da medição.', 409);
        const keys = (Array.isArray(b.keys) ? b.keys : []).map(String).filter(k => RET_KEYS.includes(k));
        novo.retJ4 = carimbo(conta, req, { valor: val, informado: inf, pct, bruto, liqAntes: liqA, liqApos: r2(liqA - val), keys, pend: (Array.isArray(b.pend) ? b.pend : []).slice(0, 20).map(x => String(x).slice(0, 200)), mesRef: /^\d{4}-\d{2}$/.test(String(b.mesRef || '')) ? b.mesRef : '' });
      }
    } else if (!b && a && a.srv) { if (!(ehDiretor(conta) || gravaGrupo(conta, 'fin'))) novo.retJ4 = a; }
    if (ns === 'aprovada' && vs !== 'aprovada') {
      const c = ctrDaMed(novo), ep = c ? empPend(c.parcId, c.projId) : { ret: [] };
      if (ep.ret.length && !retOk(novo)) return erro('Empreiteiro com FGTS ou folha pendente (' + ep.ret.join(', ') + '): a medição só é aprovada com a retenção do valor. A liberação da diretoria não cobre essa pendência.', 409);
      if (retOk(novo) && novo.fixo && novo.fixo.liq !== undefined && Math.abs(r2(novo.fixo.liq) - r2(novo.retJ4.liqApos)) > 0.05) return erro('O líquido da medição não confere com a retenção registrada.', 409);
    }
    return null;
  }
  /* docLib (diretoria): não cobre FGTS nem folha sem retenção */
  function docLibRetem(c0, velho, novo) {
    const a = velho ? velho.docLib : undefined, b = novo.docLib;
    if (b == null || igual(a, b) || (a && typeof b === 'object' && String(a.just || '') === String(b.just || ''))) return null;
    const m = c0 === 'medemp' ? novo : (novo.medempId ? doc('medemp/' + novo.medempId) : null);
    const c = c0 === 'medemp' ? ctrDaMed(novo) : (m ? ctrDaMed(m) : (novo.ctrempId ? doc('ctremp/' + novo.ctrempId) : null));
    if (!c || novo.retPendDe) return null;
    const ep = empPend(c.parcId, c.projId);
    if (ep.ret.length && !retOk(m)) return erro('A liberação da diretoria não vale para FGTS ou folha do empreiteiro não comprovados (' + ep.ret.join(', ') + '). Aprove a medição com a retenção do valor; pendências formais (certidão em renovação) continuam liberáveis com justificativa.', 409);
    return null;
  }
  const ehLiqEmp = l => !!(l && l.tipo === 'pagar' && l.medempId && l.parcId && !l.retencaoDe && !l.retPendDe && l.status !== 'cancelado');
  function regraRetLanc(conta, req, velho, novo) {
    const v = velho || {};
    /* conta "retenção a liberar" */
    if (v.retPendDe || novo.retPendDe) {
      if (velho && v.retPendDe) { for (const k of ['retPendDe', 'retPend', 'medempId', 'parcId', 'tipo']) if (!igual(v[k], novo[k])) return erro('A conta "retenção a liberar" não muda de medição, empreiteiro nem pendência.', 409);
        if (Math.abs((+novo.valor || 0) - (+v.valor || 0)) > 0.005) return erro('O valor da retenção não se altera.', 409); }
      else {
        const m = doc('medemp/' + String(novo.retPendDe || '')); if (!m || !retOk(m) || String(novo.medempId || '') !== String(novo.retPendDe)) return erro('Retenção sem medição aprovada com retenção.', 409);
        const ja = col('lanc').filter(l => l.retPendDe === novo.retPendDe && l.id !== novo.id && l.status !== 'cancelado').reduce((s, l) => s + (+l.valor || 0), 0);
        if (ja + (+novo.valor || 0) > (+m.retJ4.valor || 0) + 0.01) return erro('Retenção acima do valor retido na medição.', 409);
        const c = ctrDaMed(m); novo.retPend = { parcId: c ? c.parcId : (novo.parcId || ''), projId: c ? (c.projId || '') : '', mesRef: m.retJ4.mesRef || '', keys: m.retJ4.keys || [] };
      }
      const a = v.retLib, b = novo.retLib;
      if (!igual(a, b) && b != null) {
        if (a && typeof b === 'object' && String(a.just || '') === String(b.just || '') && a.modo === b.modo) novo.retLib = a;
        else {
          if (!ehDiretor(conta)) return erro('Só a diretoria libera o valor retido do empreiteiro.');
          const just = String(b.just || '').trim(), modo = b.modo === 'compensar' ? 'compensar' : 'pagar';
          if (just.length < (modo === 'compensar' ? 20 : 10)) return erro('Escreva a justificativa da liberação (ao menos ' + (modo === 'compensar' ? 20 : 10) + ' caracteres).', 400);
          const rp = novo.retPend || {}, R = cfgEmp().rhx || {}, exig = R.tdExig || {};
          if (modo === 'pagar') {
            const t = rp.mesRef ? doc('tdoc/td_' + rp.parcId + '_' + rp.mesRef) : null;
            const falta = (rp.keys || []).filter(k => exig[k] !== false && !(t && t.itens && t.itens[k] && t.itens[k].ok));
            if (falta.length || !rp.mesRef) return erro('A pendência que motivou a retenção ainda não foi resolvida no checklist do empreiteiro (' + (falta.join(', ') || 'mês de referência') + '). Para usar o valor retido na quitação da guia ou da folha, escolha "Compensar".', 409);
          }
          novo.retLib = carimbo(conta, req, { modo, just: just.slice(0, 500) });
        }
      }
      if (novo.pago && !v.pago && !(novo.retLib && novo.retLib.srv)) return erro('Retenção a liberar: só é paga ou compensada depois da liberação da diretoria, com a pendência resolvida.', 409);
      return null;
    }
    /* conta líquida da medição com retenção: não passa do líquido depois da retenção */
    const mid = String(novo.medempId || v.medempId || ''); if (!mid) return null;
    const m = doc('medemp/' + mid); if (!retOk(m)) return null;
    if (velho && v.medempId && String(novo.medempId || '') !== String(v.medempId)) return erro('Conta de medição com retenção: não troque a medição.', 409);
    if (!ehLiqEmp(novo) || (velho && ehLiqEmp(v) && (+novo.valor || 0) <= (+v.valor || 0) + 0.005)) return null;
    const soma = col('lanc').filter(l => l.id !== novo.id && l.medempId === mid && ehLiqEmp(l)).reduce((s, l) => s + (+l.valor || 0), 0) + (+novo.valor || 0);
    if (soma > (+m.retJ4.liqApos || 0) + 0.05) return erro('O valor retido do empreiteiro (' + (+m.retJ4.valor).toFixed(2) + ') não pode entrar na conta líquida da medição. Ele só é pago pela conta "retenção a liberar", com a liberação da diretoria.', 409);
    return null;
  }
  /* ---- A8 ---- */
  const J4_DESL = ['sem_justa', 'acordo', 'antec_emp', 'pedido'];
  function deslGarantias(r, f) {
    const est = [], said = dataOk(r.saida) ? r.saida : hojeSP();
    const cipas = new Map(col('cipa').map(c => [c.id, c]));
    col('cipam').forEach(mb => {
      if (mb.funcId !== f.id || mb.lado !== 'empregados' || mb.status === 'substituido') return;
      const g = cipas.get(mb.cipaId), lim = g && dataOk(g.fim) ? addDias(g.fim, 365) : '';
      if (lim ? said <= lim : mb.status === 'ativo') est.push('membro eleito da CIPA' + (lim ? ' (garantia até ' + lim.split('-').reverse().join('/') + ')' : ''));
    });
    const fimAf = a => dataOk(a.ini) && +a.dias > 0 ? addDias(a.ini, +a.dias - 1) : (a.ini || '');
    col('afast').forEach(a => {
      if (a.funcId !== f.id || a.status === 'cancelado' || !['acidente', 'doenca_ocup'].includes(a.tipo) || !dataOk(a.ini)) return;
      const fim = fimAf(a);
      if (a.ini <= said && said <= fim) est.push('afastamento por acidente ou doença ocupacional em curso');
      else if (+a.dias > 15 && fim < said && diasEntre(fim, said) <= 365) est.push('retorno de afastamento por acidente ou doença ocupacional há menos de 12 meses (alta em ' + fim.split('-').reverse().join('/') + ')');
    });
    if (dataOk(r.dataParto) && said <= mais5m(r.dataParto)) est.push('gestante: garantia até 5 meses após o parto');
    if (dataOk(f.gestEm) && diasEntre(f.gestEm, said) <= 300 && !(dataOk(r.dataParto) && r.dataParto >= f.gestEm)) est.push('gravidez comunicada à empresa em ' + f.gestEm.split('-').reverse().join('/'));
    if (dataOk(f.estabAte) && said <= f.estabAte) est.push('garantia de emprego cadastrada até ' + f.estabAte.split('-').reverse().join('/') + (f.estabMotivo ? ' (' + String(f.estabMotivo).slice(0, 80) + ')' : ''));
    return [...new Set(est)];
  }
  function regraDeslAuto(velho, novo) {
    if (!J4_DESL.includes(novo.tipo)) return null;
    const concluindo = !!novo.concluidoEm && !(velho && velho.concluidoEm), temQ = J1_Q.some(k => novo[k] !== undefined);
    if (velho && !temQ && !concluindo) return null; /* registro antigo, sem as perguntas, ainda não concluído */
    const f = doc('func/' + String(novo.funcId || '')); if (!f) return null; f.id = String(novo.funcId);
    const said = dataOk(novo.saida) ? novo.saida : hojeSP();
    const mat = col('afast').some(a => a.funcId === f.id && /maternidade/.test(String(a.tipo || '')) && a.status !== 'cancelado' && dataOk(a.ini) && diasEntre(a.ini, said) <= 400 && diasEntre(a.ini, said) >= -30);
    if ((mat || (dataOk(f.gestEm) && diasEntre(f.gestEm, said) > 300 && diasEntre(f.gestEm, said) <= 500)) && !dataOk(novo.dataParto)) return erro('Há licença-maternidade ou gravidez registrada: informe a data do parto (a garantia vai até 5 meses após o parto).', 409);
    const est = deslGarantias(novo, f);
    if (est.length && !anxN(novo, 'parecerAnx')) return erro('Desligamento recusado pelo servidor: possível garantia de emprego (' + est.join('; ') + '). Anexe o parecer do advogado da empresa.', 409);
    return null;
  }
  function regraDeslFunc(velho, novo) { /* concluir pelo cadastro (status desligado) passa pela mesma conferência */
    if (novo.status !== 'desligado' || (velho && velho.status === 'desligado') || !novo.deslId) return null;
    const d = doc('desl/' + String(novo.deslId)); if (!d || d.funcId !== novo.id) return null;
    return regraDeslAuto(null, Object.assign({}, d, { concluidoEm: d.concluidoEm || Date.now() }));
  }

  /* =====================================================================
     ENTRADA: regras antes de gravar ou excluir um documento
     ===================================================================== */
  const CFG_PROT = ['alcPed', 'alcPag', 'aprovadores', 'alcNiv', 'supInvLim', 'aprovMatriz', 'aprovSubst', 'omieCorte', 'supTolPreco'];
  /* v111: a Diretoria não lança, mas decide: liberação (docLib) e aprovação/recusa de medições, sem mudar outros campos */
  const DECISAO_DIR = { lanc: ['docLib', 'retLib'], medemp: ['docLib', 'retJ4', 'status', 'motivo', 'aprovPor', 'aprovEm', 'fixo', 'puFixo'], med: ['status', 'aprovPor', 'aprovEm', 'empLib', 'empLibReq'],
    fzpedfech: ['st', 'porConf', 'emConf', 'devObs', 'eventos'], opp: ['goAprov', 'goReq', 'goHist'] };
  const DECISAO_ST = { medemp: ['status', ['aprovada', 'recusada']], med: ['status', ['aprovada']], fzpedfech: ['st', ['confirmado', 'devolvido']] };
  function excecaoDiretoria(conta, p, velho, novo, m) {
    const s = p.split('/'), L = DECISAO_DIR[s[0]]; if (m === 'DELETE' || s.length !== 2 || !L || !velho || !novo || !ehDiretor(conta)) return false;
    const livre = new Set(L.concat(['ts', 'ed', 'edBy', 'hist']));
    for (const k of new Set(Object.keys(velho).concat(Object.keys(novo)))) if (!livre.has(k) && !igual(velho[k], novo[k])) return false;
    const ds = DECISAO_ST[s[0]]; if (ds && !igual(velho[ds[0]], novo[ds[0]]) && !ds[1].includes(novo[ds[0]])) return false;
    return true;
  }
  function excecaoGravacao(conta, p, velho, novo, m) {
    if (excecaoDiretoria(conta, p, velho, novo, m)) return true;
    /* RH gera as contas a pagar da folha oficial (só essas, e só enquanto não pagas) */
    if (m === 'DELETE' || !/^lanc\/[^/]+$/.test(p) || !gravaGrupo(conta, 'folha') || !novo) return false;
    const fo = d => d && /^fo\|/.test(String(d.foKey || '')) && d.tipo === 'pagar' && !d.pago && !d.aprov;
    if (!fo(novo) || (velho && !fo(velho))) return false;
    if (velho) { const LIVRE = new Set(['valor', 'venc', 'desc', 'status', 'obs', 'ts', 'ed', 'edBy', 'hist', 'sens', 'obrig']); for (const k of new Set(Object.keys(velho).concat(Object.keys(novo)))) if (!LIVRE.has(k) && !igual(velho[k], novo[k])) return false; if (novo.status && !['aberto', 'cancelado'].includes(novo.status)) return false; }
    return true;
  }
  /* v112 (J1, relatorios/feito_v112_J1.md): travas de baixo risco repetidas no servidor
     - emprest: juros só se a empresa ligou a opção (cfg.jur1.emJuros) e até a taxa máxima (cfg.jur1.emJurosMax, padrão 1% a.m.);
       vale na criação e quando os juros mudam (empréstimos antigos continuam editáveis);
     - desl: dispensa sem justa causa, acordo, rescisão antecipada e pedido de demissão exigem as 7 respostas de garantia de
       emprego; "sim"/"não sei" ou parto há menos de 5 meses exigem o parecer anexado; pedido de demissão exige o pedido de
       próprio punho anexado. Vale na criação e nos registros que já têm as perguntas (os antigos, sem elas, não travam);
     - func.ferQuit: período de férias só é quitado com recibo e aviso anexados (ou lote com arquivo); o servidor carimba. */
  const J1_DISP = ['sem_justa', 'acordo', 'antec_emp'], J1_Q = ['qGrav', 'qCipa', 'qSind', 'qDoenca', 'qAcid', 'qPreap', 'qPai'];
  const anxN = (o, k) => Array.isArray(o && o[k]) ? o[k].filter(a => a && a.id).length : 0;
  const mais5m = d => { const x = new Date(String(d).slice(0, 10) + 'T12:00:00Z'); if (isNaN(x)) return ''; x.setUTCMonth(x.getUTCMonth() + 5); return x.toISOString().slice(0, 10); };
  /* v112 (J2): hora extra até 2 h somadas por colaborador e dia (necessidade imperiosa do art. 61, com fato e comunicação,
     até cfg.j2.heImpMax, padrão 4, máximo 6); com adicional de insalubridade, hora extra e banco de horas só com a licença
     do art. 60 (no colaborador ou em cfg.j2) ou cláusula da convenção; banco de horas novo só com o acordo anexado. */
  function art60Ok(f) { if (!f || !(+f.insal > 0)) return true; const J = cfgEmp().j2 || {}, h = hojeSP(); return (f.art60Val && String(f.art60Val) >= h) || (J.art60Val && String(J.art60Val) >= h) || !!String(J.art60Cct || '').trim(); }
  function regrasJur2(c0, conta, velho, novo) {
    if (c0 === 'heaut' && !velho) {
      const f = doc('func/' + String(novo.funcId || ''));
      if (f && !art60Ok(f)) return erro((f.nome || 'O colaborador') + ' recebe adicional de insalubridade e não há licença do art. 60 da CLT registrada.', 409);
      const imp = !!novo.imperiosa && !!String(novo.impMotivo || '').trim() && !!String(novo.impComunic || '').trim(), J = cfgEmp().j2 || {};
      const teto = imp ? Math.min(6, Math.max(2, +J.heImpMax || 4)) : 2;
      const ja = col('heaut').filter(x => x.id !== novo.id && x.funcId === novo.funcId && x.data === novo.data && !['cancelada', 'recusada'].includes(x.status)).reduce((s, x) => s + (+x.horas || 0), 0);
      if (ja + (+novo.horas || 0) > teto + 1e-9) return erro('Hora extra: o total do dia passaria de ' + teto + ' h para este colaborador (CLT, art. 59' + (imp ? ', art. 61' : '; acima disso, só necessidade imperiosa com fato e comunicação') + ').', 409);
    }
    if (c0 === 'func' && novo.bh && !(velho && velho.bh)) {
      if (!novo.bhAcordoEm || !anxN(novo, 'bhAcordoAnx')) return erro('Banco de horas: anexe o acordo assinado e informe a data.', 409);
      if (!art60Ok(novo)) return erro('Banco de horas com insalubridade: registre a licença do art. 60 da CLT.', 409);
    }
    return null;
  }
  function regrasJur1(c0, conta, velho, novo) {
    if (c0 === 'emprest') {
      const j = +novo.juros || 0; if (velho && Math.abs((+velho.juros || 0) - j) < 1e-9) return null;
      const c = cfgEmp().jur1 || {}, max = c.emJurosMax === undefined || c.emJurosMax === '' ? 1 : Math.max(0, +c.emJurosMax || 0);
      if (j > 0 && !c.emJuros) return erro('A empresa está configurada para empréstimos sem juros. Deixe os juros em 0%.', 409);
      if (j > max + 1e-9) return erro('Juros acima da taxa máxima configurada (' + max + '% ao mês, juros simples).', 409);
      return null;
    }
    if (c0 === 'desl') {
      if (!(J1_DISP.includes(novo.tipo) || novo.tipo === 'pedido')) return null;
      if (velho && !J1_Q.some(k => velho[k] !== undefined)) return null; /* registro antigo, de antes das perguntas */
      if (novo.tipo === 'pedido' && !anxN(novo, 'pedidoAnx')) return erro('Pedido de demissão: anexe o pedido escrito de próprio punho e assinado.', 409);
      const falta = J1_Q.filter(k => !novo[k]); if (falta.length) return erro('Responda às perguntas de garantia de emprego antes de gravar o desligamento.', 409);
      const est = J1_Q.some(k => novo[k] === 'sim' || novo[k] === 'nao_sei') || (novo.dataParto && String(novo.saida || hojeSP()) <= mais5m(novo.dataParto));
      if (est && !anxN(novo, 'parecerAnx')) return erro('Possível garantia de emprego: anexe o parecer do advogado da empresa para seguir.', 409);
      return null;
    }
    if (c0 === 'func' && novo.ferQuit && typeof novo.ferQuit === 'object') {
      const vq = (velho && velho.ferQuit) || {};
      for (const aq of Object.keys(novo.ferQuit)) {
        const z = novo.ferQuit[aq]; if (igual(z, vq[aq])) continue;
        if (!z || !((anxN(z, 'recibo') && anxN(z, 'aviso')) || (z.lote && anxN(z, 'anx')))) return erro('Férias: para quitar o período ' + aq + ' anexe o recibo e o aviso assinados.', 409);
        novo.ferQuit[aq] = Object.assign({}, z, { srvPor: conta.id, srvEm: Date.now() });
      }
    }
    return null;
  }
  /* =====================================================================
     v114: PERFIS DE ACESSO PERSONALIZADOS (coleção perfc) E REGRAS FINAS DOS PERFIS PADRÃO
     - perfc: só o Administrador (ou o dono), com a senha de novo, e registro na auditoria. O servidor limpa o registro:
       só nome, descrição, módulos válidos (nunca Usuários, Configurações ou Lixeira), opções sim/não e ativo.
       Desativar (ou excluir) só quando nenhum usuário usa o perfil.
     - usr: o perfil escolhido precisa existir (padrão ou personalizado ativo).
     - regras finas (perfis.json, vindas do app): "campos" (só altera estes campos, não cria nem exclui),
       "camposSt" (valores aceitos no status), "rascunho" (só documentos em rascunho), "naoExclui", "cfgNao".
     ===================================================================== */
  const PERFC_ID = X.PERFC_ID || /^c_[a-z0-9]{4,24}$/, PERF_BASE = X.PERF_BASE || {};
  const perfcUsado = id => col('usr').filter(u => u && String(u.perfil || '') === id).length;
  const perfcAtivo = id => { const d = doc('perfc/' + id); return !!(d && d.ativo !== false); };
  function regraPerfc(conta, req, p, velho, novo) {
    const s = p.split('/'); if (s.length !== 2) return erro('Caminho inválido.', 400);
    if (!(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('Só o Administrador ou o dono criam e alteram perfis de acesso.');
    const id = s[1]; if (!PERFC_ID.test(id) || PERF_BASE[id]) return erro('Identificador de perfil inválido.', 400);
    const nome = String(novo.nome || '').replace(/\s+/g, ' ').trim(); if (nome.length < 3) return erro('Dê um nome ao perfil (ao menos 3 letras).', 400);
    const mod = {}, rec = [];
    for (const [g, v] of Object.entries(novo.mod && typeof novo.mod === 'object' ? novo.mod : {})) { if (v !== 'w' && v !== 'r') continue; if (g === 'painel' || g === 'dir') continue; /* v115: Painel do Início e da diretoria só do Administrador */ if (!X.perfcGrupoValido || !X.perfcGrupoValido(g)) { rec.push(g); continue; } mod[g] = v; }
    if (rec.length) return erro('Um perfil personalizado não pode ter: ' + rec.slice(0, 5).join(', ') + '. Usuários, configurações e lixeira ficam só com o Administrador.', 400);
    const o = novo.opc && typeof novo.opc === 'object' ? novo.opc : {}, opc = { rh: o.rh === true, banco: o.banco === true, frota: o.frota === true, dir: o.dir === true };
    const ativo = novo.ativo !== false;
    if (!ativo && (!velho || velho.ativo !== false)) { const n = perfcUsado(id); if (n) return erro('Este perfil é usado por ' + n + ' pessoa(s). Troque o perfil delas em Sistema › Usuários antes de desativar.', 409); }
    if (!END.reautenticado(req)) return { reauth: true }; /* criar ou mudar perfil pede a senha de novo */
    const v = velho || {}, agora = Date.now();
    const out = { id, nome: nome.slice(0, 60), desc: String(novo.desc || '').slice(0, 500), mod, opc, ativo, base: String(novo.base || v.base || '').slice(0, 40),
      criadoPor: v.criadoPor || conta.id, criadoEm: v.criadoEm || agora, alteradoPor: conta.id, alteradoEm: agora, ts: +novo.ts || agora };
    ['cr', 'crBy', 'ed', 'edBy'].forEach(k => { if (novo[k] !== undefined) out[k] = novo[k]; });
    Object.keys(novo).forEach(k => delete novo[k]); Object.assign(novo, out);
    auditar(conta, req, velho ? (ativo === (v.ativo !== false) ? 'PERFIL_ACESSO_ALTERADO' : (ativo ? 'PERFIL_ACESSO_REATIVADO' : 'PERFIL_ACESSO_DESATIVADO')) : 'PERFIL_ACESSO_CRIADO', p, null,
      { nome: out.nome, mod, opc, ativo, pede: X.perfcCompilar ? X.perfcCompilar(out) : null });
    return null;
  }
  function regraUsrPerfil(velho, novo) {
    if (!Object.keys(PERF_BASE).length || novo.perfil == null || (velho && velho.perfil === novo.perfil)) return null;
    const pf = String(novo.perfil);
    if (PERF_BASE[pf] || (PERFC_ID.test(pf) && perfcAtivo(pf))) return null;
    return erro('Perfil de acesso inexistente ou desativado (' + pf.slice(0, 40) + '). Escolha um perfil da lista.', 400);
  }
  function regraFina(conta, p, velho, novo, m) {
    if (ehDono(conta)) return null;
    const d = defDe(conta), s = p.split('/'), c0 = s[0]; if (!d || d.custom || s.length !== 2) return null;
    const cp = d.campos && Array.isArray(d.campos[c0]) ? d.campos[c0] : null;
    if (cp) {
      if (m === 'DELETE' || !velho) return erro('Seu perfil não cria nem exclui este registro aqui; só registra ' + (c0 === 'ped' ? 'o recebimento do pedido' : 'o andamento') + '.');
      const livre = new Set(cp.concat(['id', 'ts', 'cr', 'crBy', 'ed', 'edBy', 'hist']));
      for (const k of new Set(Object.keys(velho).concat(Object.keys(novo)))) if (!livre.has(k) && !igual(velho[k], novo[k])) return erro('Seu perfil só altera ' + (c0 === 'ped' ? 'o recebimento' : 'o andamento') + ' deste registro (campo "' + k + '").');
      const sts = d.camposSt && d.camposSt[c0]; if (Array.isArray(sts) && !igual(velho.status, novo.status) && !sts.includes(novo.status)) return erro('Seu perfil não muda a situação deste registro para "' + String(novo.status || '') + '".');
    }
    if (Array.isArray(d.rascunho) && d.rascunho.includes(c0)) {
      if (m === 'DELETE') { if (velho && velho.status !== 'rascunho') return erro('Seu perfil só exclui notas em rascunho.'); }
      else if ((velho && velho.status !== 'rascunho') || novo.status !== 'rascunho') return erro('Seu perfil só cria e altera notas em rascunho (do recebimento). Quem lança a nota é o Comprador, o Fiscal ou o Financeiro.');
    }
    if (m === 'DELETE' && velho && Array.isArray(d.naoExclui) && d.naoExclui.includes(c0)) return erro('Seu perfil não exclui este registro (fica com o Gestor de segurança do trabalho ou um administrador).');
    if (c0 === 'cfg' && m !== 'DELETE' && Array.isArray(d.cfgNao)) { const k = d.cfgNao.find(k => !igual((velho || {})[k], novo[k])); if (k) return erro('Seu perfil não altera esta configuração (' + k + '). Fica com o Gestor de segurança do trabalho ou um administrador.'); }
    return null;
  }
  function antesGravar(conta, p, velho, novo, req) {
    const s = p.split('/'), c0 = s[0], ctx = { alertas: [] };
    if (c0 === 'perfc') { const e = regraPerfc(conta, req, p, velho, novo); if (e) return e; return { data: novo, ctx }; } /* v114 */
    if (c0 === 'usr' && s.length === 2) { const e = regraUsrPerfil(velho, novo); if (e) return e; }
    { const e = regraFina(conta, p, velho, novo, 'PUT'); if (e) return e; }
    if (c0 === 'rhdoc' && soNr(conta) && ((velho && !docNr(velho)) || !docNr(novo))) return erro('Seu perfil registra só certificados de NR. ASO, contrato e os outros documentos ficam com o Gestor de segurança do trabalho ou o RH.');
    if (c0 === 'ctbfech') return erro('Fechar e reabrir competência só pelos botões de Fiscal › Fechamento (o servidor registra quem fez e o motivo).');
    /* autor carimbado pelo servidor */
    if (!AREAS.has(c0) && c0 !== 'cfg' && c0 !== 'usr') {
      if (velho) { if (velho.crBy !== undefined) novo.crBy = velho.crBy; else delete novo.crBy; if (velho.cr !== undefined) novo.cr = velho.cr; }
      else if (novo.crBy !== undefined || s.length === 2) { novo.crBy = conta.id; if (!novo.cr) novo.cr = Date.now(); }
    }
    if (c0 === 'cfg' && !(ehDono(conta) || perfilEm(conta, ['admin']))) { const v = velho || {}; const k = CFG_PROT.find(k => !igual(v[k], novo[k])); if (k) return erro('Alçadas e aprovadores só um administrador altera.'); }
    if (c0 === 'cfg' && !(ehDono(conta) || perfilEm(conta, ['admin', 'rh'])) && !igual((velho || {}).pfonte, novo.pfonte)) return erro('As fontes e a trava do ponto só o RH ou um administrador alteram.');
    if (c0 === 'cfg' && !(ehDono(conta) || perfilEm(conta, ['admin'])) && !igual(((velho || {}).fz || {}).fech2, (novo.fz || {}).fech2)) return erro('O modo de fechamento (duas etapas) só um administrador altera.');
    if (c0 === 'cfg' && !(ehDono(conta) || perfilEm(conta, ['admin'])) && !igual((velho || {}).p0, novo.p0)) return erro('Quem vê o Painel do Início só um administrador altera.'); /* v115 */
    if (c0 === 'cfg' && !(ehDono(conta) || perfilEm(conta, ['admin'])) && !igual((velho || {}).j4, novo.j4)) return erro('As regras de aptidão para obra e de retenção dos empreiteiros só um administrador altera.');
    if (c0 === 'aptlib' && s.length === 2) { const e = regraAptLib(conta, req, velho, novo); if (e) return e; }
    if (c0 === 'pesqlink') return erro('O link da pesquisa só é criado pelo botão "Enviar link ao cliente".');
    if (c0 === 'tdoc' && !tdocGrava(conta)) return erro('Os documentos mensais dos empreiteiros (folha e guias) ficam com o Financeiro, o RH e a Segurança do trabalho.');
    if (c0 === 'pesq' && s.length === 2) ['viaLink', 'respLinkEm', 'linkEm', 'linkExpira'].forEach(k => { if (velho && velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; });
    if (c0 === 'pt' && s.length === 4 && (s[2] === 'fa' || s[2] === 'pc')) { const e = regraMinhaAreaAdto(conta, req, s, velho, novo); if (e) return e; }
    if (c0 === 'adtoit' && s.length === 2 && !velho && novo.pc) { const e = regraAdtoitPc(novo); if (e) return e; }
    if (c0 === 'func' && s.length === 2 && !(ehDono(conta) || perfilEm(conta, ['admin']))) { const v = velho || {}; if (v.locaisVeic !== undefined) novo.locaisVeic = v.locaisVeic; else delete novo.locaisVeic; }
    /* quem não vê a conta da folha não muda nome nem valor */
    if (c0 === 'lanc' && velho && ehLancFolha(velho) && !veFolha(conta)) { LANC_SENS.forEach(k => { if (velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; }); delete novo._restrito; }
    if (c0 === 'parc' && s.length === 2) regraParc(conta, req, velho, novo, ctx);
    let e = regraAprov(c0, conta, req, velho, novo, ctx); if (e) return e;
    if (s.length === 2) {
      if (c0 === 'lanc') { if (novo.aprovHerdada && !igual((velho || {}).aprovHerdada, novo.aprovHerdada) && !herancaOk(novo)) delete novo.aprovHerdada; e = docLibRetem(c0, velho, novo) || regraPago(conta, p, velho, novo) || regraDocLib(conta, req, velho, novo) || regraRetLanc(conta, req, velho, novo); if (e) return e; }
      if (c0 === 'medemp') { e = regraRetMed(conta, req, velho, novo) || docLibRetem(c0, velho, novo) || regraDocLib(conta, req, velho, novo) || regraMedemp(conta, req, velho, novo); if (e) return e; }
      if (c0 === 'rdo') { e = regraAptRdo(velho, novo); if (e) return e; }
      if (c0 === 'func') { e = regraAptFunc(velho, novo) || regraDeslFunc(velho, novo); if (e) return e; }
      if (c0 === 'desl') { e = regraDeslAuto(velho, novo); if (e) return e; }
      if (c0 === 'med') { e = regraMedCli(conta, req, velho, novo); if (e) return e; }
      if (c0 === 'fzpedfech') { e = regraPedFech(conta, req, velho, novo); if (e) return e; }
      if (c0 === 'opp') { e = regraGo(conta, req, velho, novo); if (e) return e; }
      if (c0 === 'nfse') { e = regraNfseCanc(conta, req, velho, novo); if (e) return e; }
      if (c0 === 'notas') { e = regraNotaConf(conta, req, velho, novo); if (e) return e; }
      e = travaPonto(c0, velho, novo); if (e) return e;
      e = regrasJur1(c0, conta, velho, novo) || regrasJur2(c0, conta, velho, novo); if (e) return e;
    }
    if (c0 === 'remessa' && s.length === 2) { e = regraRemessa(conta, velho, novo, req); if (e) return e; }
    e = regraAssinaturas(c0, conta, velho, novo, p); if (e) return e;
    if (s.length === 2) { e = travaCompetencia(c0, velho, novo); if (e) return e; }
    if (c0 === 'lanc' && !velho && novo.foFunc && /^fo\|/.test(String(novo.foKey || ''))) novo.sens = 'rh';
    return { data: novo, ctx };
  }
  function antesExcluir(conta, p, velho, req) {
    const s = p.split('/'), c0 = s[0];
    if (c0 === 'ctbfech') return erro('Competência fechada não se exclui; use Reabrir.');
    if (!velho) return null;
    if (c0 === 'perfc') { if (!(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('Só o Administrador ou o dono excluem perfis de acesso.'); const n = perfcUsado(s[1]); if (n) return erro('Este perfil é usado por ' + n + ' pessoa(s). Troque o perfil delas antes.', 409); if (req && !END.reautenticado(req)) return { reauth: true }; auditar(conta, req, 'PERFIL_ACESSO_EXCLUIDO', p, null, { nome: velho.nome }); } /* v114 */
    { const e = regraFina(conta, p, velho, null, 'DELETE'); if (e) return e; }
    if (c0 === 'rhdoc' && soNr(conta) && !docNr(velho)) return erro('Seu perfil exclui só certificados de NR.'); /* v114 */
    if (s.length === 2) { const e = travaCompetencia(c0, velho, null) || travaPonto(c0, velho, null); if (e) return e; }
    if (c0 === 'pesqlink') return erro('Link de pesquisa não se exclui por aqui.');
    if (c0 === 'aptlib' && !ehDono(conta)) return erro('Liberação do SST não se exclui: use Revogar (fica registrada).');
    if (c0 === 'lanc' && velho.retPendDe && !(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('A conta "retenção a liberar" não se exclui. Ela é paga ou compensada com a liberação da diretoria.');
    if (c0 === 'tdoc' && !tdocGrava(conta)) return erro('Os documentos mensais dos empreiteiros ficam com o Financeiro, o RH e a Segurança do trabalho.');
    if (c0 === 'pt' && s.length === 4 && s[2] === 'pc' && velho.st) return erro('Comprovante já tratado pelo Financeiro não pode ser excluído.');
    if (c0 === 'pt' && s.length === 4 && s[2] === 'fa' && !(ehDono(conta) || gravaGrupo(conta, 'fin'))) return erro('Só o Financeiro altera o resumo de adiantamentos.');
    if (c0 === 'remessa' && velho.status !== 'cancelada' && !(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('Cancele a remessa em vez de excluir.');
    if (c0 === 'epi' && velho.assin && !(ehDono(conta) || perfilEm(conta, ['admin']))) return erro('Entrega de EPI assinada não pode ser excluída.');
    return null;
  }
  function depois(conta, req, metodo, p, antes, depois_, v) {
    auditar(conta, req, metodo, p, antes, depois_);
    PRIV.aposGravar(auditar, conta, req, p, antes, depois_); /* v112: anonimização do titular alcança a auditoria */
    atualizarCitacoes(conta, p, depois_);
    if (v && v.ctx) for (const a of v.ctx.alertas) alertar(a[0], a[1], req, a[2]);
  }

  /* =====================================================================
     ROTAS
     ===================================================================== */
  async function rota(p, m, req, res, conta, u) {
    const R = async fn => { const b = await lerJson(req); const r = fn(b); if (r.reauth) { auditar(conta, req, 'PEDE_SENHA', p, null, null); if (END.exigirReauth(req, res)) return; return json(res, 409, { erro: 'Repita a ação.' }); } if (r.erro) return json(res, r.st || 403, { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : 'not_granted', erro: r.erro }); return json(res, 200, r); };
    if (m === 'POST' && (p === '/api/aprovar')) { await R(b => rotaAprovar(conta, req, b)); return true; }
    if (m === 'POST' && (p === '/api/fin/banco/confirmar' || p === '/api/fin/banco/recusar')) { await R(b => rotaBanco(p.endsWith('confirmar') ? 'confirmar' : 'recusar', conta, req, b)); return true; }
    if (m === 'POST' && (p === '/api/competencia/fechar' || p === '/api/competencia/reabrir')) { await R(b => rotaCompetencia(p.endsWith('fechar') ? 'fechar' : 'reabrir', conta, req, b)); return true; }
    if (m === 'POST' && p === '/api/epi/assinar') { await R(b => rotaEpiAssinar(conta, req, b)); return true; }
    if (m === 'POST' && p === '/api/minha-area/confirmar') { await R(b => rotaMinhaArea(conta, req, b)); return true; }
    if (m === 'POST' && p === '/api/pesquisa/link') { await R(b => rotaPesqLink(conta, req, b)); return true; }
    if (m === 'POST' && p === '/api/admin/avisos') { /* dono: mandar agora o aviso aos aprovadores ou o resumo dos cadastros bancários */
      if (!ehDono(conta)) { json(res, 403, { code: 'not_granted', erro: 'Só o dono.' }); return true; }
      const b = await lerJson(req); json(res, 200, b.tipo === 'resumo' ? enviarResumo() : avisarAprovadores()); return true; }
    if (m === 'GET' && p === '/api/aprovacoes/pendentes') { /* quem vai receber o aviso diário (conferência) */
      if (!(ehDono(conta) || perfilEm(conta, ['admin']))) { json(res, 403, { code: 'not_granted', erro: 'Só administrador.' }); return true; }
      json(res, 200, { itens: pendenciasAprovacao().map(i => Object.assign({}, i, { quem: i.quem.map(nomeConta) })) }); return true; }
    const mr = p.match(/^\/api\/remessa\/([\w\-.|~@+=]{1,200})\/arquivo$/); if (mr && m === 'GET') { rotaRemessaArquivo(conta, req, res, mr[1]); return true; }
    if (p === '/contas/auditoria' && m === 'GET') {
      if (conta.nivel !== 'owner') { auditar(conta, req, 'AUDITORIA_NEGADA', p, null, null); res.writeHead(303, { location: '/' }); res.end(); return true; }
      /* v112 (B2): quem consulta a auditoria e o que filtrou fica registrado */
      const fl = {}; ['conta', 'cam', 'met', 'de', 'ate', 'pg'].forEach(k => { const v = u.searchParams.get(k); if (v) fl[k] = String(v).slice(0, 100); });
      auditar(conta, req, 'AUDITORIA_CONSULTA', p, null, { filtros: fl });
      X.html(res, 200, pagAuditoria(conta, u)); return true;
    }
    /* v112 (B5): relatório do titular completo, gerado pelo servidor (RH, Administrador ou dono) */
    if (p === '/api/lgpd/titular' && m === 'POST') {
      if (!PRIV.podeTitular(conta)) { auditar(conta, req, 'LGPD_RELATORIO_NEGADO', p, null, null); json(res, 403, { code: 'not_granted', erro: 'Só o RH, um administrador ou o dono geram o relatório do titular.' }); return true; }
      const b = await lerJson(req), r = PRIV.relatorioTitular(conta, b);
      if (r.erro) { json(res, r.st || 400, { code: r.st === 404 ? 'not_found' : 'invalid_argument', erro: r.erro }); return true; }
      auditar(conta, req, 'LGPD_RELATORIO_TITULAR', String(b.tipo) + '/' + String(b.id), null, { secoes: r.secoes.map(s => s.col + ':' + s.n), auditoria: r.auditoria.length, completo: r.completo });
      json(res, 200, r); return true;
    }
    /* v112 (B4): prazos que o próprio servidor aplica, para a tabela de temporalidade */
    if (p === '/api/lgpd/prazos' && m === 'GET') {
      if (NIV[conta.nivel] < NIV.admin) { json(res, 403, { code: 'not_granted' }); return true; }
      const bk = X.BACKUP && X.BACKUP.estado ? X.BACKUP.estado() : {};
      json(res, 200, { auditoriaDias: AUD_DIAS, lixoAnexosDias: LIXO_DIAS, backupDias: bk.dias || null, backupS3: !!bk.s3Configurado, backupCifrado: !!bk.cifrado, leituraSaude: [...PRIV.SAUDE_LEIT] }); return true;
    }
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
    return pag('Auditoria', '<nav><a class="btn" href="/">← Voltar ao sistema</a><a class="btn" href="/contas">Contas de acesso</a><a class="btn" href="/sair">Sair</a></nav><h1>Auditoria</h1><p class="sub">Tudo o que foi gravado ou excluído, entradas e falhas de login, ações de conta, duas etapas, downloads de anexos sensíveis, backups, aprovações e alertas. Gravado pelo servidor; guardado por ' + AUD_DIAS + ' dias (AUDITORIA_DIAS). Só o dono vê esta página, e cada consulta fica registrada aqui (AUDITORIA_CONSULTA).</p><p class="sub">Nas alterações aparecem só os campos que mudaram. CPF, dados bancários e PIX, salário e valores de folha e os campos de saúde (ASO, afastamentos, acidentes, psicossocial) aparecem como "(protegido · h:…)": o código muda quando o valor muda, mas não mostra o valor. A leitura de dados de saúde aparece como LEITURA_SAUDE (uma linha por pessoa, coleção e dia) e o uso da IA como IA_USO, sem o conteúdo.</p>' + (msg ? '<div class="msg">' + esc(msg) + '</div>' : '') +
      '<div class="card"><form method="get" action="/contas/auditoria"><div class="row"><label>Pessoa<select name="conta"><option value="">Todas</option>' + cs.map(c => '<option value="' + esc(c.id) + '"' + (c.id === f.conta ? ' selected' : '') + '>' + esc(c.nome || c.email || c.id) + '</option>').join('') + '</select></label><label>Caminho contém<input name="cam" value="' + esc(f.cam) + '" placeholder="ex.: parc/, lanc/, /login"></label><label>Ação começa com<input name="met" value="' + esc(f.met) + '" placeholder="ex.: PUT, DELETE, LOGIN, APROVAR"></label></div><div class="row"><label>De<input type="date" name="de" value="' + esc(f.de) + '"></label><label>Até<input type="date" name="ate" value="' + esc(f.ate) + '"></label><div><button class="pri" type="submit">Filtrar</button> <a class="btn" href="/contas/auditoria">Limpar</a></div></div></form></div>' +
      '<div class="card"><h2>' + tot + ' registro(s)' + (tot > N ? ' · página ' + (f.pg + 1) + ' de ' + Math.ceil(tot / N) : '') + '</h2><div style="overflow-x:auto"><table><thead><tr><th>Quando</th><th>Pessoa</th><th>Endereço</th><th>Ação</th><th>Caminho</th><th>Detalhes</th></tr></thead><tbody>' +
      ls.map(r => '<tr><td style="white-space:nowrap">' + quando(r.ts) + '</td><td>' + esc(r.conta ? nomeConta(r.conta) : '—') + '</td><td>' + esc(r.ip || '') + '</td><td>' + esc(r.metodo) + '</td><td style="word-break:break-all">' + esc(r.caminho) + '</td><td>' + (r.antes || r.depois ? '<details><summary>ver</summary>' + (r.antes ? '<div class="sub">Antes</div><pre style="white-space:pre-wrap;max-width:520px;font-size:12px">' + fmt(r.antes) + '</pre>' : '') + (r.depois ? '<div class="sub">Depois</div><pre style="white-space:pre-wrap;max-width:520px;font-size:12px">' + fmt(r.depois) + '</pre>' : '') + '</details>' : '') + '</td></tr>').join('') +
      '</tbody></table></div>' + (tot > N ? '<p>' + (f.pg > 0 ? '<a class="btn" href="/contas/auditoria?' + qs({ pg: f.pg - 1 }) + '">← Mais recentes</a> ' : '') + ((f.pg + 1) * N < tot ? '<a class="btn" href="/contas/auditoria?' + qs({ pg: f.pg + 1 }) + '">Mais antigos →</a>' : '') + '</p>' : '') + '</div>' +
      '<div class="card"><h2>Lixeira de anexos</h2><p class="sub" style="margin:0 0 10px">Anexos excluídos ficam aqui por ' + LIXO_DIAS + ' dias e depois são apagados de vez.</p>' + (lixo.length ? '<table><thead><tr><th>Arquivo</th><th>Origem</th><th>Enviado por</th><th>Excluído</th><th></th></tr></thead><tbody>' + lixo.map(x => '<tr><td>' + esc(x.id) + '<div class="sub">' + esc(x.ct || '') + ' · ' + Math.round((x.tam || 0) / 1024) + ' KB</div></td><td>' + esc(x.origem || '—') + '</td><td>' + esc(nomeConta(x.por)) + '</td><td>' + quando(x.lixo) + '<div class="sub">por ' + esc(nomeConta(x.lixoPor)) + '</div></td><td><form method="post" action="/contas/auditoria/anexo"><input type="hidden" name="id" value="' + esc(x.id) + '"><button type="submit">Restaurar</button></form></td></tr>').join('') + '</tbody></table>' : '<p class="sub" style="margin:0">Vazia.</p>') + '</div>');
  }

  /* v112: leitura das coleções de saúde (server.js chama nas rotas de leitura e no envio ao vivo) e uso da IA */
  const registrarLeitura = (conta, req, col, ids, via) => PRIV.registrarLeitura(conta, req, col, ids, via);
  const auditarIa = (conta, req, corpo, ok, erroIa) => auditar(conta, req, 'IA_USO', '/api/ia', null, PRIV.resumoIa(req, corpo || {}, ok, erroIa));
  return { podeLer, redigir, antesGravar, antesExcluir, depois, excecaoGravacao, auditar, auditarHttp, rota, servirBlob, listarAnexos, excluirAnexo, MODO_LEIT,
    pontoTravado, rotaPublica, aprovadoresDe, avisarAprovadores, enviarResumo, registrarLeitura, ehSaude: PRIV.ehSaude, auditarIa, PRIV };
};

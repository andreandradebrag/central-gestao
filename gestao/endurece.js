'use strict';
/* Central de Gestão — endurecimento do servidor (segurança de acesso e de infraestrutura).
   Fica num módulo próprio para o server.js ter só poucas linhas de ligação. Reúne:
   - verificação em duas etapas obrigatória (DOIS_FATORES_OBRIGATORIO = equipe | dono | nao; DOIS_FATORES_CARENCIA_DIAS)
     e senha mínima de 12 caracteres (SENHA_MINIMA_EQUIPE) para o dono e perfis de Equipe que gravam;
   - sessão que expira por inatividade (SESSAO_INATIVIDADE_HORAS, padrão 10; SESSAO_COLABORADOR_DIAS, padrão 30)
     e reautenticação (senha ou código) para ações sensíveis (REAUTENTICAR_MINUTOS, padrão 15);
   - /setup protegido por SETUP_TOKEN;
   - política de conteúdo (CSP) do sistema e das páginas simples;
   - bibliotecas servidas de public/vendor (pdf.js, JSZip e, quando copiadas, SheetJS, html2canvas e jsPDF);
   - mensagens das páginas por código, cota de anexos por conta e alerta de disco, segredo TOTP cifrado,
     atraso progressivo no login, privacidade do Colaborador, conferência das mensagens do chat e do id de anexo.

   Função para outras rotas (ex.: financeiro):  if (END.exigirReauth(req, res)) return;
   Ela responde 403 {code:'reauth_required'} quando a pessoa não confirmou a senha/código nos últimos
   REAUTENTICAR_MINUTOS; o navegador (new_segb.js) pede a senha e repete o pedido sozinho. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

/* bibliotecas do navegador: endereço da CDN usado pelo sistema -> cópia local em public/ */
const VENDOR = [
  { cdn: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', local: 'vendor/pdfjs/pdf.min.mjs', tipo: 'pdfjs', worker: 'vendor/pdfjs/pdf.worker.min.mjs', base: 'vendor/pdfjs/' },
  { cdn: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', local: 'vendor/xlsx/xlsx.full.min.js' },
  { cdn: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', local: 'vendor/html2canvas/html2canvas.min.js' },
  { cdn: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', local: 'vendor/jspdf/jspdf.umd.min.js' },
  { cdn: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', local: 'vendor/jszip/jszip.min.js' },
  { cdn: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', local: 'vendor/pdflib/pdf-lib.min.js' } /* v111: assinatura/montagem de PDF (new_rh2.js) */
];
/* integridade (SRI) dos arquivos da CDN usados quando a cópia local não existe. Só entra aqui o que foi
   calculado sobre o arquivo da mesma versão: jszip.min.js 3.10.1 do pacote npm (o mesmo que a cdnjs publica).
   Os outros não puderam ser baixados neste ambiente; veja o LEIA-ME (Bibliotecas do navegador). */
const CDN_SRI = {
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js': 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG'
};
const CONEXOES_EXTERNAS = ['https://viacep.com.br', 'https://brasilapi.com.br', 'https://publica.cnpj.ws'];
const PESSOAIS = new Set(['chat', 'ponto', 'meu']);
const SEM_GRAVACAO = new Set(['leitura', 'leituratotal', 'pendente', 'semnivel', 'semid', 'colaborador']);
const RE_ANX = /^[A-Za-z0-9_-]{6,64}$/;

module.exports = function criar(o) {
  const { db, q, SEG, PUB } = o, F = () => o.fn(), env = process.env;
  const NIV = { view: 1, interact: 2, admin: 3, owner: 4 }; /* os mesmos níveis do server.js */
  const als = new AsyncLocalStorage();
  try { db.exec('ALTER TABLE sessoes ADD COLUMN reauth INTEGER'); } catch (e) { }
  db.exec('CREATE TABLE IF NOT EXISTS seg_2f(conta TEXT PRIMARY KEY, desde INTEGER)');
  let PERM = { perfis: {} }; try { PERM = JSON.parse(fs.readFileSync(path.join(__dirname, 'perfis.json'), 'utf8')); } catch (e) { }

  /* ---------------- segredo TOTP cifrado (CHAVE_MESTRA) ---------------- */
  function cifrarTotps() {
    if (!SEG.chaveMestra()) return 0;
    let n = 0; for (const r of db.prepare('SELECT id, totp FROM contas WHERE totp IS NOT NULL').all()) if (!SEG.segredoCifrado(r.totp)) { db.prepare('UPDATE contas SET totp=? WHERE id=?').run(SEG.cifrarSegredo(r.totp), r.id); n++; }
    return n;
  }
  { const n = cifrarTotps(); if (n) console.log('[seguranca] ' + n + ' segredo(s) de verificação em duas etapas cifrado(s) com CHAVE_MESTRA.');
    if (!SEG.chaveMestra()) { const c = db.prepare("SELECT count(*) AS n FROM contas WHERE totp LIKE 'c1:%'").get().n; if (c) console.error('[seguranca] ATENÇÃO: ' + c + ' conta(s) têm o segredo de duas etapas cifrado, mas CHAVE_MESTRA não está definida. Essas pessoas não conseguem entrar até a chave voltar (ou use DOIS_FATORES_RESET).'); } }

  /* ---------------- política de duas etapas e de senha ---------------- */
  const MODO_2F = () => { const v = String(env.DOIS_FATORES_OBRIGATORIO || 'equipe').toLowerCase(); return ['equipe', 'dono', 'nao'].includes(v) ? v : 'equipe'; };
  const MIN_EQ = () => Math.max(8, +env.SENHA_MINIMA_EQUIPE || 12);
  const PERMv = () => { try { const x = F().PERM; if (x && x.perfis) return x; } catch (e) { } return PERM; }; /* v114: o mapa do server.js já inclui os perfis personalizados */
  function perfilGrava(pf) { const P = PERMv(), pr = P.perfis && P.perfis[pf]; if (!pr) return !SEM_GRAVACAO.has(pf); if (pr.w === '*') return true; return (pr.w || []).some(g => !PESSOAIS.has(g)); }
  function equipeQueGrava(c) { if (!c) return false; if (c.nivel === 'owner') return true; if ((NIV[c.nivel] || 0) < NIV.admin) return false; return perfilGrava(F().perfilDe(c)); }
  function exige2f(c) { const m = MODO_2F(); if (m === 'nao' || !c) return false; if (c.nivel === 'owner') return true; if (m === 'dono') return false; return equipeQueGrava(c); }
  const minSenha = c => equipeQueGrava(c) ? MIN_EQ() : 8;
  const minNivel = n => (n === 'admin' || n === 'owner') ? MIN_EQ() : 8;
  const senhaFraca0 = SEG.senhaFraca;
  SEG.senhaFraca = (s, email, nome, min) => { if (min == null) { const c = email ? q.contaPorEmail.get(String(email).trim()) : null; min = c ? minSenha(c) : MIN_EQ(); } return senhaFraca0(s, email, nome, min); };
  function situacao2f(c0) {
    const c = c0 && q.contaPorId.get(c0.id); if (!c) return { obrigatorio: false, ligado: false, bloqueado: false };
    const ob = exige2f(c); if (!ob || c.totp) return { obrigatorio: ob, ligado: !!c.totp, bloqueado: false };
    let r = db.prepare('SELECT desde FROM seg_2f WHERE conta=?').get(c.id);
    if (!r) { r = { desde: Date.now() }; db.prepare('INSERT OR IGNORE INTO seg_2f(conta,desde) VALUES(?,?)').run(c.id, r.desde); }
    const prazo = r.desde + Math.max(0, +env.DOIS_FATORES_CARENCIA_DIAS || 0) * 864e5;
    return { obrigatorio: true, ligado: false, prazo, bloqueado: Date.now() >= prazo };
  }

  /* ---------------- sessão: inatividade e reautenticação ---------------- */
  const INAT = c => (NIV[c.nivel] || 0) >= NIV.admin ? Math.max(0.25, +env.SESSAO_INATIVIDADE_HORAS || 10) * 3600e3 : Math.max(1, +env.SESSAO_COLABORADOR_DIAS || 30) * 864e5;
  function sessaoInativa(s, c) {
    if (!s || !c) return true;
    if (Date.now() - (s.visto || s.criado || 0) > INAT(c)) { try { q.sessDel.run(s.token); } catch (e) { } return true; }
    return false;
  }
  setInterval(() => {
    const CONEX = F().CONEX; if (!CONEX) return;
    for (const [cid, c] of CONEX) {
      const s = c.sess && q.sessGet.get(c.sess), ca = s && q.contaPorId.get(s.conta);
      if (!s || s.expira < Date.now() || !ca || sessaoInativa(s, ca)) { CONEX.delete(cid); try { c.res.end(); } catch (e) { } }
    }
    const agora = Date.now();
    for (const [k, v] of FLASH) if (agora - v.em > 15 * 60000) FLASH.delete(k);
    for (const [k, v] of LOGIN) if (agora - v.em > 3600e3) LOGIN.delete(k);
    for (const [k, v] of REAUTH_ERR) if (agora - v.em > 3600e3) REAUTH_ERR.delete(k);
    try { db.prepare('DELETE FROM totp_novo WHERE expira<?').run(agora); } catch (e) { }
    try { cifrarTotps(); } catch (e) { }
  }, Math.max(5000, +env.SESSAO_VARREDURA_MS || 300000)).unref();

  const JANELA = () => Math.max(1, +env.REAUTENTICAR_MINUTOS || 15) * 60000;
  const sessaoDe = req => { const t = F().cookies(req).sid; return t ? q.sessGet.get(SEG.sha(t)) : null; };
  function reautenticado(req) { const s = sessaoDe(req); if (!s) return false; return Date.now() - Math.max(s.reauth || 0, s.criado || 0) <= JANELA(); }
  /* para as rotas do servidor: if (END.exigirReauth(req, res)) return; */
  function exigirReauth(req, res) {
    if (reautenticado(req)) return false;
    F().json(res, 403, { code: 'reauth_required', erro: 'Por segurança, confirme sua senha (ou o código do aplicativo) para continuar.', url: '/conta/reautenticar' });
    return true;
  }
  const REAUTH_ERR = new Map();
  /* confere senha ou código; devolve 'ok', 'erro' ou 'sair' (muitas tentativas: a sessão é encerrada) */
  function conferirReauth(req, conta, segredo) {
    const c = q.contaPorId.get(conta.id), v = String(segredo || '').trim(), s = sessaoDe(req); if (!c || !s) return 'sair';
    let ok = false;
    if (c.totp && /^\d{3}\s?\d{3}$/.test(v)) { const ps = SEG.confereCodigo(c.totp, v, c.totp_ult); if (ps > 0) { db.prepare('UPDATE contas SET totp_ult=? WHERE id=?').run(ps, c.id); ok = true; } }
    if (!ok && v && SEG.confere(v, c.hash)) ok = true;
    if (ok) { REAUTH_ERR.delete(c.id); db.prepare('UPDATE sessoes SET reauth=? WHERE token=?').run(Date.now(), s.token); return 'ok'; }
    const e = REAUTH_ERR.get(c.id) || { n: 0 }; e.n++; e.em = Date.now(); REAUTH_ERR.set(c.id, e);
    if (e.n >= 5) { REAUTH_ERR.delete(c.id); q.sessDel.run(s.token); return 'sair'; }
    return 'erro';
  }
  const voltaOk = v => typeof v === 'string' && /^\/(?!\/)[^\\\s]*$/.test(v) && v.length < 500 ? v : '/';
  function pagReauth(conta, volta, erro) {
    const { pag, esc } = F(), c = q.contaPorId.get(conta.id);
    return pag('Confirmar identidade', '<div class="card" style="max-width:420px;margin:40px auto"><h1>Confirme que é você</h1><p class="sub">Esta ação é sensível. Digite sua senha' + (c && c.totp ? ' ou o código de 6 dígitos do aplicativo autenticador' : '') + ' para continuar. Vale por ' + Math.round(JANELA() / 60000) + ' minutos.</p>' +
      (erro ? '<div class="msg err">' + esc(erro) + '</div>' : '') +
      '<form method="post" action="/conta/reautenticar"><input type="hidden" name="volta" value="' + esc(volta) + '"><label>' + (c && c.totp ? 'Senha ou código do aplicativo' : 'Senha') + '<input name="segredo" type="password" required autofocus autocomplete="current-password"></label><button class="pri" type="submit" style="width:100%">Confirmar</button></form>' +
      '<p class="sub" style="margin:14px 0 0;text-align:center"><a href="/">Cancelar</a></p></div>');
  }

  /* ações sensíveis das páginas do servidor: [método, caminho, quem (dono|gestor), volta depois de confirmar] */
  const SENSIVEIS = [
    ['POST', /^\/contas\/(salvar|editar)$/, 'gestor', '/contas'], ['POST', /^\/contas\/backup-agora$/, 'dono', '/contas'],
    ['GET', /^\/contas\/backups\/[^/]+$/, 'dono', null], ['GET', /^\/migrar$/, 'dono', null],
    ['POST', /^\/api\/admin\/importar$/, 'dono'], ['GET', /^\/api\/admin\/exportar$/, 'dono'],
    ['POST', /^\/api\/contas$/, 'gestor'], ['POST', /^\/api\/contas\/[A-Za-z0-9_-]{1,60}$/, 'gestor'],
    ['POST', /^\/api\/contas-acesso\/([A-Za-z0-9_-]{1,60}\/(provisoria|reativar)|convite-todos)$/, 'gestor'] /* v130.1 */
  ];

  /* ---------------- v111: aparelho confiável por 30 dias (verificação em duas etapas) ----------------
     Só para perfis sem Financeiro e sem Administrador (nem dono, nem Diretoria, que aprova pagamentos). Depois do código
     certo, a pessoa pode marcar "confiar neste aparelho": o servidor grava um cookie assinado (HMAC) só para /login e
     guarda o hash dele. No próximo login com a senha certa, o código não é pedido. Revoga em Segurança › Aparelhos
     confiáveis, ao desligar a verificação, ao trocar a senha ou ao "sair de todos os outros aparelhos".
     APARELHO_CONFIAVEL=0 desliga; APARELHO_CONFIAVEL_DIAS (padrão 30, máx. 90). */
  db.exec('CREATE TABLE IF NOT EXISTS aparelhos(id TEXT PRIMARY KEY, conta TEXT NOT NULL, hash TEXT NOT NULL, criado INTEGER, expira INTEGER, ua TEXT, ip TEXT, usado INTEGER, revogado INTEGER)');
  const APC_LIGADO = () => !/^(0|nao|não|false|desligado)$/i.test(String(env.APARELHO_CONFIAVEL == null ? '1' : env.APARELHO_CONFIAVEL));
  const APC_DIAS = () => Math.max(1, Math.min(90, +env.APARELHO_CONFIAVEL_DIAS || 30));
  let APC_CHAVE = null;
  function apcChave() {
    if (APC_CHAVE) return APC_CHAVE;
    const cm = SEG.chaveMestra && SEG.chaveMestra();
    if (cm) APC_CHAVE = crypto.createHash('sha256').update('aparelho-confiavel|' + (Buffer.isBuffer(cm) ? cm.toString('hex') : String(cm))).digest();
    else { let r = db.prepare("SELECT v FROM cfg WHERE k='apc_chave'").get(); if (!r) { const v = crypto.randomBytes(32).toString('hex'); db.prepare("INSERT OR REPLACE INTO cfg(k,v) VALUES('apc_chave',?)").run(v); r = { v }; } APC_CHAVE = Buffer.from(r.v, 'hex'); }
    return APC_CHAVE;
  }
  const apcAssina = t => crypto.createHmac('sha256', apcChave()).update(t).digest('base64url');
  function aparelhoElegivel(c) {
    if (!APC_LIGADO() || !c || c.nivel === 'owner') return false;
    const pf = F().perfilDe(c), P = PERMv(); if (['admin', 'financeiro', 'diretoria'].includes(pf)) return false;
    const pr = P.perfis && P.perfis[pf]; if (pr && (pr.w === '*' || pr.r === '*' || (pr.w || []).includes('fin'))) return false;
    if (pr && pr.custom && (pr.banco || pr.aprovDir || pr.sensRh)) return false; /* v114: personalizado com dados bancários, RH ou decisão da diretoria não usa aparelho confiável */
    return true;
  }
  /* devolve o cabeçalho Set-Cookie do aparelho confiável (para somar ao da sessão) */
  function aparelhoEmitir(req, c) {
    const id = crypto.randomBytes(9).toString('base64url'), tok = crypto.randomBytes(32).toString('base64url'), ag = Date.now(), exp = ag + APC_DIAS() * 864e5;
    db.prepare('INSERT INTO aparelhos(id,conta,hash,criado,expira,ua,ip) VALUES(?,?,?,?,?,?,?)').run(id, c.id, SEG.sha(tok), ag, exp, String(req.headers['user-agent'] || '').slice(0, 300), F().ipDe(req));
    const v = id + '.' + tok, seguro = String(req.headers['x-forwarded-proto'] || '').includes('https') || !!req.socket.encrypted;
    return { id, cookie: 'apc=' + v + '.' + apcAssina(v + '.' + c.id) + '; Path=/login; HttpOnly; SameSite=Lax; Max-Age=' + APC_DIAS() * 86400 + (seguro ? '; Secure' : '') };
  }
  /* id do aparelho confiável válido para esta conta (ou null) */
  function aparelhoValido(req, c) {
    try {
      if (!aparelhoElegivel(c)) return null;
      const v = String(F().cookies(req).apc || ''), ps = v.split('.'); if (ps.length !== 3) return null;
      const a = Buffer.from(ps[2]), b = Buffer.from(apcAssina(ps[0] + '.' + ps[1] + '.' + c.id)); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const r = db.prepare('SELECT * FROM aparelhos WHERE id=?').get(ps[0]); if (!r || r.conta !== c.id || r.revogado || r.expira < Date.now() || r.hash !== SEG.sha(ps[1])) return null;
      db.prepare('UPDATE aparelhos SET usado=? WHERE id=?').run(Date.now(), r.id); return r.id;
    } catch (e) { return null; }
  }
  const aparelhosDe = contaId => db.prepare('SELECT id, ua, ip, criado, expira, usado FROM aparelhos WHERE conta=? AND revogado IS NULL AND expira>? ORDER BY criado DESC').all(contaId, Date.now());
  const aparelhoRevogar = (contaId, id) => db.prepare('UPDATE aparelhos SET revogado=? WHERE conta=? AND id=? AND revogado IS NULL').run(Date.now(), contaId, String(id || '')).changes;
  const aparelhosRevogarTodos = contaId => db.prepare('UPDATE aparelhos SET revogado=? WHERE conta=? AND revogado IS NULL').run(Date.now(), contaId).changes;
  function cartaoAparelhos(c) {
    const { esc } = F(), quando = t => t ? new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
    if (!aparelhoElegivel(c)) return '<div class="card"><h2>Aparelhos confiáveis</h2><p class="sub" style="margin:0">' + (APC_LIGADO() ? 'Para o seu perfil (Administrador, Financeiro, Diretoria ou dono) o código do aplicativo é pedido em todo login: não existe "confiar neste aparelho".' : 'Desligado neste servidor (APARELHO_CONFIAVEL=0).') + '</p></div>';
    const ls = aparelhosDe(c.id);
    return '<div class="card"><h2>Aparelhos confiáveis</h2><p class="sub" style="margin:0 0 10px">Nestes aparelhos o sistema não pede o código do aplicativo por ' + APC_DIAS() + ' dias (a senha continua sendo pedida). Revogue se perder o celular ou se o aparelho não for mais seu.</p>' +
      (ls.length ? '<table><thead><tr><th>Aparelho</th><th>Endereço</th><th>Desde</th><th>Último uso</th><th>Vale até</th><th></th></tr></thead><tbody>' + ls.map(a => '<tr><td>' + esc(SEG.aparelho ? SEG.aparelho(a.ua) : a.ua) + '</td><td>' + esc(a.ip || '—') + '</td><td>' + quando(a.criado) + '</td><td>' + quando(a.usado) + '</td><td>' + quando(a.expira) + '</td><td><form method="post" action="/conta/seguranca/aparelho-revogar"><input type="hidden" name="id" value="' + esc(a.id) + '"><button type="submit" class="dng">Revogar</button></form></td></tr>').join('') + '</tbody></table>'
        : '<p class="sub" style="margin:0">Nenhum. Ao digitar o código no login, marque "Confiar neste aparelho".</p>') + '</div>';
  }

  /* ---------------- mensagens das páginas por código ---------------- */
  const FLASH = new Map();
  const CODIGOS = {
    '2f': ['Para continuar usando o sistema, ligue a verificação em duas etapas na sua conta (obrigatória para o seu perfil). Leva 2 minutos: instale um aplicativo autenticador e leia o QR Code abaixo.', true],
    'reauth': ['Identidade confirmada. Repita a ação.', false]
  };
  function redir(res, to) {
    let dest = String(to); const i = dest.indexOf('?');
    if (i >= 0) {
      const sp = new URLSearchParams(dest.slice(i + 1));
      if (sp.has('m')) { const id = crypto.randomBytes(12).toString('base64url'); if (FLASH.size > 5000) FLASH.clear(); FLASH.set(id, { m: sp.get('m'), e: sp.get('e') === '1', em: Date.now() }); sp.delete('m'); sp.delete('e'); sp.set('c', id); dest = dest.slice(0, i) + '?' + sp.toString(); }
    }
    res.writeHead(303, { location: dest }); res.end();
  }
  /* devolve [mensagem, erro] para pagSeguranca/pagContas; texto livre na URL (?m=) é ignorado */
  function msg(u) {
    const c = u.searchParams.get('c'); if (!c) return ['', ''];
    if (CODIGOS[c]) return [CODIGOS[c][0], CODIGOS[c][1] ? '1' : ''];
    const f = FLASH.get(c); return f && Date.now() - f.em < 15 * 60000 ? [f.m, f.e ? '1' : ''] : ['', ''];
  }

  /* ---------------- login: atraso progressivo por e-mail (sem travar a conta) ---------------- */
  const LOGIN = new Map();
  /* v130.1: limite por endereço (IP) mais tolerante para escritórios. Na empresa todos saem para a internet pelo MESMO IP;
     com 8 erros somados de todas as pessoas o escritório inteiro ficava 10 minutos sem entrar. Agora:
     - por IP: LOGIN_IP_FALHAS (padrão 30) erros dentro de uma janela de LOGIN_IP_JANELA_MIN (padrão 15) minutos bloqueiam o IP
       por LOGIN_IP_BLOQUEIO_MIN (padrão 15) minutos. É a barreira contra quem testa MUITOS e-mails do mesmo lugar;
     - por e-mail (protege cada conta): continua o atraso progressivo abaixo (depois de 3 erros, 1, 2, 4... até 15 s por tentativa);
     - um login certo zera só o contador do PRÓPRIO e-mail: não apaga os erros que outras pessoas do mesmo IP fizeram
       (antes, um acerto de qualquer pessoa zerava o IP, o que também deixava um atacante "limpar" o contador com uma conta dele). */
  const IP_LIM = () => Math.max(5, +env.LOGIN_IP_FALHAS || 30), IP_JAN = () => Math.max(1, +env.LOGIN_IP_JANELA_MIN || 15) * 60000, IP_BLQ = () => Math.max(1, +env.LOGIN_IP_BLOQUEIO_MIN || 15) * 60000;
  function loginAntes(ip) {
    const t = LOGIN.get('ip:' + ip); if (t && t.ate > Date.now()) return 'Muitas tentativas deste endereço. Aguarde alguns minutos.';
    return '';
  }
  /* situação de bloqueio (para Sistema › Usuários): até quando o e-mail ou algum dos IPs informados está bloqueado */
  /* a rota de login guarda o e-mail como 'e:<email>' e o contador fica em LOGIN['e:' + isso] */
  const chaveEmail = email => 'e:e:' + String(email || '').trim().toLowerCase().slice(0, 254);
  function loginEstado(email, ips) {
    const agora = Date.now(), e = LOGIN.get(chaveEmail(email));
    let ipAte = 0; for (const ip of ips || []) { const t = LOGIN.get('ip:' + ip); if (t && t.ate > agora) ipAte = Math.max(ipAte, t.ate); }
    const emailAte = e && e.n > 3 && agora - (e.em || 0) <= 15 * 60000 ? (e.em || 0) + 15 * 60000 : 0;
    return { ipAte, emailAte, ate: Math.max(ipAte, emailAte), falhasEmail: e && agora - (e.em || 0) <= 15 * 60000 ? e.n : 0 };
  }
  /* Desbloquear (Sistema › Usuários): limpa o atraso do e-mail e o bloqueio dos IPs de onde vieram os erros dessa conta */
  function loginDesbloquear(email, ips) { LOGIN.delete(chaveEmail(email)); for (const ip of ips || []) LOGIN.delete('ip:' + ip); }
  /* depois de 3 erros seguidos no mesmo e-mail, cada nova tentativa nesse e-mail espera a sua vez: 1, 2, 4, 8... até 15 s
     entre uma e outra. A conta não é travada: com a senha certa a pessoa entra (no máximo espera um pouco).
     Se a fila passar de 1 minuto, responde "tente em 1 minuto" sem contar como erro. */
  async function loginEspera(email) {
    const e = LOGIN.get('e:' + email); if (!e || e.n <= 3 || Date.now() - e.em > 15 * 60000) return true;
    const atraso = Math.min(15000, 1000 * 2 ** (e.n - 4)), agora = Date.now(), vez = Math.max(agora, e.prox || 0);
    if (vez - agora > 60000) return false;
    e.prox = vez + atraso; await new Promise(r => setTimeout(r, vez - agora)); return true;
  }
  async function loginFalhou(ip, email) {
    const t = LOGIN.get('ip:' + ip) || { n: 0, ate: 0, ini: Date.now() }; if (Date.now() - (t.ini || 0) > IP_JAN()) { t.n = 0; t.ini = Date.now(); }
    t.n++; t.em = Date.now(); if (t.n >= IP_LIM()) { t.ate = Date.now() + IP_BLQ(); t.n = 0; t.ini = Date.now(); } LOGIN.set('ip:' + ip, t);
    const e = LOGIN.get('e:' + email) || { n: 0 }; if (Date.now() - (e.em || 0) > 15 * 60000) { e.n = 0; e.prox = 0; } e.n++; e.em = Date.now(); LOGIN.set('e:' + email, e);
    await new Promise(r => setTimeout(r, 600));
  }
  function loginOk(ip, email) { LOGIN.delete('e:' + email); } /* v130.1: não zera o IP (os erros de outras pessoas continuam contando) */

  /* ---------------- /setup com SETUP_TOKEN ---------------- */
  const LIM_SETUP = new Map();
  function setupBarrado(req, res, u, m) {
    const tok = String(env.SETUP_TOKEN || ''); if (!tok) return false;
    const igual = v => { const a = Buffer.from(String(v || '')), b = Buffer.from(tok); return a.length === b.length && crypto.timingSafeEqual(a, b); };
    const seguro = String(req.headers['x-forwarded-proto'] || '').includes('https') || !!req.socket.encrypted;
    const qt = u.searchParams.get('token');
    if (m === 'GET' && qt && igual(qt)) { res.writeHead(303, { location: '/setup', 'set-cookie': 'setup=' + encodeURIComponent(qt) + '; Path=/setup; HttpOnly; SameSite=Strict; Max-Age=3600' + (seguro ? '; Secure' : '') }); res.end(); return true; }
    if (igual(F().cookies(req).setup)) return false;
    const ip = F().ipDe(req), l = LIM_SETUP.get(ip) || { n: 0, em: Date.now() }; if (Date.now() - l.em > 3600e3) { l.n = 0; l.em = Date.now(); } l.n++; LIM_SETUP.set(ip, l);
    const { pag, esc } = F();
    const corpo = pag('Primeiro acesso', '<div class="card" style="max-width:420px;margin:40px auto"><h1>Primeiro acesso</h1><p class="sub">Para criar a conta do dono, use o endereço com o código de instalação que o instalador mostrou (…/setup?token=…) ou digite o código abaixo. Ele está na variável SETUP_TOKEN do serviço gestao no Easypanel.</p>' +
      (qt || m !== 'GET' ? '<div class="msg err">Código de instalação inválido.</div>' : '') +
      '<form method="get" action="/setup"><label>Código de instalação<input name="token" required autocomplete="off" autofocus></label><button class="pri" type="submit" style="width:100%">Continuar</button></form></div>');
    setTimeout(() => { if (l.n > 30) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Muitas tentativas.'); } enviarHtml(res, 403, corpo); }, 500);
    return true;
  }

  /* ---------------- páginas simples: CSP restrita e confirmação sem JavaScript embutido ---------------- */
  const JS_CONFIRMA = "document.addEventListener('submit',function(e){var f=e.target,m=f&&f.getAttribute&&f.getAttribute('data-confirma');if(m&&!window.confirm(m))e.preventDefault();},true);";
  const hashJs = js => "'sha256-" + crypto.createHash('sha256').update(js, 'utf8').digest('base64') + "'";
  function pagina(body, extra) {
    if (extra && Object.keys(extra).some(k => k.toLowerCase() === 'content-security-policy')) return { body, cab: {} };
    let b = String(body);
    /* onsubmit="return confirm('…')" vira data-confirma (inline handlers não passam na CSP) */
    b = b.replace(/onsubmit="return confirm\('((?:[^'\\]|\\.)*)'\)"/g, (m0, t) => 'data-confirma="' + t.replace(/\\(.)/g, '$1') + '"');
    b = b.replace(/pelo menos 8 caracteres/g, 'pelo menos ' + MIN_EQ() + ' caracteres (8 para colaboradores)').replace(/\(mínimo 8\)/g, '(mínimo ' + MIN_EQ() + ' na Equipe)').replace(/\(mínimo 8 caracteres\)/g, '(mínimo 8 caracteres; ' + MIN_EQ() + ' na Equipe)');
    if (b.includes('data-confirma=')) b = b.replace(/<\/body>/i, '<script>' + JS_CONFIRMA + '</script></body>');
    const hs = []; b.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (m0, js) => { hs.push(hashJs(js)); return m0; });
    const csp = ["default-src 'none'", 'script-src ' + (hs.length ? hs.join(' ') : "'none'"), "style-src 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"].join('; ');
    /* referrer-policy fica 'same-origin' (no-referrer faria o navegador mandar Origin: null nos formulários e a proteção CSRF recusaria) */
    return { body: b, cab: { 'content-security-policy': csp, 'x-frame-options': 'DENY' } };
  }
  function enviarHtml(res, st, body) { const pg = pagina(body), b = Buffer.from(pg.body); res.writeHead(st, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' }, pg.cab)); res.end(b); }

  /* ---------------- bibliotecas locais (public/vendor) ---------------- */
  const sri = arq => 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(arq)).digest('base64');
  let VEND = null;
  function vendor() {
    if (VEND) return VEND;
    const mapa = {}, faltam = [];
    for (const v of VENDOR) {
      const arq = path.join(PUB, v.local);
      if (fs.existsSync(arq) && (!v.worker || fs.existsSync(path.join(PUB, v.worker)))) mapa[v.cdn] = Object.assign({ local: '/' + v.local, sri: sri(arq) }, v.tipo ? { tipo: v.tipo, worker: '/' + v.worker, base: '/' + v.base } : {});
      else faltam.push(v);
    }
    VEND = { mapa, cdnSri: CDN_SRI, faltam: faltam.map(v => v.local), precisaCdn: faltam.length > 0, pdfLocal: !faltam.some(v => v.tipo === 'pdfjs') };
    if (faltam.length) console.log('[seguranca] bibliotecas ainda pela CDN (copie para public/' + 'vendor, veja o LEIA-ME): ' + faltam.map(v => v.local.split('/')[1]).join(', '));
    return VEND;
  }
  const MIME_V = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/octet-stream' };
  function servirVendor(req, res, p) {
    if (p === '/vendor/lista.json') { const v = vendor(); return F().json(res, 200, { mapa: v.mapa, cdnSri: v.cdnSri }); }
    const base = path.join(PUB, 'vendor'), arq = path.join(PUB, decodeURIComponent(p.slice(1)));
    if (!arq.startsWith(base + path.sep) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(arq).toLowerCase(), st = fs.statSync(arq);
    res.writeHead(200, Object.assign({ 'content-type': MIME_V[ext] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' },
      /* política do worker do pdf.js (um worker usa a CSP da própria resposta) */
      ext === '.mjs' || ext === '.js' ? { 'content-security-policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'" } : {}));
    fs.createReadStream(arq).pipe(res);
  }

  /* ---------------- CSP do sistema (index.html) ---------------- */
  function cspApp(hashes) {
    const v = vendor(), cdn = v.precisaCdn ? ' https://cdnjs.cloudflare.com' : '';
    return ["default-src 'self'",
      "script-src 'self' " + hashes.join(' ') + (env.CSP_UNSAFE_EVAL === '1' ? " 'unsafe-eval'" : '') + cdn,
      "worker-src 'self' blob:" + (v.pdfLocal ? '' : ' https://cdnjs.cloudflare.com'),
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob:", "media-src 'self' data: blob:",
      "connect-src 'self' " + CONEXOES_EXTERNAS.join(' '),
      "frame-src 'self' blob:", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
  }

  /* ---------------- anexos: cota e disco ---------------- */
  const MB = 1048576;
  const cota = c => c.nivel === 'owner' ? 0 : ((NIV[c.nivel] || 0) >= NIV.admin ? (env.ANEXOS_COTA_MB != null && env.ANEXOS_COTA_MB !== '' ? +env.ANEXOS_COTA_MB : 2048) : (env.ANEXOS_COTA_COLABORADOR_MB != null && env.ANEXOS_COTA_COLABORADOR_MB !== '' ? +env.ANEXOS_COTA_COLABORADOR_MB : 300)) * MB;
  const usoAnexos = id => db.prepare('SELECT coalesce(sum(tam),0) AS b FROM arquivos WHERE por=?').get(id).b;
  function disco() { try { const s = fs.statfsSync(o.DATA); return { total: s.blocks * s.bsize, livre: s.bavail * s.bsize }; } catch (e) { return null; } }
  function cotaRecusa(conta, req) {
    const d = disco(); if (d && (d.livre < 200 * MB || d.livre / d.total < 0.01)) return { st: 507, erro: 'O disco do servidor está cheio. Avise o dono do sistema.' };
    const lim = cota(conta); if (!lim) return null;
    const len = +req.headers['content-length'] || F().MAX_BLOB || 25 * MB, uso = usoAnexos(conta.id);
    if (uso + len > lim) return { st: 413, erro: 'Sua cota de anexos (' + Math.round(lim / MB) + ' MB) acabou: você usa ' + (uso / MB).toFixed(1) + ' MB. Apague anexos antigos ou peça ao dono para aumentar a cota.' };
    return null;
  }
  function cartaoServidor(eu) {
    if (!eu || eu.nivel !== 'owner') return '';
    const { esc } = F(), d = disco(), gb = n => (n / 1073741824).toFixed(1) + ' GB', mb = n => (n / MB).toFixed(1) + ' MB';
    const pct = d ? Math.round(100 * d.livre / d.total) : null, alertaPct = Math.max(1, +env.DISCO_ALERTA_PCT || 10);
    let bkp = 0; try { const dir = path.join(o.DATA, 'backups'); for (const n of fs.readdirSync(dir)) try { bkp += fs.statSync(path.join(dir, n)).size; } catch (e) { } } catch (e) { }
    const anx = db.prepare('SELECT coalesce(sum(tam),0) AS b, count(*) AS n FROM arquivos').get();
    const top = db.prepare('SELECT por, sum(tam) AS b, count(*) AS n FROM arquivos GROUP BY por ORDER BY b DESC LIMIT 5').all();
    const nome = id => { const c = q.contaPorId.get(id); return c ? (c.nome || c.email || id) : (id || '—'); };
    const sem2f = q.contas.all().filter(c => c.ativo && !c.dois && exige2f(q.contaPorId.get(c.id)));
    const avisos = [];
    if (d && (pct < alertaPct || d.livre < 2 * 1073741824)) avisos.push('<b>Disco quase cheio:</b> restam ' + gb(d.livre) + ' (' + pct + '%). Apague cópias antigas, envie as cópias para o armazenamento externo (BACKUP_S3_*) ou aumente o disco da VPS. Com o disco cheio o sistema para de gravar.');
    if (!SEG.chaveMestra()) avisos.push('<b>Segredos da verificação em duas etapas sem cifra:</b> defina CHAVE_MESTRA no Ambiente (veja o LEIA-ME). Os existentes são cifrados sozinhos ao reiniciar.');
    return '<div class="card"><h2>Servidor</h2>' + avisos.map(a => '<div class="msg err">' + a + '</div>').join('') +
      '<p class="sub" style="margin:0 0 10px">' + (d ? 'Disco: ' + gb(d.livre) + ' livres de ' + gb(d.total) + ' (' + pct + '%). ' : '') + 'Anexos: ' + anx.n + ' arquivo(s), ' + mb(anx.b) + '. Cópias de segurança no servidor: ' + mb(bkp) + '.</p>' +
      '<p class="sub" style="margin:0 0 10px">Cota de anexos por pessoa: ' + (cota({ nivel: 'admin' }) ? Math.round(cota({ nivel: 'admin' }) / MB) + ' MB na Equipe' : 'sem limite na Equipe') + ', ' + (cota({ nivel: 'interact' }) ? Math.round(cota({ nivel: 'interact' }) / MB) + ' MB para colaboradores' : 'sem limite para colaboradores') + ' (ANEXOS_COTA_MB e ANEXOS_COTA_COLABORADOR_MB; 0 = sem limite).</p>' +
      (top.length ? '<table><thead><tr><th>Quem enviou</th><th>Arquivos</th><th>Espaço</th></tr></thead><tbody>' + top.map(r => '<tr><td>' + esc(nome(r.por)) + '</td><td>' + r.n + '</td><td>' + mb(r.b) + '</td></tr>').join('') + '</tbody></table>' : '') +
      '<p class="sub" style="margin:10px 0 0">Verificação em duas etapas: obrigatória para ' + ({ equipe: 'o dono e os perfis de Equipe que gravam', dono: 'o dono', nao: 'ninguém (DOIS_FATORES_OBRIGATORIO=nao)' })[MODO_2F()] + '. ' +
      (sem2f.length ? 'Ainda sem ligar: ' + sem2f.map(c => esc(c.nome || c.email)).join(', ') + '.' : 'Todas as contas obrigadas já ligaram.') + ' Sessões da Equipe expiram após ' + (+env.SESSAO_INATIVIDADE_HORAS || 10) + ' h sem uso.</p></div>';
  }

  /* ---------------- gravações: chat só de quem participa e id de anexo válido ---------------- */
  function conferirGravacao(dp, txt) {
    const st = als.getStore(); if (!st || st.rota !== '/api/db/doc' || !st.conta) return;
    const temAnx = txt.includes('"anx"') || txt.includes('"anexos"'), s = dp.split('/'), chat = s[0] === 'cm' && s.length === 4 && (s[2] === 'm' || s[2] === 'v');
    if (!temAnx && !chat) return;
    let d; try { d = JSON.parse(txt); } catch (e) { return; }
    const ids = []; const junta = x => { if (Array.isArray(x)) x.forEach(junta); else if (x && typeof x === 'object' && x.id != null) ids.push(x.id); };
    junta(d.anx); if (Array.isArray(d.anexos)) junta(d.anexos);
    if (ids.some(id => typeof id !== 'string' || !RE_ANX.test(id))) throw { st: 400, msg: 'Identificador de anexo inválido.' };
    if (chat) {
      const autor = s[1], cv = String(d.conv || ''); if (cv === 'geral') return;
      const i = cv.indexOf('/'); if (i <= 0) throw { st: 403, msg: 'Conversa inválida.' };
      const criador = cv.slice(0, i), cid = cv.slice(i + 1), r = q.docGet.get('cm/' + criador + '/c/' + cid);
      let ok = false; if (r) { try { const c = JSON.parse(r.data); ok = criador === autor || c.tipo === 'canal' || (Array.isArray(c.membros) && c.membros.includes(autor)); } catch (e) { } }
      if (!ok) throw { st: 403, msg: 'Você não participa desta conversa.' };
    }
  }
  { const put0 = q.docPut; q.docPut = { run: (dp, parent, id, txt, ts) => { conferirGravacao(dp, txt); return put0.run(dp, parent, id, txt, ts); } }; }

  /* ---------------- Colaborador: só o próprio registro em usr ---------------- */
  function leituraPropria(conta, p, data) {
    if (!conta || (NIV[conta.nivel] || 0) >= NIV.admin || !p.startsWith('usr/')) return true;
    return p === 'usr/' + conta.id || !!(data && data.uid === conta.id);
  }

  /* ---------------- ponto de entrada por pedido (depois do login) ---------------- */
  async function antes(req, res, conta, p, m, u) {
    als.enterWith({ conta, rota: p, m });
    const { json, pag } = F();
    /* reautenticação */
    if (p === '/conta/reautenticar') {
      if (m === 'GET') { enviarHtml(res, 200, pagReauth(conta, voltaOk(u.searchParams.get('volta')), '')); return true; }
      if (m === 'POST') {
        const f = {}; new URLSearchParams((await lerCorpo(req, 10000)).toString('utf8')).forEach((v, k) => { f[k] = v; });
        const r = conferirReauth(req, conta, f.segredo), volta = voltaOk(f.volta);
        if (r === 'ok') { redir(res, volta + (volta.includes('?') ? '&' : '?') + 'c=reauth'); return true; }
        if (r === 'sair') { res.writeHead(303, { location: '/login', 'set-cookie': 'sid=; Path=/; Max-Age=0' }); res.end(); return true; }
        await new Promise(x => setTimeout(x, 600)); enviarHtml(res, 401, pagReauth(conta, volta, 'Senha ou código incorreto.')); return true;
      }
    }
    if (p === '/api/reautenticar' && m === 'POST') {
      let b = {}; try { b = JSON.parse((await lerCorpo(req, 10000)).toString('utf8') || '{}'); } catch (e) { }
      const r = conferirReauth(req, conta, b.segredo);
      if (r === 'ok') { json(res, 200, { ok: true, validoMin: Math.round(JANELA() / 60000) }); return true; }
      await new Promise(x => setTimeout(x, 600));
      json(res, r === 'sair' ? 401 : 403, { code: r === 'sair' ? 'revoked' : 'reauth_failed', erro: r === 'sair' ? 'Muitas tentativas. Entre de novo.' : 'Senha ou código incorreto.' }); return true;
    }
    if (p === '/api/seguranca/estado' && m === 'GET') { json(res, 200, { doisFatores: situacao2f(conta), senhaMinima: minSenha(conta), sessao: { inatividadeHoras: INAT(conta) / 3600e3 }, reautenticado: reautenticado(req) }); return true; }
    /* verificação em duas etapas obrigatória: até ligar, só a página de segurança */
    const s2 = situacao2f(conta);
    if (s2.bloqueado) {
      const livre = p === '/conta/seguranca' || p.startsWith('/conta/seguranca/') || (p === '/contas/senha' && m === 'POST') || p === '/api/eu';
      if (!livre) {
        if (p.startsWith('/api/') || p.startsWith('/_blob/')) json(res, 403, { code: '2fa_required', erro: 'Ligue a verificação em duas etapas para continuar.', url: '/conta/seguranca' });
        else redir(res, '/conta/seguranca?c=2f');
        return true;
      }
    }
    /* ações sensíveis: senha ou código nos últimos minutos */
    for (const [mt, re, quem, volta] of SENSIVEIS) {
      if (m !== mt || !re.test(p)) continue;
      if (quem === 'dono' ? conta.nivel !== 'owner' : !F().gestorContas(conta)) break; /* sem permissão: a rota responde como sempre */
      if (reautenticado(req)) break;
      if (p.startsWith('/api/')) exigirReauth(req, res);
      else redir(res, '/conta/reautenticar?volta=' + encodeURIComponent(volta || (p + u.search)));
      return true;
    }
    if (m === 'GET' && p.startsWith('/vendor/')) { servirVendor(req, res, p); return true; }
    /* Colaborador: lista de pessoas só com nomes */
    if ((p === '/api/busca-pessoas' || p === '/api/perfis') && (NIV[conta.nivel] || 0) < NIV.admin) {
      const pub = c => ({ id: c.id, name: c.nome || 'Usuário', avatarUrl: '', color: c.cor || '#2457d6', email: null, guest: false, isMe: c.id === conta.id });
      if (p === '/api/perfis') { const o2 = {}; String(u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 500).forEach(i => { const c = q.contaPorId.get(i); if (c) o2[i] = pub(c); }); json(res, 200, o2); return true; }
      const t = String(u.searchParams.get('q') || '').toLowerCase();
      json(res, 200, q.contas.all().filter(c => c.ativo && (!t || String(c.nome || '').toLowerCase().includes(t))).slice(0, 30).map(pub)); return true;
    }
    if (p === '/api/assets' && m === 'POST') { const r = cotaRecusa(conta, req); if (r) { json(res, r.st, { code: r.st === 413 ? 'quota_exceeded' : 'unavailable', erro: r.erro }); return true; } }
    return false;
  }
  function lerCorpo(req, max) { return new Promise((ok, err) => { const ch = []; let n = 0; req.on('data', d => { n += d.length; if (n > max) { err({ st: 413, msg: 'Conteúdo grande demais.' }); req.destroy(); } else ch.push(d); }); req.on('end', () => ok(Buffer.concat(ch))); req.on('error', err); }); }

  return { antes, redir, msg, pagina, cspApp, sessaoInativa, exigirReauth, reautenticado, situacao2f, exige2f, minSenha, minNivel, setupBarrado,
    loginAntes, loginFalhou, loginOk, loginEspera, loginEstado, loginDesbloquear, leituraPropria, cartaoServidor, vendor, cifrarTotps,
    aparelhoElegivel, aparelhoEmitir, aparelhoValido, aparelhosDe, aparelhoRevogar, aparelhosRevogarTodos, cartaoAparelhos };
};

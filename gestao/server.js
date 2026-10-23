'use strict';
/* Central de Gestão — servidor próprio
   Serve o sistema e oferece, no mesmo endereço, o que a página publicada recebia do Claude:
   banco de dados com atualização ao vivo, arquivos anexos, contas de acesso, presença do chat,
   IA (opcional, com chave da Anthropic) e a ponte para o conector fiscal.
   Sem dependências externas: Node 22+ (node:sqlite, crypto, http, zlib). */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const FISCAL_URL = (process.env.FISCAL_URL || '').replace(/\/$/, '');
const FISCAL_TOKEN = process.env.FISCAL_TOKEN || '';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODELS = {
  quick: process.env.ANTHROPIC_MODEL_QUICK || 'claude-haiku-5-5',
  default: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  complex: process.env.ANTHROPIC_MODEL_COMPLEX || 'claude-opus-5-5'
};
const MAX_JSON = 40 * 1024 * 1024, MAX_BLOB = 25 * 1024 * 1024;
fs.mkdirSync(path.join(DATA, 'blobs'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'tmp'), { recursive: true });

/* ---------------- banco ---------------- */
process.removeAllListeners('warning');
const db = new DatabaseSync(path.join(DATA, 'gestao.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
CREATE TABLE IF NOT EXISTS contas(id TEXT PRIMARY KEY, nome TEXT, email TEXT UNIQUE, hash TEXT, nivel TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1, criado INTEGER, importado INTEGER DEFAULT 0, cor TEXT);
CREATE TABLE IF NOT EXISTS sessoes(token TEXT PRIMARY KEY, conta TEXT NOT NULL, criado INTEGER, expira INTEGER);
CREATE TABLE IF NOT EXISTS arquivos(id TEXT PRIMARY KEY, ct TEXT, tam INTEGER, por TEXT, criado INTEGER);
CREATE TABLE IF NOT EXISTS cfg(k TEXT PRIMARY KEY, v TEXT);`);
const q = {
  docGet: db.prepare('SELECT data, ts FROM docs WHERE path=?'),
  docPut: db.prepare('INSERT INTO docs(path,parent,id,data,ts) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, ts=excluded.ts'),
  docDel: db.prepare('DELETE FROM docs WHERE path=?'),
  colGet: db.prepare('SELECT id, data, ts FROM docs WHERE parent=?'),
  contaPorEmail: db.prepare('SELECT * FROM contas WHERE lower(email)=lower(?)'),
  contaPorId: db.prepare('SELECT * FROM contas WHERE id=?'),
  contas: db.prepare('SELECT id,nome,email,nivel,ativo,criado,importado,cor,(hash IS NOT NULL) AS temSenha FROM contas ORDER BY nome'),
  contaNova: db.prepare('INSERT INTO contas(id,nome,email,hash,nivel,ativo,criado,importado,cor) VALUES(?,?,?,?,?,?,?,?,?)'),
  contaN: db.prepare('SELECT count(*) AS n FROM contas'),
  sessNova: db.prepare('INSERT INTO sessoes(token,conta,criado,expira) VALUES(?,?,?,?)'),
  sessGet: db.prepare('SELECT * FROM sessoes WHERE token=?'),
  sessDel: db.prepare('DELETE FROM sessoes WHERE token=?'),
  arqNovo: db.prepare('INSERT OR REPLACE INTO arquivos(id,ct,tam,por,criado) VALUES(?,?,?,?,?)'),
  arqGet: db.prepare('SELECT * FROM arquivos WHERE id=?'),
  arqLista: db.prepare('SELECT * FROM arquivos ORDER BY criado DESC'),
  arqDel: db.prepare('DELETE FROM arquivos WHERE id=?'),
  blobVisivel: db.prepare("SELECT 1 FROM docs WHERE (path=? OR path LIKE ? OR parent LIKE 'cm%') AND data LIKE ? LIMIT 1")
};
const uid = (n = 20) => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const CORES = ['#2457d6', '#0e7c66', '#b54708', '#7a2eb8', '#c11574', '#2e7d32', '#00838f', '#6d4c41'];

/* ---------------- níveis e regras (iguais às da página publicada) ---------------- */
const NIV = { view: 1, interact: 2, admin: 3, owner: 4 };
const RULES = [
  ['', 'admin', 'admin'], ['usr', 'interact', 'admin'], ['usrreq', 'admin', 'admin'], ['usrreq/{self}', 'interact', 'interact'],
  ['cm', 'interact', 'owner'], ['cm/{self}', 'interact', 'interact'], ['pt', 'admin', 'admin'], ['pt/{self}', 'interact', 'interact']
];
function regra(p, contaId) {
  const seg = p.split('/').filter(Boolean);
  let best = RULES[0], bl = -1;
  for (const r of RULES) {
    const rs = r[0] ? r[0].split('/') : [];
    if (rs.length > seg.length) continue;
    let ok = true;
    for (let i = 0; i < rs.length; i++) { if (rs[i] === '{self}' ? seg[i] !== contaId : rs[i] !== seg[i]) { ok = false; break; } }
    if (ok && rs.length > bl) { best = r; bl = rs.length; }
  }
  return best;
}
const pode = (conta, p, modo) => !!conta && conta.ativo && NIV[conta.nivel] >= NIV[regra(p, conta.id)[modo === 'w' ? 2 : 1]];
const validPath = (p, doc) => { const s = String(p || '').split('/').filter(Boolean); return s.length > 0 && s.length <= 12 && s.every(x => /^[\w\-.|~@+=]{1,200}$/.test(x)) && (doc ? s.length % 2 === 0 : s.length % 2 === 1); };

/* ---------------- tempo real (SSE) ---------------- */
const CONEX = new Map(); /* id -> {res, conta, presence, updatedAt} */
function sse(res, ev, obj) { try { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { } }
function avisarDoc(op, p, data, ts) {
  const parent = p.split('/').slice(0, -1).join('/'), id = p.split('/').pop();
  for (const [cid, c] of CONEX) {
    const ca = q.contaPorId.get(c.conta.id); if (!ca || !ca.ativo) { CONEX.delete(cid); try { c.res.end(); } catch (e) { } continue; }
    c.conta = ca; if (pode(ca, p, 'r')) sse(c.res, 'doc', { op, path: p, parent, id, data, ts });
  }
}
function pares() {
  const vistos = new Map();
  for (const [cid, c] of CONEX) { const o = vistos.get(c.conta.id); if (!o || (c.updatedAt || 0) > (o.updatedAt || 0)) vistos.set(c.conta.id, { cid, by: c.conta.id, presence: c.presence || {}, updatedAt: c.updatedAt || Date.now() }); }
  return [...vistos.values()];
}
let peersT = 0;
function avisarPares() { clearTimeout(peersT); peersT = setTimeout(() => { const ps = pares(); for (const [cid, c] of CONEX) sse(c.res, 'peers', ps.map(p => ({ by: p.by, kind: 'viewer', isMe: p.by === c.conta.id, presence: p.presence, updatedAt: p.updatedAt }))); }, 120); }
setInterval(() => { for (const c of CONEX.values()) { try { c.res.write(': ping\n\n'); } catch (e) { } } }, 25000);

/* ---------------- utilidades HTTP ---------------- */
function lerCorpo(req, max) {
  return new Promise((ok, err) => { const ch = []; let n = 0; req.on('data', d => { n += d.length; if (n > max) { err({ st: 413, msg: 'Conteúdo grande demais.' }); req.destroy(); } else ch.push(d); }); req.on('end', () => ok(Buffer.concat(ch))); req.on('error', err); });
}
async function lerJson(req) { const b = await lerCorpo(req, MAX_JSON); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { throw { st: 400, msg: 'JSON inválido.' }; } }
function json(res, st, obj, extra) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(st, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' }, extra || {})); res.end(b); }
function html(res, st, body, extra) { const b = Buffer.from(body); res.writeHead(st, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' }, extra || {})); res.end(b); }
function cookies(req) { const o = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
const seguro = req => String(req.headers['x-forwarded-proto'] || '').includes('https') || !!req.socket.encrypted;
function contaDa(req) {
  const t = cookies(req).sid; if (!t) return null; const s = q.sessGet.get(t); if (!s || s.expira < Date.now()) return null;
  const c = q.contaPorId.get(s.conta); if (!c || !c.ativo) return null; return c;
}
function hashSenha(s) { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(String(s), salt, 64, { N: 16384 }); return salt.toString('hex') + ':' + h.toString('hex'); }
function confere(s, hash) { if (!hash) return false; const [salt, h] = hash.split(':'); const x = crypto.scryptSync(String(s), Buffer.from(salt, 'hex'), 64, { N: 16384 }); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); }
function abrirSessao(res, req, conta) { const t = uid(40), dias = 30; q.sessNova.run(t, conta.id, Date.now(), Date.now() + dias * 864e5); res.setHeader('set-cookie', 'sid=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + dias * 86400 + (seguro(req) ? '; Secure' : '')); }
const perfilPub = c => ({ id: c.id, name: c.nome || c.email || 'Usuário', avatarUrl: '', color: c.cor || CORES[0], email: c.email || null, guest: false });
const tentativas = new Map(), limitePub = new Map(), usoIa = new Map();
/* IP real: o último endereço acrescentado pelo proxy (Traefik/Easypanel); o cliente não consegue forjar */
const ipDe = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return x.length ? x[x.length - 1] : (req.socket.remoteAddress || ''); };
setInterval(() => { const t = Date.now(); for (const [k, v] of tentativas) if ((v.ate || 0) < t && t - (v.em || 0) > 3600e3) tentativas.delete(k); for (const [k, v] of limitePub) if (t - v.ini > 3600e3) limitePub.delete(k); for (const [k, v] of usoIa) if (t - v.ini > 3600e3) usoIa.delete(k); }, 600e3).unref();
function derrubarConexoes(contaId) { for (const [cid, c] of CONEX) if (c.conta.id === contaId) { CONEX.delete(cid); try { c.res.end(); } catch (e) { } } }

/* ---------------- páginas simples (login, contas, migração) ---------------- */
const CSS = `:root{--bg:#f3f5f9;--card:#fff;--tx:#0f1b2d;--mut:#5b6678;--line:#dfe4ec;--acc:#2457d6;--neg:#c62828}@media(prefers-color-scheme:dark){:root{--bg:#0f141c;--card:#171e29;--tx:#e8edf5;--mut:#9aa6b8;--line:#2a3443;--acc:#6f9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:960px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:0 0 16px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}p.sub{color:var(--mut);margin:0 0 16px}
label{display:block;margin:0 0 12px;font-size:13px;color:var(--mut)}input,select{display:block;width:100%;margin-top:4px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--tx);font:inherit}
button,.btn{display:inline-block;padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--tx);font:inherit;cursor:pointer;text-decoration:none}button.pri{background:var(--acc);border-color:var(--acc);color:#fff}button.dng{color:var(--neg)}
table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}th{font-size:12px;color:var(--mut);text-transform:uppercase}.msg{padding:10px 12px;border-radius:8px;background:rgba(36,87,214,.1);margin:0 0 12px}.err{background:rgba(198,40,40,.12);color:var(--neg)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}.row>*{flex:1;min-width:160px}nav{display:flex;gap:10px;margin:0 0 16px;flex-wrap:wrap}`;
const pag = (t, corpo) => '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + t + ' · Central de Gestão</title><style>' + CSS + '</style></head><body><main>' + corpo + '</main></body></html>';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function pagLogin(msg, setup) {
  return pag(setup ? 'Primeiro acesso' : 'Entrar', '<div class="card" style="max-width:420px;margin:40px auto"><h1>' + (setup ? 'Primeiro acesso' : 'Central de Gestão') + '</h1><p class="sub">' + (setup ? 'Crie a conta do dono do sistema. Ela pode criar as contas das outras pessoas depois.' : 'Entre com seu e-mail e senha.') + '</p>' + (msg ? '<div class="msg err">' + esc(msg) + '</div>' : '') +
    '<form method="post" action="' + (setup ? '/setup' : '/login') + '">' + (setup ? '<label>Seu nome<input name="nome" required autocomplete="name"></label>' : '') + '<label>E-mail<input name="email" type="email" required autocomplete="username"></label><label>Senha<input name="senha" type="password" required minlength="' + (setup ? 8 : 1) + '" autocomplete="' + (setup ? 'new-password' : 'current-password') + '"></label><button class="pri" type="submit" style="width:100%">' + (setup ? 'Criar e entrar' : 'Entrar') + '</button></form></div>');
}
const NIV_NOME = { owner: 'Dono', admin: 'Equipe (usa os módulos do perfil em Usuários)', interact: 'Colaborador (ponto, Minha área e chat)', view: 'Somente leitura (sem acesso aos dados)' };
function pagContas(eu, msg, erro) {
  const cs = q.contas.all();
  const linhas = cs.map(c => '<tr><td><b>' + esc(c.nome || '—') + '</b><div style="color:var(--mut);font-size:12px">' + esc(c.email || 'sem e-mail') + (c.importado ? ' · importado' : '') + '</div></td><td>' + esc(NIV_NOME[c.nivel] || c.nivel) + '</td><td>' + (c.ativo ? (c.temSenha ? 'Ativa' : 'Sem senha') : 'Desativada') + '</td><td style="white-space:nowrap">' +
    (c.id !== eu.id && (eu.nivel === 'owner' || c.nivel !== 'owner') ? '<form method="post" action="/contas/editar" style="display:inline"><input type="hidden" name="id" value="' + esc(c.id) + '"><button name="acao" value="' + (c.ativo ? 'desativar' : 'ativar') + '">' + (c.ativo ? 'Desativar' : 'Ativar') + '</button></form> ' +
      '<form method="post" action="/contas/editar" style="display:inline" onsubmit="return confirm(\'Excluir a conta de acesso de ' + esc(String(c.nome || c.email || '').replace(/['"\\]/g, '')) + '? A pessoa não consegue mais entrar. O cadastro dela no sistema (funcionário, perfil, histórico) continua.\')"><input type="hidden" name="id" value="' + esc(c.id) + '"><button name="acao" value="excluir" style="color:var(--neg)">Excluir</button></form> ' : '') +
    (eu.nivel === 'owner' && c.importado && c.id !== eu.id ? '<form method="post" action="/contas/editar" style="display:inline" onsubmit="return confirm(\'Usar esta conta importada como a sua? Você passa a ver as conversas e registros dela.\')"><input type="hidden" name="id" value="' + esc(c.id) + '"><button name="acao" value="soueu">Sou eu</button></form>' : '') + '</td></tr>').join('');
  return pag('Contas', '<nav><a class="btn" href="/">← Voltar ao sistema</a>' + (eu.nivel === 'owner' ? '<a class="btn" href="/migrar">Migrar dados da página antiga</a>' : '') + '<a class="btn" href="/sair">Sair</a></nav><h1>Contas de acesso</h1><p class="sub">Quem entra no sistema e com que nível. Para cadastrar uma pessoa nova, prefira <b>Sistema › Usuários › Novo usuário</b>, dentro do sistema: lá você cria o login e o perfil de uma vez.</p>' +
    (msg ? '<div class="msg' + (erro ? ' err' : '') + '">' + esc(msg) + '</div>' : '') +
    '<div class="card"><table><thead><tr><th>Pessoa</th><th>Nível</th><th>Situação</th><th></th></tr></thead><tbody>' + linhas + '</tbody></table></div>' +
    '<div class="card"><h2>Criar conta ou definir senha</h2><form method="post" action="/contas/salvar"><div class="row"><label>Conta<select name="id"><option value="">Nova conta</option>' + cs.filter(c => c.nivel !== 'owner' || c.id === eu.id).map(c => '<option value="' + esc(c.id) + '">' + esc(c.nome || c.email || c.id) + '</option>').join('') + '</select></label><label>Nome<input name="nome"></label></div><div class="row"><label>E-mail<input name="email" type="email"></label><label>Senha (mínimo 8)<input name="senha" type="password" minlength="8" autocomplete="new-password"></label><label>Nível<select name="nivel">' + ['admin', 'interact'].map(n => '<option value="' + n + '">' + NIV_NOME[n] + '</option>').join('') + '</select></label></div><button class="pri" type="submit">Salvar</button><p class="sub" style="margin:10px 0 0">Para uma conta existente, deixe em branco o que não quer mudar. Passe a senha à pessoa por um canal seguro; ela pode trocá-la depois em Minha senha.</p></form></div>' +
    '<div class="card"><h2>Minha senha</h2><form method="post" action="/contas/senha"><div class="row"><label>Senha atual<input name="atual" type="password" required autocomplete="current-password"></label><label>Nova senha<input name="nova" type="password" minlength="8" required autocomplete="new-password"></label></div><button type="submit">Trocar senha</button></form></div>');
}
function pagMigrar(eu, msg) {
  return pag('Migração', '<nav><a class="btn" href="/">← Voltar ao sistema</a><a class="btn" href="/contas">Contas</a></nav><h1>Migrar dados da página antiga</h1><p class="sub">Na página antiga (no Claude), abra Sistema › Configurações › Migrar para servidor próprio e baixe o arquivo ZIP. Envie esse arquivo aqui. Os registros com o mesmo identificador são substituídos; nada é apagado.</p>' + (msg ? '<div class="msg">' + esc(msg) + '</div>' : '') +
    '<div class="card"><input type="file" id="f" accept=".zip,application/zip"><div style="margin-top:12px"><button class="pri" id="b">Importar</button></div><p id="st" class="sub" style="margin:12px 0 0"></p></div>' +
    '<script>document.getElementById("b").onclick=function(){var f=document.getElementById("f").files[0],st=document.getElementById("st");if(!f){st.textContent="Escolha o arquivo ZIP.";return;}var x=new XMLHttpRequest();x.open("POST","/api/admin/importar");x.setRequestHeader("content-type","application/zip");x.upload.onprogress=function(e){if(e.lengthComputable)st.textContent="Enviando… "+Math.round(e.loaded/e.total*100)+"%";};x.onload=function(){var r={};try{r=JSON.parse(x.responseText)}catch(e){}st.textContent=x.status==200?("Pronto: "+r.docs+" registros, "+r.arquivos+" arquivos e "+r.contas+" contas importadas. Em Contas, defina e-mail e senha das pessoas importadas e use \\"Sou eu\\" na sua conta antiga."):("Erro: "+(r.erro||x.status));};x.onerror=function(){st.textContent="Falha de conexão.";};x.send(f);};</script>');
}

/* ---------------- leitor de ZIP (para a migração) ---------------- */
function zipEntradas(arq) {
  const fd = fs.openSync(arq, 'r'), tam = fs.fstatSync(fd).size, n = Math.min(tam, 66000), b = Buffer.alloc(n);
  fs.readSync(fd, b, 0, n, tam - n);
  let e = -1; for (let i = n - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) { fs.closeSync(fd); throw { st: 400, msg: 'Arquivo ZIP inválido.' }; }
  let cnt = b.readUInt16LE(e + 10), cdTam = b.readUInt32LE(e + 12), cdOff = b.readUInt32LE(e + 16);
  if (cdOff === 0xffffffff) { fs.closeSync(fd); throw { st: 400, msg: 'ZIP grande demais (ZIP64). Gere o arquivo de novo.' }; }
  const cd = Buffer.alloc(cdTam); fs.readSync(fd, cd, 0, cdTam, cdOff);
  const out = []; let p = 0;
  for (let k = 0; k < cnt; k++) {
    const met = cd.readUInt16LE(p + 10), comp = cd.readUInt32LE(p + 20), nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
    const nome = cd.slice(p + 46, p + 46 + nl).toString('utf8'); out.push({ nome, met, comp, off }); p += 46 + nl + xl + cl;
  }
  const ler = en => { const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, en.off); const ini = en.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28); const d = Buffer.alloc(en.comp); fs.readSync(fd, d, 0, en.comp, ini); return en.met === 0 ? d : zlib.inflateRawSync(d); };
  return { entradas: out, ler, fechar: () => fs.closeSync(fd) };
}

/* ---------------- IA (opcional) ---------------- */
async function ia(corpo) {
  if (!AI_KEY) throw { st: 503, msg: 'IA não configurada no servidor.' };
  let msgs = Array.isArray(corpo.input) ? corpo.input.map(m => ({ role: m.role, content: String(m.content) })) : [{ role: 'user', content: String(corpo.input || '') }];
  if (Array.isArray(corpo.images) && corpo.images.length) {
    const ult = msgs[msgs.length - 1];
    ult.content = corpo.images.slice(0, 8).map(im => ({ type: 'image', source: { type: 'base64', media_type: im.type || 'image/png', data: im.data } })).concat([{ type: 'text', text: ult.content }]);
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: AI_MODELS[corpo.nivel < NIV.admin && corpo.modelTier === 'complex' ? 'default' : corpo.modelTier] || AI_MODELS.default, max_tokens: 8000, messages: msgs }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { st: r.status === 429 ? 429 : 502, msg: (j.error && j.error.message) || 'Falha na IA.', code: r.status === 429 ? 'rate_limited' : 'upstream_error' };
  return { text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), truncated: j.stop_reason === 'max_tokens' };
}

/* ---------------- rotas ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function estatico(req, res, arq) {
  const p = path.join(PUB, arq); if (!p.startsWith(PUB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return false;
  const st = fs.statSync(p), ext = path.extname(p).toLowerCase(), range = req.headers.range;
  const h = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'private, max-age=3600', 'accept-ranges': 'bytes' };
  if (range && /^bytes=\d*-\d*$/.test(range)) { let [a, b] = range.slice(6).split('-'); a = a ? +a : st.size - +b; b = b && range.slice(6)[0] !== '-' ? Math.min(+b, st.size - 1) : st.size - 1; if (!(a >= 0 && a <= b && a < st.size)) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); res.end(); return true; } res.writeHead(206, Object.assign(h, { 'content-range': 'bytes ' + a + '-' + b + '/' + st.size, 'content-length': b - a + 1 })); fs.createReadStream(p, { start: a, end: b }).pipe(res); return true; }
  res.writeHead(200, Object.assign(h, { 'content-length': st.size })); fs.createReadStream(p).pipe(res); return true;
}
function form(b) { const o = {}; new URLSearchParams(b.toString('utf8')).forEach((v, k) => { o[k] = v; }); return o; }
const redir = (res, to) => { res.writeHead(303, { location: to }); res.end(); };

async function rotear(req, res) {
  /* proteção contra envio de formulário vindo de outro site (CSRF) */
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) { let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch (e) { } if (!ok) return json(res, 403, { erro: 'Origem não permitida.' }); }
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('x-frame-options', 'SAMEORIGIN');
  if (p === '/saude') return json(res, 200, { ok: true });
  const semContas = q.contaN.get().n === 0;
  /* primeiro acesso */
  if (p === '/setup') {
    if (!semContas) return redir(res, '/login');
    if (m === 'GET') return html(res, 200, pagLogin('', true));
    const f = form(await lerCorpo(req, 10000));
    if (!f.email || String(f.senha || '').length < 8) return html(res, 400, pagLogin('Informe e-mail e uma senha com pelo menos 8 caracteres.', true));
    const c = { id: uid(), nome: f.nome || f.email, email: f.email.trim(), nivel: 'owner' };
    q.contaNova.run(c.id, c.nome, c.email, hashSenha(f.senha), 'owner', 1, Date.now(), 0, CORES[0]); abrirSessao(res, req, c); return redir(res, '/');
  }
  if (p === '/login') {
    if (semContas) return redir(res, '/setup');
    if (m === 'GET') return html(res, 200, pagLogin(''));
    const ip = ipDe(req), t = tentativas.get(ip) || { n: 0, ate: 0 };
    const f = form(await lerCorpo(req, 10000)), em = 'e:' + String(f.email || '').trim().toLowerCase(), te = tentativas.get(em) || { n: 0, ate: 0 };
    if (t.ate > Date.now() || te.ate > Date.now()) return html(res, 429, pagLogin('Muitas tentativas. Aguarde alguns minutos.'));
    const c = q.contaPorEmail.get(String(f.email || '').trim());
    if (!c || !c.ativo || !confere(f.senha, c.hash)) { for (const [k, x, lim] of [[ip, t, 8], [em, te, 10]]) { x.n++; x.em = Date.now(); if (x.n >= lim) { x.ate = Date.now() + 10 * 60000; x.n = 0; } tentativas.set(k, x); } await new Promise(r => setTimeout(r, 600)); return html(res, 401, pagLogin('E-mail ou senha incorretos.')); }
    tentativas.delete(ip); tentativas.delete(em); abrirSessao(res, req, c); return redir(res, '/');
  }
  if (p === '/sair') { const t = cookies(req).sid; if (t) q.sessDel.run(t); res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0'); return redir(res, '/login'); }
  /* ---- pedido de cotação: página pública em que o fornecedor responde, sem login ---- */
  const mPag = p.match(/^\/cotacao\/([A-Za-z0-9]{24,64})$/);
  if (mPag && m === 'GET') {
    const arq = path.join(PUB, 'cotacao.html'); if (!fs.existsSync(arq)) return json(res, 404, { erro: 'Página indisponível.' });
    return html(res, 200, fs.readFileSync(arq, 'utf8'), { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' });
  }
  const mApi = p.match(/^\/api\/pub\/cotacao\/([A-Za-z0-9]{24,64})$/);
  if (mApi) {
    const tok = mApi[1], ip = ipDe(req), lim = limitePub.get(ip) || { n: 0, ini: Date.now() };
    if (Date.now() - lim.ini > 3600e3) { lim.n = 0; lim.ini = Date.now(); } lim.n++; limitePub.set(ip, lim);
    if (lim.n > 300) return json(res, 429, { erro: 'Muitas solicitações. Tente mais tarde.' });
    const ln = q.docGet.get('cotlink/' + tok); if (!ln) { await new Promise(r => setTimeout(r, 400)); return json(res, 404, { erro: 'Pedido de cotação não encontrado. Confira o link recebido.' }); }
    const link = JSON.parse(ln.data), pubd = link.pub || {}, rp = q.docGet.get('cotresp/' + tok), anterior = rp ? JSON.parse(rp.data) : null;
    const semInterno = r => { if (!r) return null; const o = Object.assign({}, r); delete o.ip; delete o.aplicado; return o; };
    if (m === 'GET') return json(res, 200, { pub: pubd, resposta: semInterno(anterior) });
    if (m !== 'POST') return json(res, 405, { erro: 'Método não permitido.' });
    if (pubd.status !== 'aberta') return json(res, 409, { erro: 'Esta cotação foi encerrada pelo comprador.' });
    if (lim.n > 120) return json(res, 429, { erro: 'Muitos envios. Tente mais tarde.' });
    let b; try { b = JSON.parse((await lerCorpo(req, 200000)).toString('utf8') || '{}'); } catch (e) { return json(res, 400, { erro: 'Dados inválidos.' }); }
    const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
    const nr = v => { if (v === '' || v == null) return ''; const x = +v; return isFinite(x) && x >= 0 && x < 1e10 ? Math.round(x * 1e4) / 1e4 : ''; };
    const its = Array.isArray(pubd.itens) ? pubd.itens : [], bi = Array.isArray(b.itens) ? b.itens : [];
    const resp = { tok, cotId: link.cotId, parcId: link.parcId, em: Date.now(), recusou: !!b.recusou,
      itens: its.map((it, i) => { const x = bi[i] || {}; return { k: it.k, preco: b.recusou ? '' : nr(x.preco), obs: txt(x.obs, 200) }; }),
      frete: nr(b.frete), prazo: nr(b.prazo), pgto: txt(b.pgto, 120), validade: nr(b.validade), obsGeral: txt(b.obsGeral, 1500), nome: txt(b.nome, 100), email: txt(b.email, 120), tel: txt(b.tel, 40), envios: ((anterior && anterior.envios) || 0) + 1 };
    if (!resp.nome) return json(res, 400, { erro: 'Informe seu nome.' });
    if (!resp.recusou && !resp.itens.some(x => x.preco !== '')) return json(res, 400, { erro: 'Informe o preço de pelo menos um item.' });
    const ts = Date.now(); q.docPut.run('cotresp/' + tok, 'cotresp', tok, JSON.stringify(resp), ts); avisarDoc('set', 'cotresp/' + tok, resp, ts);
    return json(res, 200, { ok: true, resposta: semInterno(resp) });
  }
  const conta = contaDa(req);
  if (!conta) { if (p.startsWith('/api/') || p.startsWith('/_blob/')) return json(res, 401, { erro: 'Entre novamente.' }); return redir(res, semContas ? '/setup' : '/login'); }

  /* ---- contas ---- */
  if (p === '/contas' && m === 'GET') { if (NIV[conta.nivel] < NIV.admin) return redir(res, '/'); return html(res, 200, pagContas(conta, u.searchParams.get('m'), u.searchParams.get('e'))); }
  if (p === '/contas/salvar' && m === 'POST') {
    if (NIV[conta.nivel] < NIV.admin) return redir(res, '/');
    const f = form(await lerCorpo(req, 10000)), niv = ['admin', 'interact'].includes(f.nivel) ? f.nivel : 'interact';
    try {
      if (f.id) {
        const c = q.contaPorId.get(f.id); if (!c) throw 'Conta não encontrada.'; if (c.nivel === 'owner' && c.id !== conta.id) throw 'Só o dono altera a própria conta.';
        if (f.email && f.email !== c.email && q.contaPorEmail.get(f.email)) throw 'Este e-mail já está em uso.';
        if (f.senha && f.senha.length < 8) throw 'A senha precisa ter pelo menos 8 caracteres.';
        if (f.senha) db.prepare('DELETE FROM sessoes WHERE conta=? AND token<>?').run(c.id, String(cookies(req).sid || ''));
        db.prepare('UPDATE contas SET nome=coalesce(nullif(?,\'\'),nome), email=coalesce(nullif(?,\'\'),email), hash=coalesce(?,hash), nivel=? WHERE id=?').run(f.nome || '', (f.email || '').trim(), f.senha ? hashSenha(f.senha) : null, c.nivel === 'owner' ? 'owner' : niv, c.id);
      } else {
        if (!f.email || !f.senha || f.senha.length < 8) throw 'Informe e-mail e senha (mínimo 8).'; if (q.contaPorEmail.get(f.email)) throw 'Este e-mail já está em uso.';
        q.contaNova.run(uid(), f.nome || f.email, f.email.trim(), hashSenha(f.senha), niv, 1, Date.now(), 0, CORES[Math.floor(Math.random() * CORES.length)]);
      }
      return redir(res, '/contas?m=' + encodeURIComponent('Conta salva.'));
    } catch (e) { return redir(res, '/contas?e=1&m=' + encodeURIComponent(String(e))); }
  }
  if (p === '/contas/editar' && m === 'POST') {
    if (NIV[conta.nivel] < NIV.admin) return redir(res, '/');
    const f = form(await lerCorpo(req, 10000)), c = q.contaPorId.get(f.id); if (!c || c.id === conta.id) return redir(res, '/contas');
    if (f.acao === 'desativar' && c.nivel !== 'owner') { db.prepare('UPDATE contas SET ativo=0 WHERE id=?').run(c.id); db.prepare('DELETE FROM sessoes WHERE conta=?').run(c.id); derrubarConexoes(c.id); }
    if (f.acao === 'ativar') db.prepare('UPDATE contas SET ativo=1 WHERE id=?').run(c.id);
    if (f.acao === 'excluir') {
      if (c.nivel === 'owner') return redir(res, '/contas?e=1&m=' + encodeURIComponent('A conta do dono não pode ser excluída.'));
      db.prepare('DELETE FROM sessoes WHERE conta=?').run(c.id); derrubarConexoes(c.id); db.prepare('DELETE FROM contas WHERE id=?').run(c.id);
      return redir(res, '/contas?m=' + encodeURIComponent('Conta de acesso excluída.'));
    }
    if (f.acao === 'soueu' && conta.nivel === 'owner' && c.importado) {
      db.exec('BEGIN'); try {
        db.prepare('DELETE FROM contas WHERE id=?').run(c.id);
        db.prepare('UPDATE contas SET id=?, nome=coalesce(nullif(nome,\'\'),?) WHERE id=?').run(c.id, c.nome, conta.id);
        db.prepare('UPDATE sessoes SET conta=? WHERE conta=?').run(c.id, conta.id); db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return redir(res, '/contas?m=' + encodeURIComponent('Pronto: sua conta agora usa o histórico da conta importada.'));
    }
    return redir(res, '/contas?m=' + encodeURIComponent('Atualizado.'));
  }
  if (p === '/contas/senha' && m === 'POST') {
    const f = form(await lerCorpo(req, 10000)), c = q.contaPorId.get(conta.id);
    if (!confere(f.atual, c.hash) || String(f.nova || '').length < 8) return redir(res, '/contas?e=1&m=' + encodeURIComponent('Senha atual incorreta ou nova senha curta.'));
    db.prepare('UPDATE contas SET hash=? WHERE id=?').run(hashSenha(f.nova), c.id); db.prepare('DELETE FROM sessoes WHERE conta=? AND token<>?').run(c.id, String(cookies(req).sid || '')); return redir(res, '/contas?m=' + encodeURIComponent('Senha trocada.'));
  }
  if (p === '/migrar' && m === 'GET') { if (conta.nivel !== 'owner') return redir(res, '/'); return html(res, 200, pagMigrar(conta)); }

  /* ---- edição de contas pela tela Usuários (JSON, só administradores) ---- */
  if (p === '/api/contas' && m === 'POST') {
    if (NIV[conta.nivel] < NIV.admin) return json(res, 403, { erro: 'Apenas administradores.' });
    const b = await lerJson(req), nome = String(b.nome || '').trim().slice(0, 120), email = String(b.email || '').trim().toLowerCase().slice(0, 160), senha = String(b.senha || '');
    if (!nome) return json(res, 400, { erro: 'Informe o nome.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { erro: 'E-mail inválido.' });
    if (q.contaPorEmail.get(email)) return json(res, 400, { erro: 'Este e-mail já está em uso.' });
    if (senha.length < 8) return json(res, 400, { erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    const id = uid(), niv = ['admin', 'interact'].includes(b.nivel) ? b.nivel : 'interact';
    q.contaNova.run(id, nome, email, hashSenha(senha), niv, 1, Date.now(), 0, CORES[Math.floor(Math.random() * CORES.length)]);
    return json(res, 200, { ok: true, id });
  }
  const mConta = p.match(/^\/api\/contas\/([A-Za-z0-9_-]{1,60})$/);
  if (mConta) {
    if (NIV[conta.nivel] < NIV.admin) return json(res, 403, { erro: 'Apenas administradores.' });
    const c = q.contaPorId.get(mConta[1]); if (!c) return json(res, 404, { erro: 'Conta não encontrada no servidor.' });
    if (m === 'GET') return json(res, 200, { id: c.id, nome: c.nome || '', email: c.email || '', nivel: c.nivel, ativo: !!c.ativo });
    if (m === 'POST') {
      const b = await lerJson(req), nome = String(b.nome || '').trim().slice(0, 120), email = String(b.email || '').trim().toLowerCase().slice(0, 160), senha = String(b.senha || '');
      if (c.nivel === 'owner' && c.id !== conta.id) return json(res, 403, { erro: 'Só o dono altera a própria conta.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { erro: 'E-mail inválido.' });
      if (email && email !== String(c.email || '').toLowerCase()) { const o = q.contaPorEmail.get(email); if (o && o.id !== c.id) return json(res, 400, { erro: 'Este e-mail já está em uso.' }); }
      if (senha && senha.length < 8) return json(res, 400, { erro: 'A senha precisa ter pelo menos 8 caracteres.' });
      const niv = c.nivel === 'owner' ? 'owner' : (['admin', 'interact'].includes(b.nivel) ? b.nivel : c.nivel);
      const ativo = c.nivel === 'owner' || c.id === conta.id ? 1 : (b.ativo === false ? 0 : 1);
      db.prepare('UPDATE contas SET nome=coalesce(nullif(?,\'\'),nome), email=coalesce(nullif(?,\'\'),email), hash=coalesce(?,hash), nivel=?, ativo=? WHERE id=?').run(nome, email, senha ? hashSenha(senha) : null, niv, ativo, c.id);
      if (!ativo || senha) db.prepare('DELETE FROM sessoes WHERE conta=? AND token<>?').run(c.id, String(cookies(req).sid || ''));
      if (!ativo) derrubarConexoes(c.id);
      return json(res, 200, { ok: true });
    }
  }
  /* ---- API do runtime ---- */
  if (p === '/api/eu') return json(res, 200, Object.assign(perfilPub(conta), { isOwner: conta.nivel === 'owner', canEdit: NIV[conta.nivel] >= NIV.admin, nivel: conta.nivel, ia: !!AI_KEY, fiscal: !!FISCAL_URL }));
  if (p === '/api/perfis') { const ids = String(u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 500), o = {}; ids.forEach(i => { const c = q.contaPorId.get(i); if (c) o[i] = Object.assign(perfilPub(c), { isMe: c.id === conta.id }); }); return json(res, 200, o); }
  if (p === '/api/busca-pessoas') { const t = String(u.searchParams.get('q') || '').toLowerCase(); return json(res, 200, q.contas.all().filter(c => c.ativo && (!t || (c.nome + ' ' + c.email).toLowerCase().includes(t))).slice(0, 30).map(c => Object.assign(perfilPub(c), { isMe: c.id === conta.id }))); }
  if (p === '/api/db/doc') {
    const dp = String(u.searchParams.get('path') || ''); if (!validPath(dp, true)) return json(res, 400, { code: 'invalid_argument', erro: 'Caminho inválido.' });
    if (m === 'GET') { if (!pode(conta, dp, 'r')) return json(res, 403, { code: 'not_granted' }); const r = q.docGet.get(dp); return json(res, 200, r ? { exists: true, data: JSON.parse(r.data), ts: r.ts } : { exists: false }); }
    if (!pode(conta, dp, 'w')) return json(res, 403, { code: 'not_granted' });
    const seg = dp.split('/'), parent = seg.slice(0, -1).join('/'), id = seg[seg.length - 1], ts = Date.now();
    if (m === 'DELETE') { q.docDel.run(dp); avisarDoc('del', dp, null, ts); return json(res, 200, { ok: true }); }
    const corpo = await lerJson(req); let data = corpo.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { code: 'invalid_argument', erro: 'Dados inválidos.' });
    if (m === 'PATCH') { const r = q.docGet.get(dp); if (!r) return json(res, 404, { code: 'invalid_argument', erro: 'Documento não existe.' }); data = Object.assign(JSON.parse(r.data), data); }
    const txt = JSON.stringify(data); if (txt.length > 4 * 1024 * 1024) return json(res, 413, { code: 'invalid_argument', erro: 'Documento grande demais.' });
    q.docPut.run(dp, parent, id, txt, ts); avisarDoc('set', dp, data, ts); return json(res, 200, { ok: true, ts });
  }
  if (p === '/api/db/col' && m === 'GET') {
    const cp = String(u.searchParams.get('path') || ''); if (!validPath(cp, false)) return json(res, 400, { code: 'invalid_argument', erro: 'Caminho inválido.' });
    const rows = q.colGet.all(cp).filter(r => pode(conta, cp + '/' + r.id, 'r')).map(r => ({ id: r.id, data: JSON.parse(r.data), ts: r.ts }));
    return json(res, 200, { docs: rows });
  }
  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const cid = uid(12); CONEX.set(cid, { res, conta, presence: {}, updatedAt: Date.now() }); sse(res, 'hello', { cid }); avisarPares();
    req.on('close', () => { CONEX.delete(cid); avisarPares(); }); return;
  }
  if (p === '/api/room/presence' && m === 'POST') { const b = await lerJson(req), c = CONEX.get(b.cid); if (c && c.conta.id === conta.id) { const pr = Object.assign({}, c.presence); Object.keys(b.patch || {}).forEach(k => { if (b.patch[k] === null) delete pr[k]; else pr[k] = b.patch[k]; }); c.presence = pr; c.updatedAt = Date.now(); avisarPares(); } return json(res, 200, { ok: true }); }
  if (p === '/api/assets' && m === 'POST') {
    if (NIV[conta.nivel] < NIV.interact) return json(res, 403, { code: 'not_granted' });
    const b = await lerCorpo(req, MAX_BLOB).catch(e => { throw Object.assign(e, { code: 'too_large' }); }), id = uid(32).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(32, '0').slice(0, 32), ct = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    fs.writeFileSync(path.join(DATA, 'blobs', id), b); q.arqNovo.run(id, ct, b.length, conta.id, Date.now());
    return json(res, 200, { id, url: '/_blob/' + id, sizeBytes: b.length, contentType: ct });
  }
  if (p === '/api/assets' && m === 'GET') { if (NIV[conta.nivel] < NIV.admin) return json(res, 403, { code: 'not_granted' }); const l = q.arqLista.all(); return json(res, 200, { assets: l.map(a => ({ id: a.id, url: '/_blob/' + a.id, contentType: a.ct, sizeBytes: a.tam, createdAt: new Date(a.criado).toISOString() })), usage: { files: l.length, bytes: l.reduce((s, a) => s + a.tam, 0), maxFiles: 100000, maxBytes: 50 * 1024 ** 3 } }); }
  if (p.startsWith('/api/assets/') && m === 'DELETE') { if (NIV[conta.nivel] < NIV.admin) return json(res, 403, { code: 'not_granted' }); const id = p.split('/').pop().replace(/[^a-z0-9]/gi, ''); try { fs.unlinkSync(path.join(DATA, 'blobs', id)); } catch (e) { } q.arqDel.run(id); return json(res, 200, { deleted: true }); }
  if (p.startsWith('/_blob/')) {
    const id = p.slice(7).replace(/[^A-Za-z0-9_-]/g, ''), a = q.arqGet.get(id), f = path.join(DATA, 'blobs', id);
    if (!a || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    /* quem não é administrador vê só o que enviou, o que está na própria Minha área/ponto ou no chat */
    if (NIV[conta.nivel] < NIV.admin && a.por !== conta.id && !q.blobVisivel.get('pt/' + conta.id, 'pt/' + conta.id + '/%', '%' + id + '%')) { res.writeHead(404); return res.end(); }
    const ct = String(a.ct || 'application/octet-stream').toLowerCase(), seguro = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|video\/(mp4|webm)|audio\/[a-z0-9.+-]+)$/.test(ct);
    res.writeHead(200, { 'content-type': seguro ? ct : 'application/octet-stream', 'content-length': a.tam, 'cache-control': 'private, max-age=86400', 'content-disposition': seguro ? 'inline' : 'attachment', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox" }); return fs.createReadStream(f).pipe(res);
  }
  if (p === '/api/ia' && m === 'POST') {
    if (NIV[conta.nivel] < NIV.interact) return json(res, 403, { code: 'not_granted', erro: 'Sem permissão para usar a IA.' });
    const ui0 = usoIa.get(conta.id) || { n: 0, ini: Date.now() }; if (Date.now() - ui0.ini > 3600e3) { ui0.n = 0; ui0.ini = Date.now(); } ui0.n++; usoIa.set(conta.id, ui0);
    if (ui0.n > (NIV[conta.nivel] >= NIV.admin ? 120 : 30)) return json(res, 429, { code: 'rate_limited', erro: 'Limite de uso da IA nesta hora atingido.' });
  }
  if (p === '/api/ia' && m === 'POST') { try { return json(res, 200, await ia(Object.assign(await lerJson(req), { nivel: NIV[conta.nivel] }))); } catch (e) { return json(res, e.st || 500, { code: e.code || (e.st === 503 ? 'capability_disabled' : 'upstream_error'), erro: e.msg || 'Falha na IA.' }); } }
  if (p.startsWith('/api/fiscal/')) {
    if (!FISCAL_URL) return json(res, 503, { erro: 'Conector fiscal não configurado (FISCAL_URL).' });
    if (NIV[conta.nivel] < NIV.admin) return json(res, 403, { erro: 'Apenas administradores.' });
    const corpo = m === 'GET' ? undefined : await lerCorpo(req, 5 * 1024 * 1024);
    try {
      const r = await fetch(FISCAL_URL + p.slice('/api/fiscal'.length) + u.search, { method: m, headers: { 'content-type': req.headers['content-type'] || 'application/json', 'x-fiscal-token': FISCAL_TOKEN, 'x-usuario': encodeURIComponent(conta.nome || conta.email || conta.id) }, body: corpo && corpo.length ? corpo : undefined, signal: AbortSignal.timeout(180000) });
      const b = Buffer.from(await r.arrayBuffer()); res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', 'content-length': b.length, 'cache-control': 'no-store' }); return res.end(b);
    } catch (e) { return json(res, 502, { erro: 'O conector fiscal não respondeu. Confira se o serviço está no ar.' }); }
  }
  if (p === '/api/admin/importar' && m === 'POST') {
    if (conta.nivel !== 'owner') return json(res, 403, { erro: 'Apenas o dono.' });
    const tmp = path.join(DATA, 'tmp', 'imp-' + Date.now() + '.zip');
    await new Promise((ok, err) => { const w = fs.createWriteStream(tmp); req.pipe(w); w.on('finish', ok); w.on('error', err); req.on('error', err); });
    let z; try { z = zipEntradas(tmp); } catch (e) { fs.unlinkSync(tmp); return json(res, 400, { erro: e.msg || 'ZIP inválido.' }); }
    let nd = 0, na = 0, nc = 0;
    try {
      const pega = nome => { const e = z.entradas.find(x => x.nome === nome); return e ? z.ler(e) : null; };
      const dbj = pega('db.json'); if (!dbj) throw { msg: 'O ZIP não tem db.json.' };
      const dados = JSON.parse(dbj.toString('utf8')), ts = Date.now();
      db.exec('BEGIN');
      for (const d of dados.docs || []) { if (!validPath(d.path, true) || !d.data) continue; const s = d.path.split('/'); q.docPut.run(d.path, s.slice(0, -1).join('/'), s[s.length - 1], JSON.stringify(d.data), ts); nd++; }
      const us = pega('usuarios.json'); if (us) { for (const x of JSON.parse(us.toString('utf8'))) { if (!x.uid || q.contaPorId.get(x.uid)) continue; q.contaNova.run(x.uid, x.nome || '', null, null, x.dono ? 'admin' : (['admin', 'interact'].includes(x.nivel) ? x.nivel : 'interact'), 1, ts, 1, CORES[nc % CORES.length]); nc++; } }
      const meta = pega('blobs.json'), lista = meta ? JSON.parse(meta.toString('utf8')) : [];
      for (const a of lista) { const e = z.entradas.find(x => x.nome === 'blobs/' + a.id); if (!e) continue; const b = z.ler(e); fs.writeFileSync(path.join(DATA, 'blobs', String(a.id).replace(/[^A-Za-z0-9_-]/g, '')), b); q.arqNovo.run(String(a.id).replace(/[^A-Za-z0-9_-]/g, ''), a.ct || 'application/octet-stream', b.length, conta.id, ts); na++; }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } z.fechar(); fs.unlinkSync(tmp); return json(res, 400, { erro: e.msg || String(e.message || e) }); }
    z.fechar(); fs.unlinkSync(tmp);
    for (const c of CONEX.values()) sse(c.res, 'recarregar', {});
    return json(res, 200, { docs: nd, arquivos: na, contas: nc });
  }
  if (p === '/api/admin/exportar' && m === 'GET') {
    if (conta.nivel !== 'owner') return json(res, 403, { erro: 'Apenas o dono.' });
    const docs = db.prepare('SELECT path,data FROM docs').all().map(r => ({ path: r.path, data: JSON.parse(r.data) }));
    const b = zlib.gzipSync(Buffer.from(JSON.stringify({ versao: 1, em: Date.now(), docs })));
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="backup-banco-' + new Date().toISOString().slice(0, 10) + '.json.gz"', 'content-length': b.length }); return res.end(b);
  }
  if (await solidesRota(p, m, req, res, conta, u)) return;
  if (await bancosRota(p, m, req, res, conta, u)) return;
  /* ---- arquivos do sistema ---- */
  if (m === 'GET') {
    if (p === '/' || p === '/index.html') return estatico(req, res, 'index.html');
    if (estatico(req, res, decodeURIComponent(p.slice(1)))) return;
  }
  json(res, 404, { erro: 'Não encontrado.' });
}

const solidesRota = require('./solides.js')({ q, db, avisarDoc, json, lerJson, NIV });
const bancosRota = require('./bancos.js')({ q, db, avisarDoc, json, lerJson, NIV });
const srv = http.createServer((req, res) => { rotear(req, res).catch(e => { if (!res.headersSent) json(res, e.st || 500, { erro: e.msg || 'Erro interno.' }); else try { res.end(); } catch (x) { } if (!e.st) console.error(e); }); });
srv.requestTimeout = 0; srv.headersTimeout = 65000; srv.keepAliveTimeout = 61000;
srv.listen(PORT, () => console.log('Central de Gestão no ar na porta ' + PORT + ' · dados em ' + DATA + (FISCAL_URL ? ' · conector fiscal ' + FISCAL_URL : '') + (AI_KEY ? ' · IA ligada' : '') + (process.env.SOLIDES_TOKEN ? ' · Sólides ligada' : '')));
module.exports = { srv, db };

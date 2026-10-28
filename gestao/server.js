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
const APP_URL = (process.env.APP_URL || 'https://app.inaservicos.com.br').replace(/\/$/, '');
const EMAIL = require('./email.js');
const MAX_JSON = 40 * 1024 * 1024, MAX_BLOB = 25 * 1024 * 1024;
fs.mkdirSync(path.join(DATA, 'blobs'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'tmp'), { recursive: true });

/* ---------------- banco ---------------- */
process.removeAllListeners('warning');
const db = new DatabaseSync(path.join(DATA, 'gestao.db'));
const BACKUP = require('./backup.js').criar(db, DATA);
const SEG = require('./seguranca.js'), QR = require('./qr.js');
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
CREATE TABLE IF NOT EXISTS contas(id TEXT PRIMARY KEY, nome TEXT, email TEXT UNIQUE, hash TEXT, nivel TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1, criado INTEGER, importado INTEGER DEFAULT 0, cor TEXT);
CREATE TABLE IF NOT EXISTS sessoes(token TEXT PRIMARY KEY, conta TEXT NOT NULL, criado INTEGER, expira INTEGER);
CREATE TABLE IF NOT EXISTS arquivos(id TEXT PRIMARY KEY, ct TEXT, tam INTEGER, por TEXT, criado INTEGER);
CREATE TABLE IF NOT EXISTS cfg(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS perm_log(dia TEXT, conta TEXT, perfil TEXT, col TEXT, n INTEGER, ult INTEGER, PRIMARY KEY(dia, conta, col));
CREATE TABLE IF NOT EXISTS tokens_senha(hash TEXT PRIMARY KEY, conta TEXT NOT NULL, tipo TEXT, expira INTEGER);
CREATE TABLE IF NOT EXISTS login2f(hash TEXT PRIMARY KEY, conta TEXT NOT NULL, expira INTEGER, n INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS totp_novo(conta TEXT PRIMARY KEY, segredo TEXT, expira INTEGER);`);
for (const s of ['ALTER TABLE contas ADD COLUMN totp TEXT', 'ALTER TABLE contas ADD COLUMN totp_ult INTEGER', 'ALTER TABLE contas ADD COLUMN rec TEXT', 'ALTER TABLE sessoes ADD COLUMN ua TEXT', 'ALTER TABLE sessoes ADD COLUMN ip TEXT', 'ALTER TABLE sessoes ADD COLUMN visto INTEGER']) { try { db.exec(s); } catch (e) { } }
/* sessões: o banco passa a guardar só o hash do token (o cookie continua o mesmo; ninguém precisa entrar de novo) */
if (!db.prepare("SELECT v FROM cfg WHERE k='sess_hash'").get()) {
  db.exec('BEGIN'); try { for (const r of db.prepare('SELECT token FROM sessoes').all()) db.prepare('UPDATE sessoes SET token=? WHERE token=?').run(SEG.sha(r.token), r.token); db.prepare("INSERT INTO cfg(k,v) VALUES('sess_hash','1')").run(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
/* emergência: DOIS_FATORES_RESET=email@... no Ambiente desliga a verificação em duas etapas dessa conta ao iniciar */
if (process.env.DOIS_FATORES_RESET) { const r = db.prepare('UPDATE contas SET totp=NULL, totp_ult=NULL, rec=NULL WHERE lower(email)=lower(?)').run(String(process.env.DOIS_FATORES_RESET).trim()); console.log('[seguranca] verificação em duas etapas desligada para', process.env.DOIS_FATORES_RESET, '(' + r.changes + ' conta). Tire DOIS_FATORES_RESET do Ambiente.'); }
const q = {
  docGet: db.prepare('SELECT data, ts FROM docs WHERE path=?'),
  docPut: db.prepare('INSERT INTO docs(path,parent,id,data,ts) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, ts=excluded.ts'),
  docDel: db.prepare('DELETE FROM docs WHERE path=?'),
  colGet: db.prepare('SELECT id, data, ts FROM docs WHERE parent=?'),
  contaPorEmail: db.prepare('SELECT * FROM contas WHERE lower(email)=lower(?)'),
  contaPorId: db.prepare('SELECT * FROM contas WHERE id=?'),
  contas: db.prepare('SELECT id,nome,email,nivel,ativo,criado,importado,cor,(hash IS NOT NULL) AS temSenha,(totp IS NOT NULL) AS dois FROM contas ORDER BY nome'),
  contaNova: db.prepare('INSERT INTO contas(id,nome,email,hash,nivel,ativo,criado,importado,cor) VALUES(?,?,?,?,?,?,?,?,?)'),
  contaN: db.prepare('SELECT count(*) AS n FROM contas'),
  sessNova: db.prepare('INSERT INTO sessoes(token,conta,criado,expira,ua,ip,visto) VALUES(?,?,?,?,?,?,?)'),
  sessGet: db.prepare('SELECT * FROM sessoes WHERE token=?'),
  sessDel: db.prepare('DELETE FROM sessoes WHERE token=?'),
  arqNovo: db.prepare('INSERT OR REPLACE INTO arquivos(id,ct,tam,por,criado) VALUES(?,?,?,?,?)'),
  arqGet: db.prepare('SELECT * FROM arquivos WHERE id=?'),
  arqLista: db.prepare('SELECT * FROM arquivos ORDER BY criado DESC'),
  arqDel: db.prepare('DELETE FROM arquivos WHERE id=?'),
  blobRefs: db.prepare("SELECT path, data FROM docs WHERE data LIKE ? ESCAPE '\\' LIMIT 200")
};
const END = require('./endurece.js')({ db, q, SEG, DATA, PUB, fn: () => ({ perfilDe, cookies, ipDe, esc, pag, json, CONEX, gestorContas, MAX_BLOB, PERM, papelDe }) }); /* 2FA obrigatória, sessão, reautenticação, CSP, bibliotecas locais */
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
/* ---- perfis do sistema (Usuários) aplicados também no servidor ----
   O nível do login (Equipe/Colaborador) diz o que a conta pode gravar; o perfil escolhido em Usuários restringe
   no servidor os dados de RH/DP, as integrações e a gestão de contas. */
const SENS_RH = new Set(['rhdoc', 'fpag', 'ferias', 'afast', 'adm', 'dpmov', 'desl', 'esoc', 'dpsol', 'emprest', 'rel', 'psicamp', 'psr', 'cand', 'ppp', 'lgpdreq', 'lgpdinc', 'lgpdc', 'pmmes', 'bhlanc', 'fofi', 'foimp', 'tterc', 'acid', 'proc', 'procp', 'riscoia']);
const PERF_RH = new Set(['admin', 'rh', 'leituratotal', 'diretoria']); /* v111: a Diretoria lê tudo (inclusive custo de obra com salário) */
/* v111: o perfil Segurança do trabalho lê e grava a parte de SST da lista sensível (terceiros, ASO e documentos, acidentes, PPP) */
const SENS_SST = new Set(['tterc', 'rhdoc', 'acid', 'ppp', 'rel', 'psicamp']), SENS_SST_LE = new Set([...SENS_SST, 'afast']); /* afastamentos: só leitura (retorno ao trabalho e aptidão) */
/* v114: Técnico de segurança do trabalho: terceiros e registro de acidente. ASO só pelo resumo de aptidão (apto/inapto e validade) */
const SENS_TEC = new Set(['tterc', 'acid']);
/* v111: prestação de contas de adiantamento pela Minha área (relatorios/feito_v111_B.md): pt/<uid>/fa/adto (Financeiro → colaborador)
   e pt/<uid>/pc/<id> (comprovante do colaborador). O Financeiro lê e grava as duas; as regras de campo ficam em regras.js. */
const ehAdtoc = p => /^pt\/[^/]+\/(fa|pc)(\/|$)/.test(p);
const gravaFin = conta => { const pr = PERM.perfis[perfilDe(conta)]; return !!pr && (pr.w === '*' || (pr.w || []).includes('fin')); };
let perfilMapa = null;
function perfilDe(conta) {
  if (!conta) return 'pendente'; if (conta.nivel === 'owner') return 'admin';
  if (!perfilMapa) { perfilMapa = new Map(); for (const r of q.colGet.all('usr')) { try { const d = JSON.parse(r.data); if (d && d.uid) perfilMapa.set(d.uid, d); } catch (e) { } } }
  if (!perfilMapa.size) return 'admin'; /* controle de acesso ainda desligado */
  const d = perfilMapa.get(conta.id); if (!d || d.ativo === false) return 'pendente';
  const pf = String(d.perfil || 'leitura');
  /* v114: perfil que o servidor não conhece (personalizado desativado ou nome inválido) não vale como acesso total */
  if (!PERF_BASE_N || PERM.perfis[pf]) return pf;
  return /^c_/.test(pf) ? 'pendente' : 'leitura';
}
/* v114: papel do perfil nas regras que usam o nome (Gestor de SST tem o papel 'sst'); perfil personalizado nunca tem papel */
const papelDe = pf => { const d = PERM.perfis[pf]; return (d && !d.custom && d.papel) || pf; };
const papelConta = conta => conta && conta.nivel === 'owner' ? 'admin' : papelDe(perfilDe(conta));
const defConta = conta => PERM.perfis[perfilDe(conta)] || null;
/* v114: perfil personalizado e os dados sensíveis, pelo MESMO mapa módulo → coleções do perfis.json:
   - grava a coleção sensível de RH quando tem "ver dados de RH e salários" e grava o módulo dela; lê quando consulta ou grava o módulo;
   - quem grava o módulo de SST lê e grava a parte de SST da lista sensível (como o perfil SST) e só lê afastamentos. */
const gruposDe = c0 => [...new Set([].concat(PERM.colecoes[c0] || [], (PERM.leitura && PERM.leitura[c0]) || []))];
function customSens(d, c0, modo) {
  if (!d || !d.custom) return false;
  const w = d.w || [], r = d.r || [];
  if (w.includes('sst') && (SENS_SST.has(c0) || (modo === 'r' && SENS_SST_LE.has(c0)))) return true;
  if (!d.sensRh) return false;
  const gs = modo === 'w' ? (PERM.colecoes[c0] || []) : gruposDe(c0);
  return gs.some(g => w.includes(g) || (modo === 'r' && r.includes(g)));
}
/* "ver dados de RH e salários": perfis do RH e personalizado com a opção (e que consulte o módulo de RH) */
function veRh(conta) {
  const pf = perfilDe(conta), pp = papelDe(pf); if (PERF_RH.has(pp)) return true;
  const d = PERM.perfis[pf]; return !!(d && d.custom && d.sensRh && ((d.w || []).includes('rh') || (d.r || []).includes('rh')));
}
const SOMENTE_LEITURA = new Set(['leitura', 'leituratotal', 'pendente', 'semnivel', 'semid']);
const AREAS_PROPRIAS = new Set(['cm', 'pt', 'usrreq']);
function perfilPermite(conta, p, modo) {
  if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return true; /* colaborador: valem as regras de nível */
  const c0 = p.split('/')[0], pf = perfilDe(conta), pp = papelDe(pf), d = PERM.perfis[pf];
  if (c0 === 'cm' || c0 === 'usrreq') return true;
  if (c0 === 'pt') { if (p.split('/')[1] === conta.id) return true; if (ehAdtoc(p) && gravaFin(conta)) return true; if (d && d.custom && d.sensRh && (d.w || []).includes('rh')) return true; /* v114: personalizado que grava RH com dados de RH */ return modo === 'w' ? (pp === 'admin' || pp === 'rh') : PERF_RH.has(pp); }
  if (c0 === 'perfc') return modo === 'r' || pp === 'admin';
  if (c0 === 'rhdoc' && d && !d.custom && d.rhdocNr && !SOMENTE_LEITURA.has(pf)) return true; /* v114: Técnico de SST: só certificados de NR (filtro e recusa em regras.js › rhdocNr) */ /* v114: perfis personalizados: todos leem (sem dado pessoal); só o Administrador (e o dono) grava */
  if (modo === 'w') {
    if (SOMENTE_LEITURA.has(pf)) return false;
    if (c0 === 'usr') return pp === 'admin';
    if (SENS_RH.has(c0)) return pp === 'admin' || pp === 'rh' || (pp === 'sst' && SENS_SST.has(c0)) || (pp === 'ssttec' && SENS_TEC.has(c0)) || customSens(d, c0, 'w');
    return true;
  }
  if (pf === 'pendente' || pf === 'semnivel' || pf === 'semid') return c0 === 'usr' || c0 === 'cfg' || c0 === 'perfc';
  if (SENS_RH.has(c0)) return PERF_RH.has(pp) || (pp === 'sst' && SENS_SST_LE.has(c0)) || (pp === 'ssttec' && SENS_TEC.has(c0)) || customSens(d, c0, 'r');
  return true;
}
/* gestão de contas: só o perfil Administrador; contas de nível Equipe só o dono altera (evita que um administrador tome a conta de outro) */
const gestorContas = conta => !!conta && NIV[conta.nivel] >= NIV.admin && perfilEm(conta, ['admin']);
const protegida = (conta, c) => c.id !== conta.id && conta.nivel !== 'owner' && (c.nivel === 'admin' || c.nivel === 'owner');
/* cadastro de colaboradores: salário, CPF, documentos, endereço, dados bancários, benefícios e dependentes
   só para RH, Administrador e Leitura completa; os outros perfis veem nome, função, obra, contato e CNH.
   Ao gravar, o servidor mantém os campos ocultos como estavam. */
const FUNC_SENS = /^(cpf|rg|pis|ctps|nasc|salario|ben[A-Z]|tr(Valor|Modo|Linhas|Dist|Tempo|Dias)|banco|agencia|conta[A-Z]?|pix|dep[A-Z]|insal|pericul|end$|numero$|compl$|bairro$|cep$|rec[A-Z]|mae$|pai$|raca|sexo|estadoCivil|escolaridade|defic|sangue|alerg|tituloEleitor|reservista|gest[A-Z]|estab[A-Z])/; /* v113: gravidez comunicada e garantia de emprego cadastrada só para RH */
const ehDocFunc = p => /^func\/[^/]+$/.test(p);
const veFuncCompleto = conta => !conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin || veRh(conta);
function redigir(conta, p, data) {
  data = REG.redigir(conta, p, data);
  if (!data || !ehDocFunc(p) || veFuncCompleto(conta)) return data;
  const o = {}; for (const k of Object.keys(data)) if (!FUNC_SENS.test(k)) o[k] = data[k]; o._restrito = true; return o;
}
function preservarFunc(conta, p, novo) {
  if (!ehDocFunc(p) || veFuncCompleto(conta)) return novo;
  const r = q.docGet.get(p), velho = r ? JSON.parse(r.data) : {}, o = {};
  for (const k of Object.keys(novo)) if (!FUNC_SENS.test(k) && k !== '_restrito') o[k] = novo[k];
  for (const k of Object.keys(velho)) if (FUNC_SENS.test(k)) o[k] = velho[k];
  return o;
}
/* gravação por módulo: cada coleção pertence a um módulo (perfis.json, gerado a partir do sistema); o perfil
   só grava nos módulos dele. PERFIL_GRAVACAO=bloquear (padrão) recusa; PERFIL_GRAVACAO=avisar só registra o que
   seria bloqueado, para conferir antes. */
let PERM = { perfis: {}, colecoes: {} };
try { PERM = JSON.parse(fs.readFileSync(path.join(__dirname, 'perfis.json'), 'utf8')); } catch (e) { console.log('perfis.json não encontrado: gravação por módulo desligada'); }
/* ---- v114: perfis personalizados (Sistema › Perfis de acesso), guardados na coleção perfc ----
   Cada perfil: nome, descrição, mod {grupo: 'r'|'w'} e opc {rh, banco, frota, dir}. O servidor monta o perfil com o
   mesmo formato do perfis.json (w, r) e o junta aos perfis padrão. Nunca tem '*', papel, "so" nem os módulos de
   Usuários, Configurações e Lixeira: um perfil personalizado nunca tem mais poder que o Administrador. */
const PERF_BASE = PERM.perfis || {}, PERF_BASE_N = Object.keys(PERF_BASE).length;
const PERFC_PROIBIDOS = new Set(['usr', 'cfg', 'lixo']), PERFC_SO_LEITURA = new Set(['painel', 'dir', 'meu', 'ajuda']);
const PERFC_ID = /^c_[a-z0-9]{4,24}$/;
/* v115: Painel do Início e Painel da diretoria (com os indicadores) são só do Administrador, do dono e da Diretoria: o perfil
   personalizado não os recebe, mesmo que estejam gravados nele (perfis criados antes da v115). */
const PERFC_SO_ADMIN = new Set(['painel', 'dir']);
const perfcGrupoValido = g => typeof g === 'string' && !PERFC_PROIBIDOS.has(g) && ((PERM.modulos || []).some(m => m[0] === g) || g === 'agenda' || g === 'chat');
function perfcCompilar(d) {
  const w = [], r = [];
  for (const [g, v] of Object.entries((d && d.mod) || {})) { if (!perfcGrupoValido(g) || PERFC_SO_ADMIN.has(g)) continue; if (v === 'w' && !PERFC_SO_LEITURA.has(g)) w.push(g); else if (v === 'w' || v === 'r') r.push(g); }
  ['meu', 'ajuda'].forEach(g => { if (!r.includes(g)) r.push(g); });
  const o = (d && d.opc) || {};
  return { w, r, custom: true, nome: String((d && d.nome) || '').slice(0, 60), sensRh: o.rh === true, banco: o.banco === true, frotaTodos: o.frota === true, aprovDir: o.dir === true };
}
function perfcRecarregar() {
  if (!PERF_BASE_N) return; const novo = Object.assign({}, PERF_BASE);
  for (const r of q.colGet.all('perfc')) { try { const d = JSON.parse(r.data); if (PERFC_ID.test(r.id) && d && d.ativo !== false && !PERF_BASE[r.id]) novo[r.id] = perfcCompilar(d); } catch (e) { } }
  /* v127: ajustes dos perfis padrão (perfc/a_<perfil>) valem no lugar do padrão */
  for (const r of q.colGet.all('perfc')) { try { const m = PERFA_ID.exec(r.id), d = JSON.parse(r.data); if (m && perfaBaseOk(m[1]) && d && d.ajuste === true) novo[m[1]] = perfaCompilar(m[1], d); } catch (e) { } }
  PERM.perfis = novo; perfilMapa = null;
}
/* v127: ajuste de um perfil padrão (Sistema › Perfis de acesso › Ajustar), guardado em perfc/a_<perfil>: {base, ajuste:true,
   mod {grupo: 'w'|'r'|'n'} só com o que difere do padrão, opc {frota}}. Parte do perfil padrão e troca, módulo a módulo, o
   acesso (sem acesso, consulta ou grava). Mantém o papel, as regras finas ("so", "campos"...) e as opções de dados de RH,
   bancários e diretoria do padrão. Nunca dá Usuários, Configurações nem Lixeira a quem não é Administrador, e o
   Administrador nunca perde esses três (trava). Somente leitura e Leitura completa continuam sem gravar. */
const PERFA_ID = /^a_([a-z0-9]{2,30})$/, PERFA_FORA = new Set(['pendente', 'semnivel', 'semid']), PERFA_SO_LEITURA = new Set(['leitura', 'leituratotal']);
const PERFA_NAO_EDITA = new Set(['painel', 'dir', 'meu', 'ajuda']), PERFA_SISTEMA = ['usr', 'cfg', 'lixo'];
const perfaBaseOk = b => !!PERF_BASE[b] && !PERFA_FORA.has(b);
const perfaGrupos = () => [...new Set((PERM.modulos || []).map(m => m[0]).concat(['meu', 'agenda', 'chat', 'ajuda']))];
const perfaEditavel = (k, g) => perfaGrupos().includes(g) && !PERFA_NAO_EDITA.has(g) && !PERFA_SISTEMA.includes(g);
function perfaCompilar(k, d) {
  const b = PERF_BASE[k], todos = perfaGrupos(), tudoW = b.w === '*', tudoR = b.r === '*';
  let w = tudoW ? todos.slice() : [...new Set(b.w || [])], r = tudoR ? todos.slice() : [...new Set(b.r || [])];
  for (const [g, v] of Object.entries((d && d.mod) || {})) {
    if (!perfaEditavel(k, g) || !['w', 'r', 'n'].includes(v)) continue;
    w = w.filter(x => x !== g); r = r.filter(x => x !== g);
    if (v === 'w' && !PERFA_SO_LEITURA.has(k)) w.push(g); else if (v === 'w' || v === 'r') r.push(g);
  }
  const out = Object.assign({}, b, { ajustado: true });
  out.w = tudoW && todos.every(g => w.includes(g)) ? '*' : w;
  out.r = tudoR && todos.every(g => w.includes(g) || r.includes(g)) ? '*' : r;
  if (b.so) { const so = {}; Object.keys(b.so).forEach(g => { if (out.w === '*' || out.w.includes(g)) so[g] = b.so[g]; }); out.so = so; }
  const o = (d && d.opc) || {}; if (typeof o.frota === 'boolean') out.frotaTodos = o.frota;
  return out;
}
perfcRecarregar();
const MODO_GRAV = (process.env.PERFIL_GRAVACAO || 'bloquear').toLowerCase() === 'avisar' ? 'avisar' : 'bloquear';
const LIVRES = new Set(['cfg', 'lixo', 'lgpdc', 'implog', 'cm', 'pt', 'usrreq', 'usr']);
function gravacaoPermitida(conta, p) {
  if (!conta || conta.nivel === 'owner' || NIV[conta.nivel] < NIV.admin) return true;
  const pf = perfilDe(conta), pr = PERM.perfis[pf]; if (!pr || pr.w === '*') return true;
  const c0 = p.split('/')[0], gs = PERM.colecoes[c0]; if (LIVRES.has(c0) || !gs || !gs.length) return true;
  /* v111: "so" limita, dentro de um módulo, as coleções que o perfil grava (ex.: Encarregado só grava diário, hora extra e checklist em Obras) */
  return gs.some(g => pr.w.includes(g) && !(pr.so && Array.isArray(pr.so[g]) && !pr.so[g].includes(c0)));
}
const permLogPut = db.prepare('INSERT INTO perm_log(dia,conta,perfil,col,n,ult) VALUES(?,?,?,?,1,?) ON CONFLICT(dia,conta,col) DO UPDATE SET n=n+1, ult=excluded.ult, perfil=excluded.perfil');
const perfilEm = (conta, lista) => conta && (conta.nivel === 'owner' || lista.includes(papelDe(perfilDe(conta)))); /* v114: pelo papel (o Gestor de SST conta como 'sst'); perfil personalizado não entra em nenhuma lista */
/* chat: mensagens, áudios e conversas só para quem participa da conversa (o canal Geral é de todos) */
function chatVisivel(conta, p, data, memo) {
  const s = p.split('/'); if (s[0] !== 'cm' || s.length < 4 || s[1] === conta.id) return true;
  const kind = s[2], d = data || {};
  if (kind === 's') return true;
  if (kind === 'rtc') return !!d.to && d.to === conta.id; /* v116: sinalização da chamada direta: só a outra pessoa da chamada */
  const membro = (criador, cid) => { if (criador === conta.id) return true; const k = criador + '/' + cid; if (memo && memo.has(k)) return memo.get(k); let ok = false;
    const r = q.docGet.get('cm/' + criador + '/c/' + cid); if (r) { try { const cv = JSON.parse(r.data); ok = cv.tipo === 'canal' || (Array.isArray(cv.membros) && cv.membros.includes(conta.id)); } catch (e) { } }
    if (memo) memo.set(k, ok); return ok; };
  if (kind === 'c') return d.tipo === 'canal' || (Array.isArray(d.membros) && d.membros.includes(conta.id));
  if (kind === 'm' || kind === 'v') { const cv = String(d.conv || ''); if (cv === 'geral') return true; const i = cv.indexOf('/'); if (i <= 0) return false; return membro(cv.slice(0, i), cv.slice(i + 1)); }
  return false;
}
const podeVer = (conta, p, data, memo) => pode(conta, p, 'r') && perfilPermite(conta, p, 'r') && chatVisivel(conta, p, data, memo) && REG.podeLer(conta, p, data, memo) && END.leituraPropria(conta, p, data);
/* v116: sinalização das chamadas diretas (cm/<eu>/rtc/<id>): o documento leva "to" (a outra pessoa); a resposta, a recusa e o
   encerramento herdam o "to" do documento anterior ou de quem ligou, para que só as duas pessoas da chamada leiam */
const rtcPar = db.prepare("SELECT path, data FROM docs WHERE id=? AND parent LIKE 'cm/%/rtc' LIMIT 5");
function rtcPreparar(conta, dp, velho, data) {
  const s = dp.split('/'); if (s[0] !== 'cm' || s[2] !== 'rtc' || s.length !== 4) return { data };
  if (JSON.stringify(data).length > 65536) return { st: 413, erro: 'Dados da chamada grandes demais.' };
  let to = typeof data.to === 'string' && data.to ? data.to : '';
  if (!to && velho && typeof velho.to === 'string') to = velho.to;
  if (!to) for (const r of rtcPar.all(s[3])) { const a = r.path.split('/')[1]; if (a === conta.id) continue; try { if (JSON.parse(r.data).to === conta.id) { to = a; break; } } catch (e) { } }
  if (!to) { const o = Object.assign({}, data); delete o.to; return { data: o }; }
  const c = q.contaPorId.get(to); if (to === conta.id || !c || !c.ativo) return { st: 400, erro: 'Chamada para uma conta inválida.' };
  return { data: Object.assign({}, data, { to }) };
}
/* v116: servidores de conexão das chamadas diretas (STUN e, se configurado, TURN para redes que bloqueiam a ligação direta) */
function iceServers(conta) {
  const lista = v => String(v || '').split(',').map(x => x.trim()).filter(x => /^(stun|turns?):[^\s"'<>]{3,200}$/.test(x)).slice(0, 6);
  const stun = lista(process.env.STUN_URLS != null ? process.env.STUN_URLS : 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'), turn = lista(process.env.TURN_URLS), out = [];
  if (stun.length) out.push({ urls: stun });
  if (turn.length) {
    if (process.env.TURN_SEGREDO) { const username = Math.floor(Date.now() / 1000 + 12 * 3600) + ':' + conta.id; out.push({ urls: turn, username, credential: crypto.createHmac('sha1', process.env.TURN_SEGREDO).update(username).digest('base64') }); }
    else if (process.env.TURN_USUARIO) out.push({ urls: turn, username: process.env.TURN_USUARIO, credential: process.env.TURN_SENHA || '' });
    else out.push({ urls: turn });
  }
  return { iceServers: out, turn: turn.length > 0 };
}
const validPath = (p, doc) => { const s = String(p || '').split('/').filter(Boolean); return s.length > 0 && s.length <= 12 && s.every(x => /^[\w\-.|~@+=]{1,200}$/.test(x)) && (doc ? s.length % 2 === 0 : s.length % 2 === 1); };

/* ---------------- tempo real (SSE) ---------------- */
const CONEX = new Map(); /* id -> {res, conta, presence, updatedAt} */
function sse(res, ev, obj) { try { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { } }
function avisarDoc(op, p, data, ts) {
  if (p.startsWith('usr/')) perfilMapa = null;
  if (p.startsWith('perfc/')) perfcRecarregar(); /* v114 */
  const parent = p.split('/').slice(0, -1).join('/'), id = p.split('/').pop();
  for (const [cid, c] of CONEX) {
    const ca = q.contaPorId.get(c.conta.id); if (!ca || !ca.ativo) { CONEX.delete(cid); try { c.res.end(); } catch (e) { } continue; }
    c.conta = ca; if (podeVer(ca, p, data || (op === 'del' ? null : {}), null) || (op === 'del' && pode(ca, p, 'r') && perfilPermite(ca, p, 'r'))) { sse(c.res, 'doc', { op, path: p, parent, id, data: redigir(ca, p, data), ts }); if (op !== 'del' && parent.indexOf('/') < 0 && REG.ehSaude(parent)) REG.registrarLeitura(ca, null, parent, [id], 'ao vivo'); }
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
  return new Promise((ok, err) => { const ch = []; let n = 0; req.on('data', d => { n += d.length; if (n > max) { err({ st: 413, msg: 'Conteúdo grande demais.' }); req.destroy(); } else ch.push(d); }); req.on('end', () => { const b = Buffer.concat(ch); if (n <= 20000) req._corpo = b; ok(b); }); req.on('error', err); });
}
async function lerJson(req) { const b = await lerCorpo(req, MAX_JSON); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { throw { st: 400, msg: 'JSON inválido.' }; } }
function json(res, st, obj, extra) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(st, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' }, extra || {})); res.end(b); }
function html(res, st, body, extra) { const pg = END.pagina(body, extra), b = Buffer.from(pg.body); res.writeHead(st, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' }, pg.cab, extra || {})); res.end(b); }
function cookies(req) { const o = {}; String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
const seguro = req => String(req.headers['x-forwarded-proto'] || '').includes('https') || !!req.socket.encrypted;
function contaDa(req) {
  const t = cookies(req).sid; if (!t) return null; const s = q.sessGet.get(SEG.sha(t)); if (!s || s.expira < Date.now()) return null;
  const c = q.contaPorId.get(s.conta); if (!c || !c.ativo || END.sessaoInativa(s, c)) return null;
  if (!s.visto || Date.now() - s.visto > 300000) try { db.prepare('UPDATE sessoes SET visto=?, ip=? WHERE token=?').run(Date.now(), ipDe(req), s.token); } catch (e) { }
  return c;
}
const hashSenha = SEG.hashSenha, confere = SEG.confere;
const HASH_FALSO = hashSenha(crypto.randomBytes(12).toString('hex'));
function abrirSessao(res, req, conta, extra) { const t = uid(40), dias = 30, ag = Date.now(); q.sessNova.run(SEG.sha(t), conta.id, ag, ag + dias * 864e5, String(req.headers['user-agent'] || '').slice(0, 300), ipDe(req), ag); res.setHeader('set-cookie', ['sid=' + t + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + dias * 86400 + (seguro(req) ? '; Secure' : '')].concat(extra || [])); }
const perfilPub = c => ({ id: c.id, name: c.nome || c.email || 'Usuário', avatarUrl: '', color: c.cor || CORES[0], email: c.email || null, guest: false });
const tentativas = new Map(), limitePub = new Map(), usoIa = new Map();
/* IP real: o último endereço acrescentado pelo proxy (Traefik/Easypanel); o cliente não consegue forjar */
const ipDe = req => { const x = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return x.length ? x[x.length - 1] : (req.socket.remoteAddress || ''); };
setInterval(() => { const t = Date.now(); for (const [k, v] of tentativas) if ((v.ate || 0) < t && t - (v.em || 0) > 3600e3) tentativas.delete(k); for (const [k, v] of limitePub) if (t - v.ini > 3600e3) limitePub.delete(k); for (const [k, v] of usoIa) if (t - v.ini > 3600e3) usoIa.delete(k);
  for (const [k, v] of limiteEsqueci) if (t - v.ini > 3600e3) limiteEsqueci.delete(k); for (const [k, v] of cacheCnpj) if (t - v.em > 864e5) cacheCnpj.delete(k); for (const [k, v] of blobMemo) if (t - v.em > 300000) blobMemo.delete(k);
  try { db.prepare('DELETE FROM sessoes WHERE expira<?').run(t); db.prepare('DELETE FROM tokens_senha WHERE expira<?').run(t); } catch (e) { } }, 600e3).unref();
/* links de criar/redefinir senha: o banco guarda só o hash do token; valem uma vez */
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
function criarLink(contaId, tipo, horas) {
  const t = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM tokens_senha WHERE conta=? OR expira<?').run(contaId, Date.now());
  db.prepare('INSERT INTO tokens_senha(hash,conta,tipo,expira) VALUES(?,?,?,?)').run(sha(t), contaId, tipo, Date.now() + horas * 3600e3);
  return APP_URL + '/senha/' + t;
}
async function enviarLink(c, tipo) {
  const convite = tipo === 'convite', link = criarLink(c.id, tipo, convite ? 72 : 1);
  const m = convite
    ? EMAIL.modelo('Seu acesso à Central de Gestão', ['Olá, ' + (c.nome || '') + '.', 'Foi criado um acesso para você na Central de Gestão da INA Serviços. Clique no botão abaixo para criar a sua senha. Depois, entre em ' + APP_URL + ' com este e-mail (' + c.email + ') e a senha que você criou.'], 'Criar minha senha', link, 'O link vale por 72 horas e só pode ser usado uma vez. Se você não esperava este e-mail, ignore-o.')
    : EMAIL.modelo('Redefinir sua senha', ['Olá, ' + (c.nome || '') + '.', 'Recebemos um pedido para redefinir a senha da sua conta na Central de Gestão. Clique no botão abaixo para criar uma senha nova.'], 'Criar nova senha', link, 'O link vale por 1 hora e só pode ser usado uma vez. Se não foi você que pediu, ignore este e-mail: sua senha continua a mesma.');
  await EMAIL.enviar({ para: c.email, assunto: convite ? 'Seu acesso à Central de Gestão' : 'Redefinir sua senha · Central de Gestão', texto: m.texto, html: m.html });
}
const limiteEsqueci = new Map(), cacheCnpj = new Map(), blobMemo = new Map();
/* fecha as conexões ao vivo da conta, menos as deste aparelho */
function derrubarOutras(contaId, req) { const meu = SEG.sha(cookies(req).sid || ''); for (const [cid, c] of CONEX) if (c.conta.id === contaId && c.sess !== meu) { CONEX.delete(cid); try { c.res.end(); } catch (e) { } } }
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
function pagCodigo(msg, confia) {
  return pag('Código de verificação', '<div class="card" style="max-width:420px;margin:40px auto"><h1>Verificação em duas etapas</h1><p class="sub">Abra o aplicativo autenticador no celular (Google Authenticator, Microsoft Authenticator...) e digite o código de 6 dígitos da Central de Gestão.</p>' + (msg ? '<div class="msg err">' + esc(msg) + '</div>' : '') +
    '<form method="post" action="/login/codigo"><label>Código<input name="codigo" inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code" required autofocus></label>' + (confia ? '<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" name="confiar" value="1" style="width:auto;margin:0">Confiar neste aparelho por 30 dias (não pedir o código aqui)</label><p class="sub" style="margin:-4px 0 10px">Use só no seu celular ou computador pessoal. A senha continua sendo pedida.</p>' : '') + '<button class="pri" type="submit" style="width:100%">Confirmar</button></form>' +
    '<details style="margin-top:16px"><summary class="sub" style="cursor:pointer">Perdi o celular: usar um código de recuperação</summary><form method="post" action="/login/codigo" style="margin-top:10px"><label>Código de recuperação<input name="rec" placeholder="XXXXX-XXXXX" autocomplete="off" required></label><button type="submit" style="width:100%">Entrar com código de recuperação</button></form></details>' +
    '<p class="sub" style="margin:14px 0 0;text-align:center"><a href="/login">Voltar</a></p></div>');
}
function pagSeguranca(eu, req, msg, erro, extra) {
  const c = q.contaPorId.get(eu.id), meu = SEG.sha(cookies(req).sid || ''), quando = t => t ? new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
  let rec = []; try { rec = JSON.parse(c.rec || '[]'); } catch (e) { }
  const novo = db.prepare('SELECT * FROM totp_novo WHERE conta=? AND expira>?').get(c.id, Date.now());
  let dois;
  if (c.totp) dois = '<p><b style="color:#0e7c66">Ligada.</b> Ao entrar, além da senha, o sistema pede o código do aplicativo. Códigos de recuperação restantes: <b>' + rec.length + '</b>.</p>' +
    '<div class="msg" style="margin:0 0 14px"><b>Onde está o código do aplicativo?</b> Abra no celular o aplicativo autenticador em que você leu o QR Code ao ligar a verificação (Google Authenticator, Microsoft Authenticator, Authy ou outro). Procure a linha <b>Central de Gestão</b> com o seu e-mail: ela mostra um número de <b>6 dígitos</b> que muda a cada 30 segundos. Digite esse número no campo abaixo (sem espaço) antes de ele trocar.<br><span class="sub">Perdeu o celular? Use um dos códigos de recuperação para entrar e depois gere novos aqui. Sem celular e sem códigos, peça ao dono do sistema para desligar a verificação da sua conta em Contas de acesso.</span></div>' +
    '<h3 style="margin:16px 0 4px;font-size:16px">Gerar novos códigos de recuperação</h3><p class="sub" style="margin:0 0 8px">Use quando tiver gastado ou perdido os códigos (ou se alguém os viu). Os códigos antigos deixam de valer.</p>' +
    '<form method="post" action="/conta/seguranca/rec" style="max-width:420px"><label>Código de 6 dígitos do aplicativo<input name="codigo" inputmode="numeric" maxlength="7" required autocomplete="one-time-code"></label><button type="submit">Gerar novos códigos</button></form>' +
    '<details style="margin-top:18px"><summary class="sub" style="cursor:pointer">Desligar a verificação em duas etapas</summary><p class="sub" style="margin:8px 0">Só faça isso se for trocar de celular (ligue de novo em seguida). Para o seu perfil ela pode ser obrigatória: o sistema volta a pedir que você a ligue.</p>' +
    '<form method="post" action="/conta/seguranca/desligar" style="max-width:420px"><label>Senha<input name="senha" type="password" required autocomplete="current-password"></label><label>Código de 6 dígitos do aplicativo<input name="codigo" inputmode="numeric" maxlength="7" required autocomplete="one-time-code"></label><button type="submit" class="dng">Desligar</button></form></details>';
  else if (novo) { const uri = SEG.uriAutenticador(novo.segredo, c.email || c.nome || 'conta', 'Central de Gestão');
    dois = '<ol style="padding-left:18px;margin:0 0 12px"><li>Instale no celular um aplicativo autenticador (Google Authenticator, Microsoft Authenticator ou outro).</li><li>No aplicativo, toque em adicionar e leia este QR Code:</li></ol>' +
      '<div style="text-align:center;margin:8px 0">' + QR.svg(uri, 220) + '</div><p class="sub" style="text-align:center">Sem câmera? Digite a chave: <b style="font-family:monospace;letter-spacing:1px">' + esc(novo.segredo.replace(/(.{4})/g, '$1 ').trim()) + '</b></p>' +
      '<form method="post" action="/conta/seguranca/confirmar"><label>3. Digite o código de 6 dígitos que apareceu no aplicativo<input name="codigo" inputmode="numeric" maxlength="7" required autocomplete="one-time-code" autofocus></label><button class="pri" type="submit">Confirmar e ligar</button></form>'; }
  else dois = '<p><b>Desligada.</b> Com ela ligada, quem descobrir a sua senha ainda precisa do seu celular para entrar. ' + (eu.nivel === 'owner' || NIV[eu.nivel] >= NIV.admin ? '<b>Recomendado para a sua conta.</b>' : '') + '</p><form method="post" action="/conta/seguranca/iniciar"><button class="pri" type="submit">Ligar verificação em duas etapas</button></form>';
  const ss = db.prepare('SELECT token, ua, ip, criado, visto FROM sessoes WHERE conta=? AND expira>? ORDER BY coalesce(visto, criado) DESC').all(c.id, Date.now());
  return pag('Segurança', '<nav><a class="btn" href="/">← Voltar ao sistema</a>' + (eu.nivel === 'owner' ? '<a class="btn" href="/contas">Contas de acesso</a>' : '') + '<a class="btn" href="/sair">Sair</a></nav><h1>Segurança da minha conta</h1><p class="sub">' + esc(c.nome || '') + ' · ' + esc(c.email || '') + '</p>' +
    (msg ? '<div class="msg' + (erro ? ' err' : '') + '">' + esc(msg) + '</div>' : '') + (extra || '') +
    '<div class="card"><h2>Verificação em duas etapas</h2>' + dois + '</div>' +
    '<div class="card"><h2>Aparelhos conectados</h2><table><thead><tr><th>Aparelho</th><th>Endereço</th><th>Entrou em</th><th>Último uso</th></tr></thead><tbody>' + ss.map(s => '<tr><td>' + esc(SEG.aparelho(s.ua)) + (s.token === meu ? ' <b>(este)</b>' : '') + '</td><td>' + esc(s.ip || '—') + '</td><td>' + quando(s.criado) + '</td><td>' + quando(s.visto) + '</td></tr>').join('') + '</tbody></table>' +
    (ss.length > 1 ? '<form method="post" action="/conta/seguranca/sair-outros" style="margin-top:10px"><button type="submit">Sair de todos os outros aparelhos</button></form>' : '') + '</div>' +
    END.cartaoAparelhos(c) +
    '<div class="card"><h2>Trocar senha</h2><form method="post" action="/contas/senha"><input type="hidden" name="volta" value="seg"><div class="row"><label>Senha atual<input name="atual" type="password" required autocomplete="current-password"></label><label>Nova senha<input name="nova" type="password" minlength="8" required autocomplete="new-password"></label></div><p class="sub" style="margin:0 0 10px">Use pelo menos 8 caracteres. Uma frase com 3 ou 4 palavras é fácil de lembrar e difícil de adivinhar.</p><button type="submit">Trocar senha</button></form></div>');
}
function pagCodigosRec(eu, req, cods) {
  return pagSeguranca(eu, req, '', false, '<div class="card" style="border-color:#b54708"><h2>Guarde seus códigos de recuperação</h2><p class="sub" style="margin:0 0 10px">Cada código entra uma vez, se você perder o celular. Anote ou imprima e guarde em lugar seguro: eles <b>não aparecem de novo</b>.</p><div style="font-family:monospace;font-size:16px;columns:2;max-width:360px;line-height:1.9">' + cods.map(esc).join('<br>') + '</div></div>');
}
function pagLogin(msg, setup) {
  return pag(setup ? 'Primeiro acesso' : 'Entrar', '<div class="card" style="max-width:420px;margin:40px auto"><h1>' + (setup ? 'Primeiro acesso' : 'Central de Gestão') + '</h1><p class="sub">' + (setup ? 'Crie a conta do dono do sistema. Ela pode criar as contas das outras pessoas depois.' : 'Entre com seu e-mail e senha.') + '</p>' + (msg ? '<div class="msg err">' + esc(msg) + '</div>' : '') +
    '<form method="post" action="' + (setup ? '/setup' : '/login') + '">' + (setup ? '<label>Seu nome<input name="nome" required autocomplete="name"></label>' : '') + '<label>E-mail<input name="email" type="email" required autocomplete="username"></label><label>Senha<input name="senha" type="password" required minlength="' + (setup ? 8 : 1) + '" autocomplete="' + (setup ? 'new-password' : 'current-password') + '"></label><button class="pri" type="submit" style="width:100%">' + (setup ? 'Criar e entrar' : 'Entrar') + '</button></form>' + (setup ? '' : '<p class="sub" style="margin:14px 0 0;text-align:center"><a href="/esqueci">Esqueci minha senha</a></p>') + '</div>');
}
const NIV_NOME = { owner: 'Dono', admin: 'Equipe (usa os módulos do perfil em Usuários)', interact: 'Só ponto, Minha área e chat', view: 'Somente leitura (sem acesso aos dados)' };
function pagBackup(eu) {
  if (eu.nivel !== 'owner') return '';
  return BACKUP.cartao(esc) + END.cartaoServidor(eu);
}
function pagPermLog(eu) {
  if (eu.nivel !== 'owner' && papelConta(eu) !== 'admin') return '';
  const desde = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const ls = db.prepare('SELECT conta, perfil, col, SUM(n) AS n, MAX(ult) AS ult FROM perm_log WHERE dia>=? GROUP BY conta, col ORDER BY n DESC LIMIT 50').all(desde);
  const nome = id => { const c = q.contaPorId.get(id); return c ? (c.nome || c.email) : id; };
  return '<div class="card"><h2>Gravação por módulo</h2><p class="sub" style="margin:0 0 10px">Modo atual: <b>' + (MODO_GRAV === 'bloquear' ? 'bloquear' : 'só avisar') + '</b>. ' + (MODO_GRAV === 'bloquear' ? 'Gravações fora dos módulos do perfil são recusadas.' : 'Nada é bloqueado ainda: a lista abaixo mostra o que seria recusado nos últimos 14 dias. Se estiver vazia ou só com casos que devem mesmo ser barrados, coloque PERFIL_GRAVACAO=bloquear no serviço gestao (Ambiente) e clique em Implantar.') + '</p>' +
    (ls.length ? '<table><thead><tr><th>Pessoa</th><th>Perfil</th><th>Dados</th><th>Vezes</th><th>Última</th></tr></thead><tbody>' + ls.map(r => '<tr><td>' + esc(nome(r.conta)) + '</td><td>' + esc(r.perfil) + '</td><td>' + esc(r.col) + ' <span style="color:var(--mut)">(' + esc((PERM.colecoes[r.col] || []).join(', ')) + ')</span></td><td>' + r.n + '</td><td>' + new Date(r.ult).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '</td></tr>').join('') + '</tbody></table>' : '<p class="sub" style="margin:0">Nenhuma gravação fora do perfil nos últimos 14 dias.</p>') + '</div>';
}
function pagContas(eu, msg, erro) {
  const cs = q.contas.all();
  const linhas = cs.map(c => '<tr><td><b>' + esc(c.nome || '—') + '</b><div style="color:var(--mut);font-size:12px">' + esc(c.email || 'sem e-mail') + (c.importado ? ' · importado' : '') + '</div></td><td>' + esc(NIV_NOME[c.nivel] || c.nivel) + '</td><td>' + (c.ativo ? (c.temSenha ? 'Ativa' : 'Sem senha') : 'Desativada') + '</td><td>' + (c.dois ? 'Ligada' : '—') + '</td><td style="white-space:nowrap">' +
    (eu.nivel === 'owner' && c.dois && c.id !== eu.id ? '<form method="post" action="/contas/editar" style="display:inline" onsubmit="return confirm(\'Desligar a verificação em duas etapas desta conta? Use quando a pessoa perdeu o celular e os códigos de recuperação.\')"><input type="hidden" name="id" value="' + esc(c.id) + '"><button name="acao" value="tirar2f">Desligar 2 etapas</button></form> ' : '') +
    (c.id !== eu.id && (eu.nivel === 'owner' || c.nivel !== 'owner') ? '<form method="post" action="/contas/editar" style="display:inline"><input type="hidden" name="id" value="' + esc(c.id) + '"><button name="acao" value="' + (c.ativo ? 'desativar' : 'ativar') + '">' + (c.ativo ? 'Desativar' : 'Ativar') + '</button></form> ' +
      '<form method="post" action="/contas/editar" style="display:inline" onsubmit="return confirm(\'Excluir a conta de acesso de ' + esc(String(c.nome || c.email || '').replace(/['"\\]/g, '')) + '? A pessoa não consegue mais entrar. O cadastro dela no sistema (colaborador, perfil, histórico) continua.\')"><input type="hidden" name="id" value="' + esc(c.id) + '"><button name="acao" value="excluir" style="color:var(--neg)">Excluir</button></form> ' : '') +
    (eu.nivel === 'owner' && c.importado && c.id !== eu.id ? '<form method="post" action="/contas/editar" style="display:inline" onsubmit="return confirm(\'Usar esta conta importada como a sua? Você passa a ver as conversas e registros dela.\')"><input type="hidden" name="id" value="' + esc(c.id) + '"><button name="acao" value="soueu">Sou eu</button></form>' : '') + '</td></tr>').join('');
  return pag('Contas', '<nav><a class="btn" href="/">← Voltar ao sistema</a>' + (eu.nivel === 'owner' ? '<a class="btn" href="/migrar">Migrar dados da página antiga</a><a class="btn" href="/contas/auditoria">Auditoria</a>' : '') + '<a class="btn" href="/conta/seguranca">Segurança da minha conta</a><a class="btn" href="/sair">Sair</a></nav><h1>Contas de acesso</h1><p class="sub">Página do dono: a <b>segurança dos logins</b> (e-mail e senha de entrada, verificação em duas etapas, desativar ou excluir um login, contas importadas), as cópias de segurança e o e-mail do sistema.</p>' +
    '<div class="msg"><b>Para cadastrar ou mudar o acesso de alguém, use Sistema › Usuários</b> (dentro do sistema). Lá o botão <b>Novo usuário</b> cria o login, envia o convite por e-mail e já define o perfil, o colaborador ligado e os locais da frota; <b>Editar</b> muda perfil, nome, e-mail, senha e suspende. Aqui ficam só as funções de segurança. <a href="/#usr">Abrir Sistema › Usuários</a></div>' +
    (msg ? '<div class="msg' + (erro ? ' err' : '') + '">' + esc(msg) + '</div>' : '') +
    (eu.nivel === 'owner' && !q.contaPorId.get(eu.id).totp ? '<div class="msg err"><b>Recomendado:</b> ligue a verificação em duas etapas na sua conta de dono em <a href="/conta/seguranca">Segurança da minha conta</a>.</div>' : '') +
    '<div class="card" style="overflow-x:auto"><table style="min-width:640px"><thead><tr><th>Pessoa</th><th>Nível</th><th>Situação</th><th>2 etapas</th><th></th></tr></thead><tbody>' + linhas + '</tbody></table></div>' +
    '<details class="card"><summary><b>Criar só o login ou definir senha (avançado)</b> <span class="sub">prefira Sistema › Usuários › Novo usuário</span></summary><form method="post" action="/contas/salvar" style="margin-top:12px"><div class="row"><label>Conta<select name="id"><option value="">Nova conta</option>' + cs.filter(c => c.nivel !== 'owner' || c.id === eu.id).map(c => '<option value="' + esc(c.id) + '">' + esc(c.nome || c.email || c.id) + '</option>').join('') + '</select></label><label>Nome<input name="nome"></label></div><div class="row"><label>E-mail<input name="email" type="email"></label><label>Senha (mínimo 8)<input name="senha" type="password" minlength="8" autocomplete="new-password"></label><label>Nível<select name="nivel">' + ['admin', 'interact'].map(n => '<option value="' + n + '">' + NIV_NOME[n] + '</option>').join('') + '</select></label></div><button class="pri" type="submit">Salvar</button><p class="sub" style="margin:10px 0 0">Para uma conta existente, deixe em branco o que não quer mudar. Passe a senha à pessoa por um canal seguro; ela pode trocá-la depois em Minha senha. O login criado aqui ainda não tem perfil: defina em Sistema › Usuários.</p></form></details>' +
    pagPermLog(eu) + pagBackup(eu) +
    '<div class="card"><h2>E-mail do sistema</h2><p class="sub" style="margin:0 0 10px">' + (EMAIL.configurado() ? 'Configurado. O sistema envia o convite de novo usuário e o link de "Esqueci minha senha".' : 'Ainda não configurado: preencha SMTP_HOST, SMTP_PORT, SMTP_USUARIO, SMTP_SENHA e SMTP_REMETENTE no serviço gestao do Easypanel e clique em Implantar.') + '</p>' + (EMAIL.configurado() ? '<form method="post" action="/contas/teste-email"><button type="submit">Enviar e-mail de teste para ' + esc(eu.email || '') + '</button></form>' : '') + '</div>' +
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
  const ler = en => { const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, en.off); const ini = en.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28); const d = Buffer.alloc(en.comp); fs.readSync(fd, d, 0, en.comp, ini); return en.met === 0 ? d : zlib.inflateRawSync(d, { maxOutputLength: 512 * 1024 * 1024 }); };
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
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' }, process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}), body: JSON.stringify({ model: AI_MODELS[corpo.nivel < NIV.admin && corpo.modelTier === 'complex' ? 'default' : corpo.modelTier] || AI_MODELS.default, max_tokens: 16000, messages: msgs }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { st: r.status === 429 ? 429 : 502, msg: (j.error && j.error.message) || 'Falha na IA.', code: r.status === 429 ? 'rate_limited' : 'upstream_error' };
  return { text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), truncated: j.stop_reason === 'max_tokens' };
}

/* ---------------- rotas ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function estatico(req, res, arq) {
  const p = path.join(PUB, arq); if (!p.startsWith(PUB + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return false;
  const st = fs.statSync(p), ext = path.extname(p).toLowerCase(), range = req.headers.range;
  const h = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'private, max-age=3600', 'accept-ranges': 'bytes' };
  if (range && /^bytes=\d*-\d*$/.test(range)) { let [a, b] = range.slice(6).split('-'); a = a ? +a : st.size - +b; b = b && range.slice(6)[0] !== '-' ? Math.min(+b, st.size - 1) : st.size - 1; if (!(a >= 0 && a <= b && a < st.size)) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); res.end(); return true; } res.writeHead(206, Object.assign(h, { 'content-range': 'bytes ' + a + '-' + b + '/' + st.size, 'content-length': b - a + 1 })); fs.createReadStream(p, { start: a, end: b }).pipe(res); return true; }
  if (arq === 'index.html') h['content-security-policy'] = cspApp(p, st);
  res.writeHead(200, Object.assign(h, { 'content-length': st.size })); fs.createReadStream(p).pipe(res); return true;
}
/* política de conteúdo do sistema: só roda o script da própria página (pelo hash) e as bibliotecas da cdnjs */
let cspCache = { mt: 0, v: '' };
function cspApp(arq, st) {
  if (cspCache.mt === st.mtimeMs) return cspCache.v;
  const html = fs.readFileSync(arq, 'utf8'), hs = [];
  html.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (m0, js) => { hs.push("'sha256-" + crypto.createHash('sha256').update(js, 'utf8').digest('base64') + "'"); return m0; });
  const v = END.cspApp(hs);
  cspCache = { mt: st.mtimeMs, v }; return v;
}
function form(b) { const o = {}; new URLSearchParams(b.toString('utf8')).forEach((v, k) => { o[k] = v; }); return o; }
const redir = (res, to) => END.redir(res, to); /* ?m= vira código (texto livre na URL não aparece mais) */

async function rotear(req, res) {
  /* proteção contra envio de formulário vindo de outro site (CSRF) */
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) { let ok = false; try { ok = new URL(req.headers.origin).host === req.headers.host; } catch (e) { } if (!ok) return json(res, 403, { erro: 'Origem não permitida.' }); }
  const u = new URL(req.url, 'http://x'), p = u.pathname, m = req.method;
  res.on('finish', () => REG.auditarHttp(req, res, p, m)); /* auditoria de login, duas etapas, contas, backup e anexos */
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'same-origin'); res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('permissions-policy', 'camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), serial=()');
  if (seguro(req)) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  if (p === '/saude') return json(res, 200, { ok: true });
  const semContas = q.contaN.get().n === 0;
  /* primeiro acesso */
  if (p === '/setup' && semContas && END.setupBarrado(req, res, u, m)) return;
  if (p === '/setup') {
    if (!semContas) return redir(res, '/login');
    if (m === 'GET') return html(res, 200, pagLogin('', true));
    const f = form(await lerCorpo(req, 10000));
    if (!f.email) return html(res, 400, pagLogin('Informe o e-mail.', true)); { const fr = SEG.senhaFraca(f.senha, f.email, f.nome); if (fr) return html(res, 400, pagLogin(fr, true)); }
    const c = { id: uid(), nome: f.nome || f.email, email: f.email.trim(), nivel: 'owner' };
    if (q.contaN.get().n !== 0) return redir(res, '/login');
    q.contaNova.run(c.id, c.nome, c.email, hashSenha(f.senha), 'owner', 1, Date.now(), 0, CORES[0]); abrirSessao(res, req, c); return redir(res, '/');
  }
  if (p === '/login') {
    if (semContas) return redir(res, '/setup');
    if (m === 'GET') return html(res, 200, pagLogin(''));
    const ip = ipDe(req);
    const f = form(await lerCorpo(req, 10000)), em = 'e:' + String(f.email || '').trim().toLowerCase().slice(0, 254);
    { const lim = END.loginAntes(ip); if (lim) return html(res, 429, pagLogin(lim)); }
    if (!(await END.loginEspera(em))) return html(res, 429, pagLogin('Muitas tentativas para este e-mail. Tente de novo em 1 minuto.'));
    const c = q.contaPorEmail.get(String(f.email || '').trim().slice(0, 254));
    if (!c || !c.hash) confere(String(f.senha || ''), HASH_FALSO);
    if (!c || !c.ativo || !confere(f.senha, c.hash)) { await END.loginFalhou(ip, em); return html(res, 401, pagLogin('E-mail ou senha incorretos.')); }
    END.loginOk(ip, em);
    if (SEG.precisaRefazer(c.hash)) try { db.prepare('UPDATE contas SET hash=? WHERE id=?').run(hashSenha(f.senha), c.id); } catch (e) { }
    if (c.totp) {
      { const ap = END.aparelhoValido(req, c); if (ap) { REG.auditar(c, req, 'LOGIN_APARELHO_CONFIAVEL', '/login', null, { aparelho: ap }); abrirSessao(res, req, c); return redir(res, '/'); } } /* v111 */
      const t2 = crypto.randomBytes(24).toString('base64url');
      db.prepare('DELETE FROM login2f WHERE conta=? OR expira<?').run(c.id, Date.now());
      db.prepare('INSERT INTO login2f(hash,conta,expira,n) VALUES(?,?,?,0)').run(SEG.sha(t2), c.id, Date.now() + 5 * 60000);
      res.setHeader('set-cookie', 'p2f=' + t2 + '; Path=/login; HttpOnly; SameSite=Lax; Max-Age=300' + (seguro(req) ? '; Secure' : ''));
      return html(res, 200, pagCodigo('', END.aparelhoElegivel(c)));
    }
    abrirSessao(res, req, c); return redir(res, '/');
  }
  if (p === '/login/codigo') {
    const t2 = cookies(req).p2f, reg = t2 ? db.prepare('SELECT * FROM login2f WHERE hash=?').get(SEG.sha(t2)) : null;
    const c = reg && reg.expira > Date.now() ? q.contaPorId.get(reg.conta) : null;
    if (!c || !c.ativo || !c.totp) return html(res, 401, pagLogin('O tempo para digitar o código acabou. Entre de novo.'));
    const confia = END.aparelhoElegivel(c);
    if (m === 'GET') return html(res, 200, pagCodigo('', confia));
    if (m !== 'POST') return json(res, 405, { erro: 'Método não permitido.' });
    const ip = ipDe(req), ti = tentativas.get(ip) || { n: 0, ate: 0 };
    if (ti.ate > Date.now()) return html(res, 429, pagLogin('Muitas tentativas. Aguarde alguns minutos.'));
    const f = form(await lerCorpo(req, 10000)); let ok = false, restam = -1;
    if (f.rec) { const hs = SEG.usarCodigoRec(c.rec, f.rec); if (hs) { db.prepare('UPDATE contas SET rec=? WHERE id=?').run(JSON.stringify(hs), c.id); ok = true; restam = hs.length; } }
    else { const ps = SEG.confereCodigo(c.totp, f.codigo, c.totp_ult); if (ps > 0) { db.prepare('UPDATE contas SET totp_ult=? WHERE id=?').run(ps, c.id); ok = true; } }
    if (!ok) {
      ti.n++; ti.em = Date.now(); if (ti.n >= 8) { ti.ate = Date.now() + 10 * 60000; ti.n = 0; } tentativas.set(ip, ti);
      const n = (reg.n || 0) + 1; await new Promise(r => setTimeout(r, 600));
      if (n >= 5) { db.prepare('DELETE FROM login2f WHERE hash=?').run(reg.hash); return html(res, 401, pagLogin('Muitos códigos errados. Entre de novo com e-mail e senha.')); }
      db.prepare('UPDATE login2f SET n=? WHERE hash=?').run(n, reg.hash); return html(res, 401, pagCodigo(f.rec ? 'Código de recuperação inválido ou já usado.' : 'Código incorreto. Confira o código que aparece agora no aplicativo.', confia));
    }
    db.prepare('DELETE FROM login2f WHERE hash=?').run(reg.hash); tentativas.delete(ip);
    const ckx = ['p2f=; Path=/login; Max-Age=0'];
    if (f.confiar === '1' && confia && !f.rec) { const ap = END.aparelhoEmitir(req, c); ckx.push(ap.cookie); REG.auditar(c, req, 'APARELHO_CONFIAVEL_NOVO', '/login/codigo', null, { aparelho: ap.id, ua: String(req.headers['user-agent'] || '').slice(0, 200) }); }
    abrirSessao(res, req, c, ckx);
    return redir(res, restam >= 0 ? '/conta/seguranca?' + (restam <= 3 ? 'e=1&' : '') + 'm=' + encodeURIComponent('Você entrou com um código de recuperação. Restam ' + restam + '.' + (restam <= 3 ? ' Gere códigos novos abaixo.' : '')) : '/');
  }
  if (p === '/sair') { const t = cookies(req).sid; if (t) q.sessDel.run(SEG.sha(t)); res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0'); return redir(res, '/login'); }
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
  /* ---- esqueci minha senha / criar senha pelo link do e-mail (sem login) ---- */
  if (p === '/esqueci') {
    const caixa = (corpo) => html(res, 200, pag('Esqueci minha senha', '<div class="card" style="max-width:420px;margin:40px auto"><h1>Esqueci minha senha</h1>' + corpo + '<p class="sub" style="margin:14px 0 0;text-align:center"><a href="/login">Voltar para o login</a></p></div>'));
    if (m === 'GET') return caixa(EMAIL.configurado()
      ? '<p class="sub">Digite o e-mail que você usa para entrar. Enviaremos um link para criar uma senha nova.</p><form method="post" action="/esqueci"><label>E-mail<input name="email" type="email" required autocomplete="username"></label><button class="pri" type="submit" style="width:100%">Enviar link</button></form>'
      : '<div class="msg err">O envio de e-mail ainda não foi configurado neste sistema. Peça a um administrador para definir uma senha nova para você em Usuários › Editar.</div>');
    if (m !== 'POST') return json(res, 405, { erro: 'Método não permitido.' });
    const f = form(await lerCorpo(req, 10000)), email = String(f.email || '').trim().toLowerCase().slice(0, 254), ip = ipDe(req);
    const lim = limiteEsqueci.get(ip) || { n: 0, ini: Date.now() }; if (Date.now() - lim.ini > 3600e3) { lim.n = 0; lim.ini = Date.now(); } lim.n++; limiteEsqueci.set(ip, lim);
    const le = limiteEsqueci.get('e:' + email) || { n: 0, ini: Date.now() }; if (Date.now() - le.ini > 3600e3) { le.n = 0; le.ini = Date.now(); } le.n++; limiteEsqueci.set('e:' + email, le);
    const c = email ? q.contaPorEmail.get(email) : null;
    if (c && c.ativo && c.email && lim.n <= 10 && le.n <= 3 && EMAIL.configurado()) enviarLink(c, 'redefinir').catch(e => console.error('[email] esqueci:', e.message));
    await new Promise(r => setTimeout(r, 500));
    return caixa('<div class="msg">Se este e-mail estiver cadastrado, você vai receber em alguns minutos um link para criar uma senha nova. Confira também a caixa de spam.</div>');
  }
  const mSenha = p.match(/^\/senha\/([A-Za-z0-9_-]{20,80})$/);
  if (mSenha) {
    const reg = db.prepare('SELECT * FROM tokens_senha WHERE hash=?').get(sha(mSenha[1])), c = reg && reg.expira > Date.now() ? q.contaPorId.get(reg.conta) : null;
    const caixa = (corpo) => html(res, 200, pag('Criar senha', '<div class="card" style="max-width:420px;margin:40px auto"><h1>' + (reg && reg.tipo === 'convite' ? 'Criar sua senha' : 'Criar nova senha') + '</h1>' + corpo + '</div>'));
    if (!c || !c.ativo) return caixa('<div class="msg err">Este link expirou ou já foi usado. Peça um novo em <a href="/esqueci">Esqueci minha senha</a> ou fale com um administrador.</div>');
    const formH = erro => caixa((erro ? '<div class="msg err">' + esc(erro) + '</div>' : '') + '<p class="sub">Conta: <b>' + esc(c.email) + '</b></p><form method="post"><label>Nova senha (mínimo 8 caracteres)<input name="senha" type="password" minlength="8" required autocomplete="new-password"></label><label>Repita a senha<input name="senha2" type="password" minlength="8" required autocomplete="new-password"></label><button class="pri" type="submit" style="width:100%">Salvar senha</button></form>');
    if (m === 'GET') return formH('');
    if (m !== 'POST') return json(res, 405, { erro: 'Método não permitido.' });
    const f = form(await lerCorpo(req, 10000));
    { const fr = SEG.senhaFraca(f.senha, c.email, c.nome); if (fr) return formH(fr); }
    if (f.senha !== f.senha2) return formH('As duas senhas não são iguais.');
    db.prepare('UPDATE contas SET hash=? WHERE id=?').run(hashSenha(f.senha), c.id);
    db.prepare('DELETE FROM tokens_senha WHERE conta=?').run(c.id); db.prepare('DELETE FROM sessoes WHERE conta=?').run(c.id); derrubarConexoes(c.id); END.aparelhosRevogarTodos(c.id);
    tentativas.delete('e:' + String(c.email || '').toLowerCase());
    return html(res, 200, pag('Senha criada', '<div class="card" style="max-width:420px;margin:40px auto"><h1>Senha salva</h1><div class="msg">Pronto. Agora entre com o seu e-mail e a senha nova.</div><a class="btn pri" href="/login" style="display:block;text-align:center">Ir para o login</a></div>'));
  }
  if (await REG.rotaPublica(p, m, req, res)) return; /* v111: pesquisa de satisfação respondida pelo cliente (link de uso único) */
  const conta = contaDa(req);
  if (!conta) { if (p.startsWith('/api/') || p.startsWith('/_blob/')) return json(res, 401, { erro: 'Entre novamente.' }); return redir(res, semContas ? '/setup' : '/login'); }
  if (await END.antes(req, res, conta, p, m, u)) return; /* 2FA obrigatória, reautenticação, bibliotecas locais, cota de anexos */

  /* ---- segurança da própria conta: duas etapas, aparelhos, senha ---- */
  if (p === '/conta/seguranca' && m === 'GET') return html(res, 200, pagSeguranca(conta, req, ...END.msg(u)));
  if (p.startsWith('/conta/seguranca/') && m === 'POST') {
    const acao = p.slice(17), f = form(await lerCorpo(req, 10000)), c = q.contaPorId.get(conta.id), volta = (t, e) => redir(res, '/conta/seguranca?' + (e ? 'e=1&' : '') + 'm=' + encodeURIComponent(t));
    const ip = ipDe(req), ti = tentativas.get('s:' + c.id) || { n: 0, ate: 0 };
    if (ti.ate > Date.now()) return volta('Muitas tentativas. Aguarde alguns minutos.', 1);
    const errou = t => { ti.n++; if (ti.n >= 6) { ti.ate = Date.now() + 10 * 60000; ti.n = 0; } ti.em = Date.now(); tentativas.set('s:' + c.id, ti); return volta(t, 1); };
    if (acao === 'iniciar') { if (c.totp) return volta('Já está ligada.'); db.prepare('INSERT OR REPLACE INTO totp_novo(conta,segredo,expira) VALUES(?,?,?)').run(c.id, SEG.novoSegredo(), Date.now() + 15 * 60000); return redir(res, '/conta/seguranca'); }
    if (acao === 'confirmar') {
      const nv = db.prepare('SELECT * FROM totp_novo WHERE conta=? AND expira>?').get(c.id, Date.now()); if (!nv) return volta('O tempo acabou. Comece de novo.', 1);
      const ps = SEG.confereCodigo(nv.segredo, f.codigo, 0); if (ps < 0) return errou('Código incorreto. Confira se o horário do celular está automático e digite o código que aparece agora.');
      const r = SEG.novosCodigosRec(); db.prepare('UPDATE contas SET totp=?, totp_ult=?, rec=? WHERE id=?').run(SEG.cifrarSegredo(nv.segredo), ps, JSON.stringify(r.hashes), c.id); db.prepare('DELETE FROM totp_novo WHERE conta=?').run(c.id);
      tentativas.delete('s:' + c.id); return html(res, 200, pagCodigosRec(conta, req, r.cods));
    }
    if (acao === 'rec') {
      if (!c.totp) return redir(res, '/conta/seguranca'); const ps = SEG.confereCodigo(c.totp, f.codigo, c.totp_ult); if (ps < 0) return errou('Código incorreto.');
      const r = SEG.novosCodigosRec(); db.prepare('UPDATE contas SET totp_ult=?, rec=? WHERE id=?').run(ps, JSON.stringify(r.hashes), c.id); return html(res, 200, pagCodigosRec(conta, req, r.cods));
    }
    if (acao === 'desligar') {
      if (!c.totp) return redir(res, '/conta/seguranca'); if (!confere(f.senha, c.hash)) return errou('Senha incorreta.');
      const ps = SEG.confereCodigo(c.totp, f.codigo, c.totp_ult); if (ps < 0) return errou('Código incorreto.');
      db.prepare('UPDATE contas SET totp=NULL, totp_ult=NULL, rec=NULL WHERE id=?').run(c.id); END.aparelhosRevogarTodos(c.id); return volta('Verificação em duas etapas desligada.');
    }
    if (acao === 'sair-outros') { db.prepare('DELETE FROM sessoes WHERE conta=? AND token<>?').run(c.id, SEG.sha(cookies(req).sid || '')); derrubarOutras(c.id, req); const nr = END.aparelhosRevogarTodos(c.id); if (nr) REG.auditar(conta, req, 'APARELHO_REVOGADO', '/conta/seguranca/sair-outros', null, { todos: nr }); return volta('Os outros aparelhos foram desconectados' + (nr ? ' e os aparelhos confiáveis revogados' : '') + '.'); }
    if (acao === 'aparelho-revogar') { const n = END.aparelhoRevogar(c.id, f.id); if (n) REG.auditar(conta, req, 'APARELHO_REVOGADO', '/conta/seguranca/aparelho-revogar', null, { aparelho: String(f.id || '').slice(0, 40) }); return volta(n ? 'Aparelho revogado: no próximo login nele o código será pedido.' : 'Aparelho não encontrado.', !n); }
    return redir(res, '/conta/seguranca');
  }

  /* ---- contas ---- */
  if (p === '/contas/backup-agora' && m === 'POST') {
    if (conta.nivel !== 'owner') return redir(res, '/contas');
    try { const b = await BACKUP.fazer('manual'); return redir(res, '/contas?m=' + encodeURIComponent('Cópia gravada: ' + b.nome)); } catch (e) { return redir(res, '/contas?e=1&m=' + encodeURIComponent('A cópia falhou: ' + e.message)); }
  }
  if (p.startsWith('/contas/backups/') && m === 'GET') {
    if (conta.nivel !== 'owner') { res.writeHead(404); return res.end(); }
    const f = BACKUP.arquivo(decodeURIComponent(p.slice(16))); if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': fs.statSync(f).size, 'content-disposition': 'attachment; filename="' + path.basename(f) + '"', 'cache-control': 'no-store' });
    return fs.createReadStream(f).pipe(res);
  }
  /* v127: Contas de acesso fica só com o dono (segurança dos logins); criar e editar usuários é em Sistema › Usuários */
  if (p === '/contas' && m === 'GET') { if (conta.nivel !== 'owner') return redir(res, gestorContas(conta) ? '/#usr' : '/'); return html(res, 200, pagContas(conta, ...END.msg(u))); }
  if (p === '/contas/salvar' && m === 'POST') {
    if (!gestorContas(conta)) return redir(res, '/');
    const f = form(await lerCorpo(req, 10000)), niv = ['admin', 'interact'].includes(f.nivel) ? f.nivel : 'interact';
    try {
      if (f.id) {
        const c = q.contaPorId.get(f.id); if (!c) throw 'Conta não encontrada.'; if (c.nivel === 'owner' && c.id !== conta.id) throw 'Só o dono altera a própria conta.'; if (protegida(conta, c)) throw 'Só o dono altera contas de nível Equipe.';
        if (f.email && f.email !== c.email && q.contaPorEmail.get(f.email)) throw 'Este e-mail já está em uso.';
        if (f.senha) { const fr = SEG.senhaFraca(f.senha, f.email || c.email, f.nome || c.nome); if (fr) throw fr; }
        if (f.senha) db.prepare('DELETE FROM sessoes WHERE conta=? AND token<>?').run(c.id, SEG.sha(cookies(req).sid || ''));
        db.prepare('UPDATE contas SET nome=coalesce(nullif(?,\'\'),nome), email=coalesce(nullif(?,\'\'),email), hash=coalesce(?,hash), nivel=? WHERE id=?').run(f.nome || '', (f.email || '').trim(), f.senha ? hashSenha(f.senha) : null, c.nivel === 'owner' ? 'owner' : niv, c.id);
      } else {
        if (!f.email || !f.senha) throw 'Informe e-mail e senha.'; { const fr = SEG.senhaFraca(f.senha, f.email, f.nome, END.minNivel(niv)); if (fr) throw fr; } if (q.contaPorEmail.get(f.email)) throw 'Este e-mail já está em uso.';
        q.contaNova.run(uid(), f.nome || f.email, f.email.trim(), hashSenha(f.senha), niv, 1, Date.now(), 0, CORES[Math.floor(Math.random() * CORES.length)]);
      }
      return redir(res, '/contas?m=' + encodeURIComponent('Conta salva.'));
    } catch (e) { return redir(res, '/contas?e=1&m=' + encodeURIComponent(String(e))); }
  }
  if (p === '/contas/editar' && m === 'POST') {
    if (!gestorContas(conta)) return redir(res, '/');
    const f = form(await lerCorpo(req, 10000)), c = q.contaPorId.get(f.id); if (!c || c.id === conta.id) return redir(res, '/contas'); if (protegida(conta, c) && f.acao !== 'soueu') return redir(res, '/contas?e=1&m=' + encodeURIComponent('Só o dono altera contas de nível Equipe.'));
    if (f.acao === 'desativar' && c.nivel !== 'owner') { db.prepare('UPDATE contas SET ativo=0 WHERE id=?').run(c.id); db.prepare('DELETE FROM sessoes WHERE conta=?').run(c.id); derrubarConexoes(c.id); }
    if (f.acao === 'ativar') db.prepare('UPDATE contas SET ativo=1 WHERE id=?').run(c.id);
    if (f.acao === 'tirar2f') { if (conta.nivel !== 'owner') return redir(res, '/contas?e=1&m=' + encodeURIComponent('Só o dono desliga a verificação em duas etapas de outra pessoa.')); db.prepare('UPDATE contas SET totp=NULL, totp_ult=NULL, rec=NULL WHERE id=?').run(c.id); db.prepare('DELETE FROM sessoes WHERE conta=?').run(c.id); derrubarConexoes(c.id); return redir(res, '/contas?m=' + encodeURIComponent('Verificação em duas etapas desligada. A pessoa entra só com a senha e pode ligar de novo.')); }
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
  if (p === '/contas/teste-email' && m === 'POST') {
    if (!gestorContas(conta)) return redir(res, '/');
    try { const t = EMAIL.modelo('Teste de e-mail', ['Se você recebeu esta mensagem, o envio de e-mail da Central de Gestão está funcionando.'], 'Abrir o sistema', APP_URL, 'Mensagem automática de teste.'); await EMAIL.enviar({ para: conta.email, assunto: 'Teste de e-mail · Central de Gestão', texto: t.texto, html: t.html }); return redir(res, '/contas?m=' + encodeURIComponent('E-mail de teste enviado para ' + conta.email + '. Confira a caixa de entrada e o spam.')); }
    catch (e) { return redir(res, '/contas?e=1&m=' + encodeURIComponent('Falha no envio: ' + e.message)); }
  }
  if (p === '/contas/senha' && m === 'POST') {
    const f = form(await lerCorpo(req, 10000)), c = q.contaPorId.get(conta.id);
    const volta = f.volta === 'seg' ? '/conta/seguranca' : '/contas';
    if (!confere(f.atual, c.hash)) return redir(res, volta + '?e=1&m=' + encodeURIComponent('Senha atual incorreta.'));
    { const fr = SEG.senhaFraca(f.nova, c.email, c.nome); if (fr) return redir(res, volta + '?e=1&m=' + encodeURIComponent(fr)); }
    db.prepare('UPDATE contas SET hash=? WHERE id=?').run(hashSenha(f.nova), c.id); db.prepare('DELETE FROM sessoes WHERE conta=? AND token<>?').run(c.id, SEG.sha(cookies(req).sid || '')); derrubarOutras(c.id, req); END.aparelhosRevogarTodos(c.id); return redir(res, volta + '?m=' + encodeURIComponent('Senha trocada. Os outros aparelhos foram desconectados.'));
  }
  if (p === '/migrar' && m === 'GET') { if (conta.nivel !== 'owner') return redir(res, '/'); return html(res, 200, pagMigrar(conta)); }

  /* ---- edição de contas pela tela Usuários (JSON, só administradores) ---- */
  if (p === '/api/contas' && m === 'POST') {
    if (!gestorContas(conta)) return json(res, 403, { erro: 'Apenas administradores.' });
    const b = await lerJson(req), nome = String(b.nome || '').trim().slice(0, 120), email = String(b.email || '').trim().toLowerCase().slice(0, 160), senha = String(b.senha || '');
    if (!nome) return json(res, 400, { erro: 'Informe o nome.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { erro: 'E-mail inválido.' });
    if (q.contaPorEmail.get(email)) return json(res, 400, { erro: 'Este e-mail já está em uso.' });
    const convite = !!b.convite;
    if (convite && !EMAIL.configurado()) return json(res, 400, { erro: 'O envio de e-mail não está configurado no servidor. Use a senha provisória.' });
    if (!convite) { const fr = SEG.senhaFraca(senha, email, nome, END.minNivel(b.nivel)); if (fr) return json(res, 400, { erro: fr }); }
    const id = uid(), niv = ['admin', 'interact'].includes(b.nivel) ? b.nivel : 'interact';
    q.contaNova.run(id, nome, email, convite ? null : hashSenha(senha), niv, 1, Date.now(), 0, CORES[Math.floor(Math.random() * CORES.length)]);
    if (!convite) return json(res, 200, { ok: true, id });
    try { await enviarLink({ id, nome, email }, 'convite'); return json(res, 200, { ok: true, id, convite: 'enviado' }); }
    catch (e) { return json(res, 200, { ok: true, id, convite: 'falhou', erroEmail: e.message }); }
  }
  if (p === '/api/email/status' && m === 'GET') { if (!gestorContas(conta)) return json(res, 403, { erro: 'Apenas administradores.' }); return json(res, 200, { configurado: EMAIL.configurado() }); }
  const mLink = p.match(/^\/api\/contas\/([A-Za-z0-9_-]{1,60})\/link$/);
  if (mLink && m === 'POST') {
    if (!gestorContas(conta)) return json(res, 403, { erro: 'Apenas administradores.' });
    const c = q.contaPorId.get(mLink[1]); if (!c) return json(res, 404, { erro: 'Conta não encontrada.' });
    if (c.nivel === 'owner' && c.id !== conta.id) return json(res, 403, { erro: 'Só o dono altera a própria conta.' });
    if (protegida(conta, c)) return json(res, 403, { erro: 'Só o dono altera contas de nível Equipe.' });
    if (!c.email) return json(res, 400, { erro: 'Esta conta não tem e-mail.' });
    try { await enviarLink(c, c.hash ? 'redefinir' : 'convite'); return json(res, 200, { ok: true }); } catch (e) { return json(res, 502, { erro: e.message }); }
  }
  const mConta = p.match(/^\/api\/contas\/([A-Za-z0-9_-]{1,60})$/);
  if (mConta) {
    if (!gestorContas(conta)) return json(res, 403, { erro: 'Apenas administradores.' });
    const c = q.contaPorId.get(mConta[1]); if (!c) return json(res, 404, { erro: 'Conta não encontrada no servidor.' });
    if (m === 'GET') return json(res, 200, { id: c.id, nome: c.nome || '', email: c.email || '', nivel: c.nivel, ativo: !!c.ativo });
    if (m === 'POST') {
      const b = await lerJson(req), nome = String(b.nome || '').trim().slice(0, 120), email = String(b.email || '').trim().toLowerCase().slice(0, 160), senha = String(b.senha || '');
      if (c.nivel === 'owner' && c.id !== conta.id) return json(res, 403, { erro: 'Só o dono altera a própria conta.' });
      if (protegida(conta, c)) return json(res, 403, { erro: 'Só o dono altera contas de nível Equipe.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { erro: 'E-mail inválido.' });
      if (email && email !== String(c.email || '').toLowerCase()) { const o = q.contaPorEmail.get(email); if (o && o.id !== c.id) return json(res, 400, { erro: 'Este e-mail já está em uso.' }); }
      if (senha) { const fr = SEG.senhaFraca(senha, email || c.email, nome || c.nome); if (fr) return json(res, 400, { erro: fr }); }
      const niv = c.nivel === 'owner' ? 'owner' : (['admin', 'interact'].includes(b.nivel) ? b.nivel : c.nivel);
      const ativo = c.nivel === 'owner' || c.id === conta.id ? 1 : (b.ativo === false ? 0 : 1);
      db.prepare('UPDATE contas SET nome=coalesce(nullif(?,\'\'),nome), email=coalesce(nullif(?,\'\'),email), hash=coalesce(?,hash), nivel=?, ativo=? WHERE id=?').run(nome, email, senha ? hashSenha(senha) : null, niv, ativo, c.id);
      if (!ativo || senha) db.prepare('DELETE FROM sessoes WHERE conta=? AND token<>?').run(c.id, SEG.sha(cookies(req).sid || ''));
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
    if (m === 'GET') { if (!pode(conta, dp, 'r')) return json(res, 403, { code: 'not_granted' }); const r = q.docGet.get(dp), dd = r ? JSON.parse(r.data) : null, vis = r && podeVer(conta, dp, dd, new Map()); if (vis && REG.ehSaude(dp.split('/')[0]) && dp.split('/').length === 2) REG.registrarLeitura(conta, req, dp.split('/')[0], [dp.split('/')[1]], 'registro'); return json(res, 200, vis ? { exists: true, data: redigir(conta, dp, dd), ts: r.ts } : { exists: false }); }
    if (!pode(conta, dp, 'w') || !perfilPermite(conta, dp, 'w')) return json(res, 403, { code: 'not_granted', erro: 'Seu perfil não permite alterar estes dados.' });
    const seg = dp.split('/'), parent = seg.slice(0, -1).join('/'), id = seg[seg.length - 1], ts = Date.now();
    const r0 = q.docGet.get(dp), velho = r0 ? JSON.parse(r0.data) : null;
    let data = null;
    if (m !== 'DELETE') {
      const corpo = await lerJson(req); data = corpo.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { code: 'invalid_argument', erro: 'Dados inválidos.' });
      if (m === 'PATCH') { if (!r0) return json(res, 404, { code: 'invalid_argument', erro: 'Documento não existe.' }); data = Object.assign(JSON.parse(r0.data), data); }
      if (Object.prototype.hasOwnProperty.call(data, 'id') && data.id !== id) data.id = id;
      data = preservarFunc(conta, dp, data);
      { const rt = rtcPreparar(conta, dp, velho, data); if (rt.erro) return json(res, rt.st, { code: 'invalid_argument', erro: rt.erro }); data = rt.data; } /* v116 */
    }
    if (!gravacaoPermitida(conta, dp) && !REG.excecaoGravacao(conta, dp, velho, data, m)) {
      try { permLogPut.run(new Date().toISOString().slice(0, 10), conta.id, perfilDe(conta), dp.split('/')[0], Date.now()); } catch (e) { }
      if (MODO_GRAV === 'bloquear') { REG.auditar(conta, req, m + '_NEGADO', dp, null, null); return json(res, 403, { code: 'not_granted', erro: 'Seu perfil não grava neste módulo. Peça a um administrador.' }); }
    }
    /* regras do servidor: aprovações, dados bancários, competência fechada, assinaturas, remessa (regras.js) */
    const v = m === 'DELETE' ? REG.antesExcluir(conta, dp, velho, req) : REG.antesGravar(conta, dp, velho, data, req);
    if (v && v.reauth) { REG.auditar(conta, req, m + '_PEDE_SENHA', dp, null, null); if (END.exigirReauth(req, res)) return; } /* v111: gerar remessa pede a senha de novo */
    if (v && v.erro) { REG.auditar(conta, req, m + '_RECUSADO', dp, null, { erro: v.erro }); return json(res, v.st || 403, { code: v.st === 409 ? 'failed_precondition' : v.st === 400 ? 'invalid_argument' : 'not_granted', erro: v.erro }); }
    if (m === 'DELETE') { q.docDel.run(dp); avisarDoc('del', dp, null, ts); REG.depois(conta, req, m, dp, velho, null, null); return json(res, 200, { ok: true }); }
    data = v.data;
    const txt = JSON.stringify(data); if (txt.length > 4 * 1024 * 1024) return json(res, 413, { code: 'invalid_argument', erro: 'Documento grande demais.' });
    q.docPut.run(dp, parent, id, txt, ts); avisarDoc('set', dp, data, ts); REG.depois(conta, req, m, dp, velho, data, v); return json(res, 200, { ok: true, ts });
  }
  if (p === '/api/db/col' && m === 'GET') {
    const cp = String(u.searchParams.get('path') || ''); if (!validPath(cp, false)) return json(res, 400, { code: 'invalid_argument', erro: 'Caminho inválido.' });
    const memo = new Map(), rows = q.colGet.all(cp).map(r => ({ id: r.id, data: JSON.parse(r.data), ts: r.ts })).filter(r => podeVer(conta, cp + '/' + r.id, r.data, memo)).map(r => Object.assign(r, { data: redigir(conta, cp + '/' + r.id, r.data) }));
    if (rows.length && REG.ehSaude(cp)) REG.registrarLeitura(conta, req, cp, rows.map(r => r.id), 'lista'); /* v112: leitura de dados de saúde (uma linha por pessoa, coleção e dia) */
    return json(res, 200, { docs: rows });
  }
  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const cid = uid(12); CONEX.set(cid, { res, conta, sess: SEG.sha(cookies(req).sid || ''), presence: {}, updatedAt: Date.now() }); sse(res, 'hello', { cid }); avisarPares();
    req.on('close', () => { CONEX.delete(cid); avisarPares(); }); return;
  }
  if (p === '/api/room/presence' && m === 'POST') { const b = await lerJson(req), c = CONEX.get(b.cid); if (JSON.stringify(b.patch || {}).length > 4096) return json(res, 413, { erro: 'Presença grande demais.' }); if (c && c.conta.id === conta.id) { const pr = Object.assign({}, c.presence); Object.keys(b.patch || {}).forEach(k => { if (b.patch[k] === null) delete pr[k]; else pr[k] = b.patch[k]; }); c.presence = pr; c.updatedAt = Date.now(); avisarPares(); } return json(res, 200, { ok: true }); }
  if (p === '/api/rtc/ice' && m === 'GET') return json(res, 200, iceServers(conta)); /* v116 */
  if (p === '/api/assets' && m === 'POST') {
    if (NIV[conta.nivel] < NIV.interact) return json(res, 403, { code: 'not_granted' });
    const b = await lerCorpo(req, MAX_BLOB).catch(e => { throw Object.assign(e, { code: 'too_large' }); }), id = uid(32).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(32, '0').slice(0, 32), ct = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    fs.writeFileSync(path.join(DATA, 'blobs', id), b); q.arqNovo.run(id, ct, b.length, conta.id, Date.now());
    return json(res, 200, { id, url: '/_blob/' + id, sizeBytes: b.length, contentType: ct });
  }
  /* anexos: lista só para o dono; exclusão só por quem enviou ou pelo dono (vai para a lixeira); leitura conforme o registro de origem (regras.js) */
  if (p === '/api/assets' && m === 'GET') return REG.listarAnexos(conta, res);
  if (p.startsWith('/api/assets/') && m === 'DELETE') return REG.excluirAnexo(conta, req, res, p.split('/').pop().replace(/[^A-Za-z0-9_-]/g, ''));
  if (p.startsWith('/_blob/')) return REG.servirBlob(conta, req, res, p.slice(7).replace(/[^A-Za-z0-9_-]/g, ''));
  /* consulta de CNPJ pelo servidor (dados públicos da Receita: BrasilAPI e CNPJ.ws), com cache de 24 h */
  const mCnpj = p.match(/^\/api\/cnpj\/(brasilapi|cnpjws)\/(\d{14})$/);
  if (mCnpj && m === 'GET') {
    const chave = mCnpj[1] + mCnpj[2], ca = cacheCnpj.get(chave);
    if (ca && Date.now() - ca.em < 864e5) { res.writeHead(ca.st, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return res.end(ca.corpo); }
    const ip = ipDe(req), lim = limitePub.get('cnpj:' + ip) || { n: 0, ini: Date.now() }; if (Date.now() - lim.ini > 3600e3) { lim.n = 0; lim.ini = Date.now(); } lim.n++; limitePub.set('cnpj:' + ip, lim);
    if (lim.n > 300) return json(res, 429, { erro: 'Muitas consultas nesta hora.' });
    const url = mCnpj[1] === 'brasilapi' ? 'https://brasilapi.com.br/api/cnpj/v1/' + mCnpj[2] : 'https://publica.cnpj.ws/cnpj/' + mCnpj[2];
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'CentralGestao/1.0' }, signal: AbortSignal.timeout(10000) });
      const corpo = await r.text(), st = r.status === 404 ? 404 : r.ok ? 200 : 502;
      if (st !== 502) { cacheCnpj.set(chave, { st, corpo, em: Date.now() }); if (cacheCnpj.size > 5000) cacheCnpj.delete(cacheCnpj.keys().next().value); }
      res.writeHead(st, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return res.end(st === 502 ? JSON.stringify({ erro: 'Consulta indisponível (' + r.status + ').' }) : corpo);
    } catch (e) { return json(res, 502, { erro: 'Consulta indisponível agora.' }); }
  }
  if (p === '/api/ia' && m === 'POST') {
    if (NIV[conta.nivel] < NIV.interact) return json(res, 403, { code: 'not_granted', erro: 'Sem permissão para usar a IA.' });
    const ui0 = usoIa.get(conta.id) || { n: 0, ini: Date.now() }; if (Date.now() - ui0.ini > 3600e3) { ui0.n = 0; ui0.ini = Date.now(); } ui0.n++; usoIa.set(conta.id, ui0);
    if (ui0.n > (NIV[conta.nivel] >= NIV.admin ? 120 : 30)) return json(res, 429, { code: 'rate_limited', erro: 'Limite de uso da IA nesta hora atingido.' });
  }
  if (p === '/api/ia' && m === 'POST') { /* v112 (B9): o uso fica na auditoria (quem, quando, função, tamanho), sem o conteúdo */
    let corpo = {}; try { corpo = await lerJson(req); const r = await ia(Object.assign({}, corpo, { nivel: NIV[conta.nivel] })); REG.auditarIa(conta, req, corpo, true); return json(res, 200, r); }
    catch (e) { REG.auditarIa(conta, req, corpo, false, e.msg || e.message); return json(res, e.st || 500, { code: e.code || (e.st === 503 ? 'capability_disabled' : 'upstream_error'), erro: e.msg || 'Falha na IA.' }); } }
  /* v114: perfil personalizado usa as integrações pelo módulo: ponto (com dados de RH), contas bancárias (com dados bancários), notas fiscais */
  const dcu = defConta(conta), cu = dcu && dcu.custom ? dcu : null, cuW = g => !!cu && cu.w.includes(g), cuR = g => !!cu && (cu.w.includes(g) || cu.r.includes(g));
  if (p.startsWith('/api/solides/') && !perfilEm(conta, ['admin', 'rh']) && !(cuW('ponto') && cu.sensRh)) return json(res, 403, { code: 'not_granted', erro: 'Seu perfil não permite usar a integração de ponto.' });
  if (p.startsWith('/api/bancos/') && !perfilEm(conta, ['admin', 'financeiro']) && !(cuW('contas') && cu.banco)) return json(res, 403, { code: 'not_granted', erro: 'Seu perfil não permite usar o extrato automático.' });
  /* v123: ambiente fiscal (homologação/produção) e busca automática na SEFAZ. Ler: quem lê notas; alterar: só Administrador ou dono,
     com a senha confirmada (reauth) e trilha de auditoria. O conector só aceita a alteração com o cabeçalho x-fiscal-config, que o
     repasse genérico /api/fiscal/* não envia. */
  if (p === '/api/fiscal-config' && (m === 'GET' || m === 'POST')) {
    const leitor = perfilEm(conta, ['admin', 'financeiro', 'fiscal', 'projetos', 'leitura', 'leituratotal']) || cuR('nf'), admin = conta.nivel === 'owner' || perfilEm(conta, ['admin']);
    const chamar = (corpo, grava) => fetch(FISCAL_URL + '/tool/config', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'x-fiscal-token': FISCAL_TOKEN, 'x-usuario': encodeURIComponent(conta.nome || conta.email || conta.id) }, grava ? { 'x-fiscal-config': '1' } : {}), body: JSON.stringify(corpo || {}), signal: AbortSignal.timeout(30000) }).then(async r => ({ st: r.status, j: await r.json().catch(() => ({})) }));
    if (m === 'GET') {
      if (!leitor) return json(res, 403, { code: 'not_granted', erro: 'Seu perfil não permite ver a configuração fiscal.' });
      if (!FISCAL_URL) return json(res, 503, { code: 'capability_disabled', erro: 'Conector fiscal não configurado (FISCAL_URL).', podeAlterar: admin });
      try { const r = await chamar({}, false); return json(res, r.st === 200 ? 200 : 502, Object.assign({}, r.j, { podeAlterar: admin })); }
      catch (e) { return json(res, 502, { erro: 'O conector fiscal não respondeu. Confira se o serviço está no ar.', podeAlterar: admin }); }
    }
    let b = {}; try { b = await lerJson(req); } catch (e) { return json(res, 400, { code: 'invalid_argument', erro: 'JSON inválido.' }); }
    if (!admin) { REG.auditar(conta, req, 'FISCAL_CONFIG_NEGADO', 'fiscal/config', null, { pedido: b }); return json(res, 403, { code: 'not_granted', erro: 'Só o Administrador ou o dono altera o ambiente fiscal e a busca automática.' }); }
    const CAMPOS = ['ambiente', 'nfe_dist', 'nfse', 'auto', 'auto_ciencia', 'restaurar'];
    if (!b || typeof b !== 'object' || Array.isArray(b) || !Object.keys(b).length || Object.keys(b).some(k => !CAMPOS.includes(k))) return json(res, 400, { code: 'invalid_argument', erro: 'Configuração inválida.' });
    if (!END.reautenticado(req)) { REG.auditar(conta, req, 'FISCAL_CONFIG_PEDE_SENHA', 'fiscal/config', null, { pedido: b }); if (END.exigirReauth(req, res)) return; }
    if (!FISCAL_URL) return json(res, 503, { code: 'capability_disabled', erro: 'Conector fiscal não configurado (FISCAL_URL).' });
    try {
      const a0 = await chamar({}, false), r = await chamar(b, true), antes = a0.j && a0.j.config || null;
      if (r.st !== 200 || !r.j || !r.j.ok) { REG.auditar(conta, req, 'FISCAL_CONFIG_RECUSADO', 'fiscal/config', antes, { pedido: b, erro: (r.j && (r.j.msg || r.j.erro)) || ('HTTP ' + r.st) }); return json(res, r.st === 200 ? 400 : 502, { code: 'invalid_argument', erro: (r.j && (r.j.msg || r.j.erro)) || 'O conector fiscal recusou a configuração.' }); }
      REG.auditar(conta, req, 'FISCAL_CONFIG', 'fiscal/config', antes, r.j.config);
      return json(res, 200, Object.assign({}, r.j, { podeAlterar: true }));
    } catch (e) { REG.auditar(conta, req, 'FISCAL_CONFIG_FALHA', 'fiscal/config', null, { pedido: b }); return json(res, 502, { erro: 'O conector fiscal não respondeu. Confira se o serviço está no ar.' }); }
  }
  /* v123: a configuração do conector não passa pelo repasse genérico (sem senha nem auditoria) */
  if (p.startsWith('/api/fiscal/') && /^\/tool\/config\b/i.test(p.slice('/api/fiscal'.length).replace(/\/{2,}/g, '/'))) return json(res, 403, { code: 'not_granted', erro: 'Use Sistema › Configurações › Notas fiscais: ambiente e busca na SEFAZ.' });
  if (p.startsWith('/api/fiscal/') && !perfilEm(conta, ['admin', 'financeiro', 'fiscal', 'projetos', 'leitura', 'leituratotal']) && !cuR('nf')) return json(res, 403, { code: 'not_granted', erro: 'Seu perfil não permite acessar as notas fiscais.' });
  /* conector fiscal: consultar (GET) para quem lê notas; emitir, cancelar e demais ações só Administrador, Financeiro e Fiscal */
  if (p.startsWith('/api/fiscal/') && m !== 'GET' && m !== 'HEAD' && !perfilEm(conta, ['admin', 'financeiro', 'fiscal']) && !cuW('nf')) return json(res, 403, { code: 'not_granted', erro: 'Seu perfil só consulta as notas fiscais; emitir ou cancelar fica com Administrador, Financeiro ou Fiscal.' });
  if (p.startsWith('/api/fiscal/')) {
    if (!FISCAL_URL) return json(res, 503, { erro: 'Conector fiscal não configurado (FISCAL_URL).' });
    if (NIV[conta.nivel] < NIV.admin) return json(res, 403, { erro: 'Apenas administradores.' });
    const corpo = m === 'GET' ? undefined : await lerCorpo(req, 5 * 1024 * 1024);
    try {
      const r = await fetch(FISCAL_URL + p.slice('/api/fiscal'.length) + u.search, { method: m, headers: { 'content-type': req.headers['content-type'] || 'application/json', 'x-fiscal-token': FISCAL_TOKEN, 'x-usuario': encodeURIComponent(conta.nome || conta.email || conta.id) }, body: corpo && corpo.length ? corpo : undefined, signal: AbortSignal.timeout(180000) });
      const b = Buffer.from(await r.arrayBuffer()), ctf = r.headers.get('content-type') || 'application/json', ehJson = /^application\/json/i.test(ctf);
      res.writeHead(r.status, Object.assign({ 'content-type': ctf, 'content-length': b.length, 'cache-control': 'no-store' }, ehJson ? {} : { 'content-disposition': 'attachment', 'content-security-policy': "default-src 'none'; sandbox" })); return res.end(b);
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
    z.fechar(); fs.unlinkSync(tmp); perfilMapa = null; perfcRecarregar(); blobMemo.clear();
    for (const c of CONEX.values()) sse(c.res, 'recarregar', {});
    return json(res, 200, { docs: nd, arquivos: na, contas: nc });
  }
  if (p === '/api/admin/exportar' && m === 'GET') {
    if (conta.nivel !== 'owner') return json(res, 403, { erro: 'Apenas o dono.' });
    const docs = db.prepare('SELECT path,data FROM docs').all().map(r => ({ path: r.path, data: JSON.parse(r.data) }));
    const b = zlib.gzipSync(Buffer.from(JSON.stringify({ versao: 1, em: Date.now(), docs })));
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="backup-banco-' + new Date().toISOString().slice(0, 10) + '.json.gz"', 'content-length': b.length }); return res.end(b);
  }
  if (await REG.rota(p, m, req, res, conta, u)) return;
  if (await solidesRota(p, m, req, res, conta, u)) return;
  if (await bancosRota(p, m, req, res, conta, u)) return;
  if (await ARQF.rota(p, m, req, res, conta, u)) return; /* v129: arquivo fiscal (arquivofiscal.js) */
  if (await CAIXA.rota(p, m, req, res, conta, u)) return; /* v130: caixa nfe@ (caixanfe.js) */
  /* ---- arquivos do sistema ---- */
  if (m === 'GET') {
    if (p === '/' || p === '/index.html') return estatico(req, res, 'index.html');
    if (estatico(req, res, decodeURIComponent(p.slice(1)))) return;
  }
  json(res, 404, { erro: 'Não encontrado.' });
}

/* regras de negócio aplicadas pelo servidor (aprovações, bancos, competência, anexos, auditoria...) */
const REG = require('./regras.js')({ db, q, json, html, lerJson, lerCorpo, avisarDoc, perfilDe, perfilEm, NIV, EMAIL, ipDe, PERM, APP_URL, esc, pag, DATA, uid, cookies, SEG, SENS_RH, PERF_RH,
  papelDe, veRh, perfcCompilar, perfcGrupoValido, PERFC_ID, PERF_BASE, PERFC_PROIBIDOS, perfaCompilar, perfaBaseOk, perfaEditavel, PERFA_ID, PERFA_SISTEMA, /* v127 */
  pode, perfilPermite, podeVer, gravacaoPermitida, veFuncCompleto, END, contaDa, BACKUP });
/* v111: a sincronização da Sólides não grava ponto (pmmes) de mês travado (Fontes do ponto) nem de competência fechada; o que foi ignorado vai para a auditoria */
const solIgnorados = new Set();
const solQ = Object.assign({}, q, { docPut: { run: (dp, parent, id, txt, ts) => { if (/^pmmes\//.test(dp) && REG.pontoTravado(dp, txt)) { solIgnorados.add(dp); return { changes: 0 }; } return q.docPut.run(dp, parent, id, txt, ts); } } });
const solAvisar = (op, p, data, ts) => { if (solIgnorados.has(p)) { solIgnorados.delete(p); return; } avisarDoc(op, p, data, ts); };
const solidesRota = require('./solides.js')({ q: solQ, db, avisarDoc: solAvisar, json, lerJson, NIV });
const bancosRota = require('./bancos.js')({ q, db, avisarDoc, json, lerJson, NIV });
/* ===== v129: arquivo fiscal (XML das NF-e guardado no servidor, prazo de guarda, ligação com contas a pagar/receber) ===== */
const ARQF = require('./arquivofiscal.js')({ db, q, json, lerCorpo, avisarDoc, perfilDe, papelDe, PERM, END, DATA, uid, FISCAL_URL, FISCAL_TOKEN, auditar: (...a) => REG.auditar(...a) });
/* ===== fim v129 ===== */
/* ===== v130: leitura da caixa nfe@ (Microsoft 365 / Graph): NF-e anexadas vão para o arquivo fiscal (origem "email") ===== */
const CAIXA = require('./caixanfe.js')({ db, json, lerCorpo, perfilDe, papelDe, uid, ARQF, auditar: (...a) => REG.auditar(...a) });
/* ===== fim v130 ===== */
const srv = http.createServer((req, res) => { rotear(req, res).catch(e => { if (!res.headersSent) json(res, e.st || 500, { erro: e.msg || 'Erro interno.' }); else try { res.end(); } catch (x) { } if (!e.st) console.error(e); }); });
srv.requestTimeout = 600000; srv.headersTimeout = 65000; srv.keepAliveTimeout = 61000;
srv.listen(PORT, () => console.log('Central de Gestão no ar na porta ' + PORT + ' · dados em ' + DATA + (FISCAL_URL ? ' · conector fiscal ' + FISCAL_URL : '') + (AI_KEY ? ' · IA ligada' : '') + (process.env.SOLIDES_TOKEN ? ' · Sólides ligada' : '') + (process.env.M365_CLIENT_ID ? ' · caixa nfe@ ligada' : '')));
module.exports = { srv, db };

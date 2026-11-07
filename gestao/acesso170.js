'use strict';
/* v170 (relatorios/feito_v170.md): Controle de acesso no servidor. Ligado em regras.js por v170/ed_v170.py.
   Regras em acesso170c.js (funções puras); nuvem Tuya em tuya170.js.
   - O servidor é a fonte da verdade. A "Ponte de acesso" (deploy/ponte-acesso/, um mini PC na rede de cada local) liga PARA
     o servidor (HTTPS, espera longa em GET /api/ponte170/sync), com um token por ponte criado aqui (revogável). Nenhuma porta é
     aberta na empresa. Ela recebe o estado desejado de cada controlador Intelbras CT 3000 em mudanças numeradas (versão),
     aplica, responde o que aplicou e os erros (POST /api/ponte170/aplicado) e manda os eventos guardados com id próprio
     (POST /api/ponte170/eventos: o mesmo id nunca entra duas vezes). Os controladores seguem funcionando sem internet com a
     lista que já têm.
   - Comandos para a ponte: abrir porta e "ler crachá" (próximo crachá apresentado num leitor, até 30 s).
   - Tuya (fechadura do almoxarifado de SP e relé do portão de Tuiuti): direto da nuvem Tuya (tuya170.js).
   - Tabelas próprias (nada vai pela leitura comum /api/db/col): ac170_doc (cadastros: cfg, ponte, disp, ponto, grupo, cracha,
     vis), ac170_tok (hash do token de cada ponte), ac170_est (estado mandado por controlador e versão), ac170_meta,
     ac170_ev (registro de acessos; guardado ACESSO_LOG_DIAS, padrão 365), ac170_cmd, ac170_alerta.
   - Quem faz o quê: Administrador (e dono) e o perfil "Segurança patrimonial / controle de acesso" (segpat) cuidam de tudo
     (ou um perfil que grave "ac170cad" no módulo Controle de acesso); quem grava "ac170cr" (padrão: RH) cuida dos crachás;
     os responsáveis de cada local (configuração) recebem os alertas, veem o registro e abrem os pontos do local; o almoxarife
     vê só o registro dos pontos do almoxarifado em que é responsável ou substituto (v153). Abrir pelo sistema: o colaborador
     ligado ao usuário cujo grupo de acesso permite "abrir pelo sistema", dentro do horário do grupo. O portão de veículos
     também abre pela saída do veículo (v165), para o condutor daquela saída. Tudo fica na auditoria.
   - Os eventos de acesso NÃO são registro oficial de ponto (só comparação). */
const crypto = require('node:crypto');
const K = require('./acesso170c.js'), F165 = require('./frota165.js'), T166 = require('./terc166.js');
module.exports = function (X) {
  const { db, q, col, doc, erro, ehDono, perfilEm, gravaGrupo, cfgEmp, lerJson, json, ipDe } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const nomeConta = id => { try { return X.nomeConta(id); } catch (e) { return id || ''; } };
  const TUYA = X.tuya || require('./tuya170.js')();
  const ID_OK = /^[\w\-.|~@+=:]{1,120}$/;
  const agoraBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 16), hojeBr = () => agoraBr().slice(0, 10);
  const brTs = ts => { const d = new Date(+ts - 3 * 3600e3).toISOString(); return d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) + ' ' + d.slice(11, 16); };
  const novoId = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const sha = t => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
  const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 200);
  const LOG_DIAS = () => Math.min(3650, Math.max(30, Math.round(+process.env.ACESSO_LOG_DIAS || 365)));

  /* ---------- tabelas ---------- */
  db.exec(`CREATE TABLE IF NOT EXISTS ac170_doc(k TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER, PRIMARY KEY(k, id));
CREATE TABLE IF NOT EXISTS ac170_tok(hash TEXT PRIMARY KEY, ponte TEXT NOT NULL, criado INTEGER, por TEXT, revogado INTEGER, revPor TEXT, ult INTEGER, ip TEXT);
CREATE TABLE IF NOT EXISTS ac170_est(disp TEXT NOT NULL, k TEXT NOT NULL, data TEXT, ver INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(disp, k));
CREATE INDEX IF NOT EXISTS ac170_est_ver ON ac170_est(ver);
CREATE TABLE IF NOT EXISTS ac170_meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS ac170_ev(id TEXT PRIMARY KEY, ts INTEGER NOT NULL, recebido INTEGER, local TEXT, ponto TEXT, disp TEXT, porta INTEGER, ponte TEXT, uid TEXT, pt TEXT, pid TEXT, nome TEXT, tipo TEXT, res TEXT, metodo TEXT, motivo TEXT, origem TEXT, conta TEXT);
CREATE INDEX IF NOT EXISTS ac170_ev_ts ON ac170_ev(ts);
CREATE TABLE IF NOT EXISTS ac170_cmd(id TEXT PRIMARY KEY, ponte TEXT, tipo TEXT, dados TEXT, criado INTEGER, ate INTEGER, st TEXT, res TEXT, por TEXT, fim INTEGER);
CREATE TABLE IF NOT EXISTS ac170_alerta(id TEXT PRIMARY KEY, ts INTEGER, local TEXT, ponto TEXT, tipo TEXT, txt TEXT, chave TEXT UNIQUE, enviados INTEGER, visto INTEGER, vistoPor TEXT);`);
  const st = {
    dGet: db.prepare('SELECT data FROM ac170_doc WHERE k=? AND id=?'), dAll: db.prepare('SELECT id, data FROM ac170_doc WHERE k=?'),
    dPut: db.prepare('INSERT INTO ac170_doc(k,id,data,ts) VALUES(?,?,?,?) ON CONFLICT(k,id) DO UPDATE SET data=excluded.data, ts=excluded.ts'),
    tokIns: db.prepare('INSERT INTO ac170_tok(hash,ponte,criado,por) VALUES(?,?,?,?)'), tokGet: db.prepare('SELECT * FROM ac170_tok WHERE hash=?'),
    tokRev: db.prepare('UPDATE ac170_tok SET revogado=?, revPor=? WHERE ponte=? AND revogado IS NULL'), tokUlt: db.prepare('UPDATE ac170_tok SET ult=?, ip=? WHERE hash=?'),
    tokDe: db.prepare('SELECT hash, criado, por, revogado, revPor, ult, ip FROM ac170_tok WHERE ponte=? ORDER BY criado DESC LIMIT 10'),
    estDe: db.prepare('SELECT k, data, ver, del FROM ac170_est WHERE disp=?'), estPut: db.prepare('INSERT INTO ac170_est(disp,k,data,ver,del) VALUES(?,?,?,?,?) ON CONFLICT(disp,k) DO UPDATE SET data=excluded.data, ver=excluded.ver, del=excluded.del'),
    estDesde: db.prepare('SELECT k, data, ver, del FROM ac170_est WHERE disp=? AND ver>? ORDER BY ver'), estVivos: db.prepare('SELECT k, data, ver FROM ac170_est WHERE disp=? AND del=0'),
    mGet: db.prepare('SELECT v FROM ac170_meta WHERE k=?'), mPut: db.prepare('INSERT INTO ac170_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
    evIns: db.prepare('INSERT OR IGNORE INTO ac170_ev(id,ts,recebido,local,ponto,disp,porta,ponte,uid,pt,pid,nome,tipo,res,metodo,motivo,origem,conta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    cmdIns: db.prepare('INSERT INTO ac170_cmd(id,ponte,tipo,dados,criado,ate,st,por) VALUES(?,?,?,?,?,?,?,?)'), cmdGet: db.prepare('SELECT * FROM ac170_cmd WHERE id=?'),
    cmdPend: db.prepare("SELECT * FROM ac170_cmd WHERE ponte=? AND st IN ('pendente','enviado') AND ate>? ORDER BY criado"), cmdMarca: db.prepare("UPDATE ac170_cmd SET st='enviado' WHERE id=? AND st='pendente'"),
    cmdFim: db.prepare("UPDATE ac170_cmd SET st=?, res=?, fim=? WHERE id=? AND st IN ('pendente','enviado')"),
    alIns: db.prepare('INSERT OR IGNORE INTO ac170_alerta(id,ts,local,ponto,tipo,txt,chave,enviados) VALUES(?,?,?,?,?,?,?,?)')
  };
  const dget = (k, id) => { const r = st.dGet.get(k, String(id || '')); try { return r ? JSON.parse(r.data) : null; } catch (e) { return null; } };
  const dall = k => st.dAll.all(k).map(r => { try { return Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { return null; } }).filter(Boolean);
  const dput = (k, d) => { st.dPut.run(k, d.id, JSON.stringify(d), Date.now()); return d; };
  const meta = (k, d) => { const r = st.mGet.get(k); return r ? r.v : d; };
  const cfg = () => K.cfgPad(dget('cfg', 'geral') || {});

  /* ---------- contexto do núcleo ---------- */
  function ctx() {
    const ag = agoraBr(), C = cfg(), ce = cfgEmp(), Xc = { cfg: C, hoje: ag.slice(0, 10), agora: ag };
    const lazy = (o, k, fn) => { let v = null; Object.defineProperty(o, k, { enumerable: true, get: () => v || (v = fn()) }); };
    [['func', 'func'], ['tterc', 'tterc'], ['usr', 'usr'], ['vaut', 'vaut165'], ['vsai', 'vsai'], ['afast', 'afast'], ['rhdoc', 'rhdoc'], ['integ', 'integ'], ['veic', 'veic'], ['almox', 'almox']].forEach(([k, c]) => lazy(Xc, k, () => col(c)));
    [['pontos', 'ponto'], ['disps', 'disp'], ['pontes', 'ponte'], ['crachas', 'cracha'], ['grupos', 'grupo'], ['vis', 'vis']].forEach(([k, c]) => lazy(Xc, k, () => dall(c)));
    lazy(Xc, 'f165', () => ({ cfg: F165.cfgPad(ce.frota165), hoje: Xc.hoje, agora: ag, vaut: Xc.vaut, vsai: Xc.vsai, afast: Xc.afast, func: Xc.func, veic: Xc.veic, mig: doc('cfg/frota165mig') }));
    lazy(Xc, 't166', () => { const o = { cfg: ce, hoje: Xc.hoje }; [['ter', 'ter166'], ['tdc', 'tdc166'], ['tdoc', 'tdoc'], ['tterc', 'tterc'], ['ctremp', 'ctremp'], ['medemp', 'medemp'], ['loc', 'loc166'], ['leq', 'leq166'], ['rdo', 'rdo'], ['notas', 'notas'], ['tnl', 'tnl166'], ['integ', 'integ'], ['proj', 'proj'], ['lanc', 'lanc']].forEach(([k, c]) => lazy(o, k, () => col(c))); return o; });
    return Xc;
  }

  /* ---------- papéis ---------- */
  const admin = c => ehDono(c) || perfilEm(c, ['admin']);
  const segpat = c => !!c && !ehDono(c) && perfilEm(c, ['segpat']);
  const gestor = c => admin(c) || segpat(c) || X.gravaCol(c, 'ac170cad');
  const crachaW = c => gestor(c) || X.gravaCol(c, 'ac170cr');
  const respLocais = (c, C) => (C || cfg()).locais.filter(l => ((C || cfg()).resp[l.id] || []).includes(c.id)).map(l => l.id);
  /* pontos do almoxarifado de que a pessoa é responsável ou substituta (v153) */
  const almoxPontos = (c, Xc) => { const als = new Set(Xc.almox.filter(a => a && (a.respUid === c.id || a.substUid === c.id)).map(a => a.id)); return Xc.pontos.filter(p => p.almoxId && als.has(p.almoxId)).map(p => p.id); };
  /* registro de acessos: null = tudo; Set = só estes pontos; sem nada = sem acesso */
  function escopoLog(c, Xc) {
    if (gestor(c)) return null;
    const ls = new Set(respLocais(c, Xc.cfg)), ids = new Set(Xc.pontos.filter(p => ls.has(p.local)).map(p => p.id));
    if (X.leModulo(c, 'ac170ev')) almoxPontos(c, Xc).forEach(i => ids.add(i));
    return ids;
  }
  const funcDaConta = (c, Xc) => (Xc.func || []).find(f => f.usrId === c.id && f.status !== 'desligado') || null;

  /* ---------- avisos e alertas ---------- */
  function avisarChat(uids, texto) {
    const ag = Date.now(); let n = 0;
    for (const u of K.uniq(uids).filter(x => /^[\w\-.|~@+=]{1,200}$/.test(x) && x !== 'sistema')) {
      try {
        const cid = 'av_' + u, cp = 'cm/sistema/c/' + cid;
        if (!q.docGet.get(cp)) { const cv = { id: cid, tipo: 'dm', membros: [u], ts: ag, sistema: true }; q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(cv), ag); X.avisarDoc('set', cp, cv, ag); }
        const mid = 'm' + ag.toString(36) + crypto.randomBytes(4).toString('hex'), mp = 'cm/sistema/m/' + mid;
        const msg = { id: mid, k: 'msg', conv: 'sistema/' + cid, txt: '🔐 ' + texto, ts: ag, men: [], sistema: true, v170: 1 };
        q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(msg), ag); X.avisarDoc('set', mp, msg, ag); n++;
      } catch (e) { console.error('[v170] chat:', e.message); }
    }
    return n;
  }
  const admins = () => col('usr').filter(u => u && u.uid && u.perfil === 'admin').map(u => u.uid).slice(0, 10);
  function alertar(local, ponto, tipo, texto, chave) {
    const C = cfg(), para = (C.resp[local] && C.resp[local].length) ? C.resp[local] : admins(), id = novoId('al');
    const r = st.alIns.run(id, Date.now(), local || '', ponto || '', tipo, texto, chave || id, para.length);
    if (!r.changes) return false;
    const ln = K.localDe(C, local); avisarChat(para, 'Controle de acesso' + (ln ? ' — ' + ln.nome : '') + ': ' + texto);
    return true;
  }

  /* ---------- estado desejado e versões ---------- */
  const espera = new Set();
  function acordar() { for (const w of [...espera]) { espera.delete(w); try { w(); } catch (e) { } } }
  function recalc() {
    const Xc = ctx(), est = K.estadoDesejado(Xc, F165, T166), ativos = new Set(Object.keys(est));
    let ver = +meta('ver', '0') || 0; const ver0 = ver;
    db.exec('BEGIN');
    try {
      for (const d of Xc.disps) {
        const atual = new Map(st.estDe.all(d.id).map(r => [r.k, r])), novo = ativos.has(d.id) ? K.chaves(est[d.id]) : {};
        for (const [k, v] of Object.entries(novo)) { const j = JSON.stringify(v), a = atual.get(k); if (!a || a.del || a.data !== j) st.estPut.run(d.id, k, j, ++ver, 0); }
        for (const [k, a] of atual) if (!a.del && !(k in novo)) st.estPut.run(d.id, k, a.data, ++ver, 1);
      }
      if (ver !== ver0) st.mPut.run('ver', String(ver));
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } console.error('[v170] recalc:', e.message); return ver0; }
    if (ver !== ver0) acordar();
    return ver;
  }
  /* controlador que mudou de ponte: tudo dele vai de novo (versões novas) */
  function renumera(dispId) {
    let ver = +meta('ver', '0') || 0; db.exec('BEGIN');
    try { for (const r of st.estDe.all(dispId)) st.estPut.run(dispId, r.k, r.data, ++ver, r.del); st.mPut.run('ver', String(ver)); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } }
  }
  let tRecalc = null;
  const sujo = () => { if (tRecalc) return; tRecalc = setImmediate(() => { tRecalc = null; try { recalc(); } catch (e) { console.error('[v170]', e.message); } }); };
  const COLS_PESSOA = new Set(['func', 'tterc', 'usr', 'vaut165', 'afast', 'rhdoc', 'integ', 'ter166', 'tdc166', 'tdoc', 'cfg', 'vsai']);
  function depois(conta, req, metodo, p) { const c0 = String(p || '').split('/')[0]; if (COLS_PESSOA.has(c0)) sujo(); }

  /* ---------- pessoas (para as telas) ---------- */
  function pessoaPub(Xc, t, reg, comAcesso) {
    const o = { t, id: reg.id, nome: K.s(reg.nome), cpf: K.mascCpf(reg.cpf), funcao: K.s(reg.funcao || reg.cargo || ''), extra: t === 'terc' ? K.s((doc('parc/' + reg.parcId) || {}).nome || '') : t === 'vis' ? K.s(reg.empresa || '') : '' };
    if (t === 'func') o.sit = reg.status || 'ativo';
    if (comAcesso) { const a = K.acesso(Xc, t, reg.id, F165, T166); o.bloqueios = a.bloqueios.map(b => b.txt); o.recusados = a.recusados.map(r => ({ ponto: r.pontoId, txt: r.txt })); o.pontos = [...a.pontos.keys()]; }
    return o;
  }
  const pessoasTodas = Xc => Xc.func.filter(f => f.status !== 'desligado' || Xc.crachas.some(c => c.pt === 'func' && c.pid === f.id)).map(f => ['func', f]).concat(Xc.tterc.filter(t => t.ativo !== false || Xc.crachas.some(c => c.pt === 'terc' && c.pid === t.id)).map(t => ['terc', t]));
  const dispPub = (d, Xc) => {
    const pt = d.ponteId ? Xc.pontes.find(p => p.id === d.ponteId) : null, sd = pt && pt.dispSt ? pt.dispSt[d.id] : null, lim = cfg().alerta.offlineMin * 60e3;
    const on = K.ehTuya(d) ? (d.st ? !!d.st.online : null) : (sd && pt && Date.now() - (pt.ult || 0) < lim ? !!sd.online : sd ? false : null);
    return { id: d.id, nome: d.nome, tipo: d.tipo, local: d.local, ponteId: d.ponteId || '', ip: d.ip || '', tuyaId: d.tuyaId || '', codigo: d.codigo || '', pulsoMs: d.pulsoMs || '', ativo: d.ativo !== false, online: on, erro: (sd && sd.erro) || (d.st && d.st.erro) || '', ult: (sd && sd.em) || (d.st && d.st.em) || 0, aplicado: sd && sd.ver || 0, portas: K.portasDe(d.tipo) };
  };
  const pontePub = (p, C) => { const lim = C.alerta.offlineMin * 60e3, toks = st.tokDe.all(p.id); return { id: p.id, nome: p.nome, local: p.local, ativo: p.ativo !== false, ult: p.ult || 0, online: !!p.ult && Date.now() - p.ult < lim, ip: p.ip || '', versaoProg: p.versaoProg || '', aplicado: p.verAplicada || 0, versao: +meta('ver', '0') || 0, erros: (p.erros || []).slice(0, 20), token: toks.some(t => !t.revogado) ? 'ativo' : 'revogado', tokens: toks.map(t => ({ id: t.hash.slice(0, 10), criado: t.criado, por: nomeConta(t.por), revogado: t.revogado || null, ult: t.ult || null })) }; };

  /* ---------- modelo das telas ---------- */
  function modelo(c) {
    const Xc = ctx(), C = Xc.cfg, g = gestor(c), cw = crachaW(c), esc = escopoLog(c, Xc), rl = respLocais(c, C);
    if (!g && !cw && esc && !esc.size && !funcDaConta(c, Xc)) return erro('Sem acesso ao Controle de acesso.');
    const ve = g || cw || rl.length > 0 || !!(esc && esc.size) || esc === null; /* quem vê o cadastro (o colaborador comum vê só os botões Abrir) */
    const m = { ok: true, papel: { admin: admin(c), gestor: g, cracha: cw, log: esc === null || esc.size > 0, resp: rl, tuya: TUYA.configurado() }, cfg: g || cw ? C : { locais: C.locais, alerta: C.alerta, feriados: [], resp: {}, bloq: {} }, hoje: Xc.hoje, agora: Xc.agora, logDias: LOG_DIAS(),
      tipos: { ponto: K.TIPOS_PONTO, disp: K.TIPOS_DISP }, pontos: !ve ? [] : (g || cw) ? Xc.pontos.map(p => Object.assign({}, p)) : Xc.pontos.filter(p => rl.includes(p.local) || (esc && esc.has(p.id))).map(p => ({ id: p.id, nome: p.nome, local: p.local, tipo: p.tipo })),
      disps: g || cw ? Xc.disps.map(d => dispPub(d, Xc)) : [], almox: g ? Xc.almox.map(a => ({ id: a.id, nome: a.nome || a.id, cidade: a.cidade || '' })) : [] };
    if (g || cw) m.pontes = Xc.pontes.map(p => pontePub(p, C));
    if (g || rl.length) m.vis = Xc.vis.filter(v => g || (v.pontos || []).some(id => rl.includes((Xc.pontos.find(p => p.id === id) || {}).local))).map(v => Object.assign({}, v, { anfNome: nomeConta(v.anfitriao), cracha: (Xc.crachas.find(x => x.pt === 'vis' && x.pid === v.id) || {}).uid || '' }));
    if (g) { m.grupos = Xc.grupos; m.perfis = Object.entries((X.PERM() || {}).perfis || {}).map(([k, p]) => [k, (p && p.nome) || k]); m.funcoes = K.uniq(Xc.func.filter(f => f.status !== 'desligado').map(f => K.s(f.funcao || f.cargo))).sort(); }
    if (g || cw) {
      m.crachas = Xc.crachas.map(x => Object.assign({}, x, { nome: K.pessoaNome(Xc, x.pt, x.pid), porNome: nomeConta(x.por) }));
      m.pessoas = pessoasTodas(Xc).map(([t, r]) => pessoaPub(Xc, t, r, true));
      /* leitores: ver abaixo */
    }
    if (g || cw || rl.length) m.leitores = Xc.disps.filter(d => K.ehCt(d) && d.ativo !== false && d.ponteId).flatMap(d => Array.from({ length: K.portasDe(d.tipo) }, (_, i) => { const p = Xc.pontos.find(x => x.dispId === d.id && +x.porta === i + 1 && x.ativo !== false); return { disp: d.id, porta: i + 1, nome: d.nome + ' · porta ' + (i + 1) + (p ? ' (' + p.nome + ')' : '') }; }));
    if (g || rl.length) m.usuarios = col('usr').filter(u => u && u.uid).map(u => ({ id: u.uid, nome: nomeConta(u.uid), perfil: u.perfil || '' })).sort((a, b) => a.nome.localeCompare(b.nome));
    if (m.papel.log) m.alertas = db.prepare('SELECT * FROM ac170_alerta ORDER BY ts DESC LIMIT 200').all().filter(a => esc === null || !a.ponto ? (esc === null || rl.includes(a.local)) : esc.has(a.ponto)).slice(0, 50);
    /* o que eu abro pelo sistema agora (botões "Abrir") */
    m.abrir = Xc.pontos.filter(p => p.ativo !== false && p.remoto !== false).map(p => { const r = motivoAbrir(c, Xc, p); return { id: p.id, nome: p.nome, local: p.local, pode: !r, motivo: r || '' }; }).filter(x => x.pode || ve);
    return m;
  }

  /* =================================================================== cadastros */
  const LOCAL_OK = (C, l) => C.locais.some(x => x.id === l);
  function rotaCfg(c, req, b) {
    if (!(admin(c) || segpat(c))) return erro('Só o Administrador ou a Segurança patrimonial altera a configuração do controle de acesso.');
    const antes = dget('cfg', 'geral'), n = K.cfgPad(b.cfg || {}), us = new Set(col('usr').map(u => u.uid));
    Object.keys(n.resp).forEach(l => { n.resp[l] = n.resp[l].filter(u => us.has(u)); });
    dput('cfg', Object.assign({ id: 'geral' }, n)); auditar(c, req, 'AC170_CFG', 'ac170/cfg', antes, n); sujo();
    return { ok: true, msg: 'Configuração salva.', cfg: n };
  }
  function rotaPonte(c, req, b) {
    if (!gestor(c)) return erro('Só o Administrador ou a Segurança patrimonial cadastra pontes.');
    const C = cfg(), id = b.id ? String(b.id) : novoId('pn'), ant = b.id ? dget('ponte', id) : null;
    if (b.id && !ant) return erro('Ponte não encontrada.', 404);
    const nome = txt(b.nome, 60); if (nome.length < 2) return erro('Dê um nome à ponte (ex.: Mini PC São Paulo).', 400);
    if (!LOCAL_OK(C, b.local)) return erro('Escolha o local.', 400);
    const p = Object.assign({}, ant || { id, criado: Date.now(), por: c.id }, { nome, local: b.local, ativo: b.ativo !== false });
    dput('ponte', p); auditar(c, req, ant ? 'AC170_PONTE_ALTERADA' : 'AC170_PONTE_NOVA', 'ac170/ponte/' + id, null, { nome, local: p.local });
    if (!ant) { const t = novoToken(c, id); return { ok: true, msg: 'Ponte cadastrada. Copie o token agora: ele não aparece de novo.', id, token: t }; }
    return { ok: true, msg: 'Ponte salva.', id };
  }
  function novoToken(c, ponteId) { const t = 'pa_' + crypto.randomBytes(32).toString('base64url'); st.tokRev.run(Date.now(), c.id, ponteId); st.tokIns.run(sha(t), ponteId, Date.now(), c.id); return t; }
  function rotaToken(c, req, b, revogar) {
    if (!gestor(c)) return erro('Só o Administrador ou a Segurança patrimonial mexe no token da ponte.');
    const p = dget('ponte', b.id); if (!p) return erro('Ponte não encontrada.', 404);
    if (revogar) { const r = st.tokRev.run(Date.now(), c.id, p.id); auditar(c, req, 'AC170_TOKEN_REVOGADO', 'ac170/ponte/' + p.id, null, { n: r.changes }); acordar(); return { ok: true, msg: 'Token revogado: a ponte não conecta mais até receber um token novo.' }; }
    const t = novoToken(c, p.id); auditar(c, req, 'AC170_TOKEN_NOVO', 'ac170/ponte/' + p.id, null, null); acordar();
    return { ok: true, msg: 'Token novo gerado (o anterior foi revogado). Copie agora: ele não aparece de novo.', token: t };
  }
  function rotaDisp(c, req, b) {
    if (!gestor(c)) return erro('Só o Administrador ou a Segurança patrimonial cadastra dispositivos.');
    const C = cfg(), id = b.id ? String(b.id) : novoId('dp'), ant = b.id ? dget('disp', id) : null; if (b.id && !ant) return erro('Dispositivo não encontrado.', 404);
    const tipo = String(b.tipo || ''); if (!K.TIPOS_DISP.some(t => t[0] === tipo)) return erro('Tipo de dispositivo inválido.', 400);
    if (!LOCAL_OK(C, b.local)) return erro('Escolha o local.', 400);
    const nome = txt(b.nome, 60); if (nome.length < 2) return erro('Dê um nome ao dispositivo.', 400);
    const d = Object.assign({}, ant || { id, criado: Date.now() }, { nome, tipo, local: b.local, ativo: b.ativo !== false });
    if (K.ehCt(d)) {
      const pt = dget('ponte', b.ponteId); if (!pt) return erro('Escolha a ponte de acesso que fala com este controlador.', 400);
      if (pt.local !== d.local) return erro('A ponte é de outro local.', 400);
      d.ponteId = pt.id; d.ip = txt(b.ip, 60); delete d.tuyaId;
      const usadas = dall('ponto').filter(p => p.dispId === id && p.ativo !== false && +p.porta > K.portasDe(tipo)); if (usadas.length) return erro('Este modelo tem ' + K.portasDe(tipo) + ' porta(s); há pontos ligados a portas acima disso.', 409);
    } else {
      const ti = String(b.tuyaId || '').trim(); if (!/^[A-Za-z0-9_-]{6,64}$/.test(ti)) return erro('Informe o id do aparelho na nuvem Tuya (Tuya IoT Platform › Devices).', 400);
      d.tuyaId = ti; d.ponteId = ''; d.codigo = /^[a-z0-9_]{2,40}$/.test(String(b.codigo || '')) ? b.codigo : 'switch_1'; d.pulsoMs = Math.min(10000, Math.max(200, +b.pulsoMs || 1000));
    }
    dput('disp', d); if (ant && ant.ponteId !== d.ponteId) renumera(d.id);
    auditar(c, req, ant ? 'AC170_DISP_ALTERADO' : 'AC170_DISP_NOVO', 'ac170/disp/' + id, null, { nome, tipo, local: d.local, ponte: d.ponteId || '' }); sujo();
    return { ok: true, msg: 'Dispositivo salvo.', id };
  }
  function rotaPonto(c, req, b) {
    if (!gestor(c)) return erro('Só o Administrador ou a Segurança patrimonial cadastra pontos de acesso.');
    const C = cfg(), id = b.id ? String(b.id) : novoId('pt'), ant = b.id ? dget('ponto', id) : null; if (b.id && !ant) return erro('Ponto não encontrado.', 404);
    const nome = txt(b.nome, 60); if (nome.length < 2) return erro('Dê um nome ao ponto (ex.: Almoxarifado Tuiuti).', 400);
    if (!LOCAL_OK(C, b.local)) return erro('Escolha o local.', 400);
    const tipo = String(b.tipo || 'porta'); if (!K.TIPOS_PONTO.some(t => t[0] === tipo)) return erro('Tipo de ponto inválido.', 400);
    const p = Object.assign({}, ant || { id, criado: Date.now() }, { nome, local: b.local, tipo, reaproveita: !!b.reaproveita, nota: txt(b.nota, 300), almoxId: b.almoxId && doc('almox/' + b.almoxId) ? String(b.almoxId) : '', remoto: b.remoto !== false, abertaSeg: b.abertaSeg ? Math.min(3600, Math.max(5, Math.round(+b.abertaSeg))) : '', ativo: b.ativo !== false, dispId: '', porta: '' });
    if (b.dispId) {
      const d = dget('disp', b.dispId); if (!d) return erro('Dispositivo não encontrado.', 400);
      if (d.local !== p.local) return erro('O dispositivo é de outro local.', 400);
      p.dispId = d.id; p.porta = K.ehCt(d) ? Math.round(+b.porta || 0) : 1;
      if (K.ehCt(d) && !(p.porta >= 1 && p.porta <= K.portasDe(d.tipo))) return erro('Escolha a porta do controlador (1 a ' + K.portasDe(d.tipo) + ').', 400);
      if (p.ativo && dall('ponto').some(o => o.id !== id && o.ativo !== false && o.dispId === d.id && +o.porta === +p.porta)) return erro('Esta porta do dispositivo já está ligada a outro ponto.', 409);
    }
    dput('ponto', p); auditar(c, req, ant ? 'AC170_PONTO_ALTERADO' : 'AC170_PONTO_NOVO', 'ac170/ponto/' + id, null, { nome, tipo, disp: p.dispId, porta: p.porta }); sujo();
    return { ok: true, msg: 'Ponto de acesso salvo.', id };
  }
  function rotaGrupo(c, req, b) {
    if (!gestor(c)) return erro('Só o Administrador ou a Segurança patrimonial cadastra grupos de acesso.');
    const id = b.id ? String(b.id) : novoId('gr'), ant = b.id ? dget('grupo', id) : null; if (b.id && !ant) return erro('Grupo não encontrado.', 404);
    const nome = txt(b.nome, 80); if (nome.length < 2) return erro('Dê um nome ao grupo.', 400);
    const pts = new Set(dall('ponto').map(p => p.id)), pontos = K.uniq((b.pontos || []).map(String)).filter(p => pts.has(p));
    if (!pontos.length) return erro('Escolha ao menos um ponto de acesso.', 400);
    const faixas = K.faixasOk(b.faixas); if (!b.sempre && !faixas.length) return erro('Informe o horário (dias e faixa) ou marque "sempre".', 400);
    const pessoas = (Array.isArray(b.pessoas) ? b.pessoas : []).filter(p => p && ['func', 'terc'].includes(p.t) && ID_OK.test(String(p.id || ''))).map(p => ({ t: p.t, id: String(p.id) })).slice(0, 500);
    const g = Object.assign({}, ant || { id, criado: Date.now() }, { nome, pontos, faixas, sempre: !!b.sempre, feriados: b.feriados === 'libera' ? 'libera' : 'bloqueia', funcoes: K.uniq((b.funcoes || []).map(x => txt(x, 80))).slice(0, 50), perfis: K.uniq((b.perfis || []).map(String)).slice(0, 30), pessoas, condutores: !!b.condutores, terceiros: !!b.terceiros, remoto: !!b.remoto, ativo: b.ativo !== false });
    dput('grupo', g); auditar(c, req, ant ? 'AC170_GRUPO_ALTERADO' : 'AC170_GRUPO_NOVO', 'ac170/grupo/' + id, ant, g); sujo();
    return { ok: true, msg: 'Grupo de acesso salvo.', id };
  }

  /* =================================================================== crachás */
  const proxN = () => { const n = (+meta('crachaN', '100') || 100) + 1; st.mPut.run('crachaN', String(n)); return n; };
  function novoCracha(c, req, Xc, pt, pid, uid, de, ate, origem) {
    const r = { id: novoId('cr'), uid, pt, pid, n: proxN(), st: 'ativo', em: Date.now(), por: c.id, origem: origem || 'digitado', de: de || '', ate: ate || '', hist: [{ em: Date.now(), por: c.id, o: 'Crachá ' + uid + ' entregue (' + (origem === 'leitor' ? 'lido no leitor' : 'digitado') + ')' }] };
    dput('cracha', r); return r;
  }
  function rotaCracha(c, req, b) {
    if (!crachaW(c)) return erro('Seu perfil não cuida de crachás.');
    const Xc = ctx(), uid = K.uidNorm(b.uid), pt = String(b.pt || ''), pid = String(b.pid || '');
    if (!['func', 'terc'].includes(pt)) return erro('Escolha a pessoa (colaborador ou trabalhador terceiro).', 400);
    const reg = K.pessoaReg(Xc, pt, pid); if (!reg) return erro('Pessoa não encontrada.', 404);
    if (pt === 'func' && reg.status === 'desligado') return erro('Colaborador desligado não recebe crachá.', 409);
    if (!uid) return erro('UID do crachá inválido: 8, 14 ou 20 caracteres hexadecimais (MIFARE de 4, 7 ou 10 bytes).', 400);
    const ja = K.crachaAtivo(Xc, pt, pid); if (ja) return erro('Esta pessoa já tem um crachá ativo (' + ja.uid + '). Use "Perdido" ou "Substituir".', 409);
    const outro = Xc.crachas.find(x => x.uid === uid && x.st === 'ativo'); if (outro) return erro('Este crachá já está ativo para ' + K.pessoaNome(Xc, outro.pt, outro.pid) + '.', 409);
    const r = novoCracha(c, req, Xc, pt, pid, uid, '', '', b.origem === 'leitor' ? 'leitor' : 'digitado');
    auditar(c, req, 'AC170_CRACHA_NOVO', 'ac170/cracha/' + r.id, null, { uid, pessoa: pt + ':' + pid }); recalc();
    return { ok: true, msg: 'Crachá cadastrado: vale na próxima sincronização da ponte.', id: r.id };
  }
  function rotaCrachaSit(c, req, b) {
    if (!crachaW(c)) return erro('Seu perfil não cuida de crachás.');
    const r = dget('cracha', b.id); if (!r) return erro('Crachá não encontrado.', 404); if (r.st !== 'ativo') return erro('Este crachá não está ativo.', 409);
    const acao = String(b.acao || ''), mot = txt(b.motivo, 200), Xc = ctx();
    if (acao === 'substituir') {
      const uid = K.uidNorm(b.uid); if (!uid) return erro('UID do crachá novo inválido.', 400); if (uid === r.uid) return erro('É o mesmo crachá.', 400);
      const outro = Xc.crachas.find(x => x.uid === uid && x.st === 'ativo'); if (outro) return erro('O crachá novo já está ativo para ' + K.pessoaNome(Xc, outro.pt, outro.pid) + '.', 409);
      r.st = 'substituido'; r.fim = Date.now(); r.motivo = mot || 'substituído'; r.hist = (r.hist || []).concat([{ em: Date.now(), por: c.id, o: 'Substituído por ' + uid + (mot ? ': ' + mot : '') }]).slice(-30); dput('cracha', r);
      const n = novoCracha(c, req, Xc, r.pt, r.pid, uid, r.de, r.ate, b.origem === 'leitor' ? 'leitor' : 'digitado'); n.anterior = r.id; dput('cracha', n);
      auditar(c, req, 'AC170_CRACHA_SUBSTITUIDO', 'ac170/cracha/' + r.id, { uid: r.uid }, { uid, novo: n.id, motivo: mot }); recalc();
      return { ok: true, msg: 'Crachá substituído: o antigo deixa de abrir na próxima sincronização.', id: n.id };
    }
    if (!['perdido', 'devolvido', 'cancelado'].includes(acao)) return erro('Ação inválida.', 400);
    if (acao === 'perdido' && mot.length < 3) return erro('Conte o que aconteceu (perda, roubo, quebra).', 400);
    r.st = acao; r.fim = Date.now(); r.motivo = mot; r.hist = (r.hist || []).concat([{ em: Date.now(), por: c.id, o: ({ perdido: 'Perdido', devolvido: 'Devolvido', cancelado: 'Cancelado' })[acao] + (mot ? ': ' + mot : '') }]).slice(-30);
    dput('cracha', r); auditar(c, req, 'AC170_CRACHA_' + acao.toUpperCase(), 'ac170/cracha/' + r.id, null, { uid: r.uid, motivo: mot }); recalc();
    return { ok: true, msg: 'Crachá ' + acao + ': deixa de abrir na próxima sincronização.' };
  }

  /* =================================================================== visitantes */
  const mascDoc = d => { const x = String(d || '').replace(/\W/g, ''); return x ? '***' + x.slice(-3) : ''; };
  function rotaVis(c, req, b) {
    const C = cfg(); if (!(gestor(c) || respLocais(c, C).length)) return erro('Só a Segurança patrimonial, o Administrador ou o responsável do local registra visitantes.');
    const nome = txt(b.nome, 80); if (nome.length < 3) return erro('Informe o nome do visitante.', 400);
    const de = String(b.de || '').slice(0, 16), ate = String(b.ate || '').slice(0, 16); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ate) || ate <= de) return erro('Informe a validade (de e até, com hora).', 400);
    if (Date.parse(ate + ':00Z') - Date.parse(de + ':00Z') > 31 * 864e5) return erro('A visita vale no máximo 31 dias.', 400);
    const anf = String(b.anfitriao || ''); if (!col('usr').some(u => u.uid === anf)) return erro('Escolha o anfitrião (quem recebe).', 400);
    const motivo = txt(b.motivo, 200); if (motivo.length < 3) return erro('Informe o motivo da visita.', 400);
    const pts = dall('ponto'), pontos = K.uniq((b.pontos || []).map(String)).filter(p => pts.some(x => x.id === p)); if (!pontos.length) return erro('Escolha os pontos que o visitante pode usar.', 400);
    if (!gestor(c)) { const ls = respLocais(c, C); if (pontos.some(p => !ls.includes((pts.find(x => x.id === p) || {}).local))) return erro('Você é responsável só por ' + ls.join(', ') + '.'); }
    const modo = b.modo === 'remoto' ? 'remoto' : 'cracha', Xc = ctx();
    let uid = ''; if (modo === 'cracha') { uid = K.uidNorm(b.uid); if (!uid) return erro('Informe o UID do crachá temporário (ou escolha "abertura pelo sistema").', 400); const o = Xc.crachas.find(x => x.uid === uid && x.st === 'ativo'); if (o) return erro('Este crachá já está ativo para ' + K.pessoaNome(Xc, o.pt, o.pid) + '.', 409); }
    const v = { id: novoId('vi'), nome, doc: mascDoc(b.doc), empresa: txt(b.empresa, 80), anfitriao: anf, motivo, de, ate, pontos, modo, st: 'ativa', em: Date.now(), por: c.id };
    dput('vis', v); if (uid) novoCracha(c, req, Xc, 'vis', v.id, uid, de, ate, b.origem === 'leitor' ? 'leitor' : 'digitado');
    auditar(c, req, 'AC170_VISITA_NOVA', 'ac170/vis/' + v.id, null, { nome, anfitriao: anf, de, ate, pontos, modo }); recalc();
    if (anf !== c.id) avisarChat([anf], 'Visita registrada para você: ' + nome + (v.empresa ? ' (' + v.empresa + ')' : '') + ', de ' + K.br(de) + ' ' + de.slice(11) + ' a ' + K.br(ate) + ' ' + ate.slice(11) + '. Motivo: ' + motivo + '.' + (modo === 'remoto' ? ' Você abre a porta para o visitante em Controle de acesso › Visitantes.' : ''));
    return { ok: true, msg: 'Visita registrada.', id: v.id };
  }
  function rotaVisFim(c, req, b) {
    const v = dget('vis', b.id); if (!v) return erro('Visita não encontrada.', 404);
    if (!(gestor(c) || v.anfitriao === c.id || respLocais(c).length)) return erro('Sem permissão.');
    v.st = 'encerrada'; v.fim = Date.now(); dput('vis', v);
    dall('cracha').filter(x => x.pt === 'vis' && x.pid === v.id && x.st === 'ativo').forEach(x => { x.st = 'devolvido'; x.fim = Date.now(); x.hist = (x.hist || []).concat([{ em: Date.now(), por: c.id, o: 'Visita encerrada' }]); dput('cracha', x); });
    auditar(c, req, 'AC170_VISITA_ENCERRADA', 'ac170/vis/' + v.id, null, null); recalc();
    return { ok: true, msg: 'Visita encerrada: o crachá temporário deixa de abrir.' };
  }

  /* =================================================================== abrir pelo sistema */
  /* '' = pode; senão o motivo */
  function motivoAbrir(c, Xc, p, visId) {
    if (!p || p.ativo === false) return 'Ponto inativo.';
    if (p.remoto === false) return 'Este ponto não abre pelo sistema.';
    if (!p.dispId) return 'Ponto sem dispositivo ligado.';
    if (visId) {
      const v = Xc.vis.find(x => x.id === visId); if (!v || v.st !== 'ativa') return 'Visita não encontrada ou encerrada.';
      if (!(v.de <= Xc.agora && Xc.agora < v.ate)) return 'Fora da validade da visita.';
      if (!(v.pontos || []).includes(p.id)) return 'A visita não inclui este ponto.';
      if (!(gestor(c) || v.anfitriao === c.id || respLocais(c, Xc.cfg).includes(p.local))) return 'Só o anfitrião, o responsável do local ou a Segurança patrimonial abre para o visitante.';
      return '';
    }
    if (gestor(c)) return '';
    if (respLocais(c, Xc.cfg).includes(p.local)) return '';
    const f = funcDaConta(c, Xc); if (!f) return 'Seu usuário não está ligado a um colaborador (Pessoal › Colaboradores › usuário do sistema).';
    return K.podeAbrirPessoa(Xc, f.id, p.id, F165, T166);
  }
  function ev(o) {
    const id = o.id || novoId('ev');
    return st.evIns.run(id, o.ts || Date.now(), Date.now(), o.local || '', o.ponto || '', o.disp || '', +o.porta || 0, o.ponte || '', o.uid || '', o.pt || '', o.pid || '', txt(o.nome, 80), o.tipo || 'acesso', o.res || '', o.metodo || '', txt(o.motivo, 300), o.origem || '', o.conta || '').changes > 0;
  }
  async function esperaCmd(id, ms) {
    const fim = Date.now() + ms;
    while (Date.now() < fim) { const r = st.cmdGet.get(id); if (r && ['ok', 'erro'].includes(r.st)) return r; await new Promise(z => setTimeout(z, 150)); }
    return st.cmdGet.get(id);
  }
  function cmd(ponteId, tipo, dados, ms, por) { const id = novoId('cm'); st.cmdIns.run(id, ponteId, tipo, JSON.stringify(dados), Date.now(), Date.now() + ms, 'pendente', por || ''); acordar(); return id; }
  /* abre o ponto no dispositivo: CT 3000 pela ponte; Tuya pela nuvem */
  async function abrirNoDisp(p, c, motivo) {
    const d = dget('disp', p.dispId); if (!d || d.ativo === false) return { ok: false, erro: 'Dispositivo inativo.' };
    try {
      if (K.ehCt(d)) {
        if (!d.ponteId) return { ok: false, erro: 'Controlador sem ponte.' };
        const id = cmd(d.ponteId, 'abrir', { disp: d.id, porta: +p.porta || 1, motivo: txt(motivo, 80) }, 15000, c.id), r = await esperaCmd(id, +process.env.AC170_ESPERA_ABRIR_MS || 8000);
        if (r && r.st === 'ok') return { ok: true, via: 'ponte' }; if (r && r.st === 'erro') return { ok: false, erro: 'A ponte não abriu: ' + (r.res || 'erro') };
        return { ok: false, erro: 'A ponte não respondeu a tempo (pode estar desligada ou sem internet). O pedido vale por 15 segundos.', enviado: true };
      }
      if (d.tipo === 'tuya_rele') { await TUYA.pulso(d.tuyaId, d.codigo || 'switch_1', d.pulsoMs || cfg().pulsoMs); return { ok: true, via: 'tuya' }; }
      if (d.tipo === 'tuya_fechadura') { await TUYA.desbloquear(d.tuyaId); return { ok: true, via: 'tuya' }; }
    } catch (e) { return { ok: false, erro: e.message }; }
    return { ok: false, erro: 'Tipo de dispositivo sem abertura.' };
  }
  async function rotaAbrir(c, req, b) {
    const Xc = ctx(), p = Xc.pontos.find(x => x.id === String(b.pontoId || '')); if (!p) return erro('Ponto não encontrado.', 404);
    const visId = b.visId ? String(b.visId) : '', v = visId ? Xc.vis.find(x => x.id === visId) : null, mot = txt(b.motivo, 200);
    const r = motivoAbrir(c, Xc, p, visId), quem = v ? v.nome + ' (visitante; aberto por ' + nomeConta(c.id) + ')' : nomeConta(c.id);
    if (r) {
      auditar(c, req, 'AC170_ABRIR_RECUSADO', 'ac170/ponto/' + p.id, null, { motivo: r, visita: visId || null });
      ev({ ts: Date.now(), local: p.local, ponto: p.id, disp: p.dispId, porta: p.porta, nome: quem, tipo: 'remoto', res: 'recusado', metodo: 'sistema', motivo: r, origem: 'sistema', conta: c.id, pt: v ? 'vis' : '', pid: v ? v.id : '' });
      return erro(r, 403);
    }
    const x = await abrirNoDisp(p, c, mot);
    ev({ ts: Date.now(), local: p.local, ponto: p.id, disp: p.dispId, porta: p.porta, nome: quem, tipo: 'remoto', res: x.ok ? 'aberto' : 'falhou', metodo: 'sistema', motivo: (mot ? mot + ' · ' : '') + (x.ok ? 'aberto pelo sistema' : x.erro), origem: 'sistema', conta: c.id, pt: v ? 'vis' : '', pid: v ? v.id : '' });
    auditar(c, req, x.ok ? 'AC170_ABRIR' : 'AC170_ABRIR_FALHOU', 'ac170/ponto/' + p.id, null, { ponto: p.nome, via: x.via || '', erro: x.erro || '', motivo: mot, visita: visId || null });
    if (!x.ok) return erro(x.erro, x.enviado ? 504 : 502);
    if (K.foraHorario(Xc.cfg, Xc.hoje, Xc.agora.slice(11, 16))) alertar(p.local, p.id, 'fora_horario', 'Acesso fora do horário: ' + p.nome + ' aberto pelo sistema por ' + quem + ' às ' + Xc.agora.slice(11, 16) + '.', 'fh|sis|' + p.id + '|' + Xc.agora);
    return { ok: true, msg: p.nome + ' aberto.' };
  }
  /* portão de veículos pela saída do veículo (v165): o condutor daquela saída */
  function portoesDaSaida(c, Xc, sd) {
    const v = Xc.veic.find(x => x.id === sd.veicId), l = K.localDaCidade(Xc.cfg, v ? F165.cidadeDe(v) : '');
    return l ? Xc.pontos.filter(p => p.ativo !== false && p.local === l.id && p.tipo === 'portao_veiculos' && p.dispId && p.remoto !== false) : [];
  }
  function saidaOk(c, Xc, sd) {
    if (!sd) return 'Saída não encontrada.';
    const f = funcDaConta(c, Xc); if (!f || sd.funcId !== f.id) return 'Só o condutor desta saída abre o portão por aqui.';
    const fim = sd.retornoEm ? Date.parse(K.s(sd.retornoEm).slice(0, 10) + 'T' + (K.s(sd.horaRet) || '23:59') + ':00-03:00') : 0;
    if (sd.retornoEm && !(Date.now() - fim < 30 * 60e3)) return 'Saída já encerrada (retorno registrado).';
    const sit = K.condutor(Xc, f, F165); if (!sit.ok) return 'Condutor não autorizado (v165): ' + sit.txt + '.';
    return '';
  }
  function rotaMeusPortoes(c) {
    const Xc = ctx(), f = funcDaConta(c, Xc); if (!f) return { ok: true, saidas: [] };
    const out = Xc.vsai.filter(sd => sd.funcId === f.id && !sd.retornoEm).map(sd => { const ps = portoesDaSaida(c, Xc, sd); return { vsaiId: sd.id, veicId: sd.veicId, pontos: ps.map(p => ({ id: p.id, nome: p.nome })), motivo: ps.length ? saidaOk(c, Xc, sd) : '' }; }).filter(x => x.pontos.length);
    return { ok: true, saidas: out };
  }
  async function rotaPortao(c, req, b) {
    const Xc = ctx(), sd = Xc.vsai.find(x => x.id === String(b.vsaiId || ''));
    const r = saidaOk(c, Xc, sd), ps = sd ? portoesDaSaida(c, Xc, sd) : [], p = ps.find(x => x.id === String(b.pontoId || '')) || ps[0];
    const mot = r || (!p ? 'Nenhum portão de veículos com abertura pelo sistema no local do veículo.' : '');
    if (mot) { auditar(c, req, 'AC170_PORTAO_RECUSADO', 'vsai/' + String(b.vsaiId || ''), null, { motivo: mot }); if (p) ev({ local: p.local, ponto: p.id, disp: p.dispId, porta: p.porta, nome: nomeConta(c.id), tipo: 'remoto', res: 'recusado', metodo: 'saida', motivo: mot, origem: 'sistema', conta: c.id }); return erro(mot, 403); }
    const x = await abrirNoDisp(p, c, 'saída do veículo');
    const v = Xc.veic.find(y => y.id === sd.veicId), vn = v ? (v.placa || v.modelo || '') : '';
    ev({ local: p.local, ponto: p.id, disp: p.dispId, porta: p.porta, nome: nomeConta(c.id), pt: 'func', pid: sd.funcId, tipo: 'remoto', res: x.ok ? 'aberto' : 'falhou', metodo: 'saida', motivo: 'Saída do veículo ' + vn + (x.ok ? '' : ' · ' + x.erro), origem: 'sistema', conta: c.id });
    auditar(c, req, x.ok ? 'AC170_PORTAO' : 'AC170_PORTAO_FALHOU', 'vsai/' + sd.id, null, { ponto: p.nome, veiculo: vn, erro: x.erro || '' });
    return x.ok ? { ok: true, msg: p.nome + ' aberto.' } : erro(x.erro, 502);
  }
  /* "Ler crachá": espera até 30 s o próximo crachá apresentado no leitor escolhido */
  async function rotaLer(c, req, b) {
    if (!(crachaW(c) || respLocais(c).length)) return erro('Seu perfil não cuida de crachás.');
    const d = dget('disp', b.disp); if (!d || !K.ehCt(d) || !d.ponteId) return erro('Escolha um leitor de controlador CT 3000 ligado a uma ponte.', 400);
    const porta = Math.round(+b.porta || 1), seg = Math.min(30, Math.max(1, +b.espera || 30));
    const id = cmd(d.ponteId, 'ler', { disp: d.id, porta, seg }, seg * 1000 + 2000, c.id), r = await esperaCmd(id, seg * 1000 + 1500);
    auditar(c, req, 'AC170_LER_CRACHA', 'ac170/disp/' + d.id, null, { porta, ok: !!(r && r.st === 'ok') });
    if (r && r.st === 'ok') { let o = {}; try { o = JSON.parse(r.res || '{}'); } catch (e) { } const uid = K.uidNorm(o.uid); if (uid) return { ok: true, uid }; }
    if (r && r.st === 'erro') return erro('A ponte não leu: ' + (r.res || 'erro'), 502);
    return erro('Nenhum crachá apresentado no leitor em ' + seg + ' segundos (ou a ponte está sem conexão).', 504);
  }
  async function rotaTuyaSenha(c, req, b) {
    if (!gestor(c)) return erro('Só o Administrador ou a Segurança patrimonial cria senha temporária.');
    const p = dget('ponto', b.pontoId), d = p ? dget('disp', p.dispId) : null; if (!d || d.tipo !== 'tuya_fechadura') return erro('O ponto não é uma fechadura Tuya.', 400);
    const de = Date.parse(String(b.de || '') + ':00-03:00'), ate = Date.parse(String(b.ate || '') + ':00-03:00'); if (!(de && ate && ate > de)) return erro('Informe a validade (de e até).', 400);
    try { const r = await TUYA.senhaTemp(d.tuyaId, { nome: txt(b.nome, 20) || 'Visitante', senha: String(b.senha || ''), de, ate }); auditar(c, req, 'AC170_TUYA_SENHA', 'ac170/ponto/' + p.id, null, { de: b.de, ate: b.ate, nome: txt(b.nome, 20) }); return { ok: true, msg: 'Senha temporária criada na fechadura.', id: r.id }; }
    catch (e) { return erro(e.message, 502); }
  }

  /* =================================================================== registro de acessos */
  const RES_TXT = { liberado: 'Liberado', negado: 'Negado', forcada: 'Porta forçada', aberta: 'Porta aberta além do tempo', violacao: 'Violação do equipamento', aberto: 'Aberto pelo sistema', recusado: 'Abertura recusada', falhou: 'Abertura falhou', leitura: 'Leitura para cadastro', saida: 'Botão de saída' };
  function consultaLog(c, u, lim) {
    const Xc = ctx(), esc = escopoLog(c, Xc); if (esc && !esc.size) return erro('Seu perfil não vê o registro de acessos.');
    const w = [], a = [], g = k => String(u.searchParams.get(k) || '').trim();
    const dt = (s0, fim) => { const t = Date.parse(s0 + 'T' + (fim ? '23:59:59.999' : '00:00:00') + '-03:00'); return isFinite(t) ? t : null; };
    if (K.dataOk(g('de'))) { w.push('ts>=?'); a.push(dt(g('de'))); } if (K.dataOk(g('ate'))) { w.push('ts<=?'); a.push(dt(g('ate'), 1)); }
    if (g('local')) { w.push('local=?'); a.push(g('local')); } if (g('ponto')) { w.push('ponto=?'); a.push(g('ponto')); }
    if (g('res')) { w.push('res=?'); a.push(g('res')); } if (g('pid')) { w.push('pid=?'); a.push(g('pid')); }
    if (g('q')) { w.push("(nome LIKE ? ESCAPE '\\' OR uid LIKE ? ESCAPE '\\')"); const z = '%' + g('q').replace(/[\\%_]/g, '\\$&') + '%'; a.push(z, z); }
    if (esc) { const ids = [...esc]; w.push('ponto IN (' + ids.map(() => '?').join(',') + ')'); a.push(...ids); }
    const wh = w.length ? ' WHERE ' + w.join(' AND ') : '', pg = Math.max(0, +g('pg') || 0), N = lim || 100;
    const tot = db.prepare('SELECT count(*) n FROM ac170_ev' + wh).get(...a).n, ls = db.prepare('SELECT * FROM ac170_ev' + wh + ' ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?').all(...a, N, pg * N);
    const pn = new Map(Xc.pontos.map(p => [p.id, p.nome]));
    return { ok: true, total: tot, pg, por: N, linhas: ls.map(r => ({ id: r.id, ts: r.ts, quando: brTs(r.ts), local: r.local, ponto: r.ponto, pontoNome: pn.get(r.ponto) || (r.disp ? r.disp + ' porta ' + r.porta : '—'), uid: r.uid, pt: r.pt, pid: r.pid, nome: r.nome, tipo: r.tipo, res: r.res, resTxt: RES_TXT[r.res] || r.res, metodo: r.metodo, motivo: r.motivo, origem: r.origem })) };
  }
  function csv(c, req, res, u) {
    const r = consultaLog(c, u, 20000); if (r.erro) return json(res, r.st || 403, { erro: r.erro });
    const e = v => { const x = String(v == null ? '' : v); return /[;"\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const linhas = [['Quando', 'Local', 'Ponto', 'Pessoa', 'Crachá', 'Resultado', 'Como', 'Motivo'].join(';')].concat(r.linhas.map(l => [l.quando, l.local, l.pontoNome, l.nome, l.uid, l.resTxt, l.metodo, l.motivo].map(e).join(';')));
    auditar(c, req, 'AC170_LOG_EXPORTADO', '/api/ac170/log.csv', null, { linhas: r.linhas.length, filtros: Object.fromEntries([...u.searchParams].slice(0, 10)) });
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="registro-de-acessos.csv"', 'cache-control': 'no-store' });
    res.end('\ufeff' + linhas.join('\r\n') + '\r\n'); return true;
  }

  /* =================================================================== API da ponte (sem login; token próprio) */
  const falhas = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of falhas) if (t - v.ini > 600e3) falhas.delete(k); }, 300e3).unref();
  function ponteDoToken(req) {
    const h = String(req.headers.authorization || ''), m = h.match(/^Bearer\s+(pa_[A-Za-z0-9_-]{20,80})$/); if (!m) return null;
    const t = st.tokGet.get(sha(m[1])); if (!t || t.revogado) return null;
    const p = dget('ponte', t.ponte); if (!p || p.ativo === false) return null;
    st.tokUlt.run(Date.now(), ipDe(req), t.hash); p.ult = Date.now(); p.ip = ipDe(req); if (p.offAvisado) { p.offAvisado = 0; alertar(p.local, '', 'online', 'Ponte "' + p.nome + '" voltou a conectar.', 'on|' + p.id + '|' + Date.now()); } dput('ponte', p);
    return p;
  }
  function mudancas(p, desde) {
    const ds = dall('disp').filter(d => d.ponteId === p.id && K.ehCt(d)), out = {}, completo = !desde;
    for (const d of ds) {
      const rows = completo ? st.estVivos.all(d.id).map(r => Object.assign(r, { del: 0 })) : st.estDesde.all(d.id, desde);
      if (!rows.length && !completo) continue;
      const o = { portas: [], horarios: [], cartoes: [], feriados: null, removidos: { portas: [], horarios: [], cartoes: [] } };
      for (const r of rows) {
        const [t, k] = r.k.split(':'), v = JSON.parse(r.data);
        if (r.k === 'f') { o.feriados = r.del ? [] : v.feriados; continue; }
        const L = t === 'p' ? 'portas' : t === 'h' ? 'horarios' : 'cartoes';
        if (r.del) o.removidos[L].push(t === 'c' ? k : +k); else o[L].push(v);
      }
      out[d.id] = o;
    }
    return { disps: ds.map(d => ({ id: d.id, nome: d.nome, tipo: d.tipo, portas: K.portasDe(d.tipo), ip: d.ip || '' })), mudancas: out, completo };
  }
  async function apiPonte(p, m, req, res) {
    const pt = ponteDoToken(req), ip = ipDe(req);
    if (!pt) {
      const f = falhas.get(ip) || { n: 0, ini: Date.now() }; f.n++; falhas.set(ip, f);
      await new Promise(r => setTimeout(r, 300));
      return json(res, f.n > 30 ? 429 : 401, { erro: f.n > 30 ? 'Muitas tentativas.' : 'Token da ponte inválido ou revogado.' });
    }
    const u = new URL(req.url, 'http://x');
    if (p === '/api/ponte170/sync' && m === 'GET') {
      const desde = Math.max(0, +u.searchParams.get('desde') || 0), esp = Math.min(25, Math.max(0, +u.searchParams.get('espera') || 0));
      let ver = recalc(); const tem = () => (desde === 0 || ver > desde || (ver < desde)) || st.cmdPend.all(pt.id, Date.now()).some(x => x.st === 'pendente');
      if (!tem() && esp) { await new Promise(r => { const w = () => { clearTimeout(to); r(); }, to = setTimeout(() => { espera.delete(w); r(); }, esp * 1000); espera.add(w); req.on('close', () => { espera.delete(w); clearTimeout(to); r(); }); }); ver = recalc(); }
      const mm = mudancas(pt, ver < desde ? 0 : desde); /* versão do servidor menor que a da ponte (banco restaurado): manda tudo */
      const cmds = st.cmdPend.all(pt.id, Date.now()).map(x => { st.cmdMarca.run(x.id); return { id: x.id, tipo: x.tipo, dados: JSON.parse(x.dados || '{}'), ate: x.ate }; });
      return json(res, 200, Object.assign({ ok: true, ponte: { id: pt.id, nome: pt.nome }, versao: ver, cmds, intervaloEventosS: 3 }, mm));
    }
    if (m !== 'POST') return json(res, 405, { erro: 'Método não permitido.' });
    const b = await lerJson(req).catch(() => ({}));
    if (p === '/api/ponte170/aplicado' || p === '/api/ponte170/status') {
      const ds = new Set(dall('disp').filter(d => d.ponteId === pt.id).map(d => d.id)), C = cfg();
      pt.dispSt = pt.dispSt || {}; pt.erros = [];
      for (const [id, s0] of Object.entries(b.disps || {})) {
        if (!ds.has(id) || !s0) continue; const ant = pt.dispSt[id] || {};
        const novo = { online: !!s0.online, erro: txt(s0.erro, 300), em: Date.now(), ver: +s0.ver || ant.ver || 0, offAvisado: ant.offAvisado || 0 };
        if (!novo.online && !ant.offAvisado && ant.online !== false) { const d = dget('disp', id); alertar(pt.local, '', 'offline', 'Controlador "' + (d ? d.nome : id) + '" sem resposta da ponte "' + pt.nome + '"' + (novo.erro ? ' (' + novo.erro + ')' : '') + '.', 'offd|' + id + '|' + Date.now()); novo.offAvisado = Date.now(); }
        if (novo.online) novo.offAvisado = 0;
        (Array.isArray(s0.erros) ? s0.erros : []).slice(0, 20).forEach(e => pt.erros.push({ disp: id, txt: txt(e, 200) }));
        pt.dispSt[id] = novo;
      }
      if (p === '/api/ponte170/aplicado' && +b.versao >= 0) pt.verAplicada = Math.min(+b.versao, +meta('ver', '0') || 0);
      pt.versaoProg = txt(b.programa, 40) || pt.versaoProg || ''; pt.aplicEm = Date.now(); dput('ponte', pt);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/ponte170/eventos') return json(res, 200, receberEventos(pt, b));
    if (p === '/api/ponte170/cmd') {
      const r = st.cmdGet.get(String(b.id || '')); if (!r || r.ponte !== pt.id) return json(res, 404, { erro: 'Comando não encontrado.' });
      st.cmdFim.run(b.ok ? 'ok' : 'erro', b.ok ? JSON.stringify({ uid: K.uidNorm(b.uid) || '' }) : txt(b.erro, 200), Date.now(), r.id);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { erro: 'Rota não encontrada.' });
  }
  /* eventos da ponte: o mesmo id nunca entra duas vezes (fila local da ponte sem internet) */
  function receberEventos(pt, b) {
    const Xc = ctx(), C = Xc.cfg, ls = (Array.isArray(b.eventos) ? b.eventos : []).slice(0, 500), aceitos = [], ds = new Map(Xc.disps.filter(d => d.ponteId === pt.id).map(d => [d.id, d]));
    let novos = 0;
    for (const e of ls) {
      const eid = String((e && e.id) || ''); if (!/^[\w:.\-]{1,120}$/.test(eid)) continue; aceitos.push(eid);
      const d = ds.get(String(e.disp || '')); const porta = Math.round(+e.porta || 0), ts = Math.min(Date.now() + 300e3, Math.max(Date.now() - 400 * 864e5, +e.ts || Date.now()));
      const p = d ? Xc.pontos.find(x => x.dispId === d.id && +x.porta === porta) : null, uid = K.uidNorm(e.uid);
      const cr = uid ? Xc.crachas.filter(x => x.uid === uid).sort((a, z) => (z.st === 'ativo') - (a.st === 'ativo') || (z.em || 0) - (a.em || 0))[0] : null;
      let res0 = String(e.res || ''), tipo = e.tipo === 'alarme' ? 'alarme' : e.leitura ? 'leitura' : 'acesso', metodo = String(e.metodo || 'cartao').slice(0, 20);
      if (!['liberado', 'negado', 'forcada', 'aberta', 'violacao', 'saida'].includes(res0)) res0 = tipo === 'alarme' ? 'violacao' : 'negado';
      if (tipo === 'leitura') res0 = 'leitura';
      /* abertura pelo sistema: o servidor já registrou (comando dos últimos 60 s nesta porta) */
      if (metodo === 'remoto' && d && db.prepare("SELECT 1 FROM ac170_cmd WHERE ponte=? AND tipo='abrir' AND criado>? AND dados LIKE ?").get(pt.id, ts - 60e3, '%"disp":"' + d.id + '","porta":' + porta + '%')) continue;
      let motivo = txt(e.motivo, 200);
      if (res0 === 'negado' && tipo === 'acesso') {
        if (!cr) motivo = motivo || 'Crachá não cadastrado';
        else if (cr.st !== 'ativo') motivo = 'Crachá ' + cr.st;
        else { const a = K.acesso(Xc, cr.pt, cr.pid, F165, T166); if (a.bloqueios.length) motivo = 'Bloqueado: ' + a.bloqueios.map(x => x.txt).join('; '); else if (p) { const rc = a.recusados.find(x => x.pontoId === p.id); if (rc) motivo = rc.txt; else if (!a.pontos.has(p.id)) motivo = 'Sem grupo de acesso para este ponto'; else if (!a.pontos.get(p.id).some(g => K.noHorario(g, new Date(ts - 3 * 3600e3).toISOString().slice(0, 10), new Date(ts - 3 * 3600e3).toISOString().slice(11, 16), C.feriados))) motivo = 'Fora do horário do grupo'; } }
      }
      const o = { id: pt.id + '|' + eid, ts, local: (p && p.local) || (d && d.local) || pt.local, ponto: p ? p.id : '', disp: d ? d.id : String(e.disp || '').slice(0, 60), porta, ponte: pt.id, uid, pt: cr ? cr.pt : '', pid: cr ? cr.pid : '', nome: cr ? K.pessoaNome(Xc, cr.pt, cr.pid) : '', tipo, res: res0, metodo, motivo, origem: 'ponte' };
      if (!ev(o)) continue; novos++;
      alertasDoEvento(Xc, o, p);
    }
    return { ok: true, aceitos, novos };
  }
  function alertasDoEvento(Xc, o, p) {
    const C = Xc.cfg, nomeP = p ? p.nome : (o.disp + ' porta ' + o.porta), hb = new Date(o.ts - 3 * 3600e3).toISOString(), hora = hb.slice(11, 16), data = hb.slice(0, 10);
    if (o.res === 'forcada') alertar(o.local, o.ponto, 'forcada', 'Porta forçada: ' + nomeP + ' às ' + hora + ' de ' + K.br(data) + '.', 'fo|' + o.id);
    else if (o.res === 'aberta') alertar(o.local, o.ponto, 'aberta', 'Porta aberta além de ' + ((p && p.abertaSeg) || C.alerta.abertaSeg) + ' segundos: ' + nomeP + ' às ' + hora + '.', 'ab|' + o.id);
    else if (o.res === 'violacao') alertar(o.local, o.ponto, 'violacao', 'Violação do equipamento (tamper): ' + nomeP + ' às ' + hora + '.', 'vi|' + o.id);
    else if (o.res === 'liberado' && K.foraHorario(C, data, hora)) alertar(o.local, o.ponto, 'fora_horario', 'Acesso fora do horário: ' + (o.nome || 'crachá ' + o.uid) + ' em ' + nomeP + ' às ' + hora + ' de ' + K.br(data) + '.', 'fh|' + o.id);
    else if (o.res === 'negado') {
      const jan = C.alerta.negMin * 60e3, chave = o.uid ? 'uid=?' : 'ponto=?', v = o.uid || o.ponto;
      const n = db.prepare("SELECT count(*) n FROM ac170_ev WHERE res='negado' AND " + chave + ' AND ts>? AND ts<=?').get(v, o.ts - jan, o.ts).n;
      if (n >= C.alerta.negN) alertar(o.local, o.ponto, 'negadas', 'Negativas repetidas: ' + n + ' tentativas negadas em ' + C.alerta.negMin + ' min (' + (o.nome || (o.uid ? 'crachá ' + o.uid : 'sem crachá')) + ', ' + nomeP + '). Último motivo: ' + (o.motivo || '—') + '.', 'ng|' + v + '|' + Math.floor(o.ts / jan));
    }
  }

  /* =================================================================== rotinas (a cada minuto) */
  let tuyaRod = 0;
  async function rotina(forcar) {
    const C = cfg(), ag = Date.now(), lim = C.alerta.offlineMin * 60e3; let n = 0;
    for (const p of dall('ponte')) {
      if (p.ativo === false || !p.ult) continue;
      if (ag - p.ult > lim && !p.offAvisado) { p.offAvisado = ag; dput('ponte', p); if (alertar(p.local, '', 'offline', 'Ponte "' + p.nome + '" sem conexão desde ' + brTs(p.ult) + '. Os controladores continuam abrindo com a lista que já têm; mudanças e bloqueios só valem quando ela voltar.', 'offp|' + p.id + '|' + p.ult)) n++; }
    }
    if (TUYA.configurado() && (forcar || ag - tuyaRod > 5 * 60e3)) {
      tuyaRod = ag;
      for (const d of dall('disp').filter(x => K.ehTuya(x) && x.ativo !== false && x.tuyaId)) {
        try {
          const s0 = await TUYA.status(d.tuyaId), ant = d.st || {}; d.st = { online: s0.online, em: Date.now(), erro: '' };
          if (!s0.online && ant.online !== false && !ant.offAvisado) { d.st.offAvisado = Date.now(); alertar(d.local, '', 'offline', 'Dispositivo Tuya "' + d.nome + '" offline na nuvem Tuya.', 'offt|' + d.id + '|' + Date.now()); n++; }
          else if (!s0.online) d.st.offAvisado = ant.offAvisado || Date.now();
          if (d.tipo === 'tuya_fechadura') {
            const de = +meta('tuya:' + d.id, String(ag - 864e5)) || (ag - 864e5), ls = await TUYA.logs(d.tuyaId, de, ag), p = dall('ponto').find(x => x.dispId === d.id);
            let ult = de;
            for (const l of ls) { ult = Math.max(ult, l.ts + 1); const o = { id: l.id, ts: l.ts, local: d.local, ponto: p ? p.id : '', disp: d.id, porta: 1, nome: l.quem, tipo: 'acesso', res: /alarm|hijack/.test(l.codigo) ? 'violacao' : 'liberado', metodo: l.tipo, motivo: 'Fechadura Tuya: ' + l.tipo, origem: 'tuya' }; if (ev(o)) alertasDoEvento(ctx(), o, p); }
            st.mPut.run('tuya:' + d.id, String(ult));
          }
        } catch (e) { d.st = Object.assign({}, d.st || {}, { erro: txt(e.message, 200), em: Date.now() }); }
        dput('disp', d);
      }
    }
    sujo(); /* visita que venceu, ASO que venceu hoje etc. */
    return n;
  }
  function limpar() {
    const lim = Date.now() - LOG_DIAS() * 864e5;
    const a = db.prepare('DELETE FROM ac170_ev WHERE ts<?').run(lim).changes, b = db.prepare('DELETE FROM ac170_alerta WHERE ts<?').run(lim).changes, c2 = db.prepare('DELETE FROM ac170_cmd WHERE criado<?').run(Date.now() - 30 * 864e5).changes;
    return { eventos: a, alertas: b, cmds: c2 };
  }
  if (process.env.NODE_ENV !== 'test' || process.env.AC170_ROTINA === '1') {
    const t = setInterval(() => { rotina().catch(e => console.error('[v170] rotina:', e.message)); }, 60e3); if (t.unref) t.unref();
    const t2 = setInterval(() => { try { limpar(); } catch (e) { console.error('[v170] limpeza:', e.message); } }, 6 * 3600e3); if (t2.unref) t2.unref();
    setTimeout(() => { try { limpar(); recalc(); } catch (e) { } }, 5000).unref();
  }

  /* =================================================================== rotas */
  const R = (res, r) => json(res, r.erro ? (r.st || 403) : 200, r.erro ? { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : r.st >= 500 ? 'unavailable' : 'not_granted', erro: r.erro } : r);
  async function rota(p, m, req, res, conta) {
    if (!p.startsWith('/api/ac170/')) return false;
    const u = new URL(req.url, 'http://x'), k = p.slice('/api/ac170/'.length);
    if (m === 'GET') {
      if (k === 'modelo') { R(res, modelo(conta)); return true; }
      if (k === 'log') { R(res, consultaLog(conta, u)); return true; }
      if (k === 'log.csv') { csv(conta, req, res, u); return true; }
      if (k === 'meus-portoes') { R(res, rotaMeusPortoes(conta)); return true; }
      json(res, 404, { code: 'not_found', erro: 'Rota não encontrada.' }); return true;
    }
    if (m !== 'POST') { json(res, 405, { erro: 'Método não permitido.' }); return true; }
    const b = await lerJson(req).catch(() => ({})) || {};
    const T = { cfg: rotaCfg, ponte: rotaPonte, 'ponte/token': (c, r, x) => rotaToken(c, r, x, false), 'ponte/revogar': (c, r, x) => rotaToken(c, r, x, true), disp: rotaDisp, ponto: rotaPonto, grupo: rotaGrupo, cracha: rotaCracha, 'cracha/situacao': rotaCrachaSit, vis: rotaVis, 'vis/encerrar': rotaVisFim,
      abrir: rotaAbrir, portao: rotaPortao, ler: rotaLer, 'tuya/senha': rotaTuyaSenha,
      'alerta/visto': (c, r, x) => { const e = escopoLog(c, ctx()); if (e && !e.size) return erro('Sem acesso.'); db.prepare('UPDATE ac170_alerta SET visto=?, vistoPor=? WHERE id=?').run(Date.now(), c.id, String(x.id || '')); return { ok: true }; },
      rotina: async c => admin(c) ? { ok: true, n: await rotina(true), limpeza: limpar(), versao: recalc() } : erro('Só o Administrador.') };
    const fn = T[k]; if (!fn) { json(res, 404, { code: 'not_found', erro: 'Rota não encontrada.' }); return true; }
    let r; try { r = await fn(conta, req, b); } catch (e) { console.error('[v170]', e); r = erro('Falha: ' + e.message, 500); }
    R(res, r); return true;
  }
  async function publica(p, m, req, res) { if (!p.startsWith('/api/ponte170/')) return false; await apiPonte(p, m, req, res); return true; }
  return { rota, publica, depois, recalc, rotina, limpar, ctx, K };
};

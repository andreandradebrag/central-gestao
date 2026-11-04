'use strict';
/* v151 (relatorios/feito_v151_treino.md): treinamentos dentro do sistema (Escola do Almoxarifado e os próximos cursos).
   - Conteúdo: public/treino/catalogo.json (lista de cursos) e public/treino/<pasta>/conteudo.json + imagens, servidos
     como arquivos do sistema (só para quem entrou). Curso novo = pasta nova + entrada no catálogo; nada aqui é de um curso.
   - Quem faz cada curso: cfg/empresa › treino.cursos[<id>].perfis (Sistema › Treinamentos); sem a escolha, vale
     perfisPadrao do catálogo. O Administrador e o dono veem todos os cursos.
   - Progresso: coleção treino, um documento por pessoa e curso em treino/<conta>/c/<curso>. Cada pessoa grava só o
     próprio (e só de curso liberado para o perfil dela); o servidor refaz os totais e as datas. Só o Administrador, o
     dono e quem grava RH leem o de todos (rota /api/treino/acomp). Ninguém grava o de outra pessoa; zerar é só pela rota
     /api/treino/zerar (Administrador ou dono), com auditoria TREINO_ZERADO.
   Ligado em regras.js (podeLer, antesGravar, antesExcluir e rota) e em server.js (nível {self}, perfilPermite e LIVRES)
   pelo v151/ed_v151.py. */
const fs = require('node:fs');
const path = require('node:path');

module.exports = function (X) {
  const { q, db, json, lerJson, avisarDoc, auditar, ehDono, perfilEm, perfilDe, cfgEmp, col, doc, erro, nomeConta, gravaGrupo, PERM, NIV } = X;
  const RAIZ = path.join(X.PUB || path.join(__dirname, 'public'), 'treino');
  const ID = /^[a-z][a-z0-9]{1,23}$/, UID = /^[A-Za-z0-9_-]{1,64}$/;
  const FORA_PERFIS = new Set(['pendente', 'semnivel', 'semid']);
  const RE_DOC = /^treino\/([A-Za-z0-9_-]{1,64})\/c\/([a-z][a-z0-9]{1,23})$/;
  const int = (v, a, b) => { v = Math.round(+v); return isFinite(v) ? Math.max(a, Math.min(b, v)) : a; };

  /* ---------- catálogo (lido dos arquivos; recarrega quando um deles muda) ---------- */
  let cache = { chave: '', cat: { cursos: [] } };
  const mt = f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };
  function lerJsonArq(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
  function catalogo() {
    const fc = path.join(RAIZ, 'catalogo.json'), c0 = lerJsonArq(fc);
    const lista = c0 && Array.isArray(c0.cursos) ? c0.cursos.filter(c => c && ID.test(String(c.id || '')) && /^[a-z0-9_-]{1,40}$/.test(String(c.pasta || c.id))) : [];
    const chave = mt(fc) + '|' + lista.map(c => c.id + ':' + mt(path.join(RAIZ, String(c.pasta || c.id), 'conteudo.json'))).join(',');
    if (chave === cache.chave) return cache.cat;
    const cursos = [];
    for (const c of lista) {
      const pasta = String(c.pasta || c.id), ct = lerJsonArq(path.join(RAIZ, pasta, 'conteudo.json'));
      if (!ct || !Array.isArray(ct.capitulos) || !ct.capitulos.length) continue;
      const caps = ct.capitulos.filter(x => x && ID.test(String(x.id || ''))).map(x => ({ id: x.id, titulo: String(x.titulo || x.id).slice(0, 120), n: Array.isArray(x.quiz) ? x.quiz.length : 0, passos: Array.isArray(x.passos) ? x.passos.length : 0, min: +x.duracao_min || 0 }));
      if (!caps.length) continue;
      cursos.push({ id: c.id, titulo: String(c.titulo || c.id).slice(0, 120), resumo: String(c.resumo || '').slice(0, 400), pasta, publico: String(c.publico || '').slice(0, 120),
        perfisPadrao: (Array.isArray(c.perfisPadrao) ? c.perfisPadrao : []).filter(x => typeof x === 'string').slice(0, 40), caps,
        minutos: caps.reduce((s, x) => s + x.min, 0), perguntas: caps.reduce((s, x) => s + x.n, 0), passos: caps.reduce((s, x) => s + x.passos, 0) });
    }
    cache = { chave, cat: { cursos } }; return cache.cat;
  }
  const curso = id => catalogo().cursos.find(c => c.id === id) || null;
  const cfgT = () => { const t = cfgEmp().treino; return t && typeof t === 'object' && t.cursos && typeof t.cursos === 'object' ? t.cursos : {}; };
  function perfisDo(c) { const x = cfgT()[c.id]; return x && Array.isArray(x.perfis) ? x.perfis.filter(p => typeof p === 'string') : c.perfisPadrao; }
  const desligado = c => { const x = cfgT()[c.id]; return !!(x && x.off === true); };
  const ehAdmin = conta => ehDono(conta) || (NIV[conta.nivel] >= NIV.admin && perfilEm(conta, ['admin']));
  /* o curso é da pessoa (aparece como pendente) quando o perfil dela está na lista do curso */
  const paraPerfil = (conta, c) => !desligado(c) && perfisDo(c).includes(perfilDe(conta));
  const acesso = (conta, c) => !!c && (ehAdmin(conta) || paraPerfil(conta, c));
  /* lê o progresso de todos: Administrador, dono e quem grava RH (perfil RH ou personalizado que grava o módulo RH) */
  const veTodos = conta => ehAdmin(conta) || (NIV[conta.nivel] >= NIV.admin && gravaGrupo(conta, 'rh'));

  /* ---------- leitura e gravação pela rota genérica /api/db/doc ---------- */
  function podeLer(conta, p) { const s = p.split('/'); return s[1] === conta.id || veTodos(conta); }
  function resumo(d) { return d ? { curso: d.curso, feitos: d.feitos, nCaps: d.nCaps, acertos: d.acertos, total: d.total, concluido: d.concluido || null, ini: d.ini || null, em: d.em || null } : null; }
  function antes(conta, p, velho, novo) {
    const m = RE_DOC.exec(p); if (!m) return erro('Caminho de treinamento inválido (use treino/<pessoa>/c/<curso>).', 400);
    if (m[1] !== conta.id) return erro('Cada pessoa grava só o próprio progresso de treinamento.');
    const c = curso(m[2]); if (!c) return erro('Treinamento não encontrado.', 404);
    if (!acesso(conta, c)) return erro('Este treinamento não está liberado para o seu perfil.');
    const agora = Date.now(), v = velho || {}, ent = novo && novo.caps && typeof novo.caps === 'object' ? novo.caps : {}, caps = {};
    let feitos = 0, acertos = 0, total = 0;
    for (const k of c.caps) {
      const x = ent[k.id]; if (!x || x.feito !== true) continue;
      const va = (v.caps || {})[k.id] || {};
      const em = int(x.em || agora, 0, agora + 60e3);
      caps[k.id] = { feito: true, acertos: int(x.acertos, 0, k.n), total: k.n, em, tent: int(x.tent || 1, 1, 999), prim: int(va.prim || x.prim || em, 0, agora + 60e3) };
      feitos++; acertos += caps[k.id].acertos; total += k.n;
    }
    const tudo = feitos === c.caps.length;
    const ult = novo && novo.ult && typeof novo.ult === 'object' ? { cap: c.caps.some(k => k.id === novo.ult.cap) ? novo.ult.cap : c.caps[0].id, passo: int(novo.ult.passo, 0, 999) } : (v.ult || null);
    const out = { uid: conta.id, curso: c.id, caps, feitos, nCaps: c.caps.length, acertos, total, ini: int(v.ini || (novo && novo.ini) || agora, 0, agora), em: agora,
      tent: int(Math.max(+(v.tent || 0), +((novo && novo.tent) || 0)), 0, 99999), concluido: tudo ? (v.concluido || agora) : null };
    if (ult) out.ult = ult;
    return { data: out };
  }
  const antesExcluir = () => erro('O progresso de treinamento não se exclui por aqui. O Administrador usa Zerar em Sistema › Treinamentos.');
  /* cfg/empresa › treino: só o Administrador e o dono mudam; dos outros, fica o que estava */
  function cfgAntes(conta, velho, novo) {
    const v = (velho || {}).treino;
    if (!ehAdmin(conta)) { if (v !== undefined) novo.treino = v; else delete novo.treino; return null; }
    if (novo.treino === undefined) return null;
    const t = novo.treino, cs = t && typeof t === 'object' && t.cursos && typeof t.cursos === 'object' ? t.cursos : {}, out = {};
    for (const [id, x] of Object.entries(cs)) {
      if (!ID.test(id) || !x || typeof x !== 'object') continue;
      const o = {}; if (Array.isArray(x.perfis)) o.perfis = [...new Set(x.perfis.filter(p => typeof p === 'string' && /^[a-z][a-z0-9_]{1,30}$/.test(p) && !FORA_PERFIS.has(p)))].slice(0, 60);
      if (x.off === true) o.off = true; out[id] = o;
    }
    novo.treino = { cursos: out }; return null;
  }

  /* ---------- rotas ---------- */
  const situacao = d => !d ? 'nao' : d.concluido ? 'concluido' : 'andamento';
  const prog = (uid, c) => doc('treino/' + uid + '/c/' + c);
  const stTodos = db.prepare("SELECT path, data FROM docs WHERE path LIKE 'treino/%/c/%'");
  function cursosDe(conta) {
    const adm = ehAdmin(conta), cat = catalogo();
    const cursos = cat.cursos.filter(c => acesso(conta, c)).map(c => {
      const d = prog(conta.id, c.id), o = { id: c.id, titulo: c.titulo, resumo: c.resumo, pasta: c.pasta, publico: c.publico, caps: c.caps.map(k => ({ id: k.id, titulo: k.titulo, n: k.n, passos: k.passos, min: k.min })),
        minutos: c.minutos, perguntas: c.perguntas, passos: c.passos, paraVoce: paraPerfil(conta, c), prog: d || null, situacao: situacao(d) };
      if (adm) { o.perfis = perfisDo(c); o.perfisPadrao = c.perfisPadrao; o.off = desligado(c); }
      return o;
    });
    return { cursos, admin: adm, acomp: veTodos(conta), pendentes: cursos.filter(c => c.paraVoce && c.situacao !== 'concluido').length, eu: { id: conta.id, nome: nomeUsr(conta.id) } };
  }
  function nomeUsr(uid) { const u = col('usr').find(x => x.uid === uid); return (u && u.nome) || nomeConta(uid); }
  function acomp() {
    const cat = catalogo(), usrs = col('usr').filter(u => u && u.uid), porUid = new Map(usrs.map(u => [u.uid, u])), linhas = [], visto = new Set();
    const docs = new Map(); for (const r of stTodos.all()) { const m = RE_DOC.exec(r.path); if (!m) continue; try { docs.set(m[1] + '|' + m[2], JSON.parse(r.data)); } catch (e) { } }
    const nomePf = pf => { const d = PERM.perfis && PERM.perfis[pf]; return (d && d.nome) || pf || ''; };
    const linha = (uid, c, d) => { const u = porUid.get(uid) || {}, ca = q.contaPorId.get(uid);
      linhas.push({ uid, nome: u.nome || nomeConta(uid), perfil: u.perfil || '', perfilNome: nomePf(u.perfil), ativo: u.ativo !== false && !!(ca && ca.ativo), curso: c.id, cursoTitulo: c.titulo, nCaps: c.caps.length,
        feitos: d ? Object.keys(d.caps || {}).filter(k => c.caps.some(x => x.id === k)).length : 0, acertos: d ? +d.acertos || 0 : 0, total: d ? +d.total || 0 : 0,
        ini: d ? d.ini || null : null, em: d ? d.em || null : null, concluido: d ? d.concluido || null : null, situacao: situacao(d), tent: d ? d.tent || 0 : 0 }); visto.add(uid + '|' + c.id); };
    for (const c of cat.cursos) {
      const ps = perfisDo(c);
      if (!desligado(c)) for (const u of usrs) if (u.ativo !== false && ps.includes(u.perfil)) linha(u.uid, c, docs.get(u.uid + '|' + c.id) || null);
      for (const [k, d] of docs) { const [uid, cid] = k.split('|'); if (cid === c.id && !visto.has(k)) linha(uid, c, d); }
    }
    return { cursos: cat.cursos.map(c => ({ id: c.id, titulo: c.titulo, nCaps: c.caps.length, perfis: perfisDo(c), off: desligado(c) })), linhas };
  }
  async function rota(p, m, req, res, conta) {
    if (!p.startsWith('/api/treino/')) return false;
    if (p === '/api/treino/cursos' && m === 'GET') { json(res, 200, cursosDe(conta)); return true; }
    if (p === '/api/treino/acomp' && m === 'GET') {
      if (!veTodos(conta)) { json(res, 403, { code: 'not_granted', erro: 'Só o Administrador, o dono e o RH acompanham os treinamentos da equipe.' }); return true; }
      json(res, 200, acomp()); return true;
    }
    if (p === '/api/treino/zerar' && m === 'POST') {
      if (!ehAdmin(conta)) { auditar(conta, req, 'TREINO_ZERAR_NEGADO', p, null, null); json(res, 403, { code: 'not_granted', erro: 'Só o Administrador ou o dono zeram o progresso de treinamento.' }); return true; }
      const b = await lerJson(req), uid = String(b.uid || ''), cid = String(b.curso || '');
      if (!UID.test(uid) || !ID.test(cid)) { json(res, 400, { code: 'invalid_argument', erro: 'Pessoa ou curso inválido.' }); return true; }
      const dp = 'treino/' + uid + '/c/' + cid, r = q.docGet.get(dp);
      if (!r) { json(res, 404, { code: 'not_found', erro: 'Esta pessoa não tem progresso neste curso.' }); return true; }
      let velho = null; try { velho = JSON.parse(r.data); } catch (e) { }
      q.docDel.run(dp); avisarDoc('del', dp, null, Date.now());
      auditar(conta, req, 'TREINO_ZERADO', dp, resumo(velho), { pessoa: nomeUsr(uid), motivo: String(b.motivo || '').slice(0, 300) || null });
      json(res, 200, { ok: true }); return true;
    }
    json(res, 404, { code: 'not_found', erro: 'Rota de treinamento não encontrada.' }); return true;
  }
  return { podeLer, antes, antesExcluir, cfgAntes, rota, catalogo, acesso, veTodos };
};

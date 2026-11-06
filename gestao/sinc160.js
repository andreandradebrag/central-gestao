'use strict';
/* v160: leitura incremental das coleções (relatorios/feito_v160.md).
   - Cada gravação no banco recebe um número de revisão crescente (docs.rev), dado por gatilhos do SQLite: vale para
     qualquer módulo que grave na tabela docs (rotas, Sólides, importação, regras).
   - Cada exclusão deixa uma marca (docs_del: caminho, revisão e hora). As marcas com mais de 45 dias são apagadas uma vez
     por dia; quem pedir mudanças desde antes disso recebe a coleção inteira.
   - GET /api/db/col?path=x&desde=<rev>&ep=<época> devolve só o que mudou desde <rev> (docs) e o que saiu (del), mais a
     revisão atual (rev) e a época (ep). A época junta um número sorteado a cada subida do servidor com a assinatura do
     que decide o que a pessoa pode ver (perfil, nível, locais da frota, conversas do chat...). Época diferente, revisão
     maior que a do banco ou marca de exclusão já apagada: a resposta é a coleção inteira (inc: 0), como antes.
   - Sem "desde" (navegador antigo) a resposta é a de sempre ({docs}), só com rev e ep a mais.
   - Coleções de saúde (registro de leitura por pessoa e dia, LGPD) sempre vêm inteiras.
   - Documento alterado que a pessoa não pode mais ver sai em "del" (só o id), para sumir também da cópia do navegador.
   - /api/eu passa a mandar a chave da cópia local (ck), derivada da conta com um segredo do servidor: a cópia guardada no
     navegador (shim.js, cifrada com AES-GCM) só abre para quem entrar com a mesma conta. */
const crypto = require('node:crypto');

/* coleções cujo conteúdo muda o que outras pessoas podem ver ou como veem (a época é recalculada quando mudam) */
const DEP = ['usr', 'func', 'cfg', 'veic', 'perfc', 'parc'];
const VEIC = new Set(['veic', 'vsai', 'vabas', 'vman', 'multa', 'mult', 'vrota', 'ventr']);
const MANTER_DEL_MS = 45 * 864e5;

module.exports = function (X) {
  const { db, q } = X;
  const depSql = p => "(" + p + ".parent IN (" + DEP.map(c => "'" + c + "'").join(',') + ") OR " + p + ".parent LIKE 'cm/%/c')";
  db.exec(`CREATE TABLE IF NOT EXISTS docs_seq(k INTEGER PRIMARY KEY, n INTEGER NOT NULL);
INSERT OR IGNORE INTO docs_seq(k, n) VALUES(1, 0), (2, 0);
CREATE TABLE IF NOT EXISTS docs_del(path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, em INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS docs_del_pr ON docs_del(parent, rev);`);
  try { db.exec('ALTER TABLE docs ADD COLUMN rev INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* já existe */ }
  db.exec(`CREATE INDEX IF NOT EXISTS docs_parent_rev ON docs(parent, rev);
CREATE TRIGGER IF NOT EXISTS docs160_i AFTER INSERT ON docs BEGIN
  UPDATE docs_seq SET n = n + 1 WHERE k = 1;
  UPDATE docs SET rev = (SELECT n FROM docs_seq WHERE k = 1) WHERE path = NEW.path;
  DELETE FROM docs_del WHERE path = NEW.path;
  UPDATE docs_seq SET n = n + 1 WHERE k = 2 AND ${depSql('NEW')};
END;
CREATE TRIGGER IF NOT EXISTS docs160_u AFTER UPDATE OF data ON docs BEGIN
  UPDATE docs_seq SET n = n + 1 WHERE k = 1;
  UPDATE docs SET rev = (SELECT n FROM docs_seq WHERE k = 1) WHERE path = NEW.path;
  UPDATE docs_seq SET n = n + 1 WHERE k = 2 AND ${depSql('NEW')};
END;
CREATE TRIGGER IF NOT EXISTS docs160_d AFTER DELETE ON docs BEGIN
  UPDATE docs_seq SET n = n + 1 WHERE k = 1;
  INSERT OR REPLACE INTO docs_del(path, parent, id, rev, em) VALUES(OLD.path, OLD.parent, OLD.id, (SELECT n FROM docs_seq WHERE k = 1), CAST(strftime('%s','now') AS INTEGER) * 1000);
  UPDATE docs_seq SET n = n + 1 WHERE k = 2 AND ${depSql('OLD')};
END;`);
  const st = {
    seq: db.prepare('SELECT n FROM docs_seq WHERE k = 1'),
    dep: db.prepare('SELECT n FROM docs_seq WHERE k = 2'),
    mud: db.prepare('SELECT id, data, ts FROM docs WHERE parent = ? AND rev > ?'),
    del: db.prepare('SELECT id FROM docs_del WHERE parent = ? AND rev > ?'),
    revDoc: db.prepare('SELECT rev FROM docs WHERE path = ?'),
    revDel: db.prepare('SELECT rev FROM docs_del WHERE path = ?'),
    podar: db.prepare('DELETE FROM docs_del WHERE em < ?'),
    podarMax: db.prepare('SELECT max(rev) AS r FROM docs_del WHERE em < ?'),
    cfgGet: db.prepare('SELECT v FROM cfg WHERE k = ?'),
    cfgPut: db.prepare('INSERT INTO cfg(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    chatConv: db.prepare("SELECT path, data FROM docs WHERE parent LIKE 'cm/%/c' ORDER BY path"),
    veics: db.prepare("SELECT id, data FROM docs WHERE parent = 'veic' ORDER BY id"),
    parcs: db.prepare("SELECT id, data FROM docs WHERE parent = 'parc' ORDER BY id")
  };
  const ERA = crypto.randomBytes(6).toString('base64url'); /* nova a cada subida: depois de reiniciar (ou restaurar a cópia de segurança), todo mundo recebe tudo de novo uma vez */
  let segredo = (st.cfgGet.get('cache160') || {}).v;
  if (!segredo) { segredo = crypto.randomBytes(32).toString('hex'); st.cfgPut.run('cache160', segredo); }
  const seq = () => (st.seq.get() || { n: 0 }).n;
  const delMin = () => +((st.cfgGet.get('del160_min') || {}).v || 0);
  function podar() {
    try { const lim = Date.now() - MANTER_DEL_MS, r = (st.podarMax.get(lim) || {}).r; if (r) { st.cfgPut.run('del160_min', String(Math.max(r, delMin()))); st.podar.run(lim); } } catch (e) { console.error('[sinc160] podar', e.message); }
  }
  podar(); const tPodar = setInterval(podar, 864e5); if (tPodar.unref) tPodar.unref();

  /* ---------- época (o que decide o que a pessoa vê) ---------- */
  const est = v => v === null || typeof v !== 'object' ? JSON.stringify(v === undefined ? null : v) : Array.isArray(v) ? '[' + v.map(est).join(',') + ']' : '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + est(v[k])).join(',') + '}';
  const h16 = s => crypto.createHash('sha256').update(s).digest('base64url').slice(0, 16);
  const ler = r => { try { return JSON.parse(r.data); } catch (e) { return null; } };
  let depVisto = -1; const memoConta = new Map(), memoParte = {};
  function partesGlobais() {
    const dv = (st.dep.get() || { n: 0 }).n;
    if (dv !== depVisto) {
      depVisto = dv; memoConta.clear();
      const conv = [];
      for (const r of st.chatConv.all()) { const d = ler(r) || {}; conv.push([r.path, d.tipo || '', Array.isArray(d.membros) ? d.membros.slice().sort() : []]); }
      memoParte.chat = h16(est(conv));
      memoParte.veic = h16(est(st.veics.all().map(r => [r.id, (ler(r) || {}).local || ''])));
      memoParte.parc = h16(est(st.parcs.all().map(r => [r.id, (ler(r) || {}).nome || ''])));
      let cfg = null; try { const r = q.docGet.get('cfg/empresa'); cfg = r ? ler(r) : null; } catch (e) { }
      memoParte.cfg = h16(est((cfg && cfg.frotaLocais) || []));
    }
    return memoParte;
  }
  function baseConta(conta) {
    const g = partesGlobais(), pf = X.perfilDe(conta), k = conta.id + '|' + conta.nivel + '|' + conta.ativo + '|' + pf;
    const m = memoConta.get(conta.id); if (m && m.k === k && m.perm === X.PERM.perfis) return m.h;
    let u = null; const fs_ = [];
    try { for (const r of q.colGet.all('usr')) { const d = ler(r); if (d && d.uid === conta.id) { u = { perfil: d.perfil || '', ativo: d.ativo !== false, locaisVeic: d.locaisVeic || [] }; } } } catch (e) { }
    try { for (const r of q.colGet.all('func')) { const d = ler(r); if (d && d.usrId === conta.id) fs_.push([r.id, d.locaisVeic || []]); } } catch (e) { }
    let semUsr = false; try { semUsr = !q.colGet.all('usr').length; } catch (e) { }
    const h = h16(est([conta.id, conta.nivel, !!conta.ativo, pf, (X.PERM.perfis || {})[pf] || null, u, fs_.sort(), g.cfg, semUsr]));
    memoConta.set(conta.id, { k, h, perm: X.PERM.perfis }); return h;
  }
  /* época de uma coleção para uma conta */
  function epoca(conta, cp) {
    const g = partesGlobais(), c0 = cp.split('/')[0];
    let extra = '';
    if (c0 === 'cm') extra = cp.split('/')[1] === conta.id ? '' : g.chat;
    else if (VEIC.has(c0)) extra = g.veic;
    else if (c0 === 'proj' || c0 === 'lixo') extra = g.parc;
    return ERA + '.' + baseConta(conta) + (extra ? '.' + extra.slice(0, 8) : '');
  }

  /* ---------- leitura de coleção ---------- */
  /* devolve o corpo da resposta incremental, ou null para responder a coleção inteira */
  function incremental(conta, cp, desde, ep) {
    const atual = seq(), e = epoca(conta, cp);
    if (!(desde >= 0) || desde > atual || ep !== e || desde < delMin()) return null;
    const memo = new Map(), docs = [], del = [];
    for (const r of st.mud.all(cp, desde)) {
      let d; try { d = JSON.parse(r.data); } catch (x) { continue; }
      const p = cp + '/' + r.id;
      if (X.podeVer(conta, p, d, memo)) docs.push({ id: r.id, data: X.redigir(conta, p, d), ts: r.ts }); else del.push(r.id);
    }
    for (const r of st.del.all(cp, desde)) del.push(r.id);
    return { docs, del, rev: atual, ep: e, inc: 1 };
  }
  /* revisão da gravação que acabou de acontecer (vai junto do aviso ao vivo) */
  function revDe(op, p) { try { const r = op === 'del' ? st.revDel.get(p) : st.revDoc.get(p); return r ? r.rev : seq(); } catch (e) { return undefined; } }
  /* chave da cópia local (AES-GCM, 256 bits): só quem entra com a conta recebe */
  const chave = conta => crypto.createHmac('sha256', segredo).update('cache160|' + conta.id).digest('base64url');
  return { incremental, epoca, seq, revDe, chave, ERA, podar, delMin };
};

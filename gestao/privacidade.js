'use strict';
/* Central de Gestão — privacidade no servidor (v112, relatorios/juridico_v3.md: B2, B3, B4, B5 e B9)
   1. Auditoria com só os campos alterados e dados pessoais protegidos: CPF, conta bancária e PIX, salário e valores
      de folha e todos os campos das coleções de saúde (ASO, afastamentos, acidentes, psicossocial) viram
      "(protegido · h:<hash>)". O hash é HMAC-SHA256 com uma chave do servidor (AUDITORIA_CHAVE ou uma chave
      aleatória guardada no banco): permite ver que o valor mudou ou voltou ao anterior, sem mostrar o valor.
      Migração única dos registros antigos (aud_masc_v1), em lotes, sem travar a partida.
   2. Anonimização de um titular (func, parc, cand, tterc com anon:true) também anonimiza os registros de
      auditoria sobre ele (o caminho do cadastro e as menções ao nome, CPF, e-mail e telefone). As ações FEITAS pela
      pessoa como usuária (login, aprovações) ficam com o identificador da conta até vencer o prazo da auditoria
      (AUDITORIA_DIAS), para segurança e defesa (LGPD, art. 7º, VI e IX, e art. 16, I e II).
   3. Leitura das coleções de saúde (rhdoc, afast, acid, psr e anexos delas): uma linha de auditoria por
      pessoa, coleção e dia (LEITURA_SAUDE), com os registros lidos (sem o conteúdo).
   4. Relatório do titular gerado no servidor com todas as coleções (POST /api/lgpd/titular): colaborador,
      candidato, trabalhador terceiro ou pessoa física cadastrada; chat só com metadados; auditoria do titular.
   5. Uso da IA registrado (quem, quando, função, tamanho), sem o conteúdo.
   6. GET /api/lgpd/prazos: prazos aplicados pelo servidor (auditoria, lixeira de anexos, cópias de segurança). */
const crypto = require('node:crypto');

module.exports = function (X) {
  const { db, q, perfilDe, NIV, ipDe } = X;
  const SAUDE = new Set(['rhdoc', 'afast', 'acid', 'psr', 'ppp', 'psicamp']); /* auditoria: todos os campos protegidos */
  const SAUDE_LEIT = new Set(['rhdoc', 'afast', 'acid', 'psr']); /* registro de leitura */
  const FOLHA = new Set(['fpag', 'fofi', 'foimp', 'emprest', 'desl', 'ferias', 'dpmov', 'adm', 'esoc', 'dpsol', 'bhlanc', 'adtoit', 'adto']);
  const SEGREDOS = /^(senha|senha2|atual|nova|codigo|rec|token|segredo|hash|totp|img)$/i;
  const KEEP = /^(id|_alterados|ts|ed|edBy|crBy|cr|em|por|criadoEm|criadoPor|editEm|editPor|srv|[a-zA-Z]+Id|uid|usrId|col|rid|mes|comp|status|st|tipo|data)$/;
  const KEEP_SAUDE = /^(id|_alterados|ts|ed|edBy|crBy|cr|em|por|criadoEm|criadoPor|editEm|editPor|srv|funcId|tercId|usrId|uid|col|rid)$/;
  const CAMPO_SENS = /^(cpf|cpfs|rg|pis|nis|ctps|cnhNum|tituloEleitor|reservista|banco|agencia|contaTipo|pix|pixTipo|chavePix|bancoPend|bancoHist|salario|salarios|salHist|salBase|salarioBase|remuneracao|liquido|bruto|proventos|descontos|ben[A-Z]\w*|pensao\w*|diag\w*|cid|cid10|aso[A-Z]?\w*|exame\w*|restric\w*|laudo\w*|atestado\w*|doenca\w*|saude\w*|alerg\w*|sangue|defic\w*|gestante|gravidez|gestEm|dataParto|afastMotivo|lesao\w*|parteCorpo|medico|crm)$/;
  const CPF_RE = /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/;
  const NUM_RE = /^-?\d{1,3}(\.?\d{3})*(,\d+)?$|^-?\d+(\.\d+)?$/;
  const LANC_SENS = new Set(['desc', 'valor', 'valorPago', 'foFunc', 'obs', 'foKey', 'juros', 'multa', 'descPago']);

  /* ---------- chave do hash ---------- */
  let CH = null;
  function chave() {
    if (CH) return CH;
    if (process.env.AUDITORIA_CHAVE) { CH = crypto.createHash('sha256').update('auditoria|' + process.env.AUDITORIA_CHAVE).digest(); return CH; }
    let r = db.prepare("SELECT v FROM cfg WHERE k='aud_chave'").get();
    if (!r) { db.prepare("INSERT OR IGNORE INTO cfg(k,v) VALUES('aud_chave',?)").run(crypto.randomBytes(32).toString('hex')); r = db.prepare("SELECT v FROM cfg WHERE k='aud_chave'").get(); }
    CH = Buffer.from(r.v, 'hex'); return CH;
  }
  const est = v => { if (v === undefined || v === null) return 'null'; if (Array.isArray(v)) return '[' + v.map(est).join(',') + ']'; if (typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined && v[k] !== null).sort().map(k => JSON.stringify(k) + ':' + est(v[k])).join(',') + '}'; return JSON.stringify(v); };
  const igual = (a, b) => est(a) === est(b);
  const hash = v => crypto.createHmac('sha256', chave()).update(est(typeof v === 'string' && CPF_RE.test(v.trim()) ? v.replace(/\D/g, '') : v)).digest('hex').slice(0, 12);
  const PROT_RE = /^\(protegido · h:[0-9a-f]{12}\)$|^\(oculto\)$|^\(anonimizado\)$/;
  const prot = v => (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) ? v : (typeof v === 'string' && PROT_RE.test(v)) ? v : '(protegido · h:' + hash(v) + ')';
  const ehLancFolha = d => !!d && typeof d === 'object' && (d.sens === 'rh' || (!!d.foFunc && /^fo\|/.test(String(d.foKey || ''))));

  /* ---------- mascaramento ---------- */
  function mascarar(o, ctx, n) {
    n = n || 0;
    if (o == null) return o;
    if (typeof o !== 'object') {
      if (typeof o === 'string') { if (CPF_RE.test(o.trim())) return prot(o); return o.length > 2000 ? o.slice(0, 2000) + '…' : o; }
      return o;
    }
    if (n > 6) return '…';
    if (Array.isArray(o)) return o.slice(0, 200).map(x => mascarar(x, ctx, n + 1));
    const r = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (SEGREDOS.test(k)) r[k] = v ? '(oculto)' : v;
      else if (k === '_alterados') r[k] = v;
      else if (ctx.saude && !KEEP_SAUDE.test(k)) r[k] = prot(v);
      else if (CAMPO_SENS.test(k)) r[k] = prot(v);
      else if (ctx.banco && (k === 'conta' || k === 'contaDv')) r[k] = prot(v); /* conta bancária (em outras coleções "conta" é a conta de acesso) */
      else if ((k === 'doc' || k === 'documento' || k === 'cpfCnpj') && typeof v === 'string' && v.replace(/\D/g, '').length === 11) r[k] = prot(v);
      else if (ctx.lancFolha && LANC_SENS.has(k)) r[k] = prot(v);
      else if (ctx.folha && !KEEP.test(k) && (typeof v === 'number' || (typeof v === 'string' && NUM_RE.test(v.trim())))) r[k] = prot(v);
      else r[k] = mascarar(v, ctx, n + 1);
    }
    return r;
  }
  const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o);
  const IGN = new Set(['ts', 'ed', 'edBy']);
  /* caminho de documento ("col/id", "pt/<uid>/sl/<id>") ou de rota ("/api/...") → contexto do mascaramento */
  function contexto(caminho, antes, depois) {
    const s = String(caminho || ''), c0 = s.startsWith('/') ? '' : s.split('/')[0];
    return { c0, banco: ['parc', 'func', 'remessa', 'pt', 'adto', 'adtoit', 'emprest', 'cand', 'tterc'].includes(c0), saude: SAUDE.has(c0), folha: FOLHA.has(c0), lancFolha: c0 === 'lanc' && (ehLancFolha(antes) || ehLancFolha(depois)) };
  }
  /* o que vai para a auditoria: em alteração de documento, só os campos alterados */
  function paraAuditoria(caminho, metodo, antes, depois) {
    const ctx = contexto(caminho, antes, depois), ehDoc = ctx.c0 !== '';
    if (ehDoc && ctx.c0 === 'lixo' && antes && !depois) return [{ col: antes.col, rid: antes.rid, _lixeira: true }, null]; /* exclusão da lixeira: só a referência */
    if (ehDoc && isObj(antes) && isObj(depois)) {
      const ks = [...new Set(Object.keys(antes).concat(Object.keys(depois)))].filter(k => !IGN.has(k) && !igual(antes[k], depois[k]));
      const a = {}, b = {}; ks.forEach(k => { if (antes[k] !== undefined) a[k] = antes[k]; if (depois[k] !== undefined) b[k] = depois[k]; });
      return [mascarar(a, ctx), Object.assign(mascarar(b, ctx), { _alterados: ks })];
    }
    return [antes == null ? antes : mascarar(antes, ctx), depois == null ? depois : mascarar(depois, ctx)];
  }
  /* termos de titulares anonimizados há pouco: novos registros (ex.: exclusão das cópias na lixeira logo depois) também saem sem eles */
  const TERMOS = []; /* {t, ate} */
  function semTermos(txt) {
    if (txt == null || !TERMOS.length) return txt; const agora = Date.now();
    for (let i = TERMOS.length - 1; i >= 0; i--) if (TERMOS[i].ate < agora) TERMOS.splice(i, 1);
    for (const x of TERMOS) { const j = JSON.stringify(x.t).slice(1, -1); if (j && txt.includes(j)) txt = txt.split(j).join('(titular anonimizado)'); }
    return txt;
  }
  const corta = t => { if (t == null) return null; let s = JSON.stringify(t); if (s.length > 65536) s = s.slice(0, 65536) + '…(cortado)'; return semTermos(s); };

  /* ---------- migração única dos registros antigos ---------- */
  function converterLinha(r) {
    const pj = t => { if (t == null) return { ok: true, v: null }; try { return { ok: true, v: JSON.parse(t) }; } catch (e) { return { ok: false }; } };
    const a = pj(r.antes), b = pj(r.depois);
    const RUIM = '"(conteúdo antigo removido na v112: não foi possível proteger os dados pessoais)"';
    if (!a.ok || !b.ok) return [a.ok ? corta(paraAuditoria(r.caminho, r.metodo, a.v, null)[0]) : (r.antes == null ? null : RUIM), b.ok ? corta(paraAuditoria(r.caminho, r.metodo, null, b.v)[1]) : (r.depois == null ? null : RUIM)];
    if (/^"\(mensagem\)"$/.test(String(r.antes)) || /^"\(mensagem\)"$/.test(String(r.depois))) return [r.antes, r.depois];
    const [x, y] = paraAuditoria(r.caminho, r.metodo, a.v, b.v); return [corta(x), corta(y)];
  }
  let migrando = false;
  function migrarAuditoria(cb) {
    if (migrando) return; const ja = db.prepare("SELECT v FROM cfg WHERE k='aud_masc_v1'").get(); if (ja) { if (cb) cb(); return; }
    migrando = true;
    let mx = db.prepare("SELECT v FROM cfg WHERE k='aud_masc_max'").get();
    if (!mx) { const m = db.prepare('SELECT max(id) AS m FROM auditoria').get().m || 0; db.prepare("INSERT OR REPLACE INTO cfg(k,v) VALUES('aud_masc_max',?)").run(String(m)); mx = { v: String(m) }; }
    const max = +mx.v || 0, sel = db.prepare('SELECT id, caminho, metodo, antes, depois FROM auditoria WHERE id>? AND id<=? ORDER BY id LIMIT 300'), up = db.prepare('UPDATE auditoria SET antes=?, depois=? WHERE id=?');
    let total = 0;
    const passo = () => {
      try {
        const ptr = +((db.prepare("SELECT v FROM cfg WHERE k='aud_masc_ptr'").get() || {}).v || 0), rs = sel.all(ptr, max);
        if (!rs.length) {
          db.prepare("INSERT OR REPLACE INTO cfg(k,v) VALUES('aud_masc_v1',?)").run(String(Date.now()));
          st.aud.run(Date.now(), null, null, 'AUDITORIA_MIGRADA', 'auditoria', null, JSON.stringify({ registros: total, ate: max }));
          migrando = false; if (total) console.log('[auditoria] registros antigos protegidos:', total); if (cb) cb(); return;
        }
        db.exec('BEGIN');
        try { for (const r of rs) { const [a, b] = converterLinha(r); up.run(a, b, r.id); } db.prepare("INSERT OR REPLACE INTO cfg(k,v) VALUES('aud_masc_ptr',?)").run(String(rs[rs.length - 1].id)); db.exec('COMMIT'); total += rs.length; }
        catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
      } catch (e) { console.error('[auditoria] migração:', e.message); migrando = false; return; }
      setTimeout(passo, 15);
    };
    setTimeout(passo, +process.env.AUDITORIA_MIGRAR_ESPERA_MS || 2000);
  }
  const st = { aud: db.prepare('INSERT INTO auditoria(ts,conta,ip,metodo,caminho,antes,depois) VALUES(?,?,?,?,?,?,?)') };

  /* ---------- anonimização: registros de auditoria sobre o titular ---------- */
  const fmtCpf = d => d.length === 11 ? d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9) : '';
  function termosDe(d) {
    const t = new Set(), add = v => { v = String(v == null ? '' : v).trim(); if (v.length >= 6) t.add(v); };
    if (!d) return [];
    add(d.nome); add(d.email); add(d.telefone); add(d.tel); add(d.celular); add(d.recTel);
    for (const k of ['cpf', 'doc']) { const dg = String(d[k] || '').replace(/\D/g, ''); if (dg.length === 11) { t.add(dg); t.add(fmtCpf(dg)); } }
    return [...t];
  }
  function trocaTermos(o, termos) {
    if (o == null) return o; if (typeof o === 'string') { let s = o; for (const t of termos) if (s.includes(t)) s = s.split(t).join('(titular anonimizado)'); return s; }
    if (typeof o !== 'object') return o; if (Array.isArray(o)) return o.map(x => trocaTermos(x, termos));
    const r = {}; for (const k of Object.keys(o)) r[k] = trocaTermos(o[k], termos); return r;
  }
  function tudoAnon(o, n) {
    n = n || 0; if (o == null || n > 8) return o;
    if (typeof o !== 'object') return typeof o === 'boolean' ? o : '(anonimizado)';
    if (Array.isArray(o)) return o.map(x => tudoAnon(x, n + 1));
    const r = {}; for (const k of Object.keys(o)) r[k] = KEEP_SAUDE.test(k) || k === 'anon' || k === 'anonEm' ? o[k] : tudoAnon(o[k], n + 1); return r;
  }
  function anonimizarAuditoria(p, antes) {
    const termos = termosDe(antes), up = db.prepare('UPDATE auditoria SET antes=?, depois=? WHERE id=?'), pj = t => { try { return t == null ? null : JSON.parse(t); } catch (e) { return undefined; } };
    let n = 0; const vistos = new Set();
    db.exec('BEGIN');
    try {
      for (const r of db.prepare('SELECT id, antes, depois FROM auditoria WHERE caminho=?').all(p)) {
        const a = pj(r.antes), b = pj(r.depois); vistos.add(r.id);
        up.run(a === undefined ? '"(anonimizado)"' : a == null ? null : JSON.stringify(tudoAnon(a)), b === undefined ? '"(anonimizado)"' : b == null ? null : JSON.stringify(tudoAnon(b)), r.id); n++;
      }
      for (const t of termos) {
        const lk = '%' + JSON.stringify(t).slice(1, -1).replace(/[\\%_]/g, '\\$&') + '%';
        for (const r of db.prepare("SELECT id, antes, depois FROM auditoria WHERE antes LIKE ? ESCAPE '\\' OR depois LIKE ? ESCAPE '\\' LIMIT 50000").all(lk, lk)) {
          if (vistos.has(r.id)) continue; vistos.add(r.id);
          const a = pj(r.antes), b = pj(r.depois), tx = (v, raw) => v === undefined ? semTermosLista(raw, termos) : v == null ? null : JSON.stringify(trocaTermos(v, termos));
          up.run(tx(a, r.antes), tx(b, r.depois), r.id); n++;
        }
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } console.error('[auditoria] anonimização:', e.message); }
    const ate = Date.now() + 3600e3; termos.forEach(t => TERMOS.push({ t, ate }));
    return n;
  }
  function semTermosLista(raw, termos) { let s = String(raw); for (const t of termos) { const j = JSON.stringify(t).slice(1, -1); s = s.split(j).join('(titular anonimizado)'); } return s; }
  /* depois de gravar: anonimização de titular */
  function aposGravar(auditar, conta, req, p, antes, depois) {
    const s = String(p).split('/');
    if (s.length !== 2 || !['func', 'parc', 'cand', 'tterc'].includes(s[0]) || !depois || !depois.anon || (antes && antes.anon) || !antes) return;
    const n = anonimizarAuditoria(p, antes);
    auditar(conta, req, 'LGPD_ANONIMIZACAO_AUDITORIA', p, null, { registros: n, regra: 'registros sobre o titular anonimizados; ações feitas pela conta do titular ficam até o fim do prazo da auditoria' });
  }

  /* ---------- leitura de dados de saúde: uma linha por pessoa, coleção e dia ---------- */
  db.exec('CREATE TABLE IF NOT EXISTS leitura_saude(dia TEXT NOT NULL, conta TEXT NOT NULL, col TEXT NOT NULL, aud INTEGER, n INTEGER, ids TEXT, PRIMARY KEY(dia, conta, col))');
  const diaSP = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const ls = { get: db.prepare('SELECT * FROM leitura_saude WHERE dia=? AND conta=? AND col=?'), ins: db.prepare('INSERT INTO leitura_saude(dia,conta,col,aud,n,ids) VALUES(?,?,?,?,?,?)'), up: db.prepare('UPDATE leitura_saude SET n=?, ids=? WHERE dia=? AND conta=? AND col=?'), aud: db.prepare('UPDATE auditoria SET depois=? WHERE id=?') };
  const ehSaude = c0 => SAUDE_LEIT.has(c0);
  function registrarLeitura(conta, req, col, ids, via) {
    try {
      if (!conta || !ids || !ids.length) return; const dia = diaSP(), cid = conta.id || String(conta), r = ls.get.get(dia, cid, col);
      if (!r) {
        const lista = [...new Set(ids)].slice(0, 500), dep = { registros: lista, total: lista.length, leituras: 1, via: via || 'lista', obs: 'Uma linha por pessoa, coleção e dia; sem o conteúdo.' };
        const info = st.aud.run(Date.now(), cid, req ? ipDe(req) : null, 'LEITURA_SAUDE', col, null, JSON.stringify(dep));
        ls.ins.run(dia, cid, col, Number(info.lastInsertRowid), 1, JSON.stringify(lista)); return;
      }
      let lista = []; try { lista = JSON.parse(r.ids || '[]'); } catch (e) { }
      const s = new Set(lista), antes = s.size; ids.forEach(i => { if (s.size < 500) s.add(i); });
      const n = (r.n || 0) + 1; lista = [...s];
      ls.up.run(n, JSON.stringify(lista), dia, cid, col);
      ls.aud.run(JSON.stringify({ registros: lista, total: lista.length, leituras: n, via: via || 'lista', obs: 'Uma linha por pessoa, coleção e dia; sem o conteúdo.' }), r.aud);
    } catch (e) { console.error('[auditoria] leitura:', e.message); }
  }
  setInterval(() => { try { db.prepare('DELETE FROM leitura_saude WHERE dia<?').run(new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)); } catch (e) { } }, 6 * 3600e3).unref();

  /* ---------- IA: uso registrado sem o conteúdo ---------- */
  function resumoIa(req, corpo, ok, erro) {
    let chars = 0, msgs = 0;
    if (Array.isArray(corpo.input)) corpo.input.forEach(m => { msgs++; chars += String(m && m.content || '').length; }); else { msgs = 1; chars = String(corpo.input || '').length; }
    const ims = Array.isArray(corpo.images) ? corpo.images : [];
    const funcao = String(req.headers['x-ia-funcao'] || corpo.funcao || '').replace(/[^\w\-.: ]/g, '').slice(0, 60) || 'não informada';
    return { funcao, modelo: String(corpo.modelTier || 'default').slice(0, 20), mensagens: msgs, caracteres: chars, imagens: Math.min(ims.length, 8), imagensKB: Math.round(ims.slice(0, 8).reduce((s, im) => s + String(im && im.data || '').length * 0.75, 0) / 1024), ok: !!ok, erro: erro ? String(erro).slice(0, 200) : undefined, obs: 'Conteúdo não registrado.' };
  }

  /* ---------- relatório do titular ---------- */
  const TIPOS = { func: 'Colaborador ou ex-colaborador', cand: 'Candidato', tterc: 'Trabalhador terceiro', parc: 'Pessoa física cadastrada (cliente ou fornecedor)' };
  const SEM_REL = new Set(['arqdb', 'cotlink', 'pesqlink', 'cfg', 'leitura_saude']);
  const META = /^(id|data|mes|comp|numero|tipo|status|st|em|cr|ts|nome|desc|titulo|periodo|ini|fim|inicio)$/;
  function relatorioTitular(conta, b, lim) {
    lim = lim || {};
    const tipo = String(b.tipo || ''), id = String(b.id || '');
    if (!TIPOS[tipo] || !/^[\w\-.|~@+=]{1,200}$/.test(id)) return { erro: 'Titular inválido.', st: 400 };
    const pb = tipo + '/' + id, r0 = q.docGet.get(pb); if (!r0) return { erro: 'Cadastro não encontrado.', st: 404 };
    let base; try { base = JSON.parse(r0.data); } catch (e) { return { erro: 'Cadastro ilegível.', st: 500 }; }
    const ids = new Set([id]), uid = tipo === 'func' && base.usrId ? String(base.usrId) : ''; if (uid) ids.add(uid);
    const dg = String(base.cpf || (tipo === 'parc' ? base.doc : '') || '').replace(/\D/g, ''), cpf = dg.length === 11 ? dg : '';
    const ref = v => typeof v === 'string' && (ids.has(v) || (!!cpf && /\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2}/.test(v) && v.replace(/\D/g, '') === cpf));
    const contem = (o, n) => { n = n || 0; if (o == null || n > 10) return false; if (typeof o !== 'object') return ref(o); if (Array.isArray(o)) return o.some(x => contem(x, n + 1)); return Object.values(o).some(x => contem(x, n + 1)); };
    const recorte = (o, n) => { n = n || 0; if (!isObj(o)) return o; const top = Object.values(o).some(v => (v == null || typeof v !== 'object') && ref(v)), r = {};
      for (const k of Object.keys(o)) { const v = o[k]; if (SEGREDOS.test(k)) continue;
        if (v == null || typeof v !== 'object') { if (top || META.test(k) || ref(v)) r[k] = v; }
        else if (Array.isArray(v)) { const f = v.filter(x => x && typeof x === 'object' ? contem(x) : ref(x)); if (f.length) r[k] = f.map(x => isObj(x) ? recorte(x, n + 1) : x); else if (top) r[k] = v; }
        else if (top || contem(v)) r[k] = top && !contem(v) ? v : recorte(v, n + 1); }
      return r; };
    const likes = [], args = [];
    for (const x of ids) { likes.push("data LIKE ? ESCAPE '\\'"); args.push('%' + JSON.stringify(x).replace(/[\\%_]/g, '\\$&') + '%'); }
    if (cpf) { likes.push('data LIKE ?', 'data LIKE ?'); args.push('%' + cpf + '%', '%' + fmtCpf(cpf) + '%'); }
    const MAXD = lim.maxDocs || 20000;
    let rows = db.prepare('SELECT path, parent, data, ts FROM docs WHERE path=? OR ' + (uid ? 'path LIKE ? OR ' : '') + '(' + likes.join(' OR ') + ') LIMIT ' + (MAXD + 1)).all(...[pb].concat(uid ? ['pt/' + uid + '/%'] : []).concat(args));
    const completo = rows.length <= MAXD, avisos = []; if (!completo) { rows = rows.slice(0, MAXD); avisos.push('Mais de ' + MAXD + ' registros: o relatório foi cortado.'); }
    const secoes = new Map(), paths = [];
    for (const r of rows) {
      const c0 = r.path.split('/')[0]; if (SEM_REL.has(c0) || c0 === 'cm') continue;
      let d; try { d = JSON.parse(r.data); } catch (e) { continue; }
      const proprio = r.path === pb || (uid && r.path.startsWith('pt/' + uid + '/')) || (c0 === 'usr' && uid && d.uid === uid);
      if (!proprio && !contem(d)) continue;
      const dados = proprio ? d : recorte(d);
      if (!secoes.has(c0)) secoes.set(c0, []); secoes.get(c0).push({ path: r.path, id: r.path.split('/').pop(), atualizado: r.ts, dados }); paths.push(r.path);
    }
    /* chat: só metadados */
    let chat = null;
    if (uid) {
      const m = db.prepare("SELECT count(*) AS n, min(ts) AS ini, max(ts) AS fim FROM docs WHERE parent=? OR parent=?").get('cm/' + uid + '/m', 'cm/' + uid + '/v');
      const convs = db.prepare("SELECT count(*) AS n FROM docs WHERE parent LIKE 'cm/%/c' AND (parent=? OR data LIKE ? ESCAPE '\\')").get('cm/' + uid + '/c', '%' + JSON.stringify(uid).replace(/[\\%_]/g, '\\$&') + '%');
      chat = { mensagensEnviadas: m.n || 0, primeira: m.ini || null, ultima: m.fim || null, conversas: convs.n || 0, obs: 'Só metadados: o conteúdo das mensagens não entra no relatório (ele cita outras pessoas). Peça ao administrador se precisar de uma conversa específica.' };
    }
    /* auditoria do titular */
    const MAXA = lim.maxAud || 3000, aud = [], vistos = new Set();
    /* detalhe: só os nomes dos campos alterados nos registros do próprio titular (sem valores nem quem fez) */
    const proprioP = c => c === pb || (!!uid && String(c).startsWith('pt/' + uid + '/'));
    const pushA = (r, porTitular) => { if (vistos.has(r.id) || aud.length >= MAXA) return; vistos.add(r.id); let dd = null; try { dd = JSON.parse(r.depois); } catch (e) { dd = null; }
      const campos = proprioP(r.caminho) && isObj(dd) ? (Array.isArray(dd._alterados) ? dd._alterados : Object.keys(dd)).filter(k => !/^(crBy|edBy|cr|ed|ts|por|em|_alterados)$/.test(k)) : undefined;
      aud.push({ quando: r.ts, acao: r.metodo, caminho: r.caminho, feitoPeloTitular: porTitular, ip: porTitular ? r.ip : undefined, campos }); };
    if (uid) db.prepare('SELECT * FROM auditoria WHERE conta=? ORDER BY ts DESC LIMIT ?').all(uid, MAXA).forEach(r => pushA(r, true));
    const pp = [pb].concat(paths.filter(x => x !== pb)).slice(0, 2000);
    for (let i = 0; i < pp.length; i += 200) { const ch = pp.slice(i, i + 200); db.prepare('SELECT * FROM auditoria WHERE caminho IN (' + ch.map(() => '?').join(',') + ') ORDER BY ts DESC LIMIT ?').all(...ch, MAXA).forEach(r => pushA(r, !!uid && r.conta === uid)); }
    const saudeIds = paths.filter(x => SAUDE_LEIT.has(x.split('/')[0]) && x.split('/').length === 2).map(x => x.split('/')[1]).slice(0, 200);
    for (const sid of saudeIds) db.prepare("SELECT * FROM auditoria WHERE metodo='LEITURA_SAUDE' AND depois LIKE ? ESCAPE '\\' LIMIT 200").all('%' + JSON.stringify(sid).replace(/[\\%_]/g, '\\$&') + '%').forEach(r => { if (vistos.has(r.id) || aud.length >= MAXA) return; vistos.add(r.id); aud.push({ quando: r.ts, acao: 'CONSULTA_DADO_SAUDE', caminho: r.caminho + '/' + sid, feitoPeloTitular: !!uid && r.conta === uid }); });
    if (aud.length >= MAXA) avisos.push('Auditoria limitada aos ' + MAXA + ' registros mais recentes.');
    aud.sort((a, b2) => b2.quando - a.quando);
    return { ok: true, completo: completo && aud.length < MAXA, geradoEm: Date.now(), geradoPor: conta.id, titular: { tipo, tipoNome: TIPOS[tipo], id, nome: base.nome || '' },
      secoes: [...secoes.entries()].map(([col, regs]) => ({ col, n: regs.length, registros: regs })), chat, auditoria: aud, avisos,
      nota: 'Relatório completo gerado pelo servidor com todas as coleções do sistema que citam o titular (pelo identificador do cadastro, da conta de acesso e pelo CPF), independentemente do perfil de quem gerou. A auditoria guarda dados pessoais protegidos (hash). Prazo de resposta: LGPD, art. 19.' };
  }
  const podeTitular = conta => !!conta && (conta.nivel === 'owner' || ['admin', 'rh'].includes(perfilDe(conta)));

  return { paraAuditoria, corta, migrarAuditoria, aposGravar, anonimizarAuditoria, registrarLeitura, ehSaude, SAUDE_LEIT, resumoIa, relatorioTitular, podeTitular, prot, mascarar, contexto };
};

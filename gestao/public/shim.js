/* Central de Gestão — ponte entre o sistema e o servidor próprio.
   Oferece ao sistema a mesma interface que a página publicada no Claude recebia
   (window.claude.use('db' | 'user' | 'room' | 'assets' | 'sample' | 'downloads' | 'mcp')),
   falando com o servidor deste mesmo endereço. */
(function () {
  'use strict';
  window.__SELFHOST = true;
  var EU = null, euP = null, cid = null, es = null, presPend = {}, temPres = false;
  var docSubs = new Map(), colSubs = new Map(), peersCbs = new Set(), lastPeers = [];
  function erro(code, message) { return { code: code, message: message || code }; }
  function api(method, url, body, headers) {
    var h = headers || {}, b;
    if (body instanceof Blob) b = body; else if (body !== undefined) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
    return fetch(url, { method: method, credentials: 'same-origin', headers: h, body: b }).then(function (r) {
      if (r.status === 401) { location.href = '/login'; throw erro('revoked', 'Sessão expirada.'); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw erro(j.code || (r.status === 403 ? 'not_granted' : r.status === 413 ? 'too_large' : r.status === 429 ? 'rate_limited' : 'unavailable'), j.erro || ('HTTP ' + r.status));
        return j;
      });
    }, function () { throw erro('unavailable', 'Sem conexão com o servidor.'); });
  }
  function eu() { if (!euP) euP = api('GET', '/api/eu').then(function (j) { EU = j; persIniciar(j); return j; }); return euP; }
  var clone = function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); };
  var META = { fromCache: false, hasPendingWrites: false };
  function docSnap(id, data) { return { id: id, exists: data != null, data: function () { return data == null ? undefined : clone(data); }, metadata: META }; }

  /* ---------- tempo real ---------- */
  function abrir() {
    if (es) return; es = new EventSource('/api/stream');
    es.addEventListener('hello', function (e) { cid = JSON.parse(e.data).cid; if (temPres) enviarPres(); ressinc(); });
    es.addEventListener('doc', function (e) { var ev = JSON.parse(e.data); aplicar(ev); });
    es.addEventListener('peers', function (e) { lastPeers = JSON.parse(e.data); peersCbs.forEach(function (f) { try { f({ peers: lastPeers }); } catch (x) { } }); });
    es.addEventListener('recarregar', function () { setTimeout(function () { location.reload(); }, 400); });
  }
  function aplicar(ev) {
    var s = docSubs.get(ev.path); if (s) { s.data = ev.op === 'del' ? null : ev.data; s.fns.forEach(function (f) { try { f(docSnap(ev.id, s.data)); } catch (x) { } }); }
    var cs = colSubs.get(ev.parent); if (cs) cs.forEach(function (sub) { if (sub.voo) sub.voo.set(ev.id, { rev: ev.rev, data: ev.op === 'del' ? null : ev.data }); /* v160 */ if (!sub.map) return; if (ev.op === 'del') sub.map.delete(ev.id); else sub.map.set(ev.id, ev.data); if (sub.mud !== false) { if (!sub.mud) sub.mud = new Map(); sub.mud.set(ev.id, ev.op === 'del' ? null : ev.data); } emitir(sub); });
  }
  function ressinc() {
    docSubs.forEach(function (s, p) { api('GET', '/api/db/doc?path=' + encodeURIComponent(p)).then(function (j) { s.data = j.exists ? j.data : null; s.fns.forEach(function (f) { f(docSnap(p.split('/').pop(), s.data)); }); }, function (e) { s.errs.forEach(function (f) { f(e); }); }); });
    colSubs.forEach(function (set, p) { set.forEach(function (sub) { carregar(sub); }); });
  }

  /* ---------- consultas ---------- */
  function cmp(a, op, b) {
    switch (op) { case '==': return a === b; case '!=': return a !== b; case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
      case 'in': return Array.isArray(b) && b.indexOf(a) >= 0; case 'not-in': return Array.isArray(b) && b.indexOf(a) < 0; case 'array-contains': return Array.isArray(a) && a.indexOf(b) >= 0;
      case 'array-contains-any': return Array.isArray(a) && Array.isArray(b) && b.some(function (x) { return a.indexOf(x) >= 0; }); default: return false; }
  }
  var campo = function (o, f) { return String(f).split('.').reduce(function (x, k) { return x == null ? undefined : x[k]; }, o); };
  function montar(q, rows) {
    var l = rows.filter(function (r) { return q.where.every(function (w) { return cmp(campo(r.data, w[0]), w[1], w[2]); }); });
    if (q.order.length) l.sort(function (x, y) { for (var i = 0; i < q.order.length; i++) { var o = q.order[i], a = campo(x.data, o[0]), b = campo(y.data, o[0]); if (a === b) continue; var r = (a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1); return o[1] === 'desc' ? -r : r; } return 0; });
    if (q.lim != null) l = l.slice(0, q.lim);
    var docs = l.map(function (r) { return docSnap(r.id, r.data); });
    return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: META };
  }
  /* v159: a leitura entrega junto a lista do que mudou desde a última entrega (mud: [[id, dados ou null]]; null quando a
     coleção foi lida inteira de novo) e só monta a lista completa (docs) quando alguém a pede */
  function emitir(sub) { clearTimeout(sub.t); sub.t = setTimeout(function () { var mud = sub.mud, m = sub.map, sn0 = null; sub.mud = new Map();
    var tudo = function () { if (!sn0) { var rows = []; m.forEach(function (d, id) { rows.push({ id: id, data: d }); }); sn0 = montar(sub.q, rows); } return sn0; };
    var sn = { get docs() { return tudo().docs; }, get size() { return tudo().size; }, get empty() { return tudo().empty; }, docChanges: function () { return []; }, metadata: META, mud: mud ? Array.from(mud) : null };
    sub.fns.forEach(function (f) { try { f(sn); } catch (x) { } }); }, 30); }
  /* ---------- v160: leitura incremental e cópia local ----------
     Cada coleção lida guarda a revisão que o servidor mandou (rev) e a época (ep). A leitura seguinte (ao vivo, ao
     reconectar ou na consulta periódica) pede só o que mudou desde essa revisão (desde=rev&ep=ep); o servidor responde a
     coleção inteira quando não dá (servidor reiniciado, permissão mudou, marca de exclusão já apagada) ou quando é antigo.
     Cópia local (IndexedDB), só das coleções de operação abaixo: cifrada com AES-GCM com a chave da conta (vem de /api/eu,
     só para quem entrou), apagada ao sair, depois de 14 dias sem uso, quando outra conta entra no mesmo navegador ou
     quando passa do limite de espaço. Só serve para baixar menos: nada da cópia aparece na tela antes de o servidor
     confirmar a leitura. Não guarda RH, folha, ponto, saúde, financeiro, parceiros (dados bancários), usuários nem chat. */
  var CC = new Map(); /* caminho -> { map, rev, ep, fila, v } */
  var PERS = { ok: false, ck: null, dono: null, chave: null, db: null, tam: new Map(), t: new Map() };
  var PERS_COLS = { prod: 1, mov: 1, sc: 1, ped: 1, cot: 1, notas: 1, sep: 1, rom: 1, almox: 1, proj: 1, etapa: 1, veic: 1, vabas: 1, vman: 1, vsai: 1, ferr: 1, fmov: 1, fman: 1, os: 1 };
  var PERS_MAX = 12 * 1024 * 1024, PERS_TOTAL = 48 * 1024 * 1024, PERS_DIAS = 14, PERS_BD = 'cg-sinc160';
  function idb() {
    if (PERS.db) return PERS.db;
    PERS.db = new Promise(function (ok) {
      if (!PERS.ok || typeof indexedDB === 'undefined' || typeof crypto === 'undefined' || !crypto.subtle) return ok(null);
      var r; try { r = indexedDB.open(PERS_BD, 1); } catch (e) { return ok(null); }
      r.onupgradeneeded = function () { try { r.result.createObjectStore('col'); } catch (e) { } };
      r.onsuccess = function () { ok(r.result); }; r.onerror = function () { ok(null); }; r.onblocked = function () { ok(null); };
    });
    return PERS.db;
  }
  function pedido(r) { return new Promise(function (ok, er) { r.onsuccess = function () { ok(r.result); }; r.onerror = function () { er(r.error); }; }); }
  function loja(modo, fn) { return idb().then(function (d) { if (!d) return null; var s; try { s = d.transaction('col', modo).objectStore('col'); } catch (e) { return null; } return fn(s); }); }
  function b64u(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function chave() { if (!PERS.chave) PERS.chave = crypto.subtle.importKey('raw', b64u(PERS.ck), 'AES-GCM', false, ['encrypt', 'decrypt']); return PERS.chave; }
  function persIniciar(j) {
    if (!j || !j.ck || !(j.sinc >= 160) || !j.id) return;
    PERS.ok = true; PERS.ck = j.ck; PERS.dono = j.id;
    /* outra conta neste navegador ou cópia velha: apaga */
    loja('readwrite', function (s) { var r = s.openCursor(); r.onsuccess = function () { var c = r.result; if (!c) return; var v = c.value || {}; if (v.dono !== PERS.dono || !(Date.now() - (v.em || 0) < PERS_DIAS * 864e5)) c.delete(); c.continue(); }; }).catch(function () { });
  }
  function persApagar(p) { PERS.tam.delete(p); loja('readwrite', function (s) { return pedido(s.delete(p)); }).catch(function () { }); }
  /* apaga a cópia local inteira (ao sair, ao estourar o espaço) */
  function persLimpar() {
    PERS.ok = false; PERS.t.forEach(function (t) { clearTimeout(t); }); PERS.t.clear(); PERS.tam.clear();
    var d0 = PERS.db; PERS.db = Promise.resolve(null);
    return Promise.resolve(d0).then(function (d) { try { if (d) d.close(); } catch (e) { } }).then(function () {
      return new Promise(function (ok) { if (typeof indexedDB === 'undefined') return ok(); var t = setTimeout(ok, 1500); try { var r = indexedDB.deleteDatabase(PERS_BD); r.onsuccess = r.onerror = r.onblocked = function () { clearTimeout(t); ok(); }; } catch (e) { clearTimeout(t); ok(); } });
    }).then(function () { PERS.db = null; PERS.chave = null; });
  }
  function persLer(p, c) {
    if (!PERS.ok || !PERS_COLS[p]) return Promise.resolve();
    return loja('readonly', function (s) { return pedido(s.get(p)); }).then(function (v) {
      if (!v) return;
      if (v.dono !== PERS.dono || !(Date.now() - (v.em || 0) < PERS_DIAS * 864e5) || !v.ep || typeof v.rev !== 'number') { persApagar(p); return; }
      return chave().then(function (k) { return crypto.subtle.decrypt({ name: 'AES-GCM', iv: v.iv }, k, v.ct); }).then(function (buf) {
        if (c.map) return; var l = JSON.parse(new TextDecoder().decode(buf)); if (!Array.isArray(l)) return;
        c.map = new Map(l); c.rev = v.rev; c.ep = v.ep; PERS.tam.set(p, v.n || 0);
      });
    }).catch(function () { persApagar(p); });
  }
  function persGravar(p, c) {
    if (!PERS.ok || !PERS_COLS[p]) return;
    clearTimeout(PERS.t.get(p));
    PERS.t.set(p, setTimeout(function () {
      PERS.t.delete(p); if (!PERS.ok || !c.map || typeof c.rev !== 'number' || !c.ep) return;
      var txt; try { txt = JSON.stringify(Array.from(c.map)); } catch (e) { return; }
      var tot = txt.length; PERS.tam.forEach(function (n, k) { if (k !== p) tot += n; });
      if (txt.length > PERS_MAX || tot > PERS_TOTAL) { persApagar(p); return; }
      var rev = c.rev, ep = c.ep, iv = crypto.getRandomValues(new Uint8Array(12));
      chave().then(function (k) { return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(txt)); })
        .then(function (ct) { return loja('readwrite', function (s) { return pedido(s.put({ dono: PERS.dono, rev: rev, ep: ep, em: Date.now(), n: txt.length, iv: iv, ct: ct }, p)); }); })
        .then(function () { PERS.tam.set(p, txt.length); }, function () { persLimpar(); }); /* sem espaço (quota) ou erro: desliga a cópia local */
    }, 4000));
  }
  /* lê a coleção (uma leitura por vez por caminho): incremental quando já há revisão; devolve o mapa completo e, quando foi
     incremental, o que mudou (docs, del) e a revisão de onde partiu (desde) */
  function buscar(p) {
    var c = CC.get(p); if (!c) { c = { map: null, rev: null, ep: null, fila: null, v: 0 }; CC.set(p, c); }
    var run = function () {
      return (c.map ? Promise.resolve() : persLer(p, c)).then(function () {
        var inc = !!(c.map && typeof c.rev === 'number' && c.ep), desde = c.rev;
        return api('GET', '/api/db/col?path=' + encodeURIComponent(p) + (inc ? '&desde=' + c.rev + '&ep=' + encodeURIComponent(c.ep) : '')).then(function (j) {
          var r = { full: true, docs: null, del: null, desde: desde };
          if (j && j.inc && inc) {
            r.full = false; r.docs = j.docs || []; r.del = j.del || [];
            r.docs.forEach(function (d) { c.map.set(d.id, d.data); }); r.del.forEach(function (id) { c.map.delete(id); });
          } else c.map = new Map(((j && j.docs) || []).map(function (d) { return [d.id, d.data]; }));
          var mudou = r.full || r.docs.length > 0 || r.del.length > 0;
          c.rev = j && typeof j.rev === 'number' ? j.rev : null; c.ep = j && j.ep ? String(j.ep) : null;
          if (mudou) { c.v++; persGravar(p, c); }
          r.rev = c.rev; r.map = c.map; return r;
        });
      }).catch(function (e) { if (e && e.code === 'not_granted') { CC.delete(p); persApagar(p); } throw e; });
    };
    var f = (c.fila || Promise.resolve()).then(run, run);
    c.fila = f.catch(function () { });
    return f;
  }
  function carregar(sub) {
    sub.voo = new Map(); /* avisos ao vivo que chegarem durante a leitura */
    return buscar(sub.q.path).then(function (r) {
      var voo = sub.voo; sub.voo = null;
      if (sub.map && !r.full && typeof sub.rev === 'number' && sub.rev === r.desde) {
        if (sub.mud !== false && !sub.mud) sub.mud = new Map();
        r.docs.forEach(function (d) { sub.map.set(d.id, d.data); if (sub.mud) sub.mud.set(d.id, d.data); });
        r.del.forEach(function (id) { if (sub.map.has(id)) { sub.map.delete(id); if (sub.mud) sub.mud.set(id, null); } });
      } else { sub.map = new Map(r.map); sub.mud = false; }
      sub.rev = r.rev;
      /* o aviso ao vivo mais novo que a leitura vale (a resposta pode chegar depois dele) */
      if (voo && typeof r.rev === 'number') voo.forEach(function (x, id) { if (typeof x.rev === 'number' && x.rev > r.rev) { if (x.data === null) sub.map.delete(id); else sub.map.set(id, x.data); if (sub.mud) sub.mud.set(id, x.data); } });
      emitir(sub);
    }, function (e) { sub.voo = null; sub.errs.forEach(function (f) { f(e); }); });
  }
  /* sair: apaga a cópia local antes de encerrar a sessão; recarregar tudo: esquece as revisões e lê de novo do zero */
  window.__cgSair = function () { return persLimpar().catch(function () { }); };
  window.__cgRecarregarDados = function () { CC.clear(); colSubs.forEach(function (set) { set.forEach(function (sub) { sub.rev = null; }); }); return persLimpar().then(function () { if (EU) persIniciar(EU); ressinc(); }); };
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('click', function (e) { var a = e.target && e.target.closest && e.target.closest('a[href="/sair"]'); if (!a) return; e.preventDefault(); window.__cgSair().then(function () { location.href = '/sair'; }); }, true);
  function query(q) {
    var o = {
      where: function (f, op, v) { return query(Object.assign({}, q, { where: q.where.concat([[f, op, v]]) })); },
      orderBy: function (f, dir) { return query(Object.assign({}, q, { order: q.order.concat([[f, dir || 'asc']]) })); },
      limit: function (n) { return query(Object.assign({}, q, { lim: n })); },
      get: function () { return buscar(q.path).then(function (r) { var rows = []; r.map.forEach(function (d, id) { rows.push({ id: id, data: d }); }); return montar(q, rows); }); }, /* v160: só o que mudou vem do servidor */
      onSnapshot: function (next, err) {
        abrir(); var sub = { q: q, fns: [next], errs: err ? [err] : [], map: null };
        if (!colSubs.has(q.path)) colSubs.set(q.path, new Set()); colSubs.get(q.path).add(sub); carregar(sub);
        return function () { var s = colSubs.get(q.path); if (s) { s.delete(sub); if (!s.size) colSubs.delete(q.path); } };
      }
    };
    return o;
  }
  function docRef(p) {
    var id = p.split('/').pop();
    return {
      id: id, path: p,
      get: function () { return api('GET', '/api/db/doc?path=' + encodeURIComponent(p)).then(function (j) { return docSnap(id, j.exists ? j.data : null); }); },
      set: function (d) { return api('PUT', '/api/db/doc?path=' + encodeURIComponent(p), { data: d }).then(function () { }); },
      update: function (d) { return api('PATCH', '/api/db/doc?path=' + encodeURIComponent(p), { data: d }).then(function () { }); },
      delete: function () { return api('DELETE', '/api/db/doc?path=' + encodeURIComponent(p)).then(function () { }); },
      acquire: function () { return Promise.resolve({ acquired: true }); },
      onSnapshot: function (next, err) {
        abrir(); var s = docSubs.get(p);
        if (!s) { s = { fns: [], errs: [], data: undefined }; docSubs.set(p, s); }
        s.fns.push(next); if (err) s.errs.push(err);
        if (s.data !== undefined) setTimeout(function () { next(docSnap(id, s.data)); }, 0);
        else api('GET', '/api/db/doc?path=' + encodeURIComponent(p)).then(function (j) { s.data = j.exists ? j.data : null; next(docSnap(id, s.data)); }, function (e) { if (err) err(e); });
        return function () { var i = s.fns.indexOf(next); if (i >= 0) s.fns.splice(i, 1); if (!s.fns.length) docSubs.delete(p); };
      },
      collection: function (c) { return colRef(p + '/' + c); }
    };
  }
  function novoId() { var a = new Uint8Array(15); crypto.getRandomValues(a); return Array.from(a, function (b) { return 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]; }).join('').slice(0, 20); }
  function colRef(p) { var q = query({ path: p, where: [], order: [], lim: null }); q.path = p; q.doc = function (id) { return docRef(p + '/' + (id || novoId())); }; q.add = function (d) { var r = q.doc(); return r.set(d).then(function () { return r; }); }; return q; }
  var DB = { collection: colRef, doc: docRef };

  /* ---------- pessoas ---------- */
  var USER = {
    me: function () { return eu().then(function (j) { return { id: j.id, name: j.name, avatarUrl: '', color: j.color, email: j.email, isOwner: j.isOwner, canEdit: j.canEdit }; }); },
    id: function () { return eu().then(function (j) { return j.id; }); },
    isOwner: function () { return eu().then(function (j) { return j.isOwner; }); },
    canEdit: function () { return eu().then(function (j) { return j.canEdit; }); },
    can: function (n) { return eu().then(function (j) { return n === 'data.write' ? j.nivel !== 'view' : null; }); },
    name: function () { return eu().then(function (j) { return j.name; }); },
    avatarUrl: function () { return Promise.resolve(null); },
    email: function () { return eu().then(function (j) { return j.email; }); },
    profiles: function (ids) { ids = [].concat(ids || []); return ids.length ? api('GET', '/api/perfis?ids=' + encodeURIComponent(ids.join(','))) : Promise.resolve({}); },
    search: function (t) { return api('GET', '/api/busca-pessoas?q=' + encodeURIComponent(t || '')); }
  };

  /* ---------- presença ---------- */
  var presT = 0;
  function enviarPres() { if (!cid) return; clearTimeout(presT); presT = setTimeout(function () { var p = presPend; presPend = {}; api('POST', '/api/room/presence', { cid: cid, patch: p }).catch(function () { }); }, 80); }
  var ROOM = {
    presence: function (patch) { temPres = true; Object.assign(presPend, patch || {}); abrir(); enviarPres(); return Promise.resolve(); },
    onPeers: function (cb) { abrir(); peersCbs.add(cb); if (lastPeers.length) setTimeout(function () { cb({ peers: lastPeers }); }, 0); return function () { peersCbs.delete(cb); }; },
    emit: function () { return Promise.resolve(); }, on: function () { return function () { }; },
    join: function () { return Promise.resolve(ROOM); }, leave: function () { return Promise.resolve(); }
  };

  /* ---------- arquivos ---------- */
  var ASSETS = {
    upload: function (blob, o) { var t = (o && o.type) || blob.type || 'application/octet-stream'; return api('POST', '/api/assets', new Blob([blob], { type: t }), { 'content-type': t }); },
    list: function () { return api('GET', '/api/assets'); },
    delete: function (id) { return api('DELETE', '/api/assets/' + encodeURIComponent(id)); }
  };

  /* ---------- IA ---------- */
  function b64(blob) { return new Promise(function (ok, er) { var r = new FileReader(); r.onload = function () { ok(String(r.result).replace(/^data:[^,]*,/, '')); }; r.onerror = er; r.readAsDataURL(blob); }); }
  function amostra(input, opts) {
    opts = opts || {};
    var ims = (opts.images || []).slice(0, 8);
    return Promise.all(ims.map(function (b) { return b64(b).then(function (d) { return { type: b.type || 'image/png', data: d }; }); })).then(function (images) {
      return api('POST', '/api/ia', { input: input, modelTier: opts.modelTier || 'default', images: images });
    }).then(function (r) { if (opts.onText) try { opts.onText({ text: r.text, delta: r.text }); } catch (x) { } return r; });
  }
  amostra.json = function (input, opts) { return amostra(input, opts).then(function (r) { var t = String(r.text || ''), a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']')); try { return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t); } catch (e) { throw erro('transform_error', 'A IA não respondeu em JSON.'); } }); };
  amostra.limits = function () { return Promise.resolve({ images: true }); };

  /* ---------- baixar arquivo ---------- */
  var DOWN = { save: function (o) { var d = o.data, b = d instanceof Blob ? d : new Blob([d]); var u = URL.createObjectURL(b), a = document.createElement('a'); a.href = u; a.download = o.filename || 'arquivo'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 10000); return Promise.resolve({ saved: true }); } };

  /* ---------- conectores: só o fiscal deste servidor ---------- */
  var MCP = {
    callTool: function (server, tool, input) { if (!/fiscal/i.test(server)) return Promise.reject(erro('server_not_connected', 'Conector não disponível no servidor próprio.')); return api('POST', '/api/fiscal/tool/' + encodeURIComponent(tool), input || {}).then(function (r) { return { payload: r, content: [] }; }); },
    watchTool: function () { return function () { }; },
    describeTool: function () { return Promise.reject(erro('unavailable')); },
    server: function () { return Promise.reject(erro('server_not_connected')); }
  };

  window.claude = {
    use: function (nome) {
      switch (nome) {
        case 'db': return eu().then(function () { return DB; }, function () { return null; });
        case 'user': return eu().then(function () { return USER; }, function () { return null; });
        case 'room': return Promise.resolve(ROOM);
        case 'assets': return eu().then(function (j) { return j.nivel === 'view' ? null : ASSETS; }, function () { return null; });
        case 'sample': return eu().then(function (j) { return j.ia ? amostra : null; }, function () { return null; });
        case 'downloads': return Promise.resolve(DOWN);
        case 'mcp': return eu().then(function (j) { return j.fiscal ? MCP : null; }, function () { return null; });
        default: return Promise.resolve(null);
      }
    }
  };
})();

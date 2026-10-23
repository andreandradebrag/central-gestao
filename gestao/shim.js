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
  function eu() { if (!euP) euP = api('GET', '/api/eu').then(function (j) { EU = j; return j; }); return euP; }
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
    var cs = colSubs.get(ev.parent); if (cs) cs.forEach(function (sub) { if (!sub.map) return; if (ev.op === 'del') sub.map.delete(ev.id); else sub.map.set(ev.id, ev.data); emitir(sub); });
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
  function emitir(sub) { clearTimeout(sub.t); sub.t = setTimeout(function () { var rows = []; sub.map.forEach(function (d, id) { rows.push({ id: id, data: d }); }); var sn = montar(sub.q, rows); sub.fns.forEach(function (f) { try { f(sn); } catch (x) { } }); }, 30); }
  function carregar(sub) { return api('GET', '/api/db/col?path=' + encodeURIComponent(sub.q.path)).then(function (j) { sub.map = new Map(j.docs.map(function (d) { return [d.id, d.data]; })); emitir(sub); }, function (e) { sub.errs.forEach(function (f) { f(e); }); }); }
  function query(q) {
    var o = {
      where: function (f, op, v) { return query(Object.assign({}, q, { where: q.where.concat([[f, op, v]]) })); },
      orderBy: function (f, dir) { return query(Object.assign({}, q, { order: q.order.concat([[f, dir || 'asc']]) })); },
      limit: function (n) { return query(Object.assign({}, q, { lim: n })); },
      get: function () { return api('GET', '/api/db/col?path=' + encodeURIComponent(q.path)).then(function (j) { return montar(q, j.docs); }); },
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

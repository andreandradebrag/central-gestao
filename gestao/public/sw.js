/* Central de Gestão INA — service worker do app instalável (v167, relatorios/feito_v167.md). Gerado por v167/pwa167.py.
   - Guarda só o "casco" do app (página, shim.js, manifest, ícones e as bibliotecas de /vendor), num cache com a versão
     (cg-casco-<APP_VER>): versão nova = cache novo, e o antigo é apagado na ativação.
   - Página e shim.js: primeiro a rede (sempre a versão do servidor), o cache só sem internet. Bibliotecas e ícones: cache.
   - Nunca guarda respostas da API (/api/*), arquivos (/_blob/*) nem páginas de login: os dados para uso sem internet
     ficam no IndexedDB do próprio app (pacote do modo Campo), só os necessários e só da pessoa.
   - Background Sync (Android/Chrome): quando a conexão volta, envia a fila do modo Campo (o mesmo fila167.js do app). */
'use strict';
const VER = '167', CASCO = 'cg-casco-' + VER;
const ARQS = ['/', '/shim.js', '/manifest.webmanifest', '/icones/icone-192.png', '/icones/icone-512.png', '/icones/icone-maskable-512.png', '/icones/apple-touch-icon.png'];
const VENDOR = ["/vendor/pdfjs/pdf.min.mjs", "/vendor/pdfjs/pdf.worker.min.mjs", "/vendor/xlsx/xlsx.full.min.js", "/vendor/html2canvas/html2canvas.min.js", "/vendor/jspdf/jspdf.umd.min.js", "/vendor/jszip/jszip.min.js", "/vendor/pdflib/pdf-lib.min.js"];
/* fila167.js — fila de envio do modo Campo (v167, relatorios/feito_v167.md). O mesmo arquivo roda no app (embutido no
   index.html pelo patch149.py) e no service worker (sw.js, para o Background Sync do Android). IndexedDB do aparelho:
   - 'pac'  : pacote para uso sem internet, por usuário (chave = uid);
   - 'fila' : registros feitos no aparelho (chave = cid, identificador gerado aqui), com fotos e assinaturas;
   - 'meta' : quem entrou por último (para abrir o Campo sem internet).
   Envio: fotos primeiro (POST /api/assets), depois os passos do registro (as rotas de sempre), cada um com x-cg-cid e
   x-cg-uid; o servidor (campo167.js) devolve a mesma resposta para o mesmo cid, então nada é gravado duas vezes.
   Conflito (alguém já recebeu, veículo já saiu, sem saldo…) fica na fila com a mensagem do servidor, para a pessoa ver;
   nada é tentado de novo sozinho nem sobrescrito. Sem rede, sessão vencida ou outra pessoa no aparelho: a fila fica
   intacta e o envio para. */
const F167 = (function () {
  'use strict';
  const BD = 'cg-campo167';
  const LIM = { pac: 8 * 1048576, fila: 60 * 1048576, foto: 3 * 1048576, itens: 400, okDias: 3, pacDias: 14 };
  const ESPERA = ['pend', 'enviando', 'bloq'];
  function uuid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, ''); } catch (e) { }
    let t = ''; for (let i = 0; i < 32; i++) t += 'abcdef0123456789'[Math.floor(Math.random() * 16)]; return t;
  }
  /* ---------- armazenamento ---------- */
  function idb(nome) {
    let P = null;
    const abre = () => P || (P = new Promise((ok, er) => {
      let r; try { r = indexedDB.open(nome || BD, 1); } catch (e) { er(e); return; }
      r.onupgradeneeded = () => { const d = r.result; ['pac', 'fila', 'meta'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); }); };
      r.onsuccess = () => ok(r.result); r.onerror = () => er(r.error); r.onblocked = () => er(new Error('IndexedDB bloqueado'));
    }).catch(e => { P = null; throw e; }));
    const tx = (st, modo, fn) => abre().then(d => new Promise((ok, er) => {
      const t = d.transaction(st, modo), o = t.objectStore(st); let v; const rq = fn(o);
      if (rq) rq.onsuccess = () => { v = rq.result; };
      t.oncomplete = () => ok(v); t.onerror = () => er(t.error); t.onabort = () => er(t.error || new Error('sem espaço'));
    }));
    return {
      get: (st, k) => tx(st, 'readonly', o => o.get(k)),
      put: (st, k, v) => tx(st, 'readwrite', o => o.put(v, k)),
      del: (st, k) => tx(st, 'readwrite', o => o.delete(k)),
      todos: st => tx(st, 'readonly', o => o.getAll()),
      limpar: st => tx(st, 'readwrite', o => o.clear()),
      fechar: () => { const p = P; P = null; return p ? p.then(d => d.close()).catch(() => { }) : Promise.resolve(); }
    };
  }
  function memoria() {
    const M = { pac: new Map(), fila: new Map(), meta: new Map() };
    return { _M: M, get: (st, k) => Promise.resolve(M[st].get(k)), put: (st, k, v) => { M[st].set(k, v); return Promise.resolve(); }, del: (st, k) => { M[st].delete(k); return Promise.resolve(); },
      todos: st => Promise.resolve([...M[st].values()]), limpar: st => { M[st].clear(); return Promise.resolve(); }, fechar: () => Promise.resolve() };
  }
  /* ---------- tamanho ---------- */
  const semBlob = it => JSON.stringify(Object.assign({}, it, { fotos: (it.fotos || []).map(f => Object.assign({}, f, { blob: null })) }));
  const tamItem = it => semBlob(it).length + (it.fotos || []).reduce((t, f) => t + (f.blob && f.blob.size ? f.blob.size : 0), 0);
  async function tamanho(io) { return (await io.todos('fila')).reduce((t, it) => t + (it ? tamItem(it) : 0), 0); }
  /* ---------- fila ---------- */
  async function listar(io, uid) { return (await io.todos('fila')).filter(x => x && (!uid || x.uid === uid)).sort((a, b) => a.em - b.em); }
  async function novo(io, it) {
    const l = await io.todos('fila');
    if (l.filter(x => x && x.st !== 'ok').length >= LIM.itens) throw new Error('A fila deste aparelho chegou a ' + LIM.itens + ' registros. Conecte-se à internet para enviar antes de fazer outros.');
    for (const f of it.fotos || []) if (f.blob && f.blob.size > LIM.foto) throw new Error('A foto "' + (f.nome || f.k) + '" é grande demais (' + (f.blob.size / 1048576).toFixed(1) + ' MB).');
    const x = Object.assign({ cid: uuid(), em: Date.now(), st: 'pend', tent: 0, feito: 0, resp: [], msg: '' }, it);
    const tot = l.reduce((t, y) => t + (y ? tamItem(y) : 0), 0) + tamItem(x);
    if (tot > LIM.fila) throw new Error('O espaço do modo Campo neste aparelho está cheio (' + Math.round(LIM.fila / 1048576) + ' MB). Conecte-se à internet para enviar os registros que estão aguardando.');
    x.tam = tamItem(x);
    await io.put('fila', x.cid, x); return x;
  }
  async function resumo(io, uid) {
    const l = await listar(io, uid), o = { pend: 0, conflito: 0, erro: 0, ok: 0, total: l.length, outros: 0 };
    l.forEach(x => { if (ESPERA.includes(x.st)) o.pend++; else if (x.st === 'conflito') o.conflito++; else if (x.st === 'erro') o.erro++; else if (x.st === 'ok') o.ok++; });
    if (uid) o.outros = (await listar(io)).filter(x => x.uid !== uid && x.st !== 'ok').length;
    return o;
  }
  /* troca as marcas do corpo: "@foto:k" (foto já enviada), "@dep:caminho" (resposta do registro de que este depende) e
     "@resp:i.caminho" (resposta de um passo anterior deste mesmo registro) */
  const pega = (o, cam) => String(cam).split('.').reduce((x, k) => x == null ? undefined : x[k], o);
  function montar(v, it, dep) {
    if (typeof v === 'string') {
      if (v.startsWith('@foto:')) { const f = (it.fotos || []).find(z => z.k === v.slice(6)); return f && f.id ? { id: f.id, nome: f.nome || f.k, ct: f.ct || 'image/jpeg' } : null; }
      if (v.startsWith('@dep:')) return dep ? pega(dep.resp && dep.resp[0], v.slice(5)) : undefined;
      if (v.startsWith('@resp:')) { const i = v.indexOf('.'); return pega((it.resp || [])[+v.slice(6, i)], v.slice(i + 1)); }
      return v;
    }
    if (Array.isArray(v)) return v.map(x => montar(x, it, dep));
    if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { o[k] = montar(v[k], it, dep); }); return o; }
    return v;
  }
  /* resposta do servidor → ok | sessao | outra | rede | conflito | erro */
  function classe(st, j) {
    if (st >= 200 && st < 300) return 'ok';
    if (st === 401 || (st === 403 && j && j.code === 'senha_trocar')) return 'sessao';
    if (st === 409 && j && j.code === 'outra_conta') return 'outra';
    if (st === 409 && j && j.code === 'em_andamento') return 'rede';
    if (st === 409 && j && j.reauth) return 'sessao';
    if (st === 403 || st === 409) return 'conflito';
    if (st === 400 || st === 404 || st === 413 || st === 422) return 'erro';
    return 'rede';
  }
  const MSG = { sessao: 'Sua sessão expirou: entre de novo para enviar. O registro continua guardado neste aparelho.', outra: 'Feito por outra pessoa neste aparelho: é enviado quando ela entrar.', rede: 'Sem conexão com o servidor. O envio é tentado de novo sozinho.' };
  const enxuga = j => { const t = JSON.stringify(j || {}); if (t.length <= 4096) return j; const o = { ok: j.ok, msg: j.msg }; ['saida', 'res', 'gua'].forEach(k => { if (j[k] && j[k].id) o[k] = { id: j[k].id }; }); if (j.id) o.id = j.id; return o; };
  async function enviarItem(io, it, porCid, fx) {
    const dep = it.dep ? porCid.get(it.dep) : null;
    it.st = 'enviando'; it.tent = (it.tent || 0) + 1; it.ult = Date.now(); await io.put('fila', it.cid, it);
    const para = async (c, j) => {
      if (c === 'sessao' || c === 'outra' || c === 'rede') { it.st = 'pend'; it.msg = MSG[c]; }
      else { it.st = c; it.msg = (j && (j.erro || j.message)) || (c === 'conflito' ? 'O servidor recusou (conflito).' : 'O servidor recusou.'); it.msgEm = Date.now(); }
      await io.put('fila', it.cid, it); return c;
    };
    const chama = async (url, o) => { let r; try { r = await fx(url, Object.assign({ credentials: 'same-origin', redirect: 'manual' }, o)); } catch (e) { return { c: 'rede', j: null }; } if (r.type === 'opaqueredirect' || r.status === 0) return { c: 'sessao', j: null }; const j = await r.json().catch(() => ({})); return { c: classe(r.status, j), j }; };
    for (const f of it.fotos || []) {
      if (f.id) continue;
      if (!f.blob) return para('erro', { erro: 'A foto "' + (f.nome || f.k) + '" não está mais neste aparelho. Descarte o registro e faça de novo.' });
      const { c, j } = await chama('/api/assets', { method: 'POST', headers: { 'content-type': f.ct || f.blob.type || 'image/jpeg', 'x-cg-cid': it.cid + '.f' + String(f.k).replace(/[^A-Za-z0-9_-]/g, '_'), 'x-cg-uid': it.uid }, body: f.blob });
      if (c !== 'ok') return para(c, j);
      f.id = j.id; f.blob = null; f.url = ''; await io.put('fila', it.cid, it);
    }
    const ps = it.passos || [];
    for (let i = it.feito || 0; i < ps.length; i++) {
      const p = ps[i], corpo = montar(p.corpo, it, dep);
      const url = montar(p.url, it, dep);
      const { c, j } = await chama(url, { method: p.m || 'POST', headers: { 'content-type': 'application/json', 'x-cg-cid': i ? it.cid + '.' + i : it.cid, 'x-cg-uid': it.uid }, body: JSON.stringify(p.m === 'PUT' || p.m === 'PATCH' ? { data: corpo } : corpo) });
      if (c !== 'ok') return para(c, j);
      (it.resp = it.resp || [])[i] = enxuga(j); it.feito = i + 1; await io.put('fila', it.cid, it);
    }
    const ult = (it.resp || [])[ps.length - 1] || {};
    it.st = 'ok'; it.okEm = Date.now(); it.msg = ult.repetido ? 'Enviado (já estava no servidor).' : (ult.msg || 'Enviado.');
    it.fotos = (it.fotos || []).map(f => ({ k: f.k, nome: f.nome, id: f.id }));
    it.passos = ps.map(p => ({ m: p.m, url: p.url }));
    await io.put('fila', it.cid, it); return 'ok';
  }
  let ocupado = false;
  async function trava(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) return navigator.locks.request('cg-fila167', { ifAvailable: true }, l => l ? fn() : { ocupado: true });
    if (ocupado) return { ocupado: true }; ocupado = true; try { return await fn(); } finally { ocupado = false; }
  }
  /* envia o que está aguardando, do usuário uid, na ordem em que foi feito */
  function enviar(io, uid, opc) {
    return trava(async () => {
      const fx = (opc && opc.fetch) || ((u, o) => fetch(u, o)), out = { enviados: 0, conflitos: 0, erros: 0, sessao: false, outra: false, semRede: false, restam: 0 };
      const todos = (await io.todos('fila')).filter(Boolean), porCid = new Map(todos.map(x => [x.cid, x])); /* os mesmos objetos: o estado novo de um registro vale para quem depende dele */
      const l = todos.filter(x => x.uid === uid).sort((a, b) => a.em - b.em);
      for (const it of l) {
        if (!ESPERA.includes(it.st)) continue;
        if (it.dep) {
          const d = porCid.get(it.dep);
          if (!d || d.st !== 'ok') {
            if (!d || ['conflito', 'erro', 'bloq'].includes(d.st)) { if (it.st !== 'bloq' || !it.msg) { it.st = 'bloq'; it.msg = 'Depende de "' + (d ? d.titulo : 'um registro descartado') + '", que não foi enviado.'; await io.put('fila', it.cid, it); } }
            continue;
          }
        }
        const c = await enviarItem(io, it, porCid, fx);
        if (opc && opc.aoItem) try { opc.aoItem(it); } catch (e) { }
        if (c === 'ok') out.enviados++; else if (c === 'conflito') out.conflitos++; else if (c === 'erro') out.erros++;
        else { out[c === 'sessao' ? 'sessao' : c === 'outra' ? 'outra' : 'semRede'] = true; break; }
      }
      await purgar(io);
      out.restam = (await listar(io, uid)).filter(x => ESPERA.includes(x.st)).length;
      return out;
    });
  }
  /* a pessoa manda tentar de novo (conflito resolvido, erro corrigido no servidor) */
  async function deNovo(io, cid) { const it = await io.get('fila', cid); if (!it || it.st === 'ok') return null; it.st = 'pend'; it.msg = ''; await io.put('fila', cid, it); for (const x of await io.todos('fila')) if (x && x.dep === cid && x.st === 'bloq') { x.st = 'pend'; x.msg = ''; await io.put('fila', x.cid, x); } return it; }
  async function descartar(io, cid) { await io.del('fila', cid); }
  /* enviados há mais de LIM.okDias saem da lista; pacote sem uso há LIM.pacDias é apagado (a fila nunca é apagada sozinha) */
  async function purgar(io) {
    const ag = Date.now();
    for (const x of await io.todos('fila')) if (x && x.st === 'ok' && ag - (x.okEm || 0) > LIM.okDias * 864e5) await io.del('fila', x.cid);
    for (const p of await io.todos('pac')) if (p && ag - (p.usado || p.em || 0) > LIM.pacDias * 864e5) await io.del('pac', p.uid);
  }
  /* sair: apaga o pacote e a fila da pessoa (o app pergunta antes quando há registros não enviados) */
  async function apagarUsuario(io, uid) {
    await io.del('pac', uid);
    for (const x of await io.todos('fila')) if (x && x.uid === uid) await io.del('fila', x.cid);
    const m = await io.get('meta', 'ultimo'); if (m && m.uid === uid) await io.del('meta', 'ultimo');
  }
  async function guardarPacote(io, pac) {
    const t = JSON.stringify(pac).length; if (t > LIM.pac) throw new Error('Os dados passam do limite para uso sem internet (' + Math.round(LIM.pac / 1048576) + ' MB). Escolha menos obras.');
    for (const p of await io.todos('pac')) if (p && p.uid !== pac.uid) await io.del('pac', p.uid); /* um pacote só: o de quem está usando o aparelho */
    await io.put('pac', pac.uid, Object.assign({}, pac, { usado: Date.now() }));
  }
  return { BD, LIM, ESPERA, uuid, idb, memoria, tamItem, tamanho, listar, novo, resumo, montar, classe, enviar, deNovo, descartar, purgar, apagarUsuario, guardarPacote };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = F167;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CASCO);
    for (const u of ARQS.concat(VENDOR)) {
      try { const r = await fetch(u, { credentials: 'same-origin', cache: 'no-cache' }); if (r.ok && !r.redirected && r.type === 'basic') await c.put(u, r); } catch (x) { }
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('cg-casco-') && k !== CASCO) await caches.delete(k);
    await self.clients.claim();
  })());
});
const comPrazo = (req, ms) => new Promise((ok, er) => { const t = setTimeout(() => er(new Error('demorou')), ms); fetch(req).then(r => { clearTimeout(t); ok(r); }, x => { clearTimeout(t); er(x); }); });
async function pagina(req) {
  try {
    const r = await comPrazo(req, 8000);
    if (r.ok && r.type === 'basic' && !r.redirected && /text\/html/.test(r.headers.get('content-type') || '')) { const c = await caches.open(CASCO); await c.put('/', r.clone()); }
    return r; /* login vencido: o redirecionamento para /login passa direto (não vai para o cache) */
  } catch (x) {
    const c = await caches.open(CASCO), r = await c.match('/');
    return r || new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sem internet</title><body style="font-family:sans-serif;padding:24px"><h1>Sem internet</h1><p>Abra o sistema uma vez com internet para poder usar o modo Campo sem conexão.</p></body>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}
async function redePrimeiro(req, chave) {
  const c = await caches.open(CASCO);
  try { const r = await comPrazo(req, 8000); if (r.ok && r.type === 'basic' && !r.redirected) await c.put(chave, r.clone()); return r; }
  catch (x) { const r = await c.match(chave); if (r) return r; throw x; }
}
async function cacheAntes(req, chave) {
  const c = await caches.open(CASCO), r = await c.match(chave); if (r) return r;
  const n = await fetch(req); if (n.ok && n.type === 'basic' && !n.redirected) await c.put(chave, n.clone()); return n;
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url); if (u.origin !== self.location.origin) return;
  const p = u.pathname;
  if (p.startsWith('/api/') || p.startsWith('/_blob/') || p === '/sw.js') return; /* dados nunca passam pelo cache */
  if (req.mode === 'navigate') {
    if (p === '/' || p === '/index.html') e.respondWith(pagina(req));
    else if (p === '/sair') e.respondWith(fetch(req).catch(() => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Saiu</title><body style="font-family:sans-serif;padding:24px"><h1>Você saiu deste aparelho</h1><p>Os dados do modo Campo foram apagados deste celular. A sessão no servidor é encerrada na próxima vez que o app abrir com internet.</p><p><a href="/">Voltar</a></p></body>', { headers: { 'content-type': 'text/html; charset=utf-8' } })));
    return;
  }
  if (p === '/shim.js' || p === '/manifest.webmanifest' || p === '/vendor/lista.json') { e.respondWith(redePrimeiro(req, p)); return; }
  if (p.startsWith('/icones/') || (p.startsWith('/vendor/') && VENDOR.includes(p))) e.respondWith(cacheAntes(req, p));
});
/* fila do modo Campo: o app pede (mensagem) ou o Android avisa que a conexão voltou (Background Sync) */
async function sincronizar() {
  const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (abertas.length) { abertas.forEach(c => c.postMessage({ cg167: 'sincronizar' })); return; } /* com o app aberto, ele mesmo envia (e mostra o resultado) */
  const io = F167.idb(), m = await io.get('meta', 'ultimo'); if (!m || !m.uid) return;
  const r = await F167.enviar(io, m.uid, { fetch: (url, o) => fetch(url, o) });
  await io.fechar();
  if (r && r.semRede) throw new Error('sem rede: o navegador tenta de novo');
}
self.addEventListener('sync', e => { if (e.tag === 'cg-fila167') e.waitUntil(sincronizar()); });
self.addEventListener('message', e => { if (e.data && e.data.cg167 === 'versao' && e.source) e.source.postMessage({ cg167: 'versao', ver: VER }); });

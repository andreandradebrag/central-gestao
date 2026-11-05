/* v159: compressão e cache dos arquivos estáticos e compressão das respostas JSON grandes (relatorios/feito_v159.md).
   - Arquivos de texto (página, shim.js, manifest, json, css, svg) saem em brotli ou gzip, conforme o Accept-Encoding, com
     "Vary: Accept-Encoding". Cada arquivo é comprimido UMA vez por data de alteração (mtime), em memória e fora do laço
     principal (zlib assíncrono); enquanto a compressão não termina, a resposta espera por ela.
   - ETag (hash do conteúdo) em todos esses arquivos; pedido condicional com o mesmo ETag recebe 304 (sem corpo).
     A página (index.html) passa de "no-store" para "no-cache": o navegador guarda, mas confere a cada abertura.
   - A CSP da página continua a mesma (o servidor manda o mesmo cabeçalho no 200 e no 304).
   - JSON acima de 1 KB sai em gzip quando o navegador aceita (assíncrono, sem travar as outras requisições).
   Uso: const C159 = require('./comprime159.js'); C159.estatico(req, res, p, st, ext, h, ehPagina) e C159.json(res, st, b, extra). */
'use strict';
const fs = require('node:fs'), zlib = require('node:zlib'), crypto = require('node:crypto');
const TEXTO = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt', '.map', '.mjs']);
const MIN = 1024, MAX = 32 * 1048576;
const cache = new Map();
/* codificações aceitas (q > 0) */
function aceita(req) {
  const o = { br: false, gzip: false }; if (!req || !req.headers) return o;
  String(req.headers['accept-encoding'] || '').toLowerCase().split(',').forEach(t => {
    const [nome, ...ps] = t.trim().split(';'); let q = 1; ps.forEach(p => { const m = /^\s*q=([\d.]+)\s*$/.exec(p); if (m) q = +m[1]; });
    if (!(q > 0)) return; if (nome === 'br') o.br = true; else if (nome === 'gzip' || nome === 'x-gzip') o.gzip = true; else if (nome === '*') { o.br = true; o.gzip = true; }
  });
  return o;
}
const prom = (fn, b, o) => new Promise(ok => fn(b, o, (e, r) => ok(e ? null : r)));
function entrada(p, st) {
  let e = cache.get(p);
  if (e && e.mt === st.mtimeMs && e.size === st.size) return e;
  const raw = fs.readFileSync(p);
  e = { mt: st.mtimeMs, size: st.size, raw, etag: crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 32), gz: null, br: null, pGz: null, pBr: null };
  if (raw.length >= MIN) {
    e.pGz = prom(zlib.gzip, raw, { level: 9 }).then(r => { e.gz = r && r.length < raw.length ? r : false; });
    e.pBr = prom(zlib.brotliCompress, raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }).then(r => { e.br = r && r.length < raw.length ? r : false; });
  } else { e.gz = false; e.br = false; }
  cache.set(p, e); return e;
}
/* compara If-None-Match com o ETag (ignora W/ e o sufixo da codificação) */
function mesmo(req, etag) {
  const inm = String(req.headers['if-none-match'] || ''); if (!inm) return false;
  if (inm.trim() === '*') return true;
  return inm.split(',').some(t => t.trim().replace(/^W\//, '').replace(/^"|"$/g, '').replace(/-(br|gz)$/, '') === etag);
}
/* devolve false quando o arquivo não é de texto (o server.js segue como antes) */
function estatico(req, res, p, st, ext, h, ehPagina) {
  if (!TEXTO.has(ext) || st.size > MAX) return false;
  const e = entrada(p, st), cab = Object.assign({}, h, { etag: '"' + e.etag + '"', vary: 'Accept-Encoding' });
  if (ehPagina) cab['cache-control'] = 'no-cache';
  delete cab['content-length'];
  if (mesmo(req, e.etag)) { const c = Object.assign({}, cab); delete c['content-type']; delete c['accept-ranges']; res.writeHead(304, c); res.end(); return true; }
  const ac = aceita(req);
  const manda = () => {
    if (res.headersSent || res.destroyed) return;
    let corpo = e.raw, enc = '';
    if (ac.br && e.br) { corpo = e.br; enc = 'br'; } else if (ac.gzip && e.gz) { corpo = e.gz; enc = 'gzip'; }
    if (enc) { cab['content-encoding'] = enc; cab.etag = '"' + e.etag + '-' + (enc === 'br' ? 'br' : 'gz') + '"'; }
    cab['content-length'] = corpo.length;
    res.writeHead(200, cab); res.end(req.method === 'HEAD' ? undefined : corpo);
  };
  const quer = ac.br && e.br !== false ? 'br' : ac.gzip && e.gz !== false ? 'gz' : '';
  const espera = quer === 'br' && e.br === null ? e.pBr : quer === 'gz' && e.gz === null ? e.pGz : null;
  if (espera) espera.then(manda, manda); else manda();
  return true;
}
/* JSON: true quando a resposta vai comprimida (o server.js não escreve mais nada) */
function json(res, st, b, extra) {
  if (b.length < MIN || !res || !res.req || st === 204 || st === 304) return false;
  if (!aceita(res.req).gzip || res.req.method === 'HEAD') return false;
  zlib.gzip(b, { level: 6 }, (err, z) => {
    if (res.headersSent || res.destroyed) return;
    const base = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept-Encoding' };
    if (err || !z) { res.writeHead(st, Object.assign(base, { 'content-length': b.length }, extra || {})); return res.end(b); }
    res.writeHead(st, Object.assign(base, { 'content-length': z.length, 'content-encoding': 'gzip' }, extra || {})); res.end(z);
  });
  return true;
}
/* começa a comprimir a página já na subida do servidor (a primeira abertura não espera) */
function aquecer(p) { try { const st = fs.statSync(p); if (st.isFile() && st.size <= MAX) entrada(p, st); } catch (e) { } }
module.exports = { estatico, json, aceita, aquecer, _cache: cache };

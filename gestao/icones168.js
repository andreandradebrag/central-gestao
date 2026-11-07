'use strict';
/* v168 (relatorios/feito_v168.md): ícones do app feitos do logotipo da empresa.
   O logotipo da INA não é um arquivo do projeto: fica no banco (cfg/empresa.logo, Sistema › Configurações › Logo da empresa,
   o mesmo do topo e dos PDFs de SC e pedido). Por isso os ícones são desenhados no navegador do Administrador (canvas: fundo
   branco e margem; o "maskable" com a margem da área segura) e enviados aqui, que confere e guarda em DATA/icones168/.
   - GET  /icones/<nome>.png (sem login, como os da v167): o ícone gerado do logotipo; sem ele, os de public/icones (marca "CG").
   - GET  /api/icones168           → { hash, em, nomes } (qualquer pessoa logada: o app confere se precisa gerar de novo)
   - POST /api/icones168 { hash, icones: { 'icone-192.png': 'data:image/png;base64,…', … } }  (Administrador ou dono)
   - POST /api/icones168 { limpar: true } → volta aos ícones padrão (logotipo removido).
   Ligado em server.js por v168/ed_v168.py. */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const TAM = { 'icone-192.png': 192, 'icone-512.png': 512, 'icone-maskable-192.png': 192, 'icone-maskable-512.png': 512, 'apple-touch-icon.png': 180 };
module.exports = function (X) {
  const DIR = path.join(X.DATA, 'icones168'); fs.mkdirSync(DIR, { recursive: true });
  const estadoArq = path.join(DIR, 'estado.json');
  const estado = () => { try { return JSON.parse(fs.readFileSync(estadoArq, 'utf8')); } catch (e) { return { hash: '', em: 0, nomes: [] }; } };
  function pngOk(b, n) { return b.length > 33 && b.length < 600 * 1024 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.slice(12, 16).toString('latin1') === 'IHDR' && b.readUInt32BE(16) === n && b.readUInt32BE(20) === n; }
  /* serve o ícone gerado (devolve true) ou deixa para o arquivo padrão */
  function servir(req, res, p) {
    const nome = p.replace(/^\/icones\//, ''); if (!TAM[nome]) return false;
    const f = path.join(DIR, nome); let st; try { st = fs.statSync(f); } catch (e) { return false; }
    const et = '"i168-' + st.size.toString(36) + '-' + Math.round(st.mtimeMs).toString(36) + '"';
    if (req.headers['if-none-match'] === et) { res.writeHead(304, { etag: et, 'cache-control': 'no-cache' }); res.end(); return true; }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': st.size, 'cache-control': 'no-cache', etag: et, 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(f).pipe(res); return true;
  }
  async function rota(p, m, req, res, conta) {
    if (p !== '/api/icones168') return false;
    if (m === 'GET') { X.json(res, 200, estado()); return true; }
    if (m !== 'POST') { X.json(res, 405, { erro: 'Método não permitido.' }); return true; }
    if (!(conta.nivel === 'owner' || X.perfilEm(conta, ['admin']))) { X.json(res, 403, { code: 'not_granted', erro: 'Só o Administrador troca os ícones do app.' }); return true; }
    let b; try { b = await X.lerJson(req); } catch (e) { X.json(res, 400, { erro: 'Pedido inválido.' }); return true; }
    if (b && b.limpar) { for (const n of Object.keys(TAM)) try { fs.rmSync(path.join(DIR, n), { force: true }); } catch (e) { } fs.writeFileSync(estadoArq, JSON.stringify({ hash: '', em: Date.now(), nomes: [] })); X.auditar(conta, req, 'ICONES_APP_PADRAO_168', 'icones168', null, null); X.json(res, 200, { ok: true, padrao: true }); return true; }
    const hash = String((b && b.hash) || '').replace(/[^a-f0-9]/g, '').slice(0, 64), ic = (b && b.icones) || {}, bufs = {};
    if (hash.length < 16) { X.json(res, 400, { erro: 'Falta o código do logotipo.' }); return true; }
    for (const [n, px] of Object.entries(TAM)) {
      const m0 = String(ic[n] || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/); if (!m0) { X.json(res, 400, { erro: 'Falta o ícone ' + n + '.' }); return true; }
      const buf = Buffer.from(m0[1], 'base64'); if (!pngOk(buf, px)) { X.json(res, 400, { erro: 'O ícone ' + n + ' não é um PNG de ' + px + ' × ' + px + '.' }); return true; }
      bufs[n] = buf;
    }
    for (const [n, buf] of Object.entries(bufs)) { const t = path.join(DIR, n + '.' + crypto.randomBytes(4).toString('hex')); fs.writeFileSync(t, buf); fs.renameSync(t, path.join(DIR, n)); }
    const e = { hash, em: Date.now(), nomes: Object.keys(bufs) }; fs.writeFileSync(estadoArq, JSON.stringify(e));
    X.auditar(conta, req, 'ICONES_APP_LOGO_168', 'icones168', null, { hash: hash.slice(0, 12) });
    X.json(res, 200, Object.assign({ ok: true }, e)); return true;
  }
  return { servir, rota, estado, TAM };
};

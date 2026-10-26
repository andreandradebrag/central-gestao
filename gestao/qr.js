'use strict';
/* Gerador de QR Code (modo byte, correção M, versões 1 a 10) que devolve SVG.
   Usado só para mostrar o código da verificação em duas etapas; sem dependências externas. */
const EC_M = [null, [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]], [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gmul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; }
function rsDivisor(deg) { const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1; for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = gmul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = gmul(root, 2); } return r; }
function rsResto(data, div) { const r = new Array(div.length).fill(0); for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gmul(c, f); }); } return r; }

function gerar(texto) {
  const bytes = Array.from(Buffer.from(String(texto), 'utf8'));
  let ver = 0;
  for (let v = 1; v <= 10; v++) { const cap = EC_M[v][1].reduce((s, [n, k]) => s + n * k, 0); if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap * 8) { ver = v; break; } }
  if (!ver) throw new Error('Texto longo demais para o QR Code.');
  const [ecLen, grupos] = EC_M[ver], cap = grupos.reduce((s, [n, k]) => s + n * k, 0);
  /* bits de dados */
  const bits = []; const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, cap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const dados = []; for (let i = 0; i < bits.length; i += 8) dados.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; dados.length < cap; p++) dados.push(p % 2 ? 0x11 : 0xec);
  /* blocos e correção de erros, intercalados */
  const blocos = []; let pos = 0; const div = rsDivisor(ecLen);
  for (const [n, k] of grupos) for (let i = 0; i < n; i++) { const d = dados.slice(pos, pos + k); pos += k; blocos.push({ d, e: rsResto(d, div) }); }
  const fim = []; const maxD = Math.max(...blocos.map(b => b.d.length));
  for (let i = 0; i < maxD; i++) blocos.forEach(b => { if (i < b.d.length) fim.push(b.d[i]); });
  for (let i = 0; i < ecLen; i++) blocos.forEach(b => fim.push(b.e[i]));
  /* matriz */
  const N = ver * 4 + 17, M = Array.from({ length: N }, () => new Array(N).fill(false)), F = Array.from({ length: N }, () => new Array(N).fill(false));
  const fx = (x, y, v) => { M[y][x] = v; F[y][x] = true; };
  for (let i = 0; i < N; i++) { fx(6, i, i % 2 === 0); fx(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [N - 4, 3], [3, N - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= N || y >= N) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); fx(x, y, d !== 2 && d !== 4); }
  const al = ALIGN[ver];
  al.forEach((a, i) => al.forEach((b, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fx(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
  const formato = mask => { const d = (0 << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); const b = ((d << 10) | r) ^ 0x5412;
    const g = i => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) fx(8, i, g(i)); fx(8, 7, g(6)); fx(8, 8, g(7)); fx(7, 8, g(8)); for (let i = 9; i < 15; i++) fx(14 - i, 8, g(i));
    for (let i = 0; i < 8; i++) fx(N - 1 - i, 8, g(i)); for (let i = 8; i < 15; i++) fx(8, N - 15 + i, g(i)); fx(8, N - 8, true); };
  formato(0);
  if (ver >= 7) { let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const b = (ver << 12) | r; for (let i = 0; i < 18; i++) { const v = ((b >>> i) & 1) === 1, a = N - 11 + (i % 3), c = Math.floor(i / 3); fx(a, c, v); fx(c, a, v); } }
  let k = 0;
  for (let right = N - 1; right >= 1; right -= 2) { if (right === 6) right = 5;
    for (let vert = 0; vert < N; vert++) for (let j = 0; j < 2; j++) { const x = right - j, up = ((right + 1) & 2) === 0, y = up ? N - 1 - vert : vert;
      if (!F[y][x] && k < fim.length * 8) { M[y][x] = ((fim[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; } } }
  const MASK = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const aplicar = m => { for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!F[y][x] && MASK[m](x, y)) M[y][x] = !M[y][x]; };
  const pena = () => { let p = 0;
    const linha = get => { for (let a = 0; a < N; a++) { let run = 1; for (let b = 1; b <= N; b++) { if (b < N && get(a, b) === get(a, b - 1)) run++; else { if (run >= 5) p += run - 2; run = 1; } }
      for (let b = 0; b + 10 < N; b++) { const s = Array.from({ length: 11 }, (_, i) => get(a, b + i) ? 1 : 0).join(''); if (s === '10111010000' || s === '00001011101') p += 40; } } };
    linha((a, b) => M[a][b]); linha((a, b) => M[b][a]);
    for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) p += 3; }
    let esc = 0; M.forEach(r => r.forEach(v => { if (v) esc++; })); p += Math.floor(Math.abs(esc * 20 - N * N * 10) / (N * N)) * 10; return p; };
  let melhor = 0, menor = Infinity;
  for (let m = 0; m < 8; m++) { aplicar(m); formato(m); const p = pena(); if (p < menor) { menor = p; melhor = m; } aplicar(m); }
  aplicar(melhor); formato(melhor);
  return M;
}

function svg(texto, px) {
  const M = gerar(texto), N = M.length, b = 4, t = N + b * 2; let d = '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (M[y][x]) d += 'M' + (x + b) + ' ' + (y + b) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + t + ' ' + t + '" width="' + (px || 220) + '" height="' + (px || 220) + '" shape-rendering="crispEdges" role="img" aria-label="QR Code"><rect width="' + t + '" height="' + t + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}
module.exports = { gerar, svg };

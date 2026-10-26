'use strict';
/* Central de Gestão — senhas, códigos de verificação em duas etapas (TOTP, RFC 6238) e códigos de recuperação. */
const crypto = require('node:crypto');

/* senhas: scrypt com custo maior (N=2^16, 64 MB). Hashes antigos (N=2^14) continuam valendo e são refeitos no próximo login. */
const N_NOVO = 65536, MAXMEM = 192 * 1024 * 1024;
function hashSenha(s) { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(String(s), salt, 64, { N: N_NOVO, r: 8, p: 1, maxmem: MAXMEM }); return 's2$' + N_NOVO + '$' + salt.toString('hex') + '$' + h.toString('hex'); }
function confere(s, hash) {
  if (!hash) return false;
  try {
    if (hash.startsWith('s2$')) { const [, n, salt, h] = hash.split('$'); const x = crypto.scryptSync(String(s), Buffer.from(salt, 'hex'), 64, { N: +n, r: 8, p: 1, maxmem: MAXMEM }); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex')); }
    const [salt, h] = hash.split(':'); const x = crypto.scryptSync(String(s), Buffer.from(salt, 'hex'), 64, { N: 16384 }); return crypto.timingSafeEqual(x, Buffer.from(h, 'hex'));
  } catch (e) { return false; }
}
const precisaRefazer = hash => !!hash && !hash.startsWith('s2$' + N_NOVO + '$');

/* senhas fracas demais: recusadas mesmo com 8 caracteres */
const COMUNS = new Set(['12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', '12341234', '11223344', 'senha123', 'senha1234', 'senha@123', 'password', 'password1', 'qwerty123', 'qwertyui', 'abcd1234', 'abc12345', 'mudar123', 'trocar123', 'admin123', 'admin1234', 'inaservicos', 'ina12345', 'central123', 'gestao123', 'brasil123', 'iloveyou', 'asdfghjk', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'aaaaaaaa', 'deus1234', 'jesus123']);
/* min: tamanho mínimo (8 para colaboradores; 12 para o dono e para perfis de Equipe que gravam, ver endurece.js) */
function senhaFraca(senha, email, nome, min) {
  const s = String(senha || ''), mn = Math.max(8, +min || 8);
  if (s.length < mn) return 'A senha precisa ter pelo menos ' + mn + ' caracteres.';
  if (s.length > 200) return 'Senha longa demais.';
  const b = s.toLowerCase();
  if (COMUNS.has(b) || /^(.)\1+$/.test(b) || /^(0123456789|1234567890|abcdefgh)/.test(b)) return 'Essa senha é muito comum. Escolha outra (dica: junte 3 ou 4 palavras).';
  const u = String(email || '').toLowerCase().split('@')[0];
  if (u.length >= 4 && b.includes(u)) return 'A senha não pode conter o seu e-mail.';
  const n = String(nome || '').toLowerCase().split(/\s+/).filter(x => x.length >= 4);
  if (n.some(x => b === x || b === x + '123' || b === x + '1234')) return 'A senha não pode ser o seu nome.';
  return '';
}

/* base32 (RFC 4648) */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = 0, v = 0, o = ''; for (const b of buf) { v = (v << 8) | b; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) o += B32[(v << (5 - bits)) & 31]; return o; }
function b32dec(s) { const t = String(s).toUpperCase().replace(/[^A-Z2-7]/g, ''); let bits = 0, v = 0; const o = []; for (const c of t) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); }

/* TOTP: 6 dígitos, 30 segundos, SHA-1 (o padrão dos aplicativos autenticadores) */
function totp(segredo, passo) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', Buffer.isBuffer(segredo) ? segredo : b32dec(segredo)).update(c).digest();
  const o = h[h.length - 1] & 15, n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
/* aceita o código do passo atual e de um passo antes ou depois (relógio do celular atrasado/adiantado).
   Devolve o passo usado (para não aceitar o mesmo código duas vezes) ou -1. */
function confereCodigo(segredo, codigo, ultimoPasso, agora) {
  const c = String(codigo || '').replace(/\D/g, ''); if (c.length !== 6) return -1;
  if (typeof segredo === 'string' && segredo.startsWith(PREF_CIF)) { segredo = decifrarSegredo(segredo); if (!segredo) return -1; }
  const p0 = Math.floor((agora || Date.now()) / 30000);
  for (const d of [0, -1, 1]) { const p = p0 + d; if (p <= (ultimoPasso || 0)) continue; const esp = totp(segredo, p); if (crypto.timingSafeEqual(Buffer.from(esp), Buffer.from(c))) return p; }
  return -1;
}
const novoSegredo = () => b32enc(crypto.randomBytes(20));

/* segredo TOTP cifrado no banco (AES-256-GCM) com a chave mestra CHAVE_MESTRA do Ambiente.
   Formato: "c1:" + base64(iv 12 | tag 16 | texto cifrado). Sem a chave, o segredo fica como antes (em claro)
   e a tela de Contas avisa. A chave pode ser 64 caracteres hexadecimais ou uma frase longa. */
const PREF_CIF = 'c1:';
let chaveMestraCache = null;
function chaveMestra() {
  const k = String(process.env.CHAVE_MESTRA || '');
  if (!k) return null;
  if (chaveMestraCache && chaveMestraCache.k === k) return chaveMestraCache.b;
  const b = /^[0-9a-fA-F]{64}$/.test(k) ? Buffer.from(k, 'hex') : crypto.scryptSync(k, 'central-gestao/chave-mestra/v1', 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  chaveMestraCache = { k, b }; return b;
}
function cifrarSegredo(s) {
  const ch = chaveMestra(); if (!ch || s == null || String(s).startsWith(PREF_CIF)) return s;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ch, iv);
  const ct = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
  return PREF_CIF + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decifrarSegredo(s) {
  if (s == null) return s; s = String(s); if (!s.startsWith(PREF_CIF)) return s;
  const ch = chaveMestra(); if (!ch) return null;
  try { const b = Buffer.from(s.slice(PREF_CIF.length), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', ch, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
  catch (e) { return null; }
}
const segredoCifrado = s => typeof s === 'string' && s.startsWith(PREF_CIF);
const uriAutenticador = (segredo, conta, emissor) => 'otpauth://totp/' + encodeURIComponent(emissor) + ':' + encodeURIComponent(conta) + '?secret=' + segredo + '&issuer=' + encodeURIComponent(emissor) + '&algorithm=SHA1&digits=6&period=30';

/* códigos de recuperação: 10 de uso único, guardados só como hash */
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const normRec = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function novosCodigosRec() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', cods = [];
  for (let i = 0; i < 10; i++) { const r = crypto.randomBytes(10); let s = ''; for (let j = 0; j < 10; j++) s += a[r[j] % a.length]; cods.push(s.slice(0, 5) + '-' + s.slice(5)); }
  return { cods, hashes: cods.map(c => sha(normRec(c))) };
}
/* devolve a lista de hashes sem o código usado, ou null se o código não vale */
function usarCodigoRec(hashesJson, codigo) {
  let hs = []; try { hs = JSON.parse(hashesJson || '[]'); } catch (e) { }
  const h = sha(normRec(codigo)); const i = hs.indexOf(h); if (i < 0 || normRec(codigo).length !== 10) return null;
  hs.splice(i, 1); return hs;
}

/* resumo do aparelho a partir do user-agent, para a lista de sessões */
function aparelho(ua) {
  const u = String(ua || '');
  const so = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux' : 'Aparelho';
  const nav = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'navegador';
  return nav + ' · ' + so;
}

module.exports = { hashSenha, confere, precisaRefazer, senhaFraca, totp, confereCodigo, novoSegredo, uriAutenticador, novosCodigosRec, usarCodigoRec, b32enc, b32dec, aparelho, sha, cifrarSegredo, decifrarSegredo, segredoCifrado, chaveMestra };

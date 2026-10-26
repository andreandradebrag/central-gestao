#!/usr/bin/env node
'use strict';
/* Central de Gestão — restauração e decifra das cópias de segurança (backup.js). Sem dependências: Node 22+.
   A chave vem da variável BACKUP_CHAVE (a mesma do serviço gestao). Exemplos:
     BACKUP_CHAVE='...' node restaurar.js conferir  /caminho/backups
     BACKUP_CHAVE='...' node restaurar.js decifrar  gestao-2026-10-26.db.gz.cg            (gera gestao-2026-10-26.db.gz)
     BACKUP_CHAVE='...' node restaurar.js banco     gestao-2026-10-26.db.gz.cg  gestao.db  (decifra, descompacta e confere)
     BACKUP_CHAVE='...' node restaurar.js anexos    /caminho/backups  /caminho/blobs       (usa o inventário mais novo)
   Arquivos sem ".cg" (cópias feitas sem BACKUP_CHAVE) também funcionam, sem precisar da chave. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');

const MAGICO = Buffer.from('CGB1'), CAB = 32, TAG = 16;
const derivar = (chave, sal) => crypto.scryptSync(String(chave), sal, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const falhar = m => { console.error('ERRO: ' + m); process.exit(1); };

/* etapas que devolvem o conteúdo original (decifrado e descompactado, conforme o nome); usadas em pipeline() */
function abrir(arq, { descompactar = true } = {}) {
  const tam = fs.statSync(arq).size, et = [];
  if (arq.endsWith('.cg')) {
    const chave = process.env.BACKUP_CHAVE; if (!chave) falhar('defina BACKUP_CHAVE para abrir ' + path.basename(arq));
    if (tam < CAB + TAG) falhar(path.basename(arq) + ': arquivo curto demais');
    const fd = fs.openSync(arq, 'r'), cab = Buffer.alloc(CAB), tag = Buffer.alloc(TAG); fs.readSync(fd, cab, 0, CAB, 0); fs.readSync(fd, tag, 0, TAG, tam - TAG); fs.closeSync(fd);
    if (!cab.subarray(0, 4).equals(MAGICO)) falhar(path.basename(arq) + ': não é uma cópia cifrada da Central de Gestão');
    const d = crypto.createDecipheriv('aes-256-gcm', derivar(chave, cab.subarray(4, 20)), cab.subarray(20, 32)); d.setAuthTag(tag);
    et.push(tam > CAB + TAG ? fs.createReadStream(arq, { start: CAB, end: tam - TAG - 1 }) : require('node:stream').Readable.from([]), d);
  } else et.push(fs.createReadStream(arq));
  if (descompactar && /\.gz(\.cg)?$/.test(arq)) et.push(zlib.createGunzip());
  return et;
}
const semCg = n => n.replace(/\.cg$/, '');
async function paraArquivo(arq, saida, opc) {
  const tmp = saida + '.parcial';
  try { await pipeline(...abrir(arq, opc), fs.createWriteStream(tmp)); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (x) { } falhar(path.basename(arq) + ': ' + (/auth|unable to authenticate/i.test(e.message) ? 'chave errada ou arquivo alterado' : e.message)); }
  fs.renameSync(tmp, saida);
}
async function lerTudo(arq) { const ch = []; await pipeline(...abrir(arq), new Writable({ write(c, e, cb) { ch.push(c); cb(); } })); return Buffer.concat(ch); }

/* lê um tar (ustar) em fluxo e grava os arquivos pedidos em destino */
async function extrairTar(arq, destino, quer) {
  let buf = Buffer.alloc(0), atual = null, resta = 0, pad = 0, fim = false, n = 0;
  const w = new Writable({
    write(ch, enc, cb) {
      buf = Buffer.concat([buf, ch]);
      try {
        while (!fim) {
          if (atual) {
            if (!buf.length) break;
            const k = Math.min(resta, buf.length); if (atual.fd != null) fs.writeSync(atual.fd, buf, 0, k); buf = buf.subarray(k); resta -= k;
            if (resta === 0) { if (atual.fd != null) { fs.closeSync(atual.fd); fs.renameSync(atual.tmp, atual.dest); n++; } atual = null; }
            else break;
          } else if (pad) { const k = Math.min(pad, buf.length); buf = buf.subarray(k); pad -= k; if (pad) break; }
          else {
            if (buf.length < 512) break;
            const h = buf.subarray(0, 512); buf = buf.subarray(512);
            if (h.every(b => b === 0)) { fim = true; break; }
            const nome = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''), tam = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8);
            if (!/^(lixo\/)?[A-Za-z0-9_-]{1,64}$/.test(nome)) throw new Error('nome inesperado no pacote: ' + nome.slice(0, 80));
            const dest = path.join(destino, nome), grava = !quer || quer.has(nome); if (grava && nome.includes('/')) fs.mkdirSync(path.dirname(dest), { recursive: true });
            atual = { fd: grava ? fs.openSync(dest + '.parcial', 'w') : null, tmp: dest + '.parcial', dest }; resta = tam; pad = (512 - (tam % 512)) % 512;
            if (tam === 0) { if (atual.fd != null) { fs.closeSync(atual.fd); fs.renameSync(atual.tmp, atual.dest); n++; } atual = null; }
          }
        }
        cb();
      } catch (e) { cb(e); }
    }
  });
  await pipeline(...abrir(arq), w);
  return n;
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'decifrar') {
    if (!a || !a.endsWith('.cg')) falhar('informe um arquivo .cg');
    const saida = b || semCg(a); await paraArquivo(a, saida, { descompactar: false }); console.log('OK: ' + saida);
  } else if (cmd === 'banco') {
    if (!a || !b) falhar('uso: node restaurar.js banco <gestao-AAAA-MM-DD.db.gz[.cg]> <destino.db>');
    if (fs.existsSync(b)) falhar(b + ' já existe. Escolha outro destino (nunca sobrescreva o banco em uso).');
    await paraArquivo(a, b);
    const cab = Buffer.alloc(16), fd = fs.openSync(b, 'r'); fs.readSync(fd, cab, 0, 16, 0); fs.closeSync(fd);
    if (cab.toString('latin1') !== 'SQLite format 3\0') falhar('o arquivo restaurado não é um banco SQLite');
    const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(b, { readOnly: true });
    const ok = db.prepare('PRAGMA integrity_check').get(), n = db.prepare('SELECT count(*) AS n FROM docs').get().n, c = db.prepare('SELECT count(*) AS n FROM contas').get().n; db.close();
    console.log('OK: ' + b + ' · integridade: ' + Object.values(ok)[0] + ' · ' + n + ' registros · ' + c + ' contas');
  } else if (cmd === 'anexos') {
    if (!a || !b) falhar('uso: node restaurar.js anexos <pasta-com-as-copias> <pasta-destino-dos-anexos> [inventario]');
    const invs = fs.readdirSync(a).filter(n => /^anexos-.*-inventario\.json\.gz(\.cg)?$/.test(n)).sort();
    const nInv = process.argv[5] || invs[invs.length - 1]; if (!nInv) falhar('nenhum inventário de anexos em ' + a);
    const inv = JSON.parse((await lerTudo(path.join(a, nInv))).toString('utf8'));
    fs.mkdirSync(b, { recursive: true });
    const porPacote = new Map(); for (const [id, pac] of Object.entries(inv.arquivos || {})) { if (!porPacote.has(pac)) porPacote.set(pac, new Set()); porPacote.get(pac).add(id); }
    let tot = 0, faltam = [];
    for (const [pac, ids] of [...porPacote].sort()) {
      const arq = path.join(a, pac); if (!fs.existsSync(arq)) { faltam.push(pac); continue; }
      const n = await extrairTar(arq, b, ids); tot += n; console.log('  ' + pac + ': ' + n + ' arquivo(s)');
    }
    if (faltam.length) falhar('faltam pacotes (baixe do armazenamento externo para a mesma pasta): ' + faltam.join(', '));
    console.log('OK: ' + tot + ' de ' + Object.keys(inv.arquivos || {}).length + ' anexos restaurados em ' + b + ' (inventário ' + nInv + ')');
  } else if (cmd === 'conferir') {
    if (!a) falhar('uso: node restaurar.js conferir <pasta-com-as-copias>');
    let ok = 0, ruins = 0;
    for (const n of fs.readdirSync(a).filter(n => /^(gestao|anexos)-.*\.gz(\.cg)?$/.test(n)).sort()) {
      try { await pipeline(...abrir(path.join(a, n)), new Writable({ write(c, e, cb) { cb(); } })); ok++; console.log('  ok    ' + n); }
      catch (e) { ruins++; console.log('  FALHA ' + n + ': ' + (/auth/i.test(e.message) ? 'chave errada ou arquivo alterado' : e.message)); }
    }
    console.log((ruins ? 'ATENÇÃO: ' : 'OK: ') + ok + ' arquivo(s) íntegro(s), ' + ruins + ' com falha.'); if (ruins) process.exit(2);
  } else {
    console.log('Uso:\n  node restaurar.js conferir <pasta>\n  node restaurar.js decifrar <arquivo.cg> [saida]\n  node restaurar.js banco <gestao-...db.gz[.cg]> <destino.db>\n  node restaurar.js anexos <pasta-com-as-copias> <pasta-destino> [inventario]\nA chave vem de BACKUP_CHAVE.');
    process.exit(cmd ? 1 : 0);
  }
}
main().catch(e => falhar(e.message));

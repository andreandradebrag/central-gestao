'use strict';
/* Central de Gestão — cópia de segurança diária do banco.
   Todo dia, a partir das 03:00 (horário de Brasília), grava DATA_DIR/backups/gestao-AAAA-MM-DD.db.gz
   (cópia consistente com VACUUM INTO, compactada) e apaga as com mais de BACKUP_DIAS (padrão 30).
   Opcional, cópia fora do servidor (S3, Cloudflare R2, Backblaze B2, Wasabi...), no Easypanel:
     BACKUP_S3_ENDPOINT (ex.: https://<conta>.r2.cloudflarestorage.com), BACKUP_S3_BUCKET,
     BACKUP_S3_REGIAO (padrão auto), BACKUP_S3_CHAVE, BACKUP_S3_SEGREDO, BACKUP_S3_PASTA (opcional).
   Os anexos (pasta blobs) não entram aqui: ficam cobertos pelo backup da VPS na Hostinger. */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

function criar(db, DATA) {
  const DIR = path.join(DATA, 'backups');
  fs.mkdirSync(DIR, { recursive: true });
  const DIAS = Math.max(3, +process.env.BACKUP_DIAS || 30);
  const est = { ultimo: null, erro: '', s3: '', rodando: false };
  const hojeBR = () => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()); const g = t => p.find(x => x.type === t).value; return { dia: g('year') + '-' + g('month') + '-' + g('day'), hora: +g('hour') }; };
  const lista = () => fs.readdirSync(DIR).filter(n => /^gestao-\d{4}-\d{2}-\d{2}(-\d{4})?\.db\.gz$/.test(n)).sort().reverse().map(n => { const st = fs.statSync(path.join(DIR, n)); return { nome: n, tam: st.size, em: st.mtimeMs }; });
  const s3Cfg = () => { const e = process.env; return e.BACKUP_S3_ENDPOINT && e.BACKUP_S3_BUCKET && e.BACKUP_S3_CHAVE && e.BACKUP_S3_SEGREDO ? { ep: e.BACKUP_S3_ENDPOINT.replace(/\/+$/, ''), bucket: e.BACKUP_S3_BUCKET, reg: e.BACKUP_S3_REGIAO || 'auto', chave: e.BACKUP_S3_CHAVE, seg: e.BACKUP_S3_SEGREDO, pasta: (e.BACKUP_S3_PASTA || '').replace(/^\/+|\/+$/g, '') } : null; };

  /* envio S3 (assinatura AWS v4, endereço no estilo caminho: endpoint/bucket/arquivo) */
  function enviarS3(arq, nome) {
    const c = s3Cfg(); if (!c) return Promise.resolve('');
    const corpo = fs.readFileSync(arq), u = new URL(c.ep), chaveObj = (c.pasta ? c.pasta + '/' : '') + nome;
    const caminho = (u.pathname.replace(/\/+$/, '') + '/' + c.bucket + '/' + chaveObj).split('/').map(encodeURIComponent).join('/');
    const agora = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), dia = agora.slice(0, 8);
    const hashC = crypto.createHash('sha256').update(corpo).digest('hex');
    const cab = { host: u.host, 'x-amz-content-sha256': hashC, 'x-amz-date': agora, 'content-type': 'application/gzip', 'content-length': String(corpo.length) };
    const nomes = Object.keys(cab).filter(k => k !== 'content-length').sort();
    const canon = ['PUT', caminho, '', nomes.map(k => k + ':' + cab[k] + '\n').join(''), nomes.join(';'), hashC].join('\n');
    const escopo = dia + '/' + c.reg + '/s3/aws4_request';
    const assinar = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
    const kAss = assinar(assinar(assinar(assinar('AWS4' + c.seg, dia), c.reg), 's3'), 'aws4_request');
    const ass = crypto.createHmac('sha256', kAss).update(['AWS4-HMAC-SHA256', agora, escopo, crypto.createHash('sha256').update(canon).digest('hex')].join('\n')).digest('hex');
    cab.authorization = 'AWS4-HMAC-SHA256 Credential=' + c.chave + '/' + escopo + ', SignedHeaders=' + nomes.join(';') + ', Signature=' + ass;
    return new Promise((ok, err) => {
      const r = (u.protocol === 'http:' ? http : https).request({ method: 'PUT', hostname: u.hostname, port: u.port || undefined, path: caminho, headers: cab, timeout: 120000 }, res => {
        let t = ''; res.on('data', d => { if (t.length < 2000) t += d; }); res.on('end', () => res.statusCode < 300 ? ok('enviado') : err(new Error('armazenamento respondeu ' + res.statusCode + ' ' + (t.match(/<Code>([^<]+)/) || [, ''])[1])));
      });
      r.on('timeout', () => r.destroy(new Error('tempo esgotado'))); r.on('error', err); r.end(corpo);
    });
  }

  async function fazer(motivo) {
    if (est.rodando) throw new Error('Já existe uma cópia em andamento.');
    est.rodando = true;
    const { dia } = hojeBR(), extra = motivo === 'manual' ? '-' + new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(':', '') : '';
    const nome = 'gestao-' + dia + extra + '.db.gz', tmp = path.join(DIR, '.tmp-' + process.pid + '.db'), dest = path.join(DIR, nome);
    try {
      try { fs.unlinkSync(tmp); } catch (e) { }
      db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
      await new Promise((ok, err) => { const w = fs.createWriteStream(dest + '.parcial'); fs.createReadStream(tmp).pipe(zlib.createGzip({ level: 6 })).pipe(w).on('finish', ok).on('error', err); });
      fs.renameSync(dest + '.parcial', dest);
      est.ultimo = { nome, em: Date.now(), tam: fs.statSync(dest).size }; est.erro = '';
      /* apaga as antigas (sempre guarda pelo menos as 7 mais novas) */
      const limite = Date.now() - DIAS * 864e5;
      lista().slice(7).forEach(b => { if (b.em < limite) try { fs.unlinkSync(path.join(DIR, b.nome)); } catch (e) { } });
      if (s3Cfg()) { try { await enviarS3(dest, nome); est.s3 = 'Última cópia enviada ao armazenamento externo em ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '.'; } catch (e) { est.s3 = 'Falhou o envio ao armazenamento externo: ' + e.message; console.error('[backup] S3:', e.message); } }
      console.log('[backup] ' + nome + ' (' + est.ultimo.tam + ' bytes)');
      return est.ultimo;
    } catch (e) { est.erro = e.message; console.error('[backup]', e.message); try { fs.unlinkSync(dest + '.parcial'); } catch (x) { } throw e; }
    finally { try { fs.unlinkSync(tmp); } catch (e) { } est.rodando = false; }
  }

  /* agenda: confere a cada 10 minutos; a partir das 3h faz a do dia se ainda não existe */
  const verificar = () => { const { dia, hora } = hojeBR(); if (hora < 3 || est.rodando) return; if (fs.existsSync(path.join(DIR, 'gestao-' + dia + '.db.gz'))) return; fazer('auto').catch(() => { }); };
  if (process.env.BACKUP_DESLIGADO !== '1') { setTimeout(verificar, 60000).unref(); setInterval(verificar, 600000).unref(); }

  const arquivo = nome => /^gestao-\d{4}-\d{2}-\d{2}(-\d{4})?\.db\.gz$/.test(nome) && fs.existsSync(path.join(DIR, nome)) ? path.join(DIR, nome) : null;
  return { fazer, lista, arquivo, estado: () => Object.assign({ s3Configurado: !!s3Cfg(), dias: DIAS }, est) };
}
module.exports = { criar };

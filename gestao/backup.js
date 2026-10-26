'use strict';
/* Central de Gestão — cópia de segurança diária do banco e dos anexos.
   Todo dia, a partir das 03:00 (horário de Brasília):
   1. Banco: DATA_DIR/backups/gestao-AAAA-MM-DD.db.gz (cópia consistente com VACUUM INTO, compactada).
   2. Anexos (/data/blobs): uma cópia completa por semana (anexos-AAAA-MM-DD-completo-NN.tar.gz) e, nos outros
      dias, só os arquivos novos (anexos-AAAA-MM-DD-incr-NN.tar.gz), mais um inventário
      (anexos-AAAA-MM-DD-inventario.json.gz) que diz em qual pacote está cada anexo.
   Com BACKUP_CHAVE preenchida, tudo é cifrado (AES-256-GCM, chave derivada por scrypt) e os arquivos ganham ".cg".
   Sem a chave, a tela de Contas avisa que a cópia está sem cifra.
   Para restaurar ou decifrar: node restaurar.js (veja o LEIA-ME).
   Opcional, cópia fora do servidor (S3, Cloudflare R2, Backblaze B2, Wasabi...), no Easypanel:
     BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_REGIAO (padrão auto), BACKUP_S3_CHAVE, BACKUP_S3_SEGREDO, BACKUP_S3_PASTA.
   Outras opções: BACKUP_DIAS (30), BACKUP_ANEXOS=0 (desliga os anexos), BACKUP_ANEXOS_COMPLETO_DIAS (7),
   BACKUP_ANEXOS_VOLUME_MB (1024, tamanho máximo de cada pacote), BACKUP_ANEXOS_MANTER_LOCAL (1 sem S3; 0 com S3). */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');

/* ---------- cifra (formato compartilhado com restaurar.js) ----------
   'CGB1' (4 bytes) | sal (16) | iv (12) | dados cifrados | tag GCM (16) */
const MAGICO = Buffer.from('CGB1');
const derivar = (chave, sal) => crypto.scryptSync(String(chave), sal, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
function cifrador(chave) {
  const sal = crypto.randomBytes(16), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', derivar(chave, sal), iv);
  let ini = false;
  return new Transform({
    transform(ch, enc, cb) { if (!ini) { ini = true; this.push(Buffer.concat([MAGICO, sal, iv])); } cb(null, c.update(ch)); },
    flush(cb) { if (!ini) this.push(Buffer.concat([MAGICO, sal, iv])); const f = c.final(); if (f.length) this.push(f); this.push(c.getAuthTag()); cb(); }
  });
}

/* ---------- tar (ustar) mínimo, sem dependências ---------- */
function cabTar(nome, tam, mtime) {
  const h = Buffer.alloc(512, 0);
  const put = (s, off, len) => { Buffer.from(s, 'utf8').copy(h, off, 0, len); };
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(nome, 0, 100); put('0000644\0', 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(tam, 12), 124, 12); put(oct(Math.floor(mtime / 1000), 12), 136, 12); put('        ', 148, 8); put('0', 156, 1);
  put('ustar\0', 257, 6); put('00', 263, 2);
  let s = 0; for (let i = 0; i < 512; i++) s += h[i];
  put(s.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
async function* gerarTar(dir, itens) {
  for (const it of itens) {
    yield cabTar(it.id, it.tam, it.mt);
    let n = 0;
    for await (const ch of fs.createReadStream(path.join(dir, it.id))) { n += ch.length; if (n > it.tam) { yield ch.subarray(0, ch.length - (n - it.tam)); break; } yield ch; }
    if (n < it.tam) yield Buffer.alloc(it.tam - n, 0); /* arquivo encolheu durante a cópia: completa com zeros (não acontece; anexos não mudam) */
    const pad = (512 - (it.tam % 512)) % 512; if (pad) yield Buffer.alloc(pad, 0);
  }
  yield Buffer.alloc(1024, 0);
}

function criar(db, DATA) {
  const DIR = path.join(DATA, 'backups'), BLOBS = path.join(DATA, 'blobs');
  fs.mkdirSync(DIR, { recursive: true });
  const DIAS = Math.max(3, +process.env.BACKUP_DIAS || 30);
  const chave = () => process.env.BACKUP_CHAVE || '';
  const CG = () => chave() ? '.cg' : '';
  const est = { ultimo: null, erro: '', s3: '', rodando: false, anexos: null, anexosErro: '' };
  const hojeBR = () => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()); const g = t => p.find(x => x.type === t).value; return { dia: g('year') + '-' + g('month') + '-' + g('day'), hora: +g('hour') }; };
  const RE_BANCO = /^gestao-\d{4}-\d{2}-\d{2}(-\d{4})?\.db\.gz(\.cg)?$/;
  const RE_ANX = /^anexos-\d{4}-\d{2}-\d{2}(-\d{4})?-(completo|incr)-\d{2}\.tar\.gz(\.cg)?$/;
  const RE_INV = /^anexos-\d{4}-\d{2}-\d{2}(-\d{4})?-inventario\.json\.gz(\.cg)?$/;
  const info = n => { const st = fs.statSync(path.join(DIR, n)); return { nome: n, tam: st.size, em: st.mtimeMs, cifrado: n.endsWith('.cg') }; };
  const lista = () => fs.readdirSync(DIR).filter(n => RE_BANCO.test(n)).sort().reverse().map(info);
  const listaAnexos = () => fs.readdirSync(DIR).filter(n => RE_ANX.test(n) || RE_INV.test(n)).sort().reverse().map(info);
  const s3Cfg = () => { const e = process.env; return e.BACKUP_S3_ENDPOINT && e.BACKUP_S3_BUCKET && e.BACKUP_S3_CHAVE && e.BACKUP_S3_SEGREDO ? { ep: e.BACKUP_S3_ENDPOINT.replace(/\/+$/, ''), bucket: e.BACKUP_S3_BUCKET, reg: e.BACKUP_S3_REGIAO || 'auto', chave: e.BACKUP_S3_CHAVE, seg: e.BACKUP_S3_SEGREDO, pasta: (e.BACKUP_S3_PASTA || '').replace(/^\/+|\/+$/g, '') } : null; };
  const manterLocal = () => process.env.BACKUP_ANEXOS_MANTER_LOCAL ? process.env.BACKUP_ANEXOS_MANTER_LOCAL !== '0' : !s3Cfg();

  /* grava um fluxo compactado (e cifrado, com chave) em destino, de forma atômica */
  async function gravar(origem, destino) {
    const etapas = [origem, zlib.createGzip({ level: 6 })];
    if (chave()) etapas.push(cifrador(chave()));
    etapas.push(fs.createWriteStream(destino + '.parcial'));
    await pipeline(...etapas);
    fs.renameSync(destino + '.parcial', destino);
  }

  /* envio S3 (assinatura AWS v4, endereço no estilo caminho: endpoint/bucket/arquivo). O arquivo é lido em
     fluxo duas vezes (hash e envio), sem carregar tudo na memória. */
  async function enviarS3(arq, nome) {
    const c = s3Cfg(); if (!c) return '';
    const tam = fs.statSync(arq).size, u = new URL(c.ep), chaveObj = (c.pasta ? c.pasta + '/' : '') + nome;
    const hs = crypto.createHash('sha256'); for await (const ch of fs.createReadStream(arq)) hs.update(ch); const hashC = hs.digest('hex');
    const caminho = (u.pathname.replace(/\/+$/, '') + '/' + c.bucket + '/' + chaveObj).split('/').map(encodeURIComponent).join('/');
    const agora = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), dia = agora.slice(0, 8);
    const cab = { host: u.host, 'x-amz-content-sha256': hashC, 'x-amz-date': agora, 'content-type': 'application/octet-stream', 'content-length': String(tam) };
    const nomes = Object.keys(cab).filter(k => k !== 'content-length').sort();
    const canon = ['PUT', caminho, '', nomes.map(k => k + ':' + cab[k] + '\n').join(''), nomes.join(';'), hashC].join('\n');
    const escopo = dia + '/' + c.reg + '/s3/aws4_request';
    const assinar = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
    const kAss = assinar(assinar(assinar(assinar('AWS4' + c.seg, dia), c.reg), 's3'), 'aws4_request');
    const ass = crypto.createHmac('sha256', kAss).update(['AWS4-HMAC-SHA256', agora, escopo, crypto.createHash('sha256').update(canon).digest('hex')].join('\n')).digest('hex');
    cab.authorization = 'AWS4-HMAC-SHA256 Credential=' + c.chave + '/' + escopo + ', SignedHeaders=' + nomes.join(';') + ', Signature=' + ass;
    return new Promise((ok, err) => {
      const r = (u.protocol === 'http:' ? http : https).request({ method: 'PUT', hostname: u.hostname, port: u.port || undefined, path: caminho, headers: cab, timeout: 600000 }, res => {
        let t = ''; res.on('data', d => { if (t.length < 2000) t += d; }); res.on('end', () => res.statusCode < 300 ? ok('enviado') : err(new Error('armazenamento respondeu ' + res.statusCode + ' ' + (t.match(/<Code>([^<]+)/) || [, ''])[1])));
      });
      r.on('timeout', () => r.destroy(new Error('tempo esgotado'))); r.on('error', err);
      fs.createReadStream(arq).on('error', err).pipe(r);
    });
  }

  /* ---------- anexos: completo semanal + incremental diário + inventário ---------- */
  const ESTADO = path.join(DIR, 'anexos-estado.json');
  const lerEstado = () => { try { return JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch (e) { return { completoEm: '', mapa: {} }; } };
  async function fazerAnexos(rotulo) {
    if (process.env.BACKUP_ANEXOS === '0' || !fs.existsSync(BLOBS)) return [];
    const e0 = lerEstado(), atuais = new Map();
    /* anexos ativos e os da lixeira (blobs/lixo, ainda restauráveis pelo sistema) */
    for (const sub of ['', 'lixo']) { const pasta = path.join(BLOBS, sub); let ns = []; try { ns = fs.readdirSync(pasta); } catch (e) { continue; }
      for (const n of ns) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(n) || (!sub && n === 'lixo')) continue; const id = sub ? sub + '/' + n : n; try { const st = fs.statSync(path.join(pasta, n)); if (st.isFile()) atuais.set(id, { id, tam: st.size, mt: st.mtimeMs }); } catch (e) { } } }
    const diasDesde = e0.completoEm ? (Date.parse(rotulo.slice(0, 10)) - Date.parse(e0.completoEm)) / 864e5 : Infinity;
    const completo = !e0.completoEm || diasDesde >= Math.max(1, +process.env.BACKUP_ANEXOS_COMPLETO_DIAS || 7);
    const mapa = completo ? {} : Object.fromEntries(Object.entries(e0.mapa || {}).filter(([id]) => atuais.has(id)));
    const novos = [...atuais.values()].filter(x => !mapa[x.id]).sort((a, b) => a.mt - b.mt);
    const VOL = Math.max(16, +process.env.BACKUP_ANEXOS_VOLUME_MB || 1024) * 1048576, feitos = [];
    let grupo = [], soma = 0, n = 0;
    const fechar = async () => {
      if (!grupo.length) return; n++;
      const nome = 'anexos-' + rotulo + '-' + (completo ? 'completo' : 'incr') + '-' + String(n).padStart(2, '0') + '.tar.gz' + CG();
      await gravar(Readable.from(gerarTar(BLOBS, grupo)), path.join(DIR, nome));
      for (const x of grupo) mapa[x.id] = nome; feitos.push(nome); grupo = []; soma = 0;
    };
    for (const x of novos) { if (grupo.length && soma + x.tam > VOL) await fechar(); grupo.push(x); soma += x.tam; }
    await fechar();
    const inv = { versao: 1, gerado: Date.now(), rotulo, tipo: completo ? 'completo' : 'incremental', cifrado: !!chave(), total: atuais.size, bytes: [...atuais.values()].reduce((s, x) => s + x.tam, 0), novos: novos.length, arquivos: mapa };
    const nomeInv = 'anexos-' + rotulo + '-inventario.json.gz' + CG();
    await gravar(Readable.from([Buffer.from(JSON.stringify(inv))]), path.join(DIR, nomeInv));
    feitos.push(nomeInv);
    fs.writeFileSync(ESTADO + '.parcial', JSON.stringify({ completoEm: completo ? rotulo.slice(0, 10) : e0.completoEm, mapa })); fs.renameSync(ESTADO + '.parcial', ESTADO);
    est.anexos = { em: Date.now(), tipo: inv.tipo, novos: novos.length, total: atuais.size, pacotes: feitos.length - 1 };
    return feitos;
  }
  /* apaga pacotes de anexos que já não fazem parte da cópia atual e são mais velhos que BACKUP_DIAS */
  function limparAnexos() {
    const usados = new Set(Object.values(lerEstado().mapa || {})), limite = Date.now() - DIAS * 864e5;
    const invs = listaAnexos().filter(b => RE_INV.test(b.nome));
    for (const b of listaAnexos()) {
      if (RE_ANX.test(b.nome) && !usados.has(b.nome) && b.em < limite) try { fs.unlinkSync(path.join(DIR, b.nome)); } catch (e) { }
    }
    invs.slice(7).forEach(b => { if (b.em < limite) try { fs.unlinkSync(path.join(DIR, b.nome)); } catch (e) { } });
  }

  async function fazer(motivo) {
    if (est.rodando) throw new Error('Já existe uma cópia em andamento.');
    est.rodando = true;
    const { dia } = hojeBR(), extra = motivo === 'manual' ? '-' + new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(':', '') : '';
    const nome = 'gestao-' + dia + extra + '.db.gz' + CG(), tmp = path.join(DIR, '.tmp-' + process.pid + '.db'), dest = path.join(DIR, nome);
    try {
      try { fs.unlinkSync(tmp); } catch (e) { }
      db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
      await gravar(fs.createReadStream(tmp), dest);
      est.ultimo = { nome, em: Date.now(), tam: fs.statSync(dest).size, cifrado: !!chave() }; est.erro = '';
      /* apaga as antigas (sempre guarda pelo menos as 7 mais novas) */
      const limite = Date.now() - DIAS * 864e5;
      lista().slice(7).forEach(b => { if (b.em < limite) try { fs.unlinkSync(path.join(DIR, b.nome)); } catch (e) { } });
      let anx = [];
      try { anx = await fazerAnexos(dia + extra); est.anexosErro = ''; } catch (e) { est.anexosErro = e.message; console.error('[backup] anexos:', e.message); }
      if (s3Cfg()) {
        /* pacotes de anexos que não subiram numa vez anterior ficam numa fila e são tentados de novo */
        const PEND = path.join(DIR, 's3-pendentes.json'); let pend = []; try { pend = JSON.parse(fs.readFileSync(PEND, 'utf8')); } catch (e) { }
        pend = [...new Set(pend.concat(anx))]; const resta = []; let falha = null;
        try { await enviarS3(dest, nome); } catch (e) { falha = e; }
        for (const a of pend) {
          if (!fs.existsSync(path.join(DIR, a))) continue;
          try { await enviarS3(path.join(DIR, a), a); if (!manterLocal() && RE_ANX.test(a)) try { fs.unlinkSync(path.join(DIR, a)); } catch (e) { } }
          catch (e) { resta.push(a); falha = falha || e; }
        }
        try { fs.writeFileSync(PEND, JSON.stringify(resta)); } catch (e) { }
        if (falha) { est.s3 = 'Falhou o envio ao armazenamento externo: ' + falha.message + (resta.length ? ' (' + resta.length + ' arquivo(s) de anexos ficam para a próxima vez)' : ''); console.error('[backup] S3:', falha.message); }
        else est.s3 = 'Última cópia (banco' + (anx.length ? ' e anexos' : '') + ') enviada ao armazenamento externo em ' + new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + '.';
      }
      limparAnexos();
      console.log('[backup] ' + nome + ' (' + est.ultimo.tam + ' bytes)' + (anx.length ? ' + ' + anx.length + ' arquivo(s) de anexos' : '') + (chave() ? ' · cifrado' : ' · SEM CIFRA (defina BACKUP_CHAVE)'));
      return est.ultimo;
    } catch (e) { est.erro = e.message; console.error('[backup]', e.message); try { fs.unlinkSync(dest + '.parcial'); } catch (x) { } throw e; }
    finally { try { fs.unlinkSync(tmp); } catch (e) { } est.rodando = false; }
  }

  /* agenda: confere a cada 10 minutos; a partir das 3h faz a do dia se ainda não existe */
  const verificar = () => { const { dia, hora } = hojeBR(); if (hora < 3 || est.rodando) return; if (lista().some(b => b.nome.startsWith('gestao-' + dia + '.db.gz'))) return; fazer('auto').catch(() => { }); };
  if (process.env.BACKUP_DESLIGADO !== '1') { setTimeout(verificar, 60000).unref(); setInterval(verificar, 600000).unref(); }

  const arquivo = nome => (RE_BANCO.test(nome) || RE_ANX.test(nome) || RE_INV.test(nome)) && fs.existsSync(path.join(DIR, nome)) ? path.join(DIR, nome) : null;

  /* cartão da tela Contas de acesso (só o dono vê) */
  function cartao(esc) {
    const e = Object.assign({ s3Configurado: !!s3Cfg(), dias: DIAS }, est), ls = lista().slice(0, 10), la = listaAnexos().filter(b => RE_INV.test(b.nome)).slice(0, 1);
    const mb = n => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + ' MB', quando = t => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return '<div class="card"><h2>Cópia de segurança</h2>' +
      (chave() ? '' : '<div class="msg err"><b>Cópia sem cifra.</b> Quem conseguir o arquivo da cópia (no servidor, no armazenamento externo ou baixado) lê todos os dados. Defina <b>BACKUP_CHAVE</b> no serviço gestao › Ambiente (uma frase longa ou <code>openssl rand -hex 32</code>), guarde a chave fora do servidor e clique em Implantar.</div>') +
      '<p class="sub" style="margin:0 0 10px">Todo dia, a partir das 3h, o sistema grava uma cópia do banco de dados' + (process.env.BACKUP_ANEXOS === '0' ? '' : ' e dos anexos (completa uma vez por semana, nos outros dias só os arquivos novos)') + ' e guarda as dos últimos ' + e.dias + ' dias' + (chave() ? ', <b>cifradas</b>' : '') + '. ' +
      (e.s3Configurado ? 'Cada cópia também vai para o armazenamento externo configurado.' : '<b>As cópias estão só neste servidor.</b> Para guardar fora dele, preencha BACKUP_S3_* no Easypanel (veja o LEIA-ME).') + '</p>' +
      (e.erro ? '<div class="msg err">A última tentativa falhou: ' + esc(e.erro) + '</div>' : '') + (e.anexosErro ? '<div class="msg err">A cópia dos anexos falhou: ' + esc(e.anexosErro) + '</div>' : '') +
      (e.s3 ? '<p class="sub" style="margin:0 0 10px">' + esc(e.s3) + '</p>' : '') +
      (e.anexos ? '<p class="sub" style="margin:0 0 10px">Anexos: ' + (e.anexos.tipo === 'completo' ? 'cópia completa' : 'cópia dos novos') + ' em ' + quando(e.anexos.em) + ' (' + e.anexos.novos + ' novo(s), ' + e.anexos.total + ' no total).</p>' : la.length ? '<p class="sub" style="margin:0 0 10px">Último inventário de anexos: ' + esc(la[0].nome) + ' (' + quando(la[0].em) + ').</p>' : '') +
      (ls.length ? '<table><thead><tr><th>Arquivo</th><th>Tamanho</th><th>Gravada em</th><th></th></tr></thead><tbody>' + ls.map(b => '<tr><td>' + esc(b.nome) + (b.cifrado ? '' : ' <span style="color:var(--neg)">(sem cifra)</span>') + '</td><td>' + mb(b.tam) + '</td><td>' + quando(b.em) + '</td><td><a class="btn" href="/contas/backups/' + encodeURIComponent(b.nome) + '">Baixar</a></td></tr>').join('') + '</tbody></table>' : '<p class="sub">Nenhuma cópia ainda.</p>') +
      '<form method="post" action="/contas/backup-agora" style="margin-top:10px"><button type="submit">Fazer uma cópia agora</button></form></div>';
  }
  return { fazer, lista, listaAnexos, arquivo, cartao, cifrado: () => !!chave(), estado: () => Object.assign({ s3Configurado: !!s3Cfg(), dias: DIAS, cifrado: !!chave() }, est) };
}
module.exports = { criar, cifrador, MAGICO, derivar };

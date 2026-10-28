'use strict';
/* Central de Gestão — envio de e-mail (SMTP) sem dependências externas.
   Configuração no Easypanel (serviço gestao › Ambiente):
     SMTP_HOST, SMTP_PORT (465 = SSL direto; 587 ou 25 = STARTTLS), SMTP_USUARIO, SMTP_SENHA,
     SMTP_REMETENTE (ex.: "INA Serviços <inaservicos@inaservicos.com.br>"; padrão = SMTP_USUARIO).
   Usado para o convite de novo usuário e para "Esqueci minha senha".
   v125: cópia (cc) e anexos ([{nome, tipo, dados: Buffer}]), usados no envio da ordem de fabricação (PDF) à fábrica. */
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const CFG = () => ({
  host: (process.env.SMTP_HOST || '').trim(),
  port: +process.env.SMTP_PORT || 465,
  usuario: (process.env.SMTP_USUARIO || '').trim(),
  senha: process.env.SMTP_SENHA || '',
  remetente: (process.env.SMTP_REMETENTE || process.env.SMTP_USUARIO || '').trim(),
  tlsDireto: process.env.SMTP_TLS === 'ssl' ? true : process.env.SMTP_TLS === 'starttls' ? false : (+process.env.SMTP_PORT || 465) === 465,
  /* sem TLS só nos testes automáticos (NODE_ENV=test); em produção a senha do e-mail nunca trafega aberta */
  semTls: process.env.SMTP_TLS === 'nao' && process.env.NODE_ENV === 'test'
});
if (process.env.SMTP_TLS === 'nao' && process.env.NODE_ENV !== 'test') console.warn('[email] SMTP_TLS=nao ignorado: só vale com NODE_ENV=test. O envio usa TLS.');
const configurado = () => { const c = CFG(); return !!(c.host && c.usuario && c.senha && c.remetente); };

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const cab = s => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';
const enderecoDe = s => { const m = String(s).match(/<([^>]+)>/); return (m ? m[1] : String(s)).trim(); };
function remetenteFmt(r) { const m = String(r).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/); return m && m[1] ? cab(m[1]) + ' <' + m[2] + '>' : r; }
const linhas76 = s => s.replace(/.{1,76}/g, '$&\r\n');

/* conversa SMTP: lê respostas linha a linha (códigos de 3 dígitos, multilinha com "250-") */
function conversa(sock) {
  let buf = '', fila = [], esperando = null, erro = null;
  const tentar = () => {
    while (esperando) {
      const i = buf.search(/^\d{3} .*\r?\n/m); if (i < 0) return;
      const fim = buf.indexOf('\n', i) + 1, bloco = buf.slice(0, fim); buf = buf.slice(fim);
      const w = esperando; esperando = null; w.ok({ cod: +bloco.slice(i, i + 3), txt: bloco.trim() });
      if (fila.length) esperando = fila.shift();
    }
  };
  const ligar = s => { s.on('data', d => { buf += d.toString('utf8'); tentar(); }); s.on('error', e => { erro = e; if (esperando) esperando.err(e); fila.forEach(w => w.err(e)); }); };
  ligar(sock);
  return {
    trocar(s) { sock.removeAllListeners('data'); sock = s; buf = ''; ligar(s); },
    ler() { return new Promise((ok, err) => { if (erro) return err(erro); const w = { ok, err }; if (esperando) fila.push(w); else { esperando = w; tentar(); } }); },
    async cmd(linha, espera) { sock.write(linha + '\r\n'); const r = await this.ler(); if (espera && !espera.includes(r.cod)) throw new Error('Servidor de e-mail respondeu: ' + r.txt.split('\n').pop().slice(0, 200)); return r; },
    get sock() { return sock; }
  };
}

async function enviar({ para, assunto, texto, html, cc, anexos }) {
  const c = CFG();
  if (!configurado()) throw new Error('E-mail não configurado no servidor (SMTP).');
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(para)) throw new Error('E-mail do destinatário inválido.');
  const copias = [...new Set([].concat(cc || []).map(x => String(x).trim()).filter(Boolean))].filter(x => x.toLowerCase() !== String(para).toLowerCase());
  if (copias.length > 10 || copias.some(x => !/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(x))) throw new Error('E-mail de cópia inválido.');
  const anx = [].concat(anexos || []).filter(a => a && a.dados && a.dados.length);
  const abrir = () => new Promise((ok, err) => {
    const op = { host: c.host, port: c.port, servername: c.host, timeout: 20000 };
    const s = c.tlsDireto && !c.semTls ? tls.connect(op, () => ok(s)) : net.connect(op, () => ok(s));
    s.once('error', err); s.setTimeout(20000, () => s.destroy(new Error('Tempo esgotado falando com o servidor de e-mail.')));
  });
  const sock = await abrir(), cv = conversa(sock);
  try {
    let r = await cv.ler(); if (r.cod !== 220) throw new Error('Servidor de e-mail recusou a conexão: ' + r.txt.slice(0, 200));
    r = await cv.cmd('EHLO central-gestao', [250]);
    if (!c.tlsDireto && !c.semTls) {
      if (!/STARTTLS/i.test(r.txt)) throw new Error('O servidor de e-mail não oferece STARTTLS nesta porta. Use a porta 465.');
      await cv.cmd('STARTTLS', [220]); sock.removeAllListeners('data');
      const seg = await new Promise((ok, err) => { const t = tls.connect({ socket: sock, servername: c.host }, () => ok(t)); t.once('error', err); });
      cv.trocar(seg); await cv.cmd('EHLO central-gestao', [250]);
    }
    await cv.cmd('AUTH LOGIN', [334]); await cv.cmd(b64(c.usuario), [334]);
    await cv.cmd(b64(c.senha), [235]).catch(() => { throw new Error('Usuário ou senha do e-mail recusados (confira SMTP_USUARIO e SMTP_SENHA).'); });
    await cv.cmd('MAIL FROM:<' + enderecoDe(c.remetente) + '>', [250]);
    await cv.cmd('RCPT TO:<' + para + '>', [250, 251]);
    for (const x of copias) await cv.cmd('RCPT TO:<' + x + '>', [250, 251]);
    await cv.cmd('DATA', [354]);
    const fronteira = 'cg' + crypto.randomBytes(12).toString('hex'), dominio = enderecoDe(c.remetente).split('@')[1] || 'localhost';
    const corpo = ['--' + fronteira, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', linhas76(b64(texto)),
      '--' + fronteira, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', linhas76(b64(html || texto)),
      '--' + fronteira + '--', ''];
    const cabs = ['From: ' + remetenteFmt(c.remetente), 'To: <' + para + '>'].concat(copias.length ? ['Cc: ' + copias.map(x => '<' + x + '>').join(', ')] : []).concat(['Subject: ' + cab(assunto), 'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + crypto.randomBytes(16).toString('hex') + '@' + dominio + '>', 'MIME-Version: 1.0']);
    let msg;
    if (!anx.length) msg = cabs.concat(['Content-Type: multipart/alternative; boundary="' + fronteira + '"', ''], corpo).join('\r\n');
    else { /* v125: multipart/mixed com o texto e os anexos (base64) */
      const misto = 'cm' + crypto.randomBytes(12).toString('hex'), nomeArq = n => String(n || 'anexo').replace(/["\\\r\n]/g, '_').slice(0, 120);
      const partes = anx.map(a => ['--' + misto, 'Content-Type: ' + String(a.tipo || 'application/octet-stream').replace(/[^\w.+\-\/]/g, '') + '; name="' + cab(nomeArq(a.nome)) + '"', 'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="' + cab(nomeArq(a.nome)) + '"', '', linhas76(Buffer.from(a.dados).toString('base64'))].join('\r\n'));
      msg = cabs.concat(['Content-Type: multipart/mixed; boundary="' + misto + '"', '', '--' + misto, 'Content-Type: multipart/alternative; boundary="' + fronteira + '"', ''], corpo, partes, ['--' + misto + '--', '']).join('\r\n'); }
    await cv.cmd(msg + '\r\n.', [250]);
    cv.sock.write('QUIT\r\n'); cv.sock.end();
    return true;
  } catch (e) { try { cv.sock.destroy(); } catch (x) { } throw e; }
}

const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function modelo(titulo, paragrafos, botao, link, rodape) {
  const html = '<!doctype html><html><body style="margin:0;padding:24px;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f1b2d">' +
    '<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #dfe4ec;border-radius:12px;padding:28px">' +
    '<h1 style="font-size:20px;margin:0 0 16px">' + escH(titulo) + '</h1>' + paragrafos.map(p => '<p style="font-size:15px;line-height:1.5;margin:0 0 12px">' + escH(p) + '</p>').join('') +
    '<p style="margin:20px 0"><a href="' + escH(link) + '" style="display:inline-block;background:#2457d6;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">' + escH(botao) + '</a></p>' +
    '<p style="font-size:12px;color:#5b6678;line-height:1.5;margin:16px 0 0">Se o botão não funcionar, copie e cole no navegador:<br>' + escH(link) + '</p>' +
    '<p style="font-size:12px;color:#5b6678;line-height:1.5;margin:12px 0 0">' + escH(rodape) + '</p></div></body></html>';
  const texto = titulo + '\n\n' + paragrafos.join('\n\n') + '\n\n' + botao + ': ' + link + '\n\n' + rodape + '\n';
  return { html, texto };
}

module.exports = { enviar, configurado, modelo };

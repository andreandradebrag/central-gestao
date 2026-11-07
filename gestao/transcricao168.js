'use strict';
/* v168 (relatorios/feito_v168.md): transcrição das reuniões atrás de UMA interface, para que outras fontes se encaixem depois.
     fonte.transcrever(arquivo) → Promise<{ texto, segmentos: [{ ini, fim, quem, t }] }>   (ini/fim em milissegundos)
   Fontes:
   - openai: OpenAI audio/transcriptions. Chave OPENAI_API_KEY; modelo TRANSCRICAO_MODELO (padrão gpt-4o-transcribe; se a
     OpenAI recusar o modelo, tenta whisper-1); idioma pt. O áudio longo é dividido em partes abaixo do limite da API
     (TRANSCRICAO_PARTE_MB, padrão 24 MB, e TRANSCRICAO_PARTE_MIN, padrão 10 min), pelos "clusters" do WebM (cada parte = o
     cabeçalho do arquivo + clusters inteiros); a ordem e os horários são mantidos (o horário do cluster vira o deslocamento).
     whisper-1 devolve os trechos com horário (verbose_json); gpt-4o-transcribe devolve só o texto: cada parte vira um trecho
     com o horário de início e fim da parte.
   - manual (importarArquivo / importarTexto): transcrição exportada do Teams ou do Meet (.vtt, .srt, .docx) ou texto (.txt).
   - teams: PLANEJADA (não implementada). Importação automática pelo Microsoft Graph
     (GET /users/{organizador}/onlineMeetings/{id}/transcripts e .../content?$format=text/vtt, permissão de aplicativo
     OnlineMeetingTranscript.Read.All + política de acesso de aplicativo do Teams), que depende do consentimento de
     administrador do Microsoft 365 (o mesmo que falta para o e-mail). Quando existir, basta implementar transcrever() que
     baixa o .vtt e chama importarTexto('x.vtt', ...). */
const fs = require('node:fs'), zlib = require('node:zlib');

/* ---------------- WebM (EBML): divide pelos clusters ---------------- */
function vint(b, p, ehId) {
  if (p >= b.length) return null;
  const c = b[p]; let n = 1, m = 0x80; while (n <= 8 && !(c & m)) { n++; m >>= 1; }
  if (n > 8 || p + n > b.length) return null;
  if (ehId) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return { v, n }; }
  let v = c & (m - 1), todos = v === m - 1;
  for (let i = 1; i < n; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) todos = false; }
  return { v: todos ? -1 : v, n };
}
const ID = { EBML: 0x1A45DFA3, SEG: 0x18538067, CLUSTER: 0x1F43B675, INFO: 0x1549A966, TCSCALE: 0x2AD7B1, TC: 0xE7 };
const FILHOS_CLUSTER = new Set([0xE7, 0xA3, 0xA0, 0xA7, 0xAB, 0x5854]);
function uint(b, p, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; }
/* estrutura: { init: Buffer (cabeçalho até o 1º cluster, com o tamanho do Segment "desconhecido"), clusters: [{ini, fim, ms}] } */
function webmEstrutura(b) {
  let p = 0; const e = vint(b, 0, true); if (!e || e.v !== ID.EBML) return null;
  const es = vint(b, e.n); if (!es || es.v < 0) return null; p = e.n + es.n + es.v;
  const s = vint(b, p, true); if (!s || s.v !== ID.SEG) return null;
  const ss = vint(b, p + s.n); if (!ss) return null;
  const segTamPos = p + s.n, segTamN = ss.n, dados = p + s.n + ss.n, fimSeg = ss.v < 0 ? b.length : Math.min(b.length, dados + ss.v);
  let escala = 1000000; const clusters = []; p = dados;
  while (p < fimSeg) {
    const id = vint(b, p, true); if (!id) break; const tm = vint(b, p + id.n); if (!tm) break;
    const ini = p, d0 = p + id.n + tm.n;
    if (id.v === ID.CLUSTER) {
      let q = d0, ms = null, fim;
      if (tm.v >= 0) fim = Math.min(fimSeg, d0 + tm.v);
      else { fim = fimSeg; while (q < fimSeg) { const ci = vint(b, q, true); if (!ci || !FILHOS_CLUSTER.has(ci.v)) { fim = q; break; } const ct = vint(b, q + ci.n); if (!ct || ct.v < 0) { fim = q; break; } q = q + ci.n + ct.n + ct.v; if (q > fimSeg) { fim = fimSeg; break; } } }
      /* horário do cluster (Timecode, primeiro filho) */
      let r = d0; while (r < fim) { const ci = vint(b, r, true); if (!ci) break; const ct = vint(b, r + ci.n); if (!ct || ct.v < 0) break; if (ci.v === ID.TC) { ms = uint(b, r + ci.n + ct.n, ct.v) * escala / 1e6; break; } r += ci.n + ct.n + ct.v; }
      if (fim <= ini) break;
      clusters.push({ ini, fim, ms: ms == null ? (clusters.length ? clusters[clusters.length - 1].ms : 0) : ms });
      p = fim; continue;
    }
    if (tm.v < 0) break;
    if (id.v === ID.INFO) { let r = d0; const f = d0 + tm.v; while (r < f) { const ci = vint(b, r, true); if (!ci) break; const ct = vint(b, r + ci.n); if (!ct || ct.v < 0) break; if (ci.v === ID.TCSCALE) escala = uint(b, r + ci.n + ct.n, ct.v) || escala; r += ci.n + ct.n + ct.v; } }
    p = d0 + tm.v;
  }
  if (!clusters.length) return null;
  const init = Buffer.from(b.subarray(0, clusters[0].ini));
  /* o tamanho do Segment vira "desconhecido" (cada parte é um arquivo novo, menor) */
  init[segTamPos] = (0x100 >> segTamN) | ((0x100 >> segTamN) - 1); for (let i = 1; i < segTamN; i++) init[segTamPos + i] = 0xff;
  return { init, clusters, escala };
}
/* partes [{buf, iniMs, fimMs}] com até maxBytes e maxMs cada; o arquivo pequeno vai inteiro */
function dividirWebm(b, maxBytes, maxMs, durMs) {
  if (b.length <= maxBytes && (!durMs || durMs <= maxMs)) return [{ buf: b, iniMs: 0, fimMs: durMs || null }];
  const e = webmEstrutura(b);
  if (!e) { if (b.length <= maxBytes) return [{ buf: b, iniMs: 0, fimMs: durMs || null }]; throw { st: 422, msg: 'Não foi possível dividir o áudio em partes (o arquivo não é um WebM reconhecido). Grave pelo Chrome ou Edge, ou importe a transcrição.' }; }
  const partes = []; let atual = null;
  const fecha = () => { if (atual && atual.cl.length) partes.push(atual); atual = null; };
  for (const c of e.clusters) {
    const t = c.fim - c.ini;
    if (e.init.length + t > maxBytes) throw { st: 422, msg: 'Um trecho do áudio é grande demais para a transcrição.' };
    if (atual && (atual.bytes + t > maxBytes || c.ms - atual.iniMs >= maxMs)) fecha();
    if (!atual) atual = { cl: [], bytes: e.init.length, iniMs: c.ms };
    atual.cl.push(c); atual.bytes += t;
  }
  fecha();
  return partes.map((x, i) => ({ buf: Buffer.concat([e.init].concat(x.cl.map(c => b.subarray(c.ini, c.fim)))), iniMs: Math.round(x.iniMs), fimMs: i + 1 < partes.length ? Math.round(partes[i + 1].iniMs) : (durMs || null) }));
}

/* ---------------- fonte OpenAI ---------------- */
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
function cfgOpenAI() {
  return { chave: String(process.env.OPENAI_API_KEY || '').trim(), modelo: String(process.env.TRANSCRICAO_MODELO || 'gpt-4o-transcribe').trim() || 'gpt-4o-transcribe',
    parteMb: Math.min(24.5, Math.max(1, +process.env.TRANSCRICAO_PARTE_MB || 24)), parteMin: Math.min(60, Math.max(1, +process.env.TRANSCRICAO_PARTE_MIN || 10)) };
}
const ERRO_SEM_CHAVE = 'A transcrição automática não está configurada: falta a chave OPENAI_API_KEY no servidor (Easypanel › serviço gestao › Ambiente). Peça ao administrador, ou importe a transcrição exportada do Teams ou do Meet (.vtt, .docx ou .txt).';
function extDe(ct) { return /mp4|m4a|aac/.test(ct) ? 'm4a' : /ogg/.test(ct) ? 'ogg' : /mpeg|mp3/.test(ct) ? 'mp3' : /wav/.test(ct) ? 'wav' : 'webm'; }
async function chamarOpenAI(cfg, modelo, buf, ct, nome, prompt) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: ct || 'audio/webm' }), nome);
  fd.append('model', modelo); fd.append('language', 'pt');
  if (modelo === 'whisper-1') { fd.append('response_format', 'verbose_json'); fd.append('timestamp_granularities[]', 'segment'); }
  else fd.append('response_format', 'json');
  if (prompt) fd.append('prompt', prompt.slice(-800));
  let r; try { r = await fetch(OPENAI_URL, { method: 'POST', headers: { authorization: 'Bearer ' + cfg.chave }, body: fd, signal: AbortSignal.timeout(20 * 60e3) }); }
  catch (e) { throw { st: 502, msg: 'Sem conexão com a OpenAI para a transcrição (' + String(e && e.message || e).slice(0, 120) + '). Tente de novo.' }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = String((j.error && j.error.message) || '').slice(0, 300);
    if (r.status === 401) throw { st: 502, msg: 'A OpenAI recusou a chave OPENAI_API_KEY (confira a chave no servidor).' };
    if (r.status === 429) throw { st: 429, msg: 'A OpenAI está com limite de uso agora. Tente de novo em alguns minutos.' };
    throw { st: 502, msg: 'A OpenAI recusou a transcrição' + (m ? ': ' + m : '.'), modelo: r.status === 400 || r.status === 404 ? /model/i.test(m) : false };
  }
  return j;
}
function fonteOpenAI() {
  return {
    nome: 'openai',
    disponivel: () => !!cfgOpenAI().chave,
    erroIndisponivel: ERRO_SEM_CHAVE,
    /* arquivo: { caminho | buf, ct, durMs } */
    async transcrever(arquivo, aoProgresso) {
      const cfg = cfgOpenAI(); if (!cfg.chave) throw { st: 503, msg: ERRO_SEM_CHAVE };
      const buf = arquivo.buf || fs.readFileSync(arquivo.caminho), ct = String(arquivo.ct || 'audio/webm');
      const partes = /webm/.test(ct) ? dividirWebm(buf, Math.floor(cfg.parteMb * 1024 * 1024), cfg.parteMin * 60e3, arquivo.durMs || 0)
        : buf.length <= cfg.parteMb * 1024 * 1024 ? [{ buf, iniMs: 0, fimMs: arquivo.durMs || null }] : (() => { throw { st: 422, msg: 'Áudio grande demais para a transcrição neste formato. Grave pelo Chrome ou Edge (WebM), que o sistema divide em partes.' }; })();
      let modelo = cfg.modelo; const segs = [], textos = []; let ant = '';
      for (let i = 0; i < partes.length; i++) {
        const pt = partes[i]; if (aoProgresso) try { aoProgresso(i, partes.length); } catch (e) { }
        let j;
        try { j = await chamarOpenAI(cfg, modelo, pt.buf, ct, 'parte-' + (i + 1) + '.' + extDe(ct), ant); }
        catch (e) { if (e && e.modelo && modelo !== 'whisper-1') { modelo = 'whisper-1'; j = await chamarOpenAI(cfg, modelo, pt.buf, ct, 'parte-' + (i + 1) + '.' + extDe(ct), ant); } else throw e; }
        const t = String(j.text || '').trim(); textos.push(t); ant = t;
        if (Array.isArray(j.segments) && j.segments.length) for (const s of j.segments) segs.push({ ini: Math.round(pt.iniMs + (+s.start || 0) * 1000), fim: Math.round(pt.iniMs + (+s.end || 0) * 1000), quem: '', t: String(s.text || '').trim() });
        else if (t) segs.push({ ini: pt.iniMs, fim: pt.fimMs, quem: '', t });
      }
      return { texto: textos.filter(Boolean).join('\n\n'), segmentos: segs, partes: partes.length, modelo };
    }
  };
}
/* PLANEJADA: Teams pelo Microsoft Graph (ver o comentário do topo e o LEIA-ME). */
function fonteTeams() {
  return { nome: 'teams', disponivel: () => false, erroIndisponivel: 'A importação automática do Teams ainda não está disponível: depende do consentimento de administrador do Microsoft 365. Exporte a transcrição no Teams (.vtt ou .docx) e use "Importar transcrição".',
    async transcrever() { throw { st: 501, msg: this.erroIndisponivel }; } };
}

/* ---------------- importação manual (.vtt, .srt, .docx, .txt) ---------------- */
const hms = s => { const m = String(s).trim().replace(',', '.').match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/); if (!m) return null; return ((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (m[4] ? +m[4].padEnd(3, '0') : 0); };
const limpa = s => String(s || '').replace(/<\/?[a-z][^>]*>/gi, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/[ \t]+/g, ' ').trim();
function deVtt(txt) {
  const L = String(txt).replace(/\r/g, '').split('\n'), segs = [];
  const re = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
  for (let i = 0; i < L.length; i++) {
    const m = L[i].match(re); if (!m) continue;
    const linhas = []; let j = i + 1; while (j < L.length && L[j].trim() !== '' && !re.test(L[j])) linhas.push(L[j++]); i = j - 1;
    let bruto = linhas.join(' '), quem = '';
    const v = bruto.match(/<v(?:\.[^ >]*)?\s+([^>]+)>/i); if (v) quem = limpa(v[1]);
    let t = limpa(bruto); if (!quem) { const n = t.match(/^([A-ZÀ-Ü][^:]{1,60}):\s+(.+)$/); if (n) { quem = n[1].trim(); t = n[2]; } }
    if (!t) continue;
    const ult = segs[segs.length - 1];
    if (ult && ult.quem === quem && hms(m[1]) - ult.fim < 1500 && ult.t.length < 600) { ult.t += ' ' + t; ult.fim = hms(m[2]); }
    else segs.push({ ini: hms(m[1]), fim: hms(m[2]), quem, t });
  }
  return segs;
}
function deLinhas(txt) {
  const L = String(txt).replace(/\r/g, '').split('\n').map(x => x.replace(/ /g, ' ')), segs = []; let cur = null;
  for (const l0 of L) {
    const l = l0.trim(); if (!l) continue;
    /* Teams (.docx): "Nome Sobrenome   0:03" ou "0:03 Nome"; texto: "[00:01:02] Nome: fala" ou "00:01:02 Nome: fala" */
    let m = l.match(/^(.{2,80}?)\s{1,}((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\.\d+)?\s*$/);
    if (m && !/[.!?]$/.test(m[1])) { cur = { ini: hms(m[2]), fim: null, quem: m[1].trim(), t: '' }; segs.push(cur); continue; }
    m = l.match(/^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d+)?\]?\s*[-–]?\s*(?:([^:]{2,60}):\s+)?(.*)$/);
    if (m && m[3]) { cur = { ini: hms(m[1]), fim: null, quem: (m[2] || '').trim(), t: m[3].trim() }; segs.push(cur); continue; }
    m = l.match(/^([A-ZÀ-Ü][^:]{1,60}):\s+(.+)$/);
    if (m) { cur = { ini: null, fim: null, quem: m[1].trim(), t: m[2].trim() }; segs.push(cur); continue; }
    if (cur) cur.t = (cur.t ? cur.t + ' ' : '') + l; else { cur = { ini: null, fim: null, quem: '', t: l }; segs.push(cur); }
  }
  return segs.filter(s => s.t);
}
function zipLer(buf, nomeQuer) {
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw { st: 400, msg: 'O arquivo .docx está danificado.' };
  const n = buf.readUInt16LE(e + 10), off0 = buf.readUInt32LE(e + 16); let p = off0;
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    const met = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const nome = buf.subarray(p + 46, p + 46 + nl).toString('utf8'); p += 46 + nl + xl + cl;
    if (nome !== nomeQuer) continue;
    const ini = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), d = buf.subarray(ini, ini + comp);
    return met === 0 ? d : zlib.inflateRawSync(d, { maxOutputLength: 64 * 1024 * 1024 });
  }
  return null;
}
function deDocx(buf) {
  const x = zipLer(buf, 'word/document.xml'); if (!x) throw { st: 400, msg: 'Não achei o texto dentro do .docx.' };
  const xml = x.toString('utf8'), linhas = [];
  xml.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, p => { let t = ''; p.replace(/<w:(t|tab|br)(?: [^>]*)?(?:\/>|>([\s\S]*?)<\/w:t>)/g, (m0, k, v) => { t += k === 't' ? (v || '') : k === 'tab' ? '   ' : '\n'; return m0; }); linhas.push(limpa(t.replace(/\n/g, ' ')) ? t : ''); return p; });
  return deLinhas(linhas.join('\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
}
const MAX_TXT = 600000;
function montar(segs) {
  segs = segs.slice(0, 20000).map(s => ({ ini: s.ini == null ? null : Math.max(0, Math.round(s.ini)), fim: s.fim == null ? null : Math.max(0, Math.round(s.fim)), quem: String(s.quem || '').slice(0, 80), t: String(s.t || '').slice(0, 4000) }));
  const texto = segs.map(s => (s.quem ? s.quem + ': ' : '') + s.t).join('\n').slice(0, MAX_TXT);
  return { texto, segmentos: segs };
}
function importarTexto(nome, txt) {
  const n = String(nome || '').toLowerCase(), s = String(txt || '').replace(/^﻿/, '');
  if (!s.trim()) throw { st: 400, msg: 'A transcrição está vazia.' };
  const segs = /\.(vtt|srt)$/.test(n) || /^WEBVTT/.test(s) || /-->/.test(s.slice(0, 2000)) ? deVtt(s) : deLinhas(s);
  if (!segs.length) throw { st: 400, msg: 'Não achei falas na transcrição.' };
  return montar(segs);
}
function importarArquivo(nome, buf) {
  const n = String(nome || '').toLowerCase();
  if (/\.docx$/.test(n) || (buf[0] === 0x50 && buf[1] === 0x4b)) { if (!/\.docx$/.test(n) && !(buf[0] === 0x50 && buf[1] === 0x4b)) throw { st: 400, msg: 'Envie .vtt, .srt, .docx ou .txt.' }; const segs = deDocx(buf); if (!segs.length) throw { st: 400, msg: 'Não achei falas no .docx.' }; return montar(segs); }
  if (!/\.(vtt|srt|txt)$/.test(n)) throw { st: 400, msg: 'Envie a transcrição em .vtt, .srt, .docx ou .txt.' };
  return importarTexto(n, buf.toString('utf8'));
}

function fontes() { return { openai: fonteOpenAI(), teams: fonteTeams() }; }
module.exports = { fontes, fonteOpenAI, fonteTeams, importarTexto, importarArquivo, dividirWebm, webmEstrutura, cfgOpenAI, ERRO_SEM_CHAVE, OPENAI_URL };

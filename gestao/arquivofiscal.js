'use strict';
/* v129: Arquivo fiscal — guarda o XML original das NF-e (entradas e saídas da empresa) no SERVIDOR.
   O navegador recebe só uma lista leve (paginada e filtrada) e baixa o XML sob demanda; nada disso vai para as coleções do cliente.
   Tabela própria no mesmo SQLite do servidor (gestao.db):
     arqf         uma linha por NF-e (chave única), XML comprimido (gzip), sha256, origem, vínculo com títulos financeiros
     arqf_evento  eventos da NF-e (cancelamento 110111, carta de correção…), também com o XML comprimido
     arqf_lote    relatório de cada importação em lote
   Regras:
   - só NF-e autorizada (nfeProc com protocolo 100/150) em que a empresa é emitente ou destinatária (CNPJ da empresa em
     Configurações ou ARQF_CNPJ); XML "invertido" do Omie (nome com "-invertido" ou assinatura que não confere) é recusado;
   - chave única: reimportar não muda nada;
   - importação do HISTÓRICO não cria contas, não mexe no estoque, não lança nada: só guarda e liga ao título que já existe;
   - prazo de guarda: 5 anos contados de 1º de janeiro do ano seguinte ao da emissão (CTN arts. 173 e 195; Ajuste SINIEF 07/05,
     cláusula 10ª). Dentro do prazo o servidor não exclui (rota e gatilho no banco). Depois, só o dono, com a senha confirmada.
   Permissão: Administrador, Financeiro, Fiscal e Diretoria leem e importam; Comprador lê só as entradas (e envia o XML de entrada
   que recebe do fornecedor); os demais perfis não têm acesso. */
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const E = process.env;
const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';
const MAX_ZIP = Math.max(1, +E.ARQF_MAX_ZIP_MB || 300) * 1024 * 1024;
const MAX_XML = 5 * 1024 * 1024, MAX_ENTRADAS = 40000, MAX_EXPORT = 60000, PAG_MAX = 200;
const CONFERIR_ASS = E.ARQF_CONFERIR_ASSINATURA !== '0';
const SIT_HORA = Math.max(0, E.ARQF_SIT_HORA == null ? 10 : +E.ARQF_SIT_HORA || 0);
const SIT_INTERVALO = Math.max(5, +E.ARQF_SIT_INTERVALO_S || 300) * 1000;

/* ---------------- leitura do XML (sem bibliotecas) ---------------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decEnt = s => String(s).replace(/&(#[xX][0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => e[0] === '#' ? String.fromCodePoint(/^#[xX]/.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e]);
const bloco = (x, tag) => { if (!x) return ''; const m = x.match(new RegExp('<(?:\\w+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>')); return m ? m[1] : ''; };
const val = (x, tag) => { const b = bloco(x, tag); return b ? decEnt(b.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : ''; };
const blocos = (x, tag) => { const out = [], re = new RegExp('<(?:\\w+:)?' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?' + tag + '>', 'g'); let m; while ((m = re.exec(x || ''))) out.push(m[1]); return out; };
const normDoc = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const normCh = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const semZeros = s => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
const r2 = v => Math.round((+v || 0) * 100) / 100;

function textoXml(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  const cab = b.subarray(0, 200).toString('latin1');
  const enc = (cab.match(/encoding\s*=\s*["']([^"']+)/i) || [])[1] || 'utf-8';
  return /^(iso-8859-1|latin-?1|windows-1252)$/i.test(enc) ? b.toString('latin1') : b.toString('utf8');
}

/* Canonicalização C14N (inclusiva, sem comentários) do grupo infNFe, como foi assinado dentro de <NFe xmlns="…/nfe">.
   Devolve null quando o XML usa algo que esta versão simples não trata (prefixos, instruções) — a assinatura fica "não conferida". */
const escT = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
const escA = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');
function c14nInfNFe(xml) {
  const x = xml.replace(/\r\n?/g, '\n');
  const ini = x.search(/<infNFe[\s>]/); if (ini < 0) return null;
  const fim = x.indexOf('</infNFe>', ini); if (fim < 0) return null;
  const antes = x.slice(0, ini), iNfe = antes.lastIndexOf('<NFe');
  let nsPai = NS_NFE; if (iNfe >= 0) { const tg = antes.slice(iNfe, antes.indexOf('>', iNfe) + 1), m = tg.match(/\sxmlns\s*=\s*("([^"]*)"|'([^']*)')/); nsPai = m ? (m[2] != null ? m[2] : m[3]) : ''; }
  const sub = x.slice(ini, fim + 9);
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s>\/!?]+)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let out = '', m, pos = 0; const pilha = [nsPai];
  while ((m = re.exec(sub))) {
    if (m.index !== pos) return null; pos = re.lastIndex;
    const t = m[0];
    if (t.startsWith('<!--')) continue;
    if (t.startsWith('<?')) return null;
    if (m[1] != null) { out += escT(m[1]); continue; }
    if (m[2] != null) { if (m[2].includes(':')) return null; pilha.pop(); out += '</' + m[2] + '>'; continue; }
    if (m[3] != null) {
      const nome = m[3]; if (nome.includes(':')) return null;
      const ats = [], reA = /([^\s=>\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let a, ns = null;
      while ((a = reA.exec(m[4] || ''))) {
        const k = a[1], v = decEnt((a[2] != null ? a[2] : a[3]).replace(/[\t\n\r]/g, ' '));
        if (k === 'xmlns') { ns = v; continue; }
        if (k.includes(':')) return null;
        ats.push([k, v]);
      }
      const pai = pilha[pilha.length - 1], meu = ns == null ? pai : ns;
      ats.sort((p, q) => p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0);
      let tag = '<' + nome;
      if (pilha.length === 1) { if (meu) tag += ' xmlns="' + escA(meu) + '"'; }
      else if (meu !== pai) tag += ' xmlns="' + escA(meu) + '"';
      for (const [k, v] of ats) tag += ' ' + k + '="' + escA(v) + '"';
      out += tag + '>';
      if (m[5]) out += '</' + nome + '>'; else pilha.push(meu);
      continue;
    }
    out += escT(decEnt(m[6]));
  }
  if (pos !== sub.length || pilha.length !== 1) return null;
  return out;
}
/* 'ok' | 'divergente' | 'sem_assinatura' | 'nao_conferida' */
function conferirAssinatura(xml) {
  const sig = bloco(xml, 'Signature'); if (!sig) return { st: 'sem_assinatura' };
  const dv = val(sig, 'DigestValue').replace(/\s/g, ''), dp = val(bloco(xml, 'infProt'), 'digVal').replace(/\s/g, '');
  if (dp && dv && dp !== dv) return { st: 'divergente', motivo: 'o resumo da assinatura não é o mesmo do protocolo da SEFAZ' };
  if (!CONFERIR_ASS) return { st: 'nao_conferida' };
  const c = c14nInfNFe(xml); if (c == null) return { st: 'nao_conferida' };
  const d = crypto.createHash('sha1').update(c, 'utf8').digest('base64');
  return d === dv ? { st: 'ok' } : { st: 'divergente', motivo: 'o conteúdo da nota foi alterado depois de assinado' };
}

/* lê uma NF-e (nfeProc) ou um evento (procEventoNFe) */
function lerDoc(xml) {
  if (/<(?:\w+:)?procEventoNFe[\s>]/.test(xml) || (/<(?:\w+:)?evento[\s>]/.test(xml) && !/<(?:\w+:)?infNFe[\s>]/.test(xml))) {
    const ev = bloco(xml, 'infEvento'), ret = bloco(xml, 'retEvento') || bloco(xml, 'infEvento');
    const retInf = bloco(bloco(xml, 'retEvento'), 'infEvento');
    return { tipo: 'evento', chave: normCh(val(ev, 'chNFe')), tp: val(ev, 'tpEvento'), seq: val(ev, 'nSeqEvento') || '1', dh: val(ev, 'dhEvento'),
      autor: normDoc(val(ev, 'CNPJ') || val(ev, 'CPF')), desc: val(bloco(ev, 'detEvento'), 'descEvento') || val(ev, 'descEvento'),
      cStat: val(retInf, 'cStat'), prot: val(retInf, 'nProt'), temRet: !!ret && !!retInf, destDoc: normDoc(val(retInf, 'CNPJDest') || val(retInf, 'CPFDest')) };
  }
  const inf = xml.match(/<(?:\w+:)?infNFe\s[^>]*>/);
  if (!inf) return { tipo: 'outro' };
  const id = (inf[0].match(/\sId\s*=\s*["']([^"']+)/) || [])[1] || '';
  const ide = bloco(xml, 'ide'), emit = bloco(xml, 'emit'), dest = bloco(xml, 'dest'), tot = bloco(xml, 'ICMSTot'), prot = bloco(xml, 'infProt');
  return {
    tipo: 'nfe', temProc: /<(?:\w+:)?nfeProc[\s>]/.test(xml) && !!prot, chave: normCh(id.replace(/^NFe/i, '')), chProt: normCh(val(prot, 'chNFe')),
    cStat: val(prot, 'cStat'), xMotivo: val(prot, 'xMotivo'), nProt: val(prot, 'nProt'), dhRecbto: val(prot, 'dhRecbto'),
    modelo: val(ide, 'mod'), numero: val(ide, 'nNF'), serie: val(ide, 'serie'), tpNF: val(ide, 'tpNF'), finNFe: val(ide, 'finNFe'), natOp: val(ide, 'natOp'),
    emissao: (val(ide, 'dhEmi') || val(ide, 'dEmi')).slice(0, 10),
    emitDoc: normDoc(val(emit, 'CNPJ') || val(emit, 'CPF')), emitNome: val(emit, 'xNome'),
    destDoc: normDoc(val(dest, 'CNPJ') || val(dest, 'CPF') || val(dest, 'idEstrangeiro')), destNome: val(dest, 'xNome'),
    valor: r2(parseFloat(val(tot, 'vNF')) || 0),
    parcelas: blocos(bloco(xml, 'cobr'), 'dup').map(d => ({ n: val(d, 'nDup'), venc: val(d, 'dVenc'), v: r2(parseFloat(val(d, 'vDup')) || 0) }))
  };
}
const guardaAte = em => { const a = parseInt(String(em || '').slice(0, 4), 10); return a > 1900 ? (a + 5) + '-12-31' : ''; };
const hojeBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

/* ---------------- ZIP: leitura (entrada a entrada, sem carregar tudo) e escrita em fluxo ---------------- */
function zipAbrir(arq) {
  const fd = fs.openSync(arq, 'r'), tam = fs.fstatSync(fd).size, n = Math.min(tam, 66000), b = Buffer.alloc(n);
  fs.readSync(fd, b, 0, n, tam - n);
  let e = -1; for (let i = n - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) { fs.closeSync(fd); throw { st: 400, msg: 'Arquivo ZIP inválido.' }; }
  let cnt = b.readUInt16LE(e + 10), cdTam = b.readUInt32LE(e + 12), cdOff = b.readUInt32LE(e + 16);
  if (cdOff === 0xffffffff || cnt === 0xffff) { fs.closeSync(fd); throw { st: 400, msg: 'ZIP grande demais (formato ZIP64). Divida em arquivos menores (por exemplo, um por ano).' }; }
  if (cnt > MAX_ENTRADAS) { fs.closeSync(fd); throw { st: 413, msg: 'O ZIP tem ' + cnt + ' arquivos. O limite é ' + MAX_ENTRADAS + ' por envio.' }; }
  const cd = Buffer.alloc(cdTam); fs.readSync(fd, cd, 0, cdTam, cdOff);
  const out = []; let p = 0;
  for (let k = 0; k < cnt && p + 46 <= cd.length; k++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const fl = cd.readUInt16LE(p + 8), met = cd.readUInt16LE(p + 10), comp = cd.readUInt32LE(p + 20), orig = cd.readUInt32LE(p + 24), nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
    const raw = cd.subarray(p + 46, p + 46 + nl), nome = (fl & 0x800) ? raw.toString('utf8') : raw.toString('latin1');
    out.push({ nome, met, comp, orig, off, cript: !!(fl & 1) }); p += 46 + nl + xl + cl;
  }
  const ler = en => {
    if (en.cript) throw { msg: 'arquivo protegido por senha dentro do ZIP' };
    if (en.orig > MAX_XML || en.comp > MAX_XML * 2) throw { msg: 'arquivo grande demais para ser um XML de NF-e' };
    const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, en.off); const ini = en.off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
    const d = Buffer.alloc(en.comp); fs.readSync(fd, d, 0, en.comp, ini);
    if (en.met === 0) return d; if (en.met !== 8) throw { msg: 'compressão do ZIP não suportada' };
    return zlib.inflateRawSync(d, { maxOutputLength: MAX_XML });
  };
  return { entradas: out, ler, fechar: () => { try { fs.closeSync(fd); } catch (e) { } } };
}
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function zipEscritor(res) {
  const cd = []; let off = 0;
  const dt = new Date(Date.now() - 3 * 3600e3), dosT = (dt.getUTCHours() << 11) | (dt.getUTCMinutes() << 5) | (dt.getUTCSeconds() >> 1), dosD = ((dt.getUTCFullYear() - 1980) << 9) | ((dt.getUTCMonth() + 1) << 5) | dt.getUTCDate();
  const escreve = b => new Promise(ok => { off += b.length; if (res.write(b)) ok(); else res.once('drain', ok); });
  /* entrada a partir dos bytes do deflate já prontos (o XML guardado em gzip vira entrada do ZIP sem descomprimir) */
  async function addCru(nome, defl, crc, tam) {
    const nb = Buffer.from(nome, 'utf8'), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(dosT, 10); h.writeUInt16LE(dosD, 12);
    h.writeUInt32LE(crc >>> 0, 14); h.writeUInt32LE(defl.length, 18); h.writeUInt32LE(tam, 22); h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
    cd.push({ nb, crc, c: defl.length, u: tam, off });
    await escreve(Buffer.concat([h, nb])); await escreve(defl);
  }
  const addGz = (nome, gz0) => { const gz = Buffer.isBuffer(gz0) ? gz0 : Buffer.from(gz0.buffer, gz0.byteOffset, gz0.byteLength), n = gz.length; /* o node:sqlite devolve BLOB como Uint8Array */ if (gz[0] !== 0x1f || gz[1] !== 0x8b || gz[3] !== 0) { const raw = zlib.gunzipSync(gz); return addCru(nome, zlib.deflateRawSync(raw), crc32(raw), raw.length); } return addCru(nome, gz.subarray(10, n - 8), gz.readUInt32LE(n - 8), gz.readUInt32LE(n - 4)); };
  const addBuf = (nome, raw) => addCru(nome, zlib.deflateRawSync(raw), crc32(raw), raw.length);
  async function fechar() {
    const ini = off, partes = [];
    for (const e of cd) { const h = Buffer.alloc(46); h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(8, 10); h.writeUInt16LE(dosT, 12); h.writeUInt16LE(dosD, 14);
      h.writeUInt32LE(e.crc >>> 0, 16); h.writeUInt32LE(e.c, 20); h.writeUInt32LE(e.u, 24); h.writeUInt16LE(e.nb.length, 28); h.writeUInt32LE(e.off, 42); partes.push(h, e.nb); }
    const cdb = Buffer.concat(partes), fimb = Buffer.alloc(22);
    fimb.writeUInt32LE(0x06054b50, 0); fimb.writeUInt16LE(cd.length, 8); fimb.writeUInt16LE(cd.length, 10); fimb.writeUInt32LE(cdb.length, 12); fimb.writeUInt32LE(ini, 16);
    await escreve(cdb); await escreve(fimb); res.end();
  }
  return { addGz, addBuf, fechar, n: () => cd.length };
}

module.exports = function (ctx) {
  const { db, q, json, lerCorpo, avisarDoc, perfilDe, papelDe, PERM, END, DATA, uid, FISCAL_URL, FISCAL_TOKEN } = ctx;
  const auditar = (...a) => { try { ctx.auditar(...a); } catch (e) { console.error('[arquivo fiscal] auditoria', e.message); } };
  db.exec(`CREATE TABLE IF NOT EXISTS arqf(id TEXT PRIMARY KEY, chave TEXT NOT NULL UNIQUE, modelo TEXT, tipo TEXT NOT NULL, tpnf TEXT, fin TEXT,
    emit_doc TEXT, emit_nome TEXT, dest_doc TEXT, dest_nome TEXT, parc_doc TEXT, parc_nome TEXT, numero TEXT, serie TEXT, emissao TEXT, valor REAL,
    situacao TEXT NOT NULL DEFAULT 'autorizada', sit_fonte TEXT, sit_em INTEGER, sit_fila INTEGER DEFAULT 0, sit_msg TEXT, prot TEXT, ass TEXT,
    sha TEXT, xml BLOB NOT NULL, tam INTEGER, origem TEXT, arquivo TEXT, em INTEGER, por TEXT, parcelas TEXT,
    vinc TEXT, vinc_conf TEXT, vinc_em INTEGER, vinc_por TEXT, sugest TEXT);
  CREATE INDEX IF NOT EXISTS arqf_emissao ON arqf(emissao);
  CREATE INDEX IF NOT EXISTS arqf_tipo ON arqf(tipo, emissao);
  CREATE INDEX IF NOT EXISTS arqf_parc ON arqf(parc_doc);
  CREATE INDEX IF NOT EXISTS arqf_num ON arqf(numero);
  CREATE TABLE IF NOT EXISTS arqf_evento(id TEXT PRIMARY KEY, chave TEXT NOT NULL, tp TEXT, seq TEXT, dh TEXT, cstat TEXT, prot TEXT, sha TEXT UNIQUE, xml BLOB, origem TEXT, arquivo TEXT, em INTEGER, por TEXT);
  CREATE INDEX IF NOT EXISTS arqf_evento_ch ON arqf_evento(chave);
  CREATE TABLE IF NOT EXISTS arqf_lote(id TEXT PRIMARY KEY, por TEXT, em INTEGER, fim INTEGER, arquivo TEXT, origem TEXT, rel TEXT);
  CREATE TRIGGER IF NOT EXISTS arqf_guarda BEFORE DELETE ON arqf
    WHEN NOT (length(old.emissao) >= 4 AND CAST(substr(old.emissao,1,4) AS INTEGER) + 6 <= CAST(strftime('%Y','now','-3 hours') AS INTEGER))
    BEGIN SELECT RAISE(ABORT, 'arquivo fiscal: XML dentro do prazo de guarda'); END;`);
  /* v130: todas as origens de cada nota (historico, upload, sefaz, email), com a data em que chegou por cada uma.
     A coluna arqf.origem continua sendo a PRIMEIRA origem; esta tabela guarda todas. */
  db.exec(`CREATE TABLE IF NOT EXISTS arqf_origem(chave TEXT NOT NULL, origem TEXT NOT NULL, em INTEGER, ref TEXT, PRIMARY KEY(chave, origem));
    INSERT OR IGNORE INTO arqf_origem(chave, origem, em) SELECT chave, origem, em FROM arqf WHERE origem IS NOT NULL;`);
  const stOrig = db.prepare('INSERT OR IGNORE INTO arqf_origem(chave, origem, em, ref) VALUES(?,?,?,?)');
  const regOrigem = (ch, origem, ref) => { try { if (ch && origem) stOrig.run(ch, origem, Date.now(), ref || null); } catch (e) { } };
  const st = {
    porChave: db.prepare('SELECT id, chave, situacao, vinc, tipo FROM arqf WHERE chave=?'),
    porId: db.prepare('SELECT id, chave, tipo, numero, serie, emissao, valor, situacao, sit_fonte, sit_em, sit_msg, parc_doc, parc_nome, emit_doc, emit_nome, dest_doc, dest_nome, origem, vinc, vinc_conf, sugest, parcelas, em, por, arquivo, ass, prot, fin, tpnf FROM arqf WHERE id=?'),
    xml: db.prepare('SELECT xml, chave, tipo FROM arqf WHERE id=?'),
    novo: db.prepare(`INSERT INTO arqf(id,chave,modelo,tipo,tpnf,fin,emit_doc,emit_nome,dest_doc,dest_nome,parc_doc,parc_nome,numero,serie,emissao,valor,situacao,sit_fonte,sit_em,sit_fila,prot,ass,sha,xml,tam,origem,arquivo,em,por,parcelas,vinc,vinc_conf,sugest)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    sit: db.prepare('UPDATE arqf SET situacao=?, sit_fonte=?, sit_em=?, sit_msg=?, sit_fila=0 WHERE id=?'),
    sitMsg: db.prepare('UPDATE arqf SET sit_msg=?, sit_em=?, sit_fila=? WHERE id=?'),
    vinc: db.prepare('UPDATE arqf SET vinc=?, vinc_conf=?, vinc_em=?, vinc_por=?, sugest=? WHERE id=?'),
    sugest: db.prepare('UPDATE arqf SET sugest=? WHERE id=?'),
    evNovo: db.prepare('INSERT OR IGNORE INTO arqf_evento(id,chave,tp,seq,dh,cstat,prot,sha,xml,origem,arquivo,em,por) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    evCanc: db.prepare("SELECT id, dh FROM arqf_evento WHERE chave=? AND tp='110111' AND cstat IN ('135','136','155') LIMIT 1"),
    evDa: db.prepare('SELECT id, tp, seq, dh, cstat, prot, em, origem FROM arqf_evento WHERE chave=? ORDER BY dh'),
    loteNovo: db.prepare('INSERT INTO arqf_lote(id,por,em,fim,arquivo,origem,rel) VALUES(?,?,?,?,?,?,?)'),
    loteGet: db.prepare('SELECT * FROM arqf_lote WHERE id=?'),
    fila: db.prepare("SELECT id, chave, tipo, emissao FROM arqf WHERE sit_fila=1 ORDER BY em LIMIT ?"),
    del: db.prepare('DELETE FROM arqf WHERE id=?')
  };
  const docGet = p => { const r = q.docGet.get(p); try { return r ? JSON.parse(r.data) : null; } catch (e) { return null; } };
  const col = c => q.colGet.all(c).map(r => { try { return Object.assign({ id: r.id }, JSON.parse(r.data)); } catch (e) { return null; } }).filter(r => r && !r._del);

  /* ---------- empresa e parâmetros (Configurações do sistema, com padrão) ---------- */
  function empresa() {
    const c = docGet('cfg/empresa') || (col('cfg').find(x => x.cnpj) || {});
    const lista = new Set(); [c.cnpj, ...(String(E.ARQF_CNPJ || '').split(/[,;\s]+/))].forEach(x => { const d = normDoc(x); if (d.length >= 11) lista.add(d); });
    String(c.arqfCnpjs || '').split(/[,;\s]+/).forEach(x => { const d = normDoc(x); if (d.length >= 11) lista.add(d); });
    const tol = Math.min(10, Math.max(0, c.arqfTol == null || c.arqfTol === '' ? 1 : +c.arqfTol || 0)) / 100;
    const dias = Math.min(365, Math.max(1, +c.arqfDias || 120));
    return { cnpjs: lista, tol, dias };
  }

  /* ---------- permissão ---------- */
  function acesso(conta) {
    if (!conta || !conta.ativo) return null; if (conta.nivel === 'owner') return 'total';
    const pf = perfilDe(conta), pp = papelDe(pf);
    if (['admin', 'financeiro', 'fiscal', 'diretoria'].includes(pp)) return 'total';
    if (['comprador', 'compras'].includes(pp)) return 'entradas';
    const d = PERM.perfis[pf];
    if (d && d.custom) { const w = d.w || [], r = d.r || []; if (w.includes('nf') || w.includes('fin')) return 'total'; if (r.includes('nf')) return 'entradas'; }
    return null;
  }

  /* ---------- casamento com contas a pagar / receber ---------- */
  function indice() {
    const parcDoc = new Map(); for (const p of col('parc')) { const d = normDoc(p.doc || p.cnpj || p.cpf); if (d) parcDoc.set(p.id, d); }
    const notaCh = new Map(); for (const n of col('notas')) if (n.chave) notaCh.set(n.id, normCh(n.chave));
    const porDoc = new Map(), porCh = new Map();
    for (const l of col('lanc')) {
      if (l.status === 'cancelado' || l.transf || l.guia || !['pagar', 'receber'].includes(l.tipo)) continue;
      const ch = l.notaId ? notaCh.get(l.notaId) : ''; if (ch) { if (!porCh.has(ch)) porCh.set(ch, []); porCh.get(ch).push(l); }
      const d = l.parcId ? parcDoc.get(l.parcId) : ''; if (d) { if (!porDoc.has(d)) porDoc.set(d, []); porDoc.get(d).push(l); }
    }
    return { porDoc, porCh };
  }
  const numDe = l => semZeros(l.nf || l.numNf || l.numero || '');
  const temNum = (l, n) => { if (!n) return false; if (numDe(l) === n) return true; const d = String(l.desc || '') + ' ' + String(l.obs || ''); const re = new RegExp('(?:^|\\D)0*' + n + '(?:\\D|$)'); return (n.length >= 3 || /\bN\.?\s?F/i.test(d)) && re.test(d); };
  const baseDesc = l => String(l.desc || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim().toLowerCase();
  const diasEntre = (a, b) => Math.abs((Date.parse(String(a).slice(0, 10) + 'T12:00:00Z') - Date.parse(String(b).slice(0, 10) + 'T12:00:00Z')) / 864e5);
  function casar(nota, ix, par) {
    const tipoL = nota.tipo === 'saida' ? 'receber' : 'pagar', livre = l => l.tipo === tipoL && (!l.arqf || !l.arqf.ch || normCh(l.arqf.ch) === nota.chave);
    const porCh = (ix.porCh.get(nota.chave) || []).filter(livre);
    if (porCh.length) return { conf: 'alta', lancs: porCh.map(l => l.id), motivo: 'título lançado a partir desta nota' };
    const cands = (ix.porDoc.get(nota.parc_doc) || []).filter(livre); if (!cands.length) return { conf: 'sem', motivo: 'nenhum título deste ' + (tipoL === 'pagar' ? 'fornecedor' : 'cliente') };
    const tolV = v => Math.max(0.05, v * par.tol), confere = (s, v) => Math.abs(s - v) <= tolV(v);
    const dataOk = ls => ls.some(l => (l.venc && diasEntre(l.venc, nota.emissao) <= par.dias) || (l.emissao && diasEntre(l.emissao, nota.emissao) <= 10) || (l.comp && String(nota.emissao).slice(0, 7) === l.comp));
    const soma = ls => ({ v: r2(ls.reduce((s, l) => s + (+l.valor || 0), 0)), b: r2(ls.reduce((s, l) => s + (+l.valor || 0) + (+l.retido || 0), 0)) });
    const n = semZeros(nota.numero), comNum = cands.filter(l => temNum(l, n));
    if (comNum.length) {
      const s = soma(comNum);
      if ((confere(s.v, nota.valor) || confere(s.b, nota.valor)) && dataOk(comNum)) return { conf: 'alta', lancs: comNum.map(l => l.id), motivo: (tipoL === 'pagar' ? 'fornecedor' : 'cliente') + ', número da nota e valor conferem' + (comNum.length > 1 ? ' (soma de ' + comNum.length + ' parcelas)' : '') };
      const brl = v => 'R$ ' + v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'), quem = tipoL === 'pagar' ? 'fornecedor' : 'cliente';
      const vOk = confere(s.v, nota.valor) || confere(s.b, nota.valor);
      return { conf: 'sugestao', sug: [{ lancs: comNum.map(l => l.id), motivo: vOk ? 'número, ' + quem + ' e valor conferem, mas o vencimento está longe da emissão: confira' : 'número e ' + quem + ' conferem; valor dos títulos ' + brl(s.v) + ' × nota ' + brl(nota.valor) }] };
    }
    /* sem número: mesmo parceiro, valor (um título ou parcelas do mesmo documento) e data próxima */
    const grupos = new Map(); for (const l of cands) { const k = baseDesc(l); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(l); }
    const sug = [];
    for (const l of cands) if (confere(+l.valor || 0, nota.valor) && dataOk([l])) sug.push({ lancs: [l.id], motivo: 'mesmo ' + (tipoL === 'pagar' ? 'fornecedor' : 'cliente') + ', valor e data próximos (sem o número da nota no título)' });
    for (const [, ls] of grupos) if (ls.length > 1) { const s = soma(ls); if ((confere(s.v, nota.valor) || confere(s.b, nota.valor)) && dataOk(ls)) sug.push({ lancs: ls.map(l => l.id), motivo: ls.length + ' parcelas do mesmo documento somam o valor da nota' }); }
    if (sug.length) return { conf: 'sugestao', sug: sug.slice(0, 3) };
    return { conf: 'sem', motivo: 'há títulos deste ' + (tipoL === 'pagar' ? 'fornecedor' : 'cliente') + ', mas nenhum com o número ou o valor da nota' };
  }
  /* grava o vínculo nos títulos (campo leve, sem o XML) — devolve os avisos para depois do COMMIT */
  function gravarVinc(row, lancIds, conf, conta, avisos) {
    const ts = Date.now(), ids = [...new Set(lancIds)];
    const ant = row.vinc ? JSON.parse(row.vinc) : [];
    for (const id of ant) if (!ids.includes(id)) { const p = 'lanc/' + id, l = docGet(p); if (l && l.arqf && normCh(l.arqf.ch) === row.chave) { delete l.arqf; q.docPut.run(p, 'lanc', id, JSON.stringify(l), ts); avisos.push(['set', p, l, ts]); } }
    for (const id of ids) {
      const p = 'lanc/' + id, l = docGet(p); if (!l) continue;
      l.arqf = { id: row.id, ch: row.chave, n: String(row.numero || '') + (row.serie ? '/' + row.serie : ''), sit: row.situacao || 'autorizada', conf, em: ts };
      q.docPut.run(p, 'lanc', id, JSON.stringify(l), ts); avisos.push(['set', p, l, ts]);
    }
    st.vinc.run(ids.length ? JSON.stringify(ids) : null, ids.length ? conf : null, ids.length ? ts : null, conta ? conta.id : null, null, row.id);
  }
  function marcarSitNosTitulos(row, sit, avisos) {
    const ids = row.vinc ? JSON.parse(row.vinc) : [], ts = Date.now();
    for (const id of ids) { const p = 'lanc/' + id, l = docGet(p); if (l && l.arqf && normCh(l.arqf.ch) === row.chave) { l.arqf = Object.assign({}, l.arqf, { sit }); q.docPut.run(p, 'lanc', id, JSON.stringify(l), ts); avisos.push(['set', p, l, ts]); } }
  }
  const soltar = avisos => { for (const a of avisos) try { avisarDoc(...a); } catch (e) { } };

  /* ---------- processar um arquivo (XML) ---------- */
  function processar(nome, buf, origem, conta, c, emp) {
    /* c: { ix, avisos, eventos[] (adiados para o fim do lote), soEntradas } */
    if (/-invertido/i.test(nome || '')) return { r: 'ignorada', motivo: 'XML "invertido" do Omie (pelo nome do arquivo): não é o original da SEFAZ' };
    if (!buf || !buf.length) return { r: 'ignorada', motivo: 'arquivo vazio' };
    if (buf.length > MAX_XML) return { r: 'ignorada', motivo: 'arquivo grande demais para ser um XML de NF-e' };
    const xml = textoXml(buf), d = lerDoc(xml);
    if (d.tipo === 'evento') { if (c.eventos) { c.eventos.push({ nome, buf, xml, d }); return { r: 'adiado' }; } return evento(nome, buf, xml, d, origem, conta, c, emp); }
    if (d.tipo !== 'nfe') return { r: 'ignorada', motivo: 'não é XML de NF-e (sem o grupo infNFe nem evento)' };
    if (!d.temProc) return { r: 'ignorada', motivo: 'não é nfeProc autorizado: o XML não tem o protocolo de autorização da SEFAZ' };
    if (!['100', '150'].includes(d.cStat)) return { r: 'ignorada', motivo: 'nota não autorizada (SEFAZ ' + (d.cStat || '?') + (d.xMotivo ? ': ' + d.xMotivo : '') + ')' };
    if (d.modelo && d.modelo !== '55') return { r: 'ignorada', motivo: 'modelo ' + d.modelo + ' (o arquivo fiscal guarda NF-e modelo 55)' };
    if (d.chave.length !== 44) return { r: 'ignorada', motivo: 'chave de acesso inválida' };
    if (d.chProt && d.chProt !== d.chave) return { r: 'ignorada', motivo: 'a chave do protocolo é diferente da chave da nota' };
    const ehEmit = emp.cnpjs.has(d.emitDoc), ehDest = emp.cnpjs.has(d.destDoc);
    if (!ehEmit && !ehDest) return { r: 'ignorada', motivo: 'CNPJ estranho: nem o emitente (' + (d.emitDoc || '?') + ') nem o destinatário (' + (d.destDoc || '?') + ') é a empresa' };
    const tipo = ehEmit ? 'saida' : 'entrada';
    if (c.soEntradas && tipo !== 'entrada') return { r: 'ignorada', motivo: 'seu perfil envia só notas de entrada' };
    let ass = conferirAssinatura(xml);
    if (ass.st === 'divergente' && d.emitDoc && /^\d{14}$/.test(d.emitDoc) && d.chave.slice(6, 20) !== d.emitDoc) return { r: 'ignorada', motivo: 'assinatura não confere e o emitente não é o CNPJ da chave de acesso — XML "invertido"/alterado, não é o original' };
    /* Cópias exportadas pelo Omie podem ter os acentos codificados duas vezes ("NÂ°"): o conteúdo deixa de bater com a assinatura.
       Tenta desfazer; se a assinatura passar a conferir, guarda o XML restaurado. Se não, guarda a cópia marcada (é a única que a
       empresa tem) e o original pode ser baixado depois na SEFAZ pela chave. */
    if (ass.st === 'divergente' && /alterado/.test(ass.motivo || '')) {
      try { if (!/[^\x00-\xff]/.test(xml)) { const rep = Buffer.from(xml, 'latin1').toString('utf8'); if (rep !== xml && !rep.includes('\ufffd') && conferirAssinatura(rep).st === 'ok') { buf = Buffer.from(rep, 'utf8'); ass = { st: 'ok_restaurada' }; } } } catch (e) { }
    }
    if (ass.st === 'divergente' && !/alterado/.test(ass.motivo || '')) return { r: 'ignorada', motivo: 'assinatura não confere (' + ass.motivo + ')' };
    const ja = st.porChave.get(d.chave);
    if (ja) {
      /* já guardada como cópia alterada e agora chegou um XML cuja assinatura confere: troca pelo original */
      if (ass.st !== 'divergente') { const a0 = db.prepare('SELECT ass FROM arqf WHERE id=?').get(ja.id); if (a0 && a0.ass === 'divergente') {
        db.prepare("UPDATE arqf SET xml=?, tam=?, sha=?, ass=?, sit_msg=COALESCE(REPLACE(sit_msg,' · cópia alterada pelo sistema de origem (acentos); baixe o original na SEFAZ pela chave',''),'') || ' · original recebido depois' WHERE id=?")
          .run(zlib.gzipSync(buf, { level: 9 }), buf.length, crypto.createHash('sha256').update(buf).digest('hex'), ass.st, ja.id);
        regOrigem(d.chave, origem, c.ref); return { r: 'existente', id: ja.id, chave: d.chave, trocada: true, tipo: ja.tipo, situacao: ja.situacao }; } }
      regOrigem(d.chave, origem, c.ref); /* v130: guarda mais esta origem (ex.: "também recebida por e-mail") */
      return { r: 'existente', id: ja.id, chave: d.chave, tipo: ja.tipo, situacao: ja.situacao };
    }
    const id = uid(16), ts = Date.now(), gz = zlib.gzipSync(buf, { level: 9 });
    const parc = tipo === 'entrada' ? [d.emitDoc, d.emitNome] : [d.destDoc, d.destNome];
    const row = { id, chave: d.chave, tipo, numero: d.numero, serie: d.serie, emissao: d.emissao, valor: d.valor, parc_doc: parc[0], parc_nome: parc[1], situacao: 'autorizada', vinc: null };
    const canc = st.evCanc.get(d.chave); if (canc) row.situacao = 'cancelada';
    const novaOp = origem !== 'historico' && tipo === 'entrada' && diasEntre(d.emissao, hojeBr()) <= 90;
    st.novo.run(id, d.chave, d.modelo || '55', tipo, d.tpNF, d.finNFe, d.emitDoc, d.emitNome, d.destDoc, d.destNome, parc[0], parc[1], d.numero, d.serie, d.emissao, d.valor,
      row.situacao, (canc ? 'evento de cancelamento no arquivo' : 'protocolo ' + d.cStat + ' no XML (' + (d.nProt || 's/ nº') + ')') + (ass.st === 'divergente' ? ' · cópia alterada pelo sistema de origem (acentos); baixe o original na SEFAZ pela chave' : ass.st === 'ok_restaurada' ? ' · acentos restaurados; assinatura confere' : ''), ts, novaOp && FISCAL_URL && !canc ? 1 : 0, d.nProt, ass.st,
      crypto.createHash('sha256').update(buf).digest('hex'), gz, buf.length, origem, String(nome || '').slice(0, 200), ts, conta ? conta.id : null, JSON.stringify(d.parcelas || []), null, null, null);
    regOrigem(d.chave, origem, c.ref); /* v130 */
    /* ligação com o título */
    let lig = 'sem';
    if (c.ix) {
      const m = casar(row, c.ix, emp);
      if (m.conf === 'alta') { gravarVinc(row, m.lancs, 'auto', conta, c.avisos); row.vinc = JSON.stringify(m.lancs); for (const l of m.lancs) marcarUsado(c.ix, l, d.chave); lig = 'ligada'; }
      else if (m.conf === 'sugestao') { st.sugest.run(JSON.stringify(m.sug), id); lig = 'sugestao'; }
    }
    if (row.situacao === 'cancelada' && row.vinc) marcarSitNosTitulos(row, 'cancelada', c.avisos);
    return { r: 'nova', id, chave: d.chave, tipo, lig, cancelada: row.situacao === 'cancelada', copia: ass.st === 'divergente', restaurada: ass.st === 'ok_restaurada' };
  }
  function marcarUsado(ix, lancId, ch) { for (const ls of ix.porDoc.values()) for (const l of ls) if (l.id === lancId) l.arqf = { ch }; }
  function evento(nome, buf, xml, d, origem, conta, c, emp) {
    if (!d.chave || d.chave.length !== 44) return { r: 'ignorada', motivo: 'evento sem chave de acesso válida' };
    if (!d.temRet || !['135', '136', '155'].includes(d.cStat)) return { r: 'ignorada', motivo: 'evento sem o registro (protocolo) da SEFAZ' };
    const nota = st.porChave.get(d.chave), emitCh = d.chave.slice(6, 20);
    if (!nota && !emp.cnpjs.has(emitCh) && !emp.cnpjs.has(d.autor) && !emp.cnpjs.has(d.destDoc)) return { r: 'ignorada', motivo: 'evento de uma nota que não está no arquivo e não é da empresa' };
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const ins = st.evNovo.run(uid(16), d.chave, d.tp, d.seq, d.dh, d.cStat, d.prot, sha, zlib.gzipSync(buf, { level: 9 }), origem, String(nome || '').slice(0, 200), Date.now(), conta ? conta.id : null);
    if (!ins.changes) return { r: 'existente', evento: true, chave: d.chave };
    if (d.tp === '110111' && nota && nota.situacao !== 'cancelada') {
      st.sit.run('cancelada', 'evento de cancelamento ' + (d.prot || '') + ' (' + String(d.dh || '').slice(0, 10) + ')', Date.now(), null, nota.id);
      marcarSitNosTitulos(nota, 'cancelada', c.avisos);
      return { r: 'evento', cancelou: true, chave: d.chave, ligada: !!nota.vinc };
    }
    return { r: 'evento', chave: d.chave };
  }

  /* ---------- lote (ZIP) em partes, com progresso ---------- */
  const LOTES = new Map();
  function novoRel() { return { novas: 0, existentes: 0, ignoradas: 0, eventos: 0, canceladas: 0, ligadas: 0, sugestoes: 0, semTitulo: 0, entradas: 0, saidas: 0, motivos: {}, lista: [] }; }
  function conta1(rel, nome, r) {
    if (r.r === 'nova') { rel.novas++; rel[r.tipo === 'saida' ? 'saidas' : 'entradas']++; if (r.lig === 'ligada') rel.ligadas++; else if (r.lig === 'sugestao') rel.sugestoes++; else rel.semTitulo++; if (r.cancelada) rel.canceladas++; if (r.copia) rel.copiasAlteradas = (rel.copiasAlteradas || 0) + 1; if (r.restaurada) rel.restauradas = (rel.restauradas || 0) + 1; }
    else if (r.r === 'existente') rel.existentes++;
    else if (r.r === 'evento') { rel.eventos++; if (r.cancelou) rel.canceladas++; }
    else if (r.r === 'ignorada') { rel.ignoradas++; const k = r.motivo.replace(/\(.*$/, '').replace(/[:—].*$/, '').trim(); rel.motivos[k] = (rel.motivos[k] || 0) + 1; if (rel.lista.length < 2000) rel.lista.push({ arquivo: String(nome).slice(0, 200), motivo: r.motivo }); }
  }
  async function rodarLote(job, conta, req) {
    const emp = empresa(), c = { ix: indice(), avisos: [], eventos: [], soEntradas: false };
    let z; try { z = zipAbrir(job.tmp); } catch (e) { job.estado = 'erro'; job.erro = e.msg || 'ZIP inválido.'; try { fs.unlinkSync(job.tmp); } catch (x) { } return; }
    const ents = z.entradas.filter(e => !/\/$/.test(e.nome) && !/(^|\/)(__MACOSX|\.)/.test(e.nome));
    job.total = ents.length; job.estado = 'processando';
    const passo = async (lista, fn) => {
      for (let i = 0; i < lista.length; i += 50) {
        db.exec('BEGIN');
        try { for (const it of lista.slice(i, i + 50)) fn(it); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
        soltar(c.avisos.splice(0)); await new Promise(r => setImmediate(r));
      }
    };
    try {
      await passo(ents, en => {
        const nome = en.nome.split('/').pop();
        if (!/\.xml$/i.test(nome)) { conta1(job.rel, en.nome, { r: 'ignorada', motivo: 'não é arquivo .xml' }); job.feitos++; return; }
        let buf; try { buf = z.ler(en); } catch (e) { conta1(job.rel, en.nome, { r: 'ignorada', motivo: 'não foi possível ler do ZIP: ' + (e.msg || e.message || 'erro') }); job.feitos++; return; }
        let r; try { r = processar(en.nome, buf, job.origem, conta, c, emp); } catch (e) { r = { r: 'ignorada', motivo: 'XML com erro de leitura' }; }
        if (r.r !== 'adiado') { conta1(job.rel, en.nome, r); job.feitos++; }
      });
      const evs = c.eventos.splice(0); c.eventos = null;
      await passo(evs, it => { let r; try { r = evento(it.nome, it.buf, it.xml, it.d, job.origem, conta, c, emp); } catch (e) { r = { r: 'ignorada', motivo: 'evento com erro de leitura' }; } conta1(job.rel, it.nome, r); job.feitos++; });
      job.estado = 'concluido';
    } catch (e) { job.estado = 'erro'; job.erro = 'Falha ao gravar: ' + (e.message || e); console.error('[arquivo fiscal] lote', e); }
    finally { z.fechar(); try { fs.unlinkSync(job.tmp); } catch (x) { } }
    job.fim = Date.now();
    const rel = Object.assign({}, job.rel, { total: job.total, arquivo: job.arquivo, origem: job.origem, estado: job.estado, erro: job.erro || undefined, segundos: Math.round((job.fim - job.ini) / 100) / 10 });
    try { st.loteNovo.run(job.id, conta.id, job.ini, job.fim, job.arquivo, job.origem, JSON.stringify(rel)); } catch (e) { }
    auditar(conta, req, 'ARQF_IMPORTAR_LOTE', 'arqfiscal/lote/' + job.id, null, Object.assign({}, rel, { lista: undefined, primeirosRecusados: rel.lista.slice(0, 20) }));
  }

  /* ---------- situação via conector fiscal (sem consulta em massa) ---------- */
  const conectorTool = async (tool, corpo) => {
    const r = await fetch(FISCAL_URL + '/tool/' + tool, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fiscal-token': FISCAL_TOKEN, 'x-usuario': 'arquivo-fiscal' }, body: JSON.stringify(corpo || {}), signal: AbortSignal.timeout(60000) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw { msg: j.erro || ('conector respondeu ' + r.status) }; return j;
  };
  const SIT = { hora: [] };
  async function consultarSituacao(row, conta, req, manual) {
    if (!FISCAL_URL) return { ok: false, msg: 'O conector fiscal não está configurado neste servidor (FISCAL_URL).' };
    const t = Date.now(); SIT.hora = SIT.hora.filter(x => t - x < 3600e3);
    let stt = {}; try { stt = await conectorTool('status', {}); } catch (e) { return { ok: false, msg: 'O conector fiscal não respondeu.' }; }
    const bloq = stt.nfeBloqueioAte && Date.parse(stt.nfeBloqueioAte) > t;
    const achar = async () => { const j = await conectorTool('listar_documentos', { tipo: 'nfe', desde: String(row.emissao || '').slice(0, 10), limite: 2000 }); return (j.documentos || []).find(x => normCh(x.chave) === row.chave); };
    let doc; try { doc = await achar(); } catch (e) { return { ok: false, msg: e.msg || 'Falha ao ler o conector.' }; }
    let baixou = null;
    if (!doc || doc.situacao !== 'completa') {
      if (row.tipo !== 'entrada') return fimSit(row, null, 'O conector só consulta notas em que a empresa é destinatária. Para a saída, confira a chave no portal da NF-e.', conta, req);
      if (diasEntre(row.emissao, hojeBr()) > 90) return fimSit(row, null, 'A SEFAZ só consulta por chave notas de até 90 dias. Confira a chave no portal da NF-e.', conta, req);
      if (!manual && SIT.hora.length >= SIT_HORA) return { ok: false, adiar: 'cota', msg: 'limite de consultas automáticas por hora' };
      if (bloq) return { ok: false, adiar: 'bloqueio', msg: 'A SEFAZ está em espera de consumo indevido (656). Tente depois de ' + new Date(stt.nfeBloqueioAte).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) + '.' };
      SIT.hora.push(t);
      try { baixou = await conectorTool('baixar', { chave: row.chave }); } catch (e) { return { ok: false, msg: e.msg || 'Falha ao consultar.' }; }
      if (baixou && (baixou.bloqueado || baixou.limite)) return { ok: false, adiar: baixou.bloqueado ? 'bloqueio' : 'cota', msg: baixou.msg };
      /* v130: respostas da consulta por chave (Distribuição DF-e) que já dizem a situação da nota */
      const cs = String((baixou && baixou.cStat) || '');
      if (cs === '653') return fimSit(row, 'cancelada', 'SEFAZ (consulta por chave): NF-e cancelada (cStat 653).', conta, req);
      if (cs === '654') return fimSit(row, 'denegada', 'SEFAZ (consulta por chave): NF-e denegada (cStat 654).', conta, req);
      if (['137', '217', '640'].includes(cs) && diasEntre(row.emissao, hojeBr()) >= 2) return fimSit(row, 'inexistente', 'SEFAZ (consulta por chave): nota não encontrada para o CNPJ da empresa (cStat ' + cs + '). Confira a chave no portal da NF-e antes de pagar.', conta, req);
      try { doc = await achar(); } catch (e) { }
    }
    const evs = doc && Array.isArray(doc.eventos) ? doc.eventos : [];
    if (evs.some(e => String(e.tp) === '110111')) return fimSit(row, 'cancelada', 'Cancelada: evento de cancelamento visto pelo conector fiscal.', conta, req);
    if (doc && doc.situacao === 'completa') return fimSit(row, 'autorizada', 'Conector fiscal: nota completa, sem evento de cancelamento.', conta, req);
    return fimSit(row, null, (baixou && baixou.msg) || 'O conector ainda não tem esta nota. Tente mais tarde.', conta, req);
  }
  function fimSit(row, sit, msg, conta, req) {
    const avisos = [];
    if (sit) { st.sit.run(sit, 'conector fiscal', Date.now(), msg, row.id); if (['cancelada', 'inexistente', 'denegada'].includes(sit)) { const r = st.porChave.get(row.chave); marcarSitNosTitulos(r, sit, avisos); } }
    else st.sitMsg.run(msg, Date.now(), 0, row.id);
    soltar(avisos); auditar(conta, req, 'ARQF_SITUACAO', 'arqfiscal/' + row.chave, null, { situacao: sit || '(sem mudança)', msg });
    return { ok: true, situacao: sit || row.situacao, msg };
  }
  let filaRodando = false;
  async function rodarFila() {
    if (filaRodando || !FISCAL_URL || !SIT_HORA) return; filaRodando = true;
    try { for (const r of st.fila.all(20)) { const x = await consultarSituacao(st.porId.get(r.id), null, null, false); if (x.adiar === 'bloqueio') break; if (!x.ok && !x.adiar) st.sitMsg.run(x.msg, Date.now(), 0, r.id); } } catch (e) { } finally { filaRodando = false; }
  }
  if (FISCAL_URL && SIT_HORA) setInterval(() => { rodarFila(); }, SIT_INTERVALO).unref();

  /* ---------- ponte com o conector: notas que o conector já baixou entram no arquivo ---------- */
  async function ponteSefaz(conta, req, dias) {
    if (!FISCAL_URL) return { ok: false, st: 503, msg: 'O conector fiscal não está configurado neste servidor (FISCAL_URL).' };
    const desde = new Date(Date.now() - Math.min(3650, Math.max(1, dias || 90)) * 864e5).toISOString().slice(0, 10);
    let docs; try { docs = (await conectorTool('listar_documentos', { tipo: 'nfe', desde, limite: 2000 })).documentos || []; } catch (e) { return { ok: false, st: 502, msg: 'O conector fiscal não respondeu.' }; }
    const emp = empresa(), rel = novoRel(), c = { ix: indice(), avisos: [], eventos: null }; let canc = 0;
    for (const d of docs) {
      const ch = normCh(d.chave), ja = st.porChave.get(ch);
      if (ja) { if ((d.eventos || []).some(e => String(e.tp) === '110111') && ja.situacao !== 'cancelada') { st.sit.run('cancelada', 'conector fiscal (evento visto na distribuição)', Date.now(), null, ja.id); marcarSitNosTitulos(ja, 'cancelada', c.avisos); canc++; } rel.existentes++; continue; }
      if (d.situacao !== 'completa' || !d.temXml) continue;
      let x; try { x = await conectorTool('obter_xml', { chave: ch }); } catch (e) { continue; }
      if (!x || !x.ok || !x.xml) continue;
      db.exec('BEGIN'); let r; try { r = processar(ch + '.xml', Buffer.from(x.xml, 'utf8'), 'sefaz', conta, c, emp); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (y) { } r = { r: 'ignorada', motivo: 'erro ao gravar' }; }
      conta1(rel, ch + '.xml', r); soltar(c.avisos.splice(0));
    }
    soltar(c.avisos.splice(0)); rel.canceladas += canc;
    auditar(conta, req, 'ARQF_PONTE_SEFAZ', 'arqfiscal/sefaz', null, Object.assign({}, rel, { lista: rel.lista.slice(0, 20) }));
    return { ok: true, rel };
  }

  /* ---------- listagem ---------- */
  function filtros(u, acc) {
    const g = k => String(u.searchParams.get(k) || '').trim().slice(0, 120), w = [], a = [];
    let tipo = g('tipo'); if (acc === 'entradas') tipo = 'entrada';
    if (tipo === 'entrada' || tipo === 'saida') { w.push('tipo=?'); a.push(tipo); }
    const de = g('de'), ate = g('ate'); if (/^\d{4}-\d{2}-\d{2}$/.test(de)) { w.push('emissao>=?'); a.push(de); } if (/^\d{4}-\d{2}-\d{2}$/.test(ate)) { w.push('emissao<=?'); a.push(ate); }
    const sit = g('sit'); if (['autorizada', 'cancelada', 'desconhecida', 'inexistente', 'denegada'].includes(sit)) { w.push('situacao=?'); a.push(sit); }
    const v = g('vinc'); if (v === 'ligada') w.push('vinc IS NOT NULL'); else if (v === 'pendente') w.push('vinc IS NULL'); else if (v === 'sugestao') w.push('vinc IS NULL AND sugest IS NOT NULL'); else if (v === 'sem') w.push('vinc IS NULL AND sugest IS NULL');
    else if (v === 'cancligada') w.push("vinc IS NOT NULL AND situacao='cancelada'");
    const org = g('origem'); if (['historico', 'upload', 'sefaz'].includes(org)) { w.push('origem=?'); a.push(org); }
    else if (org === 'email') w.push("chave IN (SELECT chave FROM arqf_origem WHERE origem='email')"); /* v130: recebida (também) por e-mail */
    const vmin = parseFloat(g('vmin').replace(',', '.')), vmax = parseFloat(g('vmax').replace(',', '.'));
    if (isFinite(vmin)) { w.push('valor>=?'); a.push(vmin); } if (isFinite(vmax)) { w.push('valor<=?'); a.push(vmax); }
    const qq = g('q'); if (qq) {
      const d = normDoc(qq), n = semZeros(qq), lk = '%' + qq.replace(/[\\%_]/g, '\\$&').toLowerCase() + '%';
      const ors = ["lower(parc_nome) LIKE ? ESCAPE '\\'", "lower(emit_nome) LIKE ? ESCAPE '\\'", "lower(dest_nome) LIKE ? ESCAPE '\\'"]; a.push(lk, lk, lk);
      if (d.length >= 4) { ors.push('chave LIKE ?', 'parc_doc LIKE ?', 'emit_doc LIKE ?', 'dest_doc LIKE ?'); a.push('%' + d + '%', d + '%', d + '%', d + '%'); }
      if (n && /^\d{1,9}$/.test(n)) { ors.push("ltrim(numero,'0')=?"); a.push(n); }
      w.push('(' + ors.join(' OR ') + ')');
    }
    return { wh: w.length ? ' WHERE ' + w.join(' AND ') : '', a };
  }
  const linha = r => ({ id: r.id, chave: r.chave, tipo: r.tipo, numero: r.numero, serie: r.serie, emissao: r.emissao, valor: r.valor, parcDoc: r.parc_doc, parcNome: r.parc_nome,
    situacao: r.situacao, sitFonte: r.sit_fonte, sitMsg: r.sit_msg || undefined, sitEm: r.sit_em, origem: r.origem, vinc: r.vinc ? JSON.parse(r.vinc) : [], vincConf: r.vinc_conf || undefined,
    sug: r.sugest ? JSON.parse(r.sugest) : undefined, guardaAte: guardaAte(r.emissao), em: r.em, ass: r.ass, fila: r.sit_fila ? 1 : undefined });
  function listar(u, acc) {
    const f = filtros(u, acc), pg = Math.max(0, +u.searchParams.get('pg') || 0), n = Math.min(PAG_MAX, Math.max(10, +u.searchParams.get('n') || 50));
    const ord = u.searchParams.get('ord') === 'valor' ? 'valor DESC' : u.searchParams.get('ord') === 'antigas' ? 'emissao ASC, numero ASC' : 'emissao DESC, numero DESC';
    const total = db.prepare('SELECT count(*) AS n, coalesce(sum(valor),0) AS v FROM arqf' + f.wh).get(...f.a);
    const ls = db.prepare('SELECT id,chave,tipo,numero,serie,emissao,valor,parc_doc,parc_nome,situacao,sit_fonte,sit_msg,sit_em,sit_fila,origem,vinc,vinc_conf,sugest,em,ass FROM arqf' + f.wh + ' ORDER BY ' + ord + ' LIMIT ? OFFSET ?').all(...f.a, n, pg * n);
    const tp = acc === 'entradas' ? " WHERE tipo='entrada'" : '';
    const res = db.prepare("SELECT count(*) AS total, sum(tipo='entrada') AS entradas, sum(tipo='saida') AS saidas, sum(vinc IS NOT NULL) AS ligadas, sum(vinc IS NULL) AS pendentes, sum(vinc IS NULL AND sugest IS NOT NULL) AS sugestoes, sum(situacao='cancelada') AS canceladas, sum(situacao='cancelada' AND vinc IS NOT NULL) AS cancLigadas, min(emissao) AS primeira, max(emissao) AS ultima FROM arqf" + tp).get();
    for (const k of Object.keys(res)) if (res[k] == null && k !== 'primeira' && k !== 'ultima') res[k] = 0;
    const itens = ls.map(linha);
    /* v130: todas as origens de cada nota da página (uma consulta só) */
    if (itens.length) { const og = new Map(); for (const o of db.prepare('SELECT chave, origem, em FROM arqf_origem WHERE chave IN (' + itens.map(() => '?').join(',') + ') ORDER BY em').all(...itens.map(x => x.chave))) { if (!og.has(o.chave)) og.set(o.chave, []); og.get(o.chave).push({ origem: o.origem, em: o.em }); } for (const x of itens) x.origens = og.get(x.chave) || [{ origem: x.origem, em: x.em }]; }
    return { itens, total: total.n, soma: r2(total.v), pg, n, resumo: res, acesso: acc, hoje: hojeBr() };
  }

  /* ---------- rotas ---------- */
  async function lerJsonLim(req, max) { const b = await lerCorpo(req, max); if (!b.length) return {}; try { return JSON.parse(b.toString('utf8')); } catch (e) { throw { st: 400, msg: 'JSON inválido.' }; } }
  const negar = (res, conta, req, p, msg) => { auditar(conta, req, 'ARQF_NEGADO', p, null, null); return json(res, 403, { code: 'not_granted', erro: msg || 'Seu perfil não tem acesso ao arquivo fiscal.' }); };
  async function rota(p, m, req, res, conta, u) {
    if (!p.startsWith('/api/arqfiscal')) return false;
    const acc = acesso(conta);
    if (!acc) { negar(res, conta, req, p); return true; }
    const total = acc === 'total';
    if (p === '/api/arqfiscal' && m === 'GET') { json(res, 200, listar(u, acc)); return true; }
    if (p === '/api/arqfiscal/config' && m === 'GET') { const e = empresa(); json(res, 200, { cnpjs: [...e.cnpjs], tol: e.tol * 100, dias: e.dias, conector: !!FISCAL_URL, maxZipMb: Math.round(MAX_ZIP / 1048576), conferirAssinatura: CONFERIR_ASS, acesso: acc }); return true; }
    /* envio de XML (um ou alguns, em JSON): fornecedor, conector ou o próprio usuário */
    if (p === '/api/arqfiscal/xml' && m === 'POST') {
      const b = await lerJsonLim(req, 12 * 1024 * 1024), arqs = Array.isArray(b.arquivos) ? b.arquivos : [];
      if (!arqs.length || arqs.length > 50) { json(res, 400, { code: 'invalid_argument', erro: 'Envie de 1 a 50 arquivos XML por vez (para mais, use um ZIP).' }); return true; }
      let origem = ['upload', 'sefaz', 'historico'].includes(b.origem) ? b.origem : 'upload'; if (!total) origem = 'upload';
      const emp = empresa(); if (!emp.cnpjs.size) { json(res, 409, { code: 'failed_precondition', erro: 'Informe o CNPJ da empresa em Sistema › Configurações antes de guardar notas no arquivo fiscal.' }); return true; }
      const c = { ix: indice(), avisos: [], eventos: [], soEntradas: !total }, rel = novoRel(), out = [];
      db.exec('BEGIN');
      try {
        for (const a of arqs) { const r = processar(String(a.nome || 'nota.xml'), Buffer.from(String(a.xml || ''), 'utf8'), origem, conta, c, emp); if (r.r !== 'adiado') { conta1(rel, a.nome, r); out.push(Object.assign({ arquivo: a.nome }, r)); } }
        for (const it of c.eventos.splice(0)) { const r = evento(it.nome, it.buf, it.xml, it.d, origem, conta, c, emp); conta1(rel, it.nome, r); out.push(Object.assign({ arquivo: it.nome }, r)); }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
      soltar(c.avisos);
      if (rel.novas || rel.eventos) auditar(conta, req, 'ARQF_IMPORTAR', 'arqfiscal/xml', null, { origem, novas: rel.novas, existentes: rel.existentes, ignoradas: rel.ignoradas, eventos: rel.eventos, chaves: out.filter(x => x.r === 'nova').map(x => x.chave).slice(0, 50) });
      json(res, 200, { rel, itens: out.map(x => ({ arquivo: x.arquivo, r: x.r, motivo: x.motivo, chave: x.chave, id: x.id, tipo: x.tipo, lig: x.lig })) }); return true;
    }
    /* importação em lote: o corpo é o ZIP; processa em partes; o andamento é consultado em /lote/<id> */
    if (p === '/api/arqfiscal/lote' && m === 'POST') {
      if (!total) { negar(res, conta, req, p, 'Seu perfil não importa lotes no arquivo fiscal.'); return true; }
      const emp = empresa(); if (!emp.cnpjs.size) { json(res, 409, { code: 'failed_precondition', erro: 'Informe o CNPJ da empresa em Sistema › Configurações antes de importar.' }); return true; }
      if ([...LOTES.values()].filter(j => j.estado === 'processando' || j.estado === 'recebendo').length >= 2) { json(res, 429, { code: 'resource_exhausted', erro: 'Já há duas importações em andamento. Espere uma terminar.' }); return true; }
      const len = +req.headers['content-length'] || 0; if (len > MAX_ZIP) { json(res, 413, { code: 'invalid_argument', erro: 'ZIP grande demais (limite ' + Math.round(MAX_ZIP / 1048576) + ' MB). Divida por ano ou por mês.' }); return true; }
      const id = uid(16), tmp = path.join(DATA, 'tmp', 'arqf-' + id + '.zip');
      const job = { id, por: conta.id, ini: Date.now(), estado: 'recebendo', total: 0, feitos: 0, rel: novoRel(), tmp, arquivo: String(u.searchParams.get('nome') || 'lote.zip').slice(0, 200), origem: ['historico', 'upload'].includes(u.searchParams.get('origem')) ? u.searchParams.get('origem') : 'historico' };
      LOTES.set(id, job);
      try {
        await new Promise((ok, err) => { let n = 0; const w = fs.createWriteStream(tmp); req.on('data', d => { n += d.length; if (n > MAX_ZIP) { req.unpipe(w); w.destroy(); err({ st: 413, msg: 'ZIP grande demais (limite ' + Math.round(MAX_ZIP / 1048576) + ' MB).' }); req.resume(); } }); req.pipe(w); w.on('finish', ok); w.on('error', err); req.on('error', err); });
      } catch (e) { LOTES.delete(id); try { fs.unlinkSync(tmp); } catch (x) { } json(res, e.st || 400, { erro: e.msg || 'Falha ao receber o arquivo.' }); return true; }
      if (/\.xml$/i.test(job.arquivo)) { /* um XML solto também passa por aqui */
        const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp); const c = { ix: indice(), avisos: [], eventos: null }; let r;
        db.exec('BEGIN'); try { r = processar(job.arquivo, buf, job.origem, conta, c, emp); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
        soltar(c.avisos); conta1(job.rel, job.arquivo, r); job.total = job.feitos = 1; job.estado = 'concluido'; job.fim = Date.now();
      } else { setImmediate(() => rodarLote(job, conta, req)); job.estado = 'processando'; }
      json(res, 202, { id, estado: job.estado }); return true;
    }
    const ml = p.match(/^\/api\/arqfiscal\/lote\/([A-Za-z0-9]{8,40})$/);
    if (ml && m === 'GET') {
      const j = LOTES.get(ml[1]);
      if (j) { if (j.por !== conta.id && conta.nivel !== 'owner' && !total) { negar(res, conta, req, p); return true; } json(res, 200, { id: j.id, estado: j.estado, total: j.total, feitos: j.feitos, erro: j.erro, rel: j.rel, arquivo: j.arquivo, segundos: Math.round(((j.fim || Date.now()) - j.ini) / 100) / 10 }); return true; }
      const r = st.loteGet.get(ml[1]); if (!r) { json(res, 404, { erro: 'Importação não encontrada.' }); return true; }
      const rel = JSON.parse(r.rel || '{}'); json(res, 200, { id: r.id, estado: rel.estado || 'concluido', total: rel.total, feitos: rel.total, rel, arquivo: r.arquivo, segundos: rel.segundos }); return true;
    }
    if (p === '/api/arqfiscal/lotes' && m === 'GET') { json(res, 200, { lotes: db.prepare('SELECT id, por, em, fim, arquivo, origem, rel FROM arqf_lote ORDER BY em DESC LIMIT 30').all().map(r => { const x = JSON.parse(r.rel || '{}'); delete x.lista; return Object.assign({ id: r.id, por: r.por, em: r.em, fim: r.fim, arquivo: r.arquivo, origem: r.origem }, x); }) }); return true; }
    /* exportar ZIP por período (para o contador), gerado em fluxo */
    if (p === '/api/arqfiscal/exportar' && m === 'GET') {
      if (!total) { negar(res, conta, req, p, 'Seu perfil não exporta o arquivo fiscal.'); return true; }
      const f = filtros(u, acc), ids = db.prepare('SELECT id, chave, tipo, numero, serie, emissao, valor, parc_doc, parc_nome, situacao FROM arqf' + f.wh + ' ORDER BY emissao, numero').all(...f.a);
      if (!ids.length) { json(res, 404, { code: 'not_found', erro: 'Nenhuma nota no período.' }); return true; }
      if (ids.length > MAX_EXPORT) { json(res, 413, { code: 'invalid_argument', erro: 'São ' + ids.length + ' notas. Exporte por partes (até ' + MAX_EXPORT + ').' }); return true; }
      const de = u.searchParams.get('de') || ids[0].emissao, ate = u.searchParams.get('ate') || ids[ids.length - 1].emissao;
      auditar(conta, req, 'ARQF_EXPORTAR', 'arqfiscal/exportar', null, { de, ate, tipo: u.searchParams.get('tipo') || 'todas', notas: ids.length });
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="notas-fiscais-' + String(de).replace(/[^0-9-]/g, '') + '-a-' + String(ate).replace(/[^0-9-]/g, '') + '.zip"', 'cache-control': 'no-store' });
      const z = zipEscritor(res), gx = db.prepare('SELECT xml FROM arqf WHERE id=?'), gev = db.prepare('SELECT tp, seq, xml FROM arqf_evento WHERE chave=?');
      const csv = [['chave', 'tipo', 'numero', 'serie', 'emissao', 'cnpj_parceiro', 'parceiro', 'valor', 'situacao'].join(';')];
      try {
        for (const r of ids) {
          const pasta = String(r.emissao || '0000').slice(0, 4) + '/' + (r.tipo === 'saida' ? 'saidas' : 'entradas') + '/';
          await z.addGz(pasta + r.chave + '-nfe.xml', gx.get(r.id).xml);
          for (const e of gev.all(r.chave)) await z.addGz(pasta + r.chave + '-evento-' + e.tp + '-' + (e.seq || '1') + '.xml', e.xml);
          csv.push([r.chave, r.tipo, r.numero, r.serie, r.emissao, r.parc_doc, '"' + String(r.parc_nome || '').replace(/"/g, '""') + '"', String(r.valor).replace('.', ','), r.situacao].join(';'));
        }
        await z.addBuf('indice.csv', Buffer.from('﻿' + csv.join('\r\n'), 'utf8'));
        await z.fechar();
      } catch (e) { console.error('[arquivo fiscal] exportar', e.message); try { res.destroy(); } catch (x) { } }
      return true;
    }
    if (p === '/api/arqfiscal/sefaz' && m === 'POST') {
      if (!total) { negar(res, conta, req, p); return true; }
      const b = await lerJsonLim(req, 10000), r = await ponteSefaz(conta, req, +b.dias || 90);
      json(res, r.ok ? 200 : r.st || 400, r.ok ? r : { erro: r.msg }); return true;
    }
    if (p === '/api/arqfiscal/religar' && m === 'POST') { /* procura títulos de novo para as notas ainda sem vínculo (ou só as chaves pedidas) */
      if (!total) { negar(res, conta, req, p); return true; }
      const b = await lerJsonLim(req, 200000), chs = Array.isArray(b.chaves) ? b.chaves.map(normCh).slice(0, 2000) : null;
      const emp = empresa(), ix = indice(), avisos = []; let lig = 0, sug = 0, vist = 0;
      const rows = chs ? chs.map(ch => st.porChave.get(ch)).filter(Boolean).map(r => st.porId.get(r.id)) : db.prepare('SELECT id,chave,tipo,numero,serie,emissao,valor,parc_doc,situacao,vinc FROM arqf WHERE vinc IS NULL').all();
      for (let i = 0; i < rows.length; i += 200) {
        db.exec('BEGIN');
        try { for (const r of rows.slice(i, i + 200)) { if (r.vinc) continue; vist++; const mm = casar(r, ix, emp); if (mm.conf === 'alta') { gravarVinc(r, mm.lancs, 'auto', conta, avisos); mm.lancs.forEach(l => marcarUsado(ix, l, r.chave)); lig++; if (r.situacao === 'cancelada') marcarSitNosTitulos(Object.assign({}, r, { vinc: JSON.stringify(mm.lancs) }), 'cancelada', avisos); } else { st.sugest.run(mm.conf === 'sugestao' ? JSON.stringify(mm.sug) : null, r.id); if (mm.conf === 'sugestao') sug++; } } db.exec('COMMIT'); }
        catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
        soltar(avisos.splice(0)); await new Promise(r => setImmediate(r));
      }
      auditar(conta, req, 'ARQF_RELIGAR', 'arqfiscal/religar', null, { vistas: vist, ligadas: lig, sugestoes: sug });
      json(res, 200, { vistas: vist, ligadas: lig, sugestoes: sug }); return true;
    }
    const mi = p.match(/^\/api\/arqfiscal\/([A-Za-z0-9]{8,40})(\/(xml|ligar|desligar|situacao|eventos))?$/);
    if (!mi) { json(res, 404, { erro: 'Não encontrado.' }); return true; }
    const row = st.porId.get(mi[1]);
    if (!row || (!total && row.tipo !== 'entrada')) { json(res, 404, { code: 'not_found', erro: 'Nota não encontrada no arquivo fiscal.' }); return true; }
    const acao = mi[3] || '';
    if (!acao && m === 'GET') { json(res, 200, Object.assign(linha(row), { emitDoc: row.emit_doc, emitNome: row.emit_nome, destDoc: row.dest_doc, destNome: row.dest_nome, parcelas: JSON.parse(row.parcelas || '[]'), arquivo: row.arquivo, por: row.por, prot: row.prot, fin: row.fin, eventos: st.evDa.all(row.chave) })); return true; }
    if (acao === 'xml' && m === 'GET') {
      const x = st.xml.get(row.id), b = zlib.gunzipSync(x.xml);
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store', 'content-disposition': (u.searchParams.get('baixar') ? 'attachment' : 'inline') + '; filename="' + row.chave + '-nfe.xml"', 'content-security-policy': "default-src 'none'; sandbox" });
      res.end(b); return true;
    }
    if (acao === 'situacao' && m === 'POST') { if (!total) { negar(res, conta, req, p); return true; } const r = await consultarSituacao(row, conta, req, true); json(res, r.ok ? 200 : 409, r.ok ? r : { erro: r.msg }); return true; }
    if ((acao === 'ligar' || acao === 'desligar') && m === 'POST') {
      if (!total) { negar(res, conta, req, p, 'Seu perfil não liga notas a títulos.'); return true; }
      const b = await lerJsonLim(req, 100000), ids = acao === 'ligar' ? (Array.isArray(b.lancIds) ? b.lancIds.map(String).filter(x => /^[\w-]{1,80}$/.test(x)).slice(0, 120) : []) : [];
      if (acao === 'ligar' && !ids.length) { json(res, 400, { code: 'invalid_argument', erro: 'Escolha ao menos um título.' }); return true; }
      const tipoL = row.tipo === 'saida' ? 'receber' : 'pagar';
      for (const id of ids) { const l = docGet('lanc/' + id); if (!l || l.tipo !== tipoL) { json(res, 400, { code: 'invalid_argument', erro: 'Título inválido para esta nota (' + id + ').' }); return true; } if (l.arqf && l.arqf.ch && normCh(l.arqf.ch) !== row.chave) { json(res, 409, { code: 'conflict', erro: 'O título "' + (l.desc || id) + '" já está ligado a outra nota (' + l.arqf.n + ').' }); return true; } }
      const antes = row.vinc ? JSON.parse(row.vinc) : [], avisos = [];
      db.exec('BEGIN'); try { gravarVinc(row, ids, 'manual', conta, avisos); if (row.situacao === 'cancelada' && ids.length) marcarSitNosTitulos(Object.assign({}, row, { vinc: JSON.stringify(ids) }), 'cancelada', avisos); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
      soltar(avisos);
      auditar(conta, req, acao === 'ligar' ? 'ARQF_LIGAR' : 'ARQF_DESLIGAR', 'arqfiscal/' + row.chave, { titulos: antes }, { titulos: ids });
      json(res, 200, linha(st.porId.get(row.id))); return true;
    }
    if (!acao && m === 'DELETE') {
      const ate = guardaAte(row.emissao), dentro = !ate || hojeBr() <= ate;
      if (dentro) { auditar(conta, req, 'ARQF_EXCLUIR_NEGADO', 'arqfiscal/' + row.chave, null, { motivo: 'prazo de guarda', guardaAte: ate }); json(res, 409, { code: 'failed_precondition', erro: 'Este XML está no prazo de guarda (até ' + (ate ? ate.split('-').reverse().join('/') : '—') + '). O sistema não exclui antes disso.' }); return true; }
      if (conta.nivel !== 'owner') { auditar(conta, req, 'ARQF_EXCLUIR_NEGADO', 'arqfiscal/' + row.chave, null, { motivo: 'não é o dono' }); json(res, 403, { code: 'not_granted', erro: 'Só o dono exclui XML depois do prazo de guarda.' }); return true; }
      if (!END.reautenticado(req)) { auditar(conta, req, 'ARQF_EXCLUIR_PEDE_SENHA', 'arqfiscal/' + row.chave, null, null); if (END.exigirReauth(req, res)) return true; }
      const avisos = [];
      db.exec('BEGIN'); try { gravarVinc(row, [], 'manual', conta, avisos); st.del.run(row.id); db.prepare('DELETE FROM arqf_evento WHERE chave=?').run(row.chave); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } json(res, 409, { erro: 'O banco recusou a exclusão: ' + e.message }); return true; }
      soltar(avisos); auditar(conta, req, 'ARQF_EXCLUIR', 'arqfiscal/' + row.chave, { chave: row.chave, numero: row.numero, emissao: row.emissao, valor: row.valor, sha: undefined }, null);
      json(res, 200, { ok: true }); return true;
    }
    json(res, 405, { erro: 'Método não permitido.' }); return true;
  }
  /* v130: pôr na fila de consulta por chave (conector fiscal, com os mesmos limites) uma nota de entrada já guardada que chegou
     de novo por outro caminho (ex.: e-mail). Só se: há conector, é entrada de até 90 dias, está autorizada, não veio do próprio
     conector (origem sefaz) e ainda não foi conferida pelo conector. Nunca consulta por NSU. */
  function enfileirar(chave) {
    if (!FISCAL_URL || !SIT_HORA) return 0;
    const lim = new Date(Date.now() - 3 * 3600e3 - 90 * 864e5).toISOString().slice(0, 10);
    return db.prepare(`UPDATE arqf SET sit_fila=1 WHERE chave=? AND tipo='entrada' AND situacao='autorizada' AND sit_fila=0 AND emissao>=?
      AND coalesce(sit_fonte,'')<>'conector fiscal' AND chave NOT IN (SELECT chave FROM arqf_origem WHERE origem='sefaz')`).run(normCh(chave), lim).changes;
  }
  return { rota, acesso, empresa, c14nInfNFe, conferirAssinatura, lerDoc, guardaAte, rodarFila,
    /* v130: usados pela leitura da caixa nfe@ (caixanfe.js) */
    processar, evento, indice, novoRel, conta1, linha, enfileirar, soltar, regOrigem, normCh, hojeBr, diasEntre, temConector: !!FISCAL_URL };
};
module.exports.util = { c14nInfNFe, conferirAssinatura, lerDoc, guardaAte, textoXml };

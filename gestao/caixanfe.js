'use strict';
/* v130: leitura da caixa nfe@inaservicos.com.br (Microsoft 365) — as NF-e que os fornecedores mandam por e-mail vão para o
   Arquivo fiscal (arquivofiscal.js, origem "email") e são comparadas com o que veio da SEFAZ (conector), do Omie (histórico) e
   do envio manual.
   Conexão: Microsoft Graph com credencial de aplicativo (client credentials). Variáveis:
     M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET  (sem as três, o leitor fica desligado e a tela explica como configurar)
     NFE_EMAIL (padrão nfe@inaservicos.com.br), NFE_EMAIL_PASTA_OK (padrão "Processadas"), NFE_EMAIL_INTERVALO_MIN (padrão 60, mínimo 15)
     M365_SECRET_VENCE=AAAA-MM-DD (data em que o segredo vence: aviso 30 dias antes)
     Só para testes: M365_GRAPH_URL e M365_LOGIN_URL (http só em 127.0.0.1/localhost), NFE_EMAIL_PRIMEIRA_S, NFE_EMAIL_MANUAL_S.
   Segurança: anexos são dados NÃO confiáveis.
     - .xml e .zip (só com .xml dentro; limite de tamanho e de quantidade; nomes com caminho recusados) passam pelo processar()
       do arquivo fiscal, que confere protocolo, modelo, CNPJ da empresa e assinatura;
     - .pdf só é guardado ("DANFE do e-mail") se o nome, o assunto ou o texto do PDF tiver uma chave de 44 dígitos válida;
       e-mail com PDF e sem XML válido fica na lista "PDF sem XML" (pedir o XML ao fornecedor);
     - outros tipos são ignorados. Limite por anexo e por mensagem. Do e-mail guarda só remetente, assunto e data (nunca o corpo).
   O segredo e o token nunca vão para log, auditoria, banco ou resposta (ocultar()). Nunca consulta a SEFAZ por NSU: a situação
   de cada nota é conferida pela fila de consulta por chave do arquivo fiscal (mesmos limites por hora e bloqueio 656). */
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const E = process.env;

const MAX_ANEXO = 5 * 1024 * 1024, MAX_MSG_BYTES = 25 * 1024 * 1024, MAX_ANEXOS_MSG = 30, MAX_MSGS = Math.max(1, +E.NFE_EMAIL_MAX_MSGS || 200);
const ZIP_MAX_ARQ = 50, ZIP_MAX_ENTRADAS = 200, ZIP_MAX_TOTAL = 20 * 1024 * 1024, MAX_XML = 5 * 1024 * 1024;
const PAPEIS = ['admin', 'financeiro', 'fiscal', 'diretoria'];

/* chave de acesso: 44 dígitos, UF válida, modelo 55 e dígito verificador (módulo 11) */
const UFS = new Set(['11', '12', '13', '14', '15', '16', '17', '21', '22', '23', '24', '25', '26', '27', '28', '29', '31', '32', '33', '35', '41', '42', '43', '50', '51', '52', '53']);
function chaveValida(c) {
  if (!/^\d{44}$/.test(c) || !UFS.has(c.slice(0, 2)) || c.slice(20, 22) !== '55') return false;
  let s = 0, p = 2; for (let i = 42; i >= 0; i--) { s += (+c[i]) * p; p = p === 9 ? 2 : p + 1; }
  const r = s % 11, dv = r < 2 ? 0 : 11 - r; return dv === +c[43];
}
function achaChaves(txt) {
  const t = String(txt || '').replace(/(\d)[ .\-\/]+(?=\d)/g, '$1'), out = []; let m; const re = /\d{44,}/g;
  while ((m = re.exec(t))) { const s = m[0]; for (let i = 0; i + 44 <= s.length && i < 8; i++) { const c = s.slice(i, i + 44); if (chaveValida(c) && !out.includes(c)) { out.push(c); break; } } }
  return out;
}
/* texto de um PDF (melhor esforço, sem bibliotecas): strings literais dos fluxos de conteúdo (descomprimidos com limite) */
function textoPdf(buf) {
  if (!buf || buf.length < 8 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return '';
  const s = buf.toString('latin1'), partes = []; let orc = 8 * 1024 * 1024, n = 0, i = 0;
  const lits = t => { const o = []; const re = /\(((?:\\.|[^\\)])*)\)/g; let m; while ((m = re.exec(t)) && o.length < 20000) o.push(m[1].replace(/\\([0-7]{1,3})/g, (x, k) => String.fromCharCode(parseInt(k, 8))).replace(/\\(.)/g, '$1')); return o.join(''); };
  while (n < 300 && orc > 0) {
    const a = s.indexOf('stream', i); if (a < 0) break;
    let ini = a + 6; if (s[ini] === '\r') ini++; if (s[ini] === '\n') ini++;
    const f = s.indexOf('endstream', ini); if (f < 0) break;
    const dic = s.slice(Math.max(0, a - 400), a); n++; i = f + 9;
    let d = buf.subarray(ini, f);
    if (/\/FlateDecode/.test(dic)) { try { d = zlib.inflateSync(d, { maxOutputLength: Math.min(orc, 2 * 1024 * 1024) }); } catch (e) { continue; } }
    else if (/\/Filter/.test(dic)) continue;
    orc -= d.length; partes.push(lits(d.toString('latin1')));
  }
  partes.push(lits(s.slice(0, 200000)));
  return partes.join(' ');
}
/* ZIP em memória (anexo de no máximo 5 MB): só lê; nunca grava nada em disco */
function zipMem(buf) {
  const n = Math.min(buf.length, 66000); let e = -1;
  for (let i = buf.length - 22; i >= buf.length - n; i--) if (i >= 0 && buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw { msg: 'ZIP inválido' };
  const cnt = buf.readUInt16LE(e + 10), cdTam = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16);
  if (cnt > ZIP_MAX_ENTRADAS) throw { msg: 'ZIP com ' + cnt + ' arquivos (limite ' + ZIP_MAX_ENTRADAS + ')' };
  if (cdOff + cdTam > buf.length) throw { msg: 'ZIP inválido' };
  const out = []; let p = cdOff;
  for (let k = 0; k < cnt && p + 46 <= cdOff + cdTam; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const fl = buf.readUInt16LE(p + 8), met = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), orig = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const raw = buf.subarray(p + 46, p + 46 + nl), nome = (fl & 0x800) ? raw.toString('utf8') : raw.toString('latin1');
    out.push({ nome, met, comp, orig, off, cript: !!(fl & 1) }); p += 46 + nl + xl + cl;
  }
  const ler = en => {
    if (en.cript) throw { msg: 'arquivo protegido por senha' };
    if (en.orig > MAX_XML || en.comp > MAX_XML * 2) throw { msg: 'arquivo grande demais para ser um XML de NF-e' };
    if (en.off + 30 > buf.length || buf.readUInt32LE(en.off) !== 0x04034b50) throw { msg: 'ZIP inválido' };
    const ini = en.off + 30 + buf.readUInt16LE(en.off + 26) + buf.readUInt16LE(en.off + 28);
    if (ini + en.comp > buf.length) throw { msg: 'ZIP inválido' };
    const d = buf.subarray(ini, ini + en.comp);
    if (en.met === 0) return Buffer.from(d); if (en.met !== 8) throw { msg: 'compressão do ZIP não suportada' };
    return zlib.inflateRawSync(d, { maxOutputLength: MAX_XML });
  };
  return { entradas: out, ler };
}
const extDe = nome => { const m = String(nome || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/); return m ? m[1] : ''; };

module.exports = function (ctx) {
  const { db, json, lerCorpo, perfilDe, papelDe, uid, ARQF } = ctx;
  const auditar = (...a) => { try { ctx.auditar(...a); } catch (e) { } };
  const TENANT = String(E.M365_TENANT_ID || '').trim(), CLIENT = String(E.M365_CLIENT_ID || '').trim(), SECRET = String(E.M365_CLIENT_SECRET || '');
  const EMAIL = String(E.NFE_EMAIL || 'nfe@inaservicos.com.br').trim().toLowerCase();
  const PASTA = String(E.NFE_EMAIL_PASTA_OK || 'Processadas').trim().slice(0, 100) || 'Processadas';
  const INTERVALO = Math.max(15, +E.NFE_EMAIL_INTERVALO_MIN || 60);
  const VENCE = /^\d{4}-\d{2}-\d{2}$/.test(String(E.M365_SECRET_VENCE || '').trim()) ? String(E.M365_SECRET_VENCE).trim() : '';
  const MANUAL_S = E.NFE_EMAIL_MANUAL_S == null || E.NFE_EMAIL_MANUAL_S === '' ? 60 : Math.max(0, +E.NFE_EMAIL_MANUAL_S || 0);
  /* endereços: os da Microsoft; os de teste só se definidos, e com http apenas na própria máquina */
  const baseOk = (u, padrao) => { const s = String(u || '').trim().replace(/\/+$/, ''); if (!s) return padrao; try { const x = new URL(s); if (x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname))) return s; } catch (e) { } return null; };
  const GRAPH = baseOk(E.M365_GRAPH_URL, 'https://graph.microsoft.com'), LOGIN = baseOk(E.M365_LOGIN_URL, 'https://login.microsoftonline.com');
  const faltam = []; if (!TENANT) faltam.push('M365_TENANT_ID'); if (!CLIENT) faltam.push('M365_CLIENT_ID'); if (!SECRET) faltam.push('M365_CLIENT_SECRET');
  const problemas = [];
  if (TENANT && !/^[A-Za-z0-9.-]{3,100}$/.test(TENANT)) problemas.push('M365_TENANT_ID inválido (use o ID do diretório, um GUID)');
  if (CLIENT && !/^[A-Za-z0-9-]{8,64}$/.test(CLIENT)) problemas.push('M365_CLIENT_ID inválido (use o ID do aplicativo, um GUID)');
  if (!/^[^@\s\/]+@[^@\s\/]+\.[a-z]{2,}$/i.test(EMAIL)) problemas.push('NFE_EMAIL inválido');
  if (!GRAPH || !LOGIN) problemas.push('M365_GRAPH_URL/M365_LOGIN_URL inválidos');
  const LIGADO = !faltam.length && !problemas.length;
  const MB = '/users/' + encodeURIComponent(EMAIL);

  /* nunca deixar credencial em log, auditoria, banco ou mensagem */
  let TOK = null;
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ocultar = t => { let s = String(t == null ? '' : t).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{6,}/gi, '$1 [oculto]').replace(/(client_secret|access_token|refresh_token)(["'=:\s]+)[^"'&\s,}]+/gi, '$1$2[oculto]');
    if (SECRET.length >= 4) s = s.replace(new RegExp(escRe(SECRET), 'g'), '[oculto]'); if (TOK && TOK.v && TOK.v.length >= 8) s = s.replace(new RegExp(escRe(TOK.v), 'g'), '[oculto]'); return s; };
  const log = m => console.log('Caixa ' + EMAIL + ': ' + ocultar(m));

  db.exec(`CREATE TABLE IF NOT EXISTS caixa_msg(id TEXT PRIMARY KEY, chave_msg TEXT NOT NULL UNIQUE, graph_id TEXT, remetente TEXT, remetente_nome TEXT, assunto TEXT,
      recebido TEXT, em INTEGER, estado TEXT, movida INTEGER DEFAULT 0, pdf_sem_xml INTEGER DEFAULT 0, dispensada INTEGER DEFAULT 0, dispensada_por TEXT,
      chaves TEXT, pdf_chaves TEXT, anexos TEXT, leitura TEXT);
    CREATE INDEX IF NOT EXISTS caixa_msg_em ON caixa_msg(em);
    CREATE TABLE IF NOT EXISTS caixa_pdf(id TEXT PRIMARY KEY, chave TEXT NOT NULL, msg_id TEXT, nome TEXT, tam INTEGER, sha TEXT, pdf BLOB, em INTEGER, UNIQUE(chave, sha));
    CREATE INDEX IF NOT EXISTS caixa_pdf_ch ON caixa_pdf(chave);
    CREATE TABLE IF NOT EXISTS caixa_leitura(id TEXT PRIMARY KEY, ini INTEGER, fim INTEGER, gatilho TEXT, por TEXT, estado TEXT, erro TEXT, rel TEXT);`);
  const st = {
    msgGet: db.prepare('SELECT id, estado, movida FROM caixa_msg WHERE chave_msg=?'),
    msgNova: db.prepare('INSERT INTO caixa_msg(id,chave_msg,graph_id,remetente,remetente_nome,assunto,recebido,em,estado,movida,pdf_sem_xml,chaves,pdf_chaves,anexos,leitura) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    msgMovida: db.prepare('UPDATE caixa_msg SET movida=1, graph_id=? WHERE id=?'),
    pdfNovo: db.prepare('INSERT OR IGNORE INTO caixa_pdf(id,chave,msg_id,nome,tam,sha,pdf,em) VALUES(?,?,?,?,?,?,?,?)'),
    leitNova: db.prepare('INSERT INTO caixa_leitura(id,ini,fim,gatilho,por,estado,erro,rel) VALUES(?,?,?,?,?,?,?,?)'),
    ultLeit: db.prepare('SELECT * FROM caixa_leitura ORDER BY ini DESC LIMIT ?'),
    primeira: db.prepare("SELECT min(ini) AS ini FROM caixa_leitura WHERE estado IN ('ok','parcial')")
  };

  /* ---------- Microsoft Graph ---------- */
  const ERRO_AAD = { 7000222: 'o segredo do aplicativo (M365_CLIENT_SECRET) venceu: crie um novo no Entra e atualize a variável', 7000215: 'o segredo do aplicativo (M365_CLIENT_SECRET) está errado', 700016: 'o aplicativo (M365_CLIENT_ID) não existe neste diretório', 90002: 'o diretório (M365_TENANT_ID) não foi encontrado', 900023: 'o diretório (M365_TENANT_ID) é inválido', 7000229: 'falta o "service principal" do aplicativo no diretório' };
  const EST = { esperas: 0 };
  async function chamar(url, op, tent) {
    let r; try { r = await fetch(url, Object.assign({ redirect: 'manual', signal: AbortSignal.timeout(60000) }, op)); }
    catch (e) { throw { msg: 'sem resposta de ' + new URL(url).host + ' (' + ocultar(e.cause && e.cause.code || e.name || 'rede') + ')' }; }
    if ((r.status === 429 || r.status === 503 || r.status === 504) && tent < 4) {
      const ra = parseInt(r.headers.get('retry-after'), 10), s = Math.min(120, Math.max(1, isFinite(ra) ? ra : 5 * 2 ** tent));
      EST.esperas++; log('Microsoft pediu para esperar (' + r.status + '): ' + s + ' s'); try { await r.arrayBuffer(); } catch (e) { }
      await new Promise(ok => setTimeout(ok, s * 1000)); return chamar(url, op, tent + 1);
    }
    return r;
  }
  async function token(forcar) {
    if (!forcar && TOK && TOK.ate > Date.now() + 120e3) return TOK.v;
    const corpo = new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString();
    const r = await chamar(LOGIN + '/' + encodeURIComponent(TENANT) + '/oauth2/v2.0/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: corpo }, 0);
    let j = {}; try { j = await r.json(); } catch (e) { }
    if (!r.ok || !j.access_token) {
      const cod = (Array.isArray(j.error_codes) ? j.error_codes : []).map(Number).find(c => ERRO_AAD[c]);
      throw { tipo: 'credencial', msg: 'O Microsoft 365 recusou a credencial do aplicativo (' + r.status + (j.error ? ' ' + String(j.error).replace(/[^\w.-]/g, '').slice(0, 40) : '') + '): ' + (cod ? ERRO_AAD[cod] : 'confira M365_TENANT_ID, M365_CLIENT_ID e M365_CLIENT_SECRET') + '.' };
    }
    TOK = { v: String(j.access_token), ate: Date.now() + Math.max(60, +j.expires_in || 3600) * 1000 }; return TOK.v;
  }
  async function graph(metodo, caminho, corpo) {
    const url = /^https?:\/\//.test(caminho) ? caminho : GRAPH + '/v1.0' + caminho;
    if (!url.startsWith(GRAPH + '/')) throw { msg: 'link de paginação fora do Microsoft Graph (ignorado por segurança)' };
    for (let k = 0; k < 2; k++) {
      const t = await token(k > 0);
      const r = await chamar(url, { method: metodo, headers: Object.assign({ authorization: 'Bearer ' + t, accept: 'application/json' }, corpo ? { 'content-type': 'application/json' } : {}), body: corpo ? JSON.stringify(corpo) : undefined }, 0);
      if (r.status === 401 && k === 0) { TOK = null; try { await r.arrayBuffer(); } catch (e) { } continue; }
      const txt = await r.text(); let j = {}; try { j = txt ? JSON.parse(txt) : {}; } catch (e) { }
      if (!r.ok) {
        const cod = String((j.error && j.error.code) || '').replace(/[^\w.-]/g, '').slice(0, 60);
        const dica = r.status === 403 ? ': o aplicativo não tem acesso a esta caixa. Confira a função "Application Mail.ReadWrite" restrita à caixa ' + EMAIL + ' (a mudança pode levar até 2 horas para valer)'
          : r.status === 404 && /users\//.test(url) && !/messages\//.test(url) ? ': a caixa ' + EMAIL + ' não foi encontrada (confira NFE_EMAIL)' : '';
        throw { st: r.status, cod, msg: 'Microsoft Graph respondeu ' + r.status + (cod ? ' (' + cod + ')' : '') + dica + '.' };
      }
      return j;
    }
    throw { msg: 'O Microsoft 365 não aceitou o token do aplicativo.' };
  }
  let PASTA_ID = null;
  async function pastaOk() {
    if (PASTA_ID) return PASTA_ID;
    const busca = async () => { const j = await graph('GET', MB + '/mailFolders?$filter=' + encodeURIComponent("displayName eq '" + PASTA.replace(/'/g, "''") + "'") + '&$select=id,displayName&$top=10'); const f = (j.value || []).find(x => String(x.displayName).toLowerCase() === PASTA.toLowerCase()); return f ? f.id : null; };
    let id = await busca();
    if (!id) { try { const j = await graph('POST', MB + '/mailFolders', { displayName: PASTA }); id = j.id; log('pasta "' + PASTA + '" criada'); } catch (e) { if (e.st === 409) id = await busca(); else throw e; } }
    if (!id) throw { msg: 'Não consegui achar nem criar a pasta "' + PASTA + '" na caixa.' };
    PASTA_ID = id; return id;
  }
  async function mover(gid) {
    try { const j = await graph('POST', MB + '/messages/' + encodeURIComponent(gid) + '/move', { destinationId: await pastaOk() }); return j.id || gid; }
    catch (e) { if (e.st === 404 && PASTA_ID) { PASTA_ID = null; const j = await graph('POST', MB + '/messages/' + encodeURIComponent(gid) + '/move', { destinationId: await pastaOk() }); return j.id || gid; } throw e; }
  }

  /* ---------- uma mensagem ---------- */
  async function umaMsg(m, emp, c, R, leituraId) {
    const chaveMsg = String(m.internetMessageId || m.id || '').slice(0, 500); if (!chaveMsg || !m.id) return;
    const ja = st.msgGet.get(chaveMsg);
    if (ja) { /* já processada antes (a mudança de pasta falhou, ou a mesma mensagem chegou de novo): só tira da entrada, sem reprocessar */
      R.jaVistas++; const nid = await mover(m.id); if (!ja.movida) st.msgMovida.run(nid, ja.id); R.movidas++; return;
    }
    R.mensagens++;
    const de = (m.from && m.from.emailAddress) || (m.sender && m.sender.emailAddress) || {};
    const assunto = String(m.subject || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 300);
    const lista = ((await graph('GET', MB + '/messages/' + encodeURIComponent(m.id) + '/attachments?$select=id,name,contentType,size,isInline')).value || []);
    const anexos = [], baixados = []; let bytes = 0;
    for (const a of lista.slice(0, 200)) {
      const nome = String(a.name || 'anexo').replace(/[\u0000-\u001f]/g, '').slice(0, 200), ext = extDe(nome), tam = +a.size || 0, item = { nome, ext, tam };
      anexos.push(item);
      if (a['@odata.type'] && a['@odata.type'] !== '#microsoft.graph.fileAttachment') { item.r = 'ignorado'; item.motivo = 'anexo não é arquivo (item ou link do Outlook)'; continue; }
      if (!['xml', 'zip', 'pdf'].includes(ext)) { item.r = 'ignorado'; item.motivo = 'tipo de arquivo não aceito (só .xml, .zip com .xml e .pdf)'; continue; }
      if (baixados.length >= MAX_ANEXOS_MSG) { item.r = 'ignorado'; item.motivo = 'mensagem com anexos demais (limite ' + MAX_ANEXOS_MSG + ')'; continue; }
      if (tam > MAX_ANEXO) { item.r = 'ignorado'; item.motivo = 'anexo grande demais (limite ' + (MAX_ANEXO >> 20) + ' MB)'; continue; }
      if (bytes + tam > MAX_MSG_BYTES) { item.r = 'ignorado'; item.motivo = 'mensagem grande demais (limite ' + (MAX_MSG_BYTES >> 20) + ' MB)'; continue; }
      const x = await graph('GET', MB + '/messages/' + encodeURIComponent(m.id) + '/attachments/' + encodeURIComponent(a.id));
      if (x['@odata.type'] && x['@odata.type'] !== '#microsoft.graph.fileAttachment') { item.r = 'ignorado'; item.motivo = 'anexo não é arquivo'; continue; }
      const buf = Buffer.from(String(x.contentBytes || ''), 'base64');
      if (buf.length > MAX_ANEXO) { item.r = 'ignorado'; item.motivo = 'anexo grande demais (limite ' + (MAX_ANEXO >> 20) + ' MB)'; continue; }
      bytes += buf.length; baixados.push({ item, buf });
    }
    /* tudo baixado: agora grava de uma vez (sem esperar rede no meio da transação) */
    const id = uid(16), chaves = [], pdfCh = [], cc = Object.assign(c, { eventos: [], ref: id, avisos: [] }); let temPdf = false, xmlOk = 0;
    const umXml = (nome, buf, item) => {
      let r; try { r = ARQF.processar(nome, buf, 'email', null, cc, emp); } catch (e) { r = { r: 'ignorada', motivo: 'XML com erro de leitura' }; }
      if (r.r === 'adiado') { item.eventos = (item.eventos || 0) + 1; return; }
      ARQF.conta1(R.rel, nome, r);
      const sub = { nome, r: r.r, motivo: r.motivo, chave: r.chave };
      if (r.r === 'nova' || r.r === 'existente') { xmlOk++; if (!chaves.includes(r.chave)) chaves.push(r.chave); if (r.r === 'existente') { R.existentes++; if (ARQF.enfileirar(r.chave)) R.enfileiradas++; } else { R.novas++; if (r.tipo === 'entrada' && ARQF.temConector) R.enfileiradas++; } }
      else R.ignoradas++;
      (item.itens = item.itens || []).push(sub);
    };
    db.exec('BEGIN');
    try {
      for (const { item, buf } of baixados) {
        if (item.ext === 'xml') { umXml(item.nome, buf, item); const s = item.itens && item.itens[0]; if (s) { item.r = s.r; item.motivo = s.motivo; item.chave = s.chave; delete item.itens; } else item.r = 'evento'; }
        else if (item.ext === 'zip') {
          let z; try { z = zipMem(buf); } catch (e) { item.r = 'ignorado'; item.motivo = 'ZIP recusado: ' + (e.msg || 'inválido'); R.ignoradas++; continue; }
          let nx = 0, tot = 0; item.r = 'zip';
          for (const en of z.entradas) {
            if (/\/$/.test(en.nome)) continue;
            if (/(^|[\\/])\.\.([\\/]|$)/.test(en.nome) || /^([\\/]|[A-Za-z]:)/.test(en.nome)) { (item.itens = item.itens || []).push({ nome: en.nome.slice(0, 200), r: 'ignorada', motivo: 'nome com caminho não permitido' }); R.ignoradas++; continue; }
            const base = en.nome.split(/[\\/]/).pop();
            if (!/\.xml$/i.test(base)) { (item.itens = item.itens || []).push({ nome: base.slice(0, 200), r: 'ignorada', motivo: 'dentro do ZIP só .xml é aceito' }); R.ignoradas++; continue; }
            if (nx >= ZIP_MAX_ARQ) { (item.itens = item.itens || []).push({ nome: base.slice(0, 200), r: 'ignorada', motivo: 'ZIP com XML demais (limite ' + ZIP_MAX_ARQ + ' por anexo)' }); R.ignoradas++; continue; }
            let xb; try { xb = z.ler(en); } catch (e) { (item.itens = item.itens || []).push({ nome: base.slice(0, 200), r: 'ignorada', motivo: 'não foi possível ler do ZIP: ' + (e.msg || 'erro') }); R.ignoradas++; continue; }
            tot += xb.length; if (tot > ZIP_MAX_TOTAL) { (item.itens = item.itens || []).push({ nome: base.slice(0, 200), r: 'ignorada', motivo: 'conteúdo do ZIP grande demais' }); R.ignoradas++; break; }
            nx++; umXml(base, xb, item);
          }
        }
      }
      for (const it of cc.eventos.splice(0)) { let r; try { r = ARQF.evento(it.nome, it.buf, it.xml, it.d, 'email', null, cc, emp); } catch (e) { r = { r: 'ignorada', motivo: 'evento com erro de leitura' }; } ARQF.conta1(R.rel, it.nome, r); if (r.r === 'evento') R.eventos++; }
      for (const { item, buf } of baixados) {
        if (item.ext !== 'pdf') continue; temPdf = true;
        if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') { item.r = 'ignorado'; item.motivo = 'não é um PDF'; continue; }
        let cs = achaChaves(item.nome); if (!cs.length) cs = achaChaves(textoPdf(buf)); if (!cs.length) cs = achaChaves(assunto);
        const ch = cs.find(x => chaves.includes(x)) || cs[0];
        if (!ch) { item.r = 'pdf_sem_chave'; item.motivo = 'PDF sem chave de acesso no nome nem no texto'; R.pdfSemChave++; continue; }
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        st.pdfNovo.run(uid(16), ch, id, item.nome, buf.length, sha, buf, Date.now());
        item.r = 'danfe'; item.chave = ch; if (!pdfCh.includes(ch)) pdfCh.push(ch); R.danfes++;
      }
      const semXml = temPdf && !xmlOk ? 1 : 0; if (semXml) R.pdfSemXml++;
      st.msgNova.run(id, chaveMsg, String(m.id).slice(0, 500), String(de.address || '').toLowerCase().slice(0, 200), String(de.name || '').slice(0, 200), assunto, String(m.receivedDateTime || '').slice(0, 30), Date.now(), 'processada', 0, semXml, JSON.stringify(chaves), JSON.stringify(pdfCh), JSON.stringify(anexos), leituraId);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
    ARQF.soltar(cc.avisos.splice(0));
    const nid = await mover(m.id); st.msgMovida.run(nid, id); R.movidas++;
  }

  /* ---------- leitura ---------- */
  let LENDO = false, TIMER = null, PROXIMA = null, ULT = null, ULT_FIM = 0;
  async function ler(gatilho, conta, req) {
    if (!LIGADO) return { ok: false, st: 409, msg: 'A leitura da caixa está desligada: faltam variáveis no servidor.' };
    if (LENDO) return { ok: false, st: 409, msg: 'Já há uma leitura em andamento.' };
    LENDO = true; const ini = Date.now(), lid = uid(16);
    const R = { mensagens: 0, novas: 0, existentes: 0, ignoradas: 0, eventos: 0, danfes: 0, pdfSemChave: 0, pdfSemXml: 0, jaVistas: 0, movidas: 0, falhas: 0, enfileiradas: 0, esperas: 0, rel: ARQF.novoRel() };
    let estado = 'ok', erro = null; const e0 = EST.esperas;
    try {
      const emp = ARQF.empresa();
      if (!emp.cnpjs.size) throw { msg: 'Informe o CNPJ da empresa em Sistema › Configurações antes de ler a caixa.' };
      await pastaOk();
      const msgs = []; let url = MB + '/mailFolders/inbox/messages?$filter=' + encodeURIComponent('hasAttachments eq true') + '&$top=25&$select=' + encodeURIComponent('id,subject,from,sender,receivedDateTime,internetMessageId');
      while (url && msgs.length < MAX_MSGS) { const j = await graph('GET', url); for (const m of j.value || []) msgs.push(m); url = j['@odata.nextLink'] || null; }
      const c = { ix: ARQF.indice(), avisos: [], eventos: [], soEntradas: false };
      for (const m of msgs.slice(0, MAX_MSGS)) {
        try { await umaMsg(m, emp, c, R, lid); }
        catch (e) { R.falhas++; erro = 'Falha em uma mensagem: ' + ocultar(e.msg || e.message || e); log(erro); if (e.tipo === 'credencial' || e.st === 403) throw e; }
      }
      if (R.falhas) estado = 'parcial';
    } catch (e) { estado = 'erro'; erro = ocultar(e.msg || e.message || String(e)); log('leitura com erro: ' + erro); }
    finally {
      LENDO = false; R.esperas = EST.esperas - e0; const fim = Date.now(); ULT_FIM = fim;
      const rel = Object.assign({}, R, { rel: undefined, motivos: R.rel.motivos, segundos: Math.round((fim - ini) / 100) / 10 });
      ULT = { id: lid, ini, fim, gatilho, por: conta ? conta.id : null, estado, erro, rel };
      try { st.leitNova.run(lid, ini, fim, gatilho, conta ? conta.id : null, estado, erro, JSON.stringify(rel)); } catch (e) { }
      auditar(conta, req, 'CAIXA_NFE_LEITURA', 'caixanfe/leitura/' + lid, null, { gatilho, estado, erro: erro || undefined, mensagens: R.mensagens, novas: R.novas, existentes: R.existentes, ignoradas: R.ignoradas, eventos: R.eventos, danfes: R.danfes, pdfSemXml: R.pdfSemXml, jaVistas: R.jaVistas, movidas: R.movidas, falhas: R.falhas });
      if (R.mensagens || erro) log('leitura ' + gatilho + ': ' + R.mensagens + ' mensagem(ns), ' + R.novas + ' nota(s) nova(s), ' + R.existentes + ' já no arquivo, ' + R.ignoradas + ' ignorada(s)' + (erro ? ' · ' + erro : ''));
      agendar(INTERVALO * 60e3);
      if (R.enfileiradas) setTimeout(() => { try { ARQF.rodarFila(); } catch (e) { } }, 1000).unref();
    }
    return { ok: estado !== 'erro', leitura: ULT };
  }
  function agendar(ms) { if (!LIGADO) return; clearTimeout(TIMER); PROXIMA = Date.now() + ms; TIMER = setTimeout(() => { ler('auto', null, null).catch(e => log('leitura: ' + (e.msg || e.message))); }, ms); if (TIMER.unref) TIMER.unref(); }
  if (LIGADO) agendar(Math.max(1, E.NFE_EMAIL_PRIMEIRA_S == null || E.NFE_EMAIL_PRIMEIRA_S === '' ? 120 : +E.NFE_EMAIL_PRIMEIRA_S || 120) * 1000);
  else if (faltam.length < 3 || problemas.length) console.log('Caixa nfe@: leitor desligado (' + faltam.concat(problemas).join('; ') + ')');

  /* ---------- listas para a tela ---------- */
  const DIAS_C = () => { try { const r = db.prepare("SELECT data FROM docs WHERE path='cfg/empresa'").get(); const c = r ? JSON.parse(r.data) : {}; return Math.min(365, Math.max(1, +c.caixaCobrarDias || 30)); } catch (e) { return 30; } };
  const SEL = 'a.id,a.chave,a.tipo,a.numero,a.serie,a.emissao,a.valor,a.parc_doc,a.parc_nome,a.situacao,a.sit_fonte,a.sit_msg,a.sit_em,a.sit_fila,a.origem,a.vinc,a.vinc_conf,a.sugest,a.em,a.ass';
  const comMsg = rows => { const pm = db.prepare('SELECT m.id, m.remetente, m.remetente_nome, m.assunto, m.recebido FROM arqf_origem o JOIN caixa_msg m ON m.id=o.ref WHERE o.chave=? AND o.origem=\'email\'');
    const pp = db.prepare('SELECT id, nome, tam FROM caixa_pdf WHERE chave=? ORDER BY em LIMIT 3');
    return rows.map(r => { const x = ARQF.linha(r); const m = pm.get(r.chave); if (m) x.email = { de: m.remetente, nome: m.remetente_nome, assunto: m.assunto, recebido: m.recebido }; x.emailEm = r.email_em; const p = pp.all(r.chave); if (p.length) x.danfes = p; return x; }); };
  function listas(dias) {
    const nd = Math.min(365, Math.max(1, +dias || DIAS_C()));
    const a = comMsg(db.prepare(`SELECT ${SEL}, o.em AS email_em FROM arqf a JOIN arqf_origem o ON o.chave=a.chave AND o.origem='email'
      WHERE a.tipo='entrada' AND a.situacao='autorizada' AND NOT EXISTS(SELECT 1 FROM arqf_origem x WHERE x.chave=a.chave AND x.origem<>'email') ORDER BY o.em DESC LIMIT 200`).all());
    const b = comMsg(db.prepare(`SELECT ${SEL}, o.em AS email_em FROM arqf a JOIN arqf_origem o ON o.chave=a.chave AND o.origem='email'
      WHERE a.situacao IN ('cancelada','inexistente','denegada') ORDER BY o.em DESC LIMIT 200`).all());
    const p0 = st.primeira.get(), desde = new Date(Date.now() - nd * 864e5 - 3 * 3600e3).toISOString().slice(0, 10); /* só depois da 1ª leitura da caixa */
    const cq = `FROM arqf a WHERE a.tipo='entrada' AND a.situacao='autorizada' AND a.emissao>=? AND EXISTS(SELECT 1 FROM arqf_origem x WHERE x.chave=a.chave AND x.origem IN ('sefaz','historico','upload'))
      AND NOT EXISTS(SELECT 1 FROM arqf_origem y WHERE y.chave=a.chave AND y.origem='email')`;
    const cTot = p0 && p0.ini ? db.prepare('SELECT count(*) AS n ' + cq).get(desde).n : 0;
    const cl = p0 && p0.ini ? db.prepare(`SELECT ${SEL} ${cq} ORDER BY a.emissao DESC LIMIT 200`).all(desde).map(r => Object.assign(ARQF.linha(r), { origens: db.prepare('SELECT origem, em FROM arqf_origem WHERE chave=? ORDER BY em').all(r.chave) })) : [];
    const temArq = db.prepare('SELECT 1 FROM arqf WHERE chave=?');
    const d = db.prepare('SELECT id, remetente, remetente_nome, assunto, recebido, em, pdf_chaves, anexos FROM caixa_msg WHERE pdf_sem_xml=1 AND dispensada=0 ORDER BY em DESC LIMIT 300').all()
      .map(m => { const pc = JSON.parse(m.pdf_chaves || '[]'); const an = JSON.parse(m.anexos || '[]'); return { id: m.id, de: m.remetente, nome: m.remetente_nome, assunto: m.assunto, recebido: m.recebido, em: m.em, chaves: pc,
        pdfs: an.filter(x => x.ext === 'pdf').map(x => ({ nome: x.nome, r: x.r, chave: x.chave })), resolvida: pc.length > 0 && pc.every(ch => temArq.get(ch)) }; })
      .filter(m => !m.resolvida).slice(0, 200);
    const cont = db.prepare("SELECT count(*) AS mensagens, sum(pdf_sem_xml) AS pdfSemXml FROM caixa_msg").get();
    const viaEmail = db.prepare("SELECT count(*) AS n FROM arqf_origem WHERE origem='email'").get().n;
    return { dias: nd, desde, a, b, c: cl, cTotal: cTot, d, contadores: { mensagens: cont.mensagens || 0, notasEmail: viaEmail, a: a.length, b: b.length, c: cTot, d: d.length } };
  }
  function segredo() {
    if (!VENCE) return { vence: null };
    const dias = Math.floor((Date.parse(VENCE + 'T23:59:59-03:00') - Date.now()) / 864e5);
    return { vence: VENCE, dias, aviso: dias <= 30, vencido: dias < 0 };
  }
  function estado() {
    const u = ULT || (() => { const r = st.ultLeit.get(1); if (!r) return null; try { return Object.assign({}, r, { rel: JSON.parse(r.rel || '{}') }); } catch (e) { return null; } })();
    return { ligado: LIGADO, estado: !LIGADO ? 'desligado' : LENDO ? 'lendo' : !u ? 'aguardando' : u.estado === 'erro' ? 'erro' : u.estado === 'parcial' ? 'parcial' : 'ok',
      faltam, problemas, email: EMAIL, pasta: PASTA, intervaloMin: INTERVALO, proxima: LIGADO ? PROXIMA : null, ultima: u, conector: !!ARQF.temConector, segredo: segredo(),
      leituras: st.ultLeit.all(10).map(r => { let rel = {}; try { rel = JSON.parse(r.rel || '{}'); } catch (e) { } return { id: r.id, ini: r.ini, fim: r.fim, gatilho: r.gatilho, por: r.por, estado: r.estado, erro: r.erro, mensagens: rel.mensagens || 0, novas: rel.novas || 0, existentes: rel.existentes || 0, ignoradas: rel.ignoradas || 0, pdfSemXml: rel.pdfSemXml || 0 }; }) };
  }

  /* ---------- permissão e rotas ---------- */
  function acesso(conta) { if (!conta || !conta.ativo) return false; if (conta.nivel === 'owner') return true; return PAPEIS.includes(papelDe(perfilDe(conta))); }
  async function rota(p, m, req, res, conta, u) {
    if (!p.startsWith('/api/caixanfe')) return false;
    if (!acesso(conta)) { auditar(conta, req, 'CAIXA_NFE_NEGADO', p, null, null); json(res, 403, { code: 'not_granted', erro: 'Seu perfil não tem acesso à caixa de notas por e-mail. Quem usa: Fiscal, Financeiro, Administrador e Diretoria.' }); return true; }
    if (p === '/api/caixanfe' && m === 'GET') { json(res, 200, Object.assign(estado(), listas(u.searchParams.get('dias')))); return true; }
    if (p === '/api/caixanfe/estado' && m === 'GET') { json(res, 200, estado()); return true; }
    if (p === '/api/caixanfe/ler' && m === 'POST') {
      if (!LIGADO) { json(res, 409, { code: 'failed_precondition', erro: 'A leitura da caixa está desligada. Peça ao responsável pelo servidor para configurar ' + (faltam.length ? faltam.join(', ') : problemas.join('; ')) + ' (veja o LEIA-ME, seção Microsoft 365).' }); return true; }
      if (LENDO) { json(res, 409, { code: 'aborted', erro: 'Já há uma leitura em andamento. Aguarde.' }); return true; }
      if (MANUAL_S && ULT_FIM && Date.now() - ULT_FIM < MANUAL_S * 1000) { json(res, 429, { code: 'resource_exhausted', erro: 'A caixa foi lida há menos de ' + MANUAL_S + ' s. Aguarde um pouco.' }); return true; }
      auditar(conta, req, 'CAIXA_NFE_LER_AGORA', 'caixanfe/ler', null, null);
      ler('manual', conta, req).catch(e => log('leitura: ' + (e.msg || e.message)));
      json(res, 202, { ok: true, estado: 'lendo' }); return true;
    }
    const mp = p.match(/^\/api\/caixanfe\/pdf\/([A-Za-z0-9]{8,40})$/);
    if (mp && m === 'GET') {
      const r = db.prepare('SELECT chave, nome, pdf FROM caixa_pdf WHERE id=?').get(mp[1]); if (!r) { json(res, 404, { erro: 'PDF não encontrado.' }); return true; }
      const b = Buffer.from(r.pdf.buffer ? Buffer.from(r.pdf.buffer, r.pdf.byteOffset, r.pdf.byteLength) : r.pdf);
      auditar(conta, req, 'CAIXA_NFE_PDF', 'caixanfe/pdf/' + r.chave, null, null);
      /* arquivo vindo de fora: sempre como download, nunca aberto como página do sistema */
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': b.length, 'content-disposition': 'attachment; filename="danfe-email-' + r.chave + '.pdf"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox" });
      res.end(b); return true;
    }
    const md = p.match(/^\/api\/caixanfe\/msg\/([A-Za-z0-9]{8,40})\/dispensar$/);
    if (md && m === 'POST') {
      const ch = db.prepare('UPDATE caixa_msg SET dispensada=1, dispensada_por=? WHERE id=? AND pdf_sem_xml=1').run(conta.id, md[1]).changes;
      if (!ch) { json(res, 404, { erro: 'Mensagem não encontrada.' }); return true; }
      auditar(conta, req, 'CAIXA_NFE_DISPENSAR', 'caixanfe/msg/' + md[1], null, { motivo: 'PDF sem XML resolvido por fora' }); json(res, 200, { ok: true }); return true;
    }
    json(res, 404, { erro: 'Não encontrado.' }); return true;
  }
  return { rota, ler, estado, listas, ocultar, util: { chaveValida, achaChaves, textoPdf, zipMem } };
};
module.exports.util = { chaveValida, achaChaves, textoPdf, zipMem };

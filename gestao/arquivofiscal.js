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
const normCh = s => { const u = String(s || '').toUpperCase().trim(); return /^NFSE-/.test(u) ? u.replace(/[^0-9A-Z-]/g, '') : u.replace(/[^0-9A-Z]/g, ''); }; /* v135: NFS-e sem chave nacional usa "NFSE-<CNPJ>-<município>-<número>" */
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

/* ===== v135: leitura das NFS-e EMITIDAS pela empresa (ZIP exportado do Omie), sem bibliotecas =====
   Dois padrões: ABRASF 2.03 (prefeitura de Tuiuti até 2025: ConsultarLoteRpsResposta → CompNfse/Nfse/InfNfse) e NFS-e Padrão
   Nacional (2026: NFSe/infNFSe com chave de 50 dígitos, e o mesmo XML dentro dos .txt JSON do Omie em xmlGZipB64).
   Os arquivos do Omie podem ter atributos de namespace estragados ("xmlnxsd=") e acentos corrompidos ("jA¡"): a leitura é por
   etiqueta (tolerante) e os textos passam por reparaAcento, que só desfaz o que dá para desfazer com segurança. */
const numN = s => { const v = parseFloat(String(s == null ? '' : s).trim().replace(',', '.')); return isFinite(v) ? r2(v) : 0; };
function reparaAcento(s) {
  s = String(s == null ? '' : s);
  if (!/[AÃ][\u0080-¿]/.test(s)) return s;
  /* UTF-8 lido como Latin-1 ("Ã©"), às vezes com o "Ã" trocado por "A" ("A©"): junta de novo os 2 bytes */
  return s.replace(/[AÃ]([\u0080-¿])/g, (m, c) => { const t = Buffer.from([0xc3, c.charCodeAt(0)]).toString('utf8'); return /[�\u0080-\u009f]/.test(t) ? m : t; });
}
function textoNfse(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  const u = b.toString('utf8'); return u.includes('�') ? b.toString('latin1') : u;
}
const txN = (x, tag) => reparaAcento(val(x, tag));
function tipoNfse(x) {
  if (/<(?:\w+:)?infNFSe[\s>]/.test(x)) return 'nacional';
  if (/<(?:\w+:)?InfNfse[\s>]/.test(x)) return 'abrasf';
  if (/<(?:\w+:)?CancelarNfseResposta[\s>]/.test(x)) return 'canc_abrasf';
  if (/<(?:\w+:)?infEvento[\s>]/.test(x) && /<(?:\w+:)?chNFSe[\s>]/.test(x)) return 'canc_nacional';
  if (/<(?:\w+:)?pedRegEvento[\s>]/.test(x)) return 'pedido_evento';
  if (/<(?:\w+:)?(?:EnviarLoteRpsEnvio|EnviarLoteRpsSincronoEnvio|GerarNfseEnvio)[\s>]/.test(x)) return 'rps_abrasf';
  if (/<(?:\w+:)?infDPS[\s>]/.test(x)) return 'dps';
  if (/<(?:\w+:)?ConsultarLoteRpsResposta[\s>]/.test(x)) return 'consulta_sem_nota';
  if (/<(?:\w+:)?(?:EnviarLoteRpsResposta|EnviarLoteRpsSincronoResposta|ConsultarLoteRpsEnvio|ConsultarSituacaoLoteRps\w*|ConsultarNfse\w*|CancelarNfseEnvio)[\s>]/.test(x)) return 'apoio';
  if (/<(?:\w+:)?infNFe[\s>]/.test(x)) return 'nfe';
  return 'outro';
}
/* parte comum da declaração ABRASF (na nota autorizada e no RPS enviado) */
function abrasfDecl(decl, vn) {
  const serv = bloco(decl, 'Servico'), vs = bloco(serv, 'Valores'), tom = bloco(decl, 'Tomador') || bloco(decl, 'TomadorServico');
  const idT = bloco(tom, 'IdentificacaoTomador'), cnpjT = normDoc(val(idT, 'Cnpj')), cpfT = normDoc(val(idT, 'Cpf'));
  const issRet = val(serv, 'IssRetido') === '1', iss = numN(val(vn, 'ValorIss') || val(vs, 'ValorIss'));
  const ret = { iss: issRet ? iss : 0, inss: numN(val(vs, 'ValorInss')), irrf: numN(val(vs, 'ValorIr')), csll: numN(val(vs, 'ValorCsll')), pis: numN(val(vs, 'ValorPis')), cofins: numN(val(vs, 'ValorCofins')), outras: numN(val(vs, 'OutrasRetencoes')) };
  const bruto = numN(val(vs, 'ValorServicos')), desconto = r2(numN(val(vs, 'DescontoIncondicionado')) + numN(val(vs, 'DescontoCondicionado')));
  const totRet = r2(Object.values(ret).reduce((s, v) => s + v, 0)), idR = bloco(decl, 'IdentificacaoRps');
  return { competencia: val(decl, 'Competencia').slice(0, 10), rps: semZeros(val(idR, 'Numero')), serieRps: val(idR, 'Serie'), dataRps: val(bloco(decl, 'Rps'), 'DataEmissao').slice(0, 10),
    tomDoc: cnpjT || cpfT, tomPf: !cnpjT && !!cpfT, tomNome: txN(tom, 'RazaoSocial'),
    desc: txN(serv, 'Discriminacao'), codServico: val(serv, 'ItemListaServico'), codTribMun: val(serv, 'CodigoTributacaoMunicipio'), localPrest: val(serv, 'CodigoMunicipio'),
    bruto, deducoes: numN(val(vs, 'ValorDeducoes')), desconto, base: numN(val(vn, 'BaseCalculo')) || r2(bruto - numN(val(vs, 'ValorDeducoes')) - numN(val(vs, 'DescontoIncondicionado'))),
    aliq: numN(val(vn, 'Aliquota') || val(vs, 'Aliquota')), iss, issRetido: issRet, ret, totRet, liq: numN(val(vn, 'ValorLiquidoNfse')) || r2(bruto - totRet - desconto) };
}
/* ABRASF 2.03: uma resposta pode ter várias CompNfse */
function lerAbrasf(x) {
  const sitLote = val(x, 'Situacao'), comps = blocos(x, 'CompNfse'), out = [];
  for (const comp of (comps.length ? comps : [x])) {
    const inf = bloco(comp, 'InfNfse'); if (!inf) continue;
    const pr = bloco(inf, 'PrestadorServico'), decl = bloco(inf, 'InfDeclaracaoPrestacaoServico') || inf, prD = bloco(decl, 'Prestador'), og = bloco(inf, 'OrgaoGerador'), canc = bloco(comp, 'NfseCancelamento');
    out.push(Object.assign(abrasfDecl(decl, bloco(inf, 'ValoresNfse')), { padrao: 'abrasf', numero: val(inf, 'Numero'), codVerif: val(inf, 'CodigoVerificacao'), dhEmi: val(inf, 'DataEmissao'), emissao: val(inf, 'DataEmissao').slice(0, 10),
      prestDoc: normDoc(val(bloco(pr, 'CpfCnpj'), 'Cnpj') || val(bloco(prD, 'CpfCnpj'), 'Cnpj') || val(bloco(pr, 'CpfCnpj'), 'Cpf')), prestIm: val(pr, 'InscricaoMunicipal') || val(prD, 'InscricaoMunicipal'), prestNome: txN(pr, 'RazaoSocial'),
      cMun: val(og, 'CodigoMunicipio') || val(bloco(pr, 'Endereco'), 'CodigoMunicipio'), sitLote, cancelada: !!canc, dhCanc: val(canc, 'DataHora') }));
  }
  return out;
}
/* RPS enviado (ABRASF): usado só quando falta o XML autorizado da nota (a nota existe: o PDF dela veio no ZIP) */
function lerRpsAbrasf(x) {
  const decl = bloco(x, 'InfDeclaracaoPrestacaoServico'); if (!decl) return null; const prD = bloco(decl, 'Prestador');
  return Object.assign(abrasfDecl(decl, ''), { padrao: 'abrasf', prestDoc: normDoc(val(bloco(prD, 'CpfCnpj'), 'Cnpj') || val(bloco(x, 'CpfCnpj'), 'Cnpj')), prestIm: val(prD, 'InscricaoMunicipal') || val(x, 'InscricaoMunicipal') });
}
/* NFS-e Padrão Nacional (NFSe/infNFSe) */
function lerNacional(x) {
  const inf = bloco(x, 'infNFSe'), idm = x.match(/<(?:\w+:)?infNFSe\s[^>]*\bId\s*=\s*["']NFS(\d{50})["']/);
  const cab = inf.split(/<(?:\w+:)?DPS[\s>]/)[0], cabV = cab.replace(/<(?:\w+:)?IBSCBS[\s>][\s\S]*?<\/(?:\w+:)?IBSCBS>/, '');
  const dps = bloco(inf, 'infDPS'), dpsId = (inf.match(/<(?:\w+:)?infDPS\s[^>]*\bId\s*=\s*["']([^"']+)["']/) || [])[1] || '';
  const emit = bloco(cab, 'emit'), vN = bloco(cabV, 'valores'), ibs = bloco(cab, 'IBSCBS'), tot = bloco(ibs, 'totCIBS');
  const toma = bloco(dps, 'toma'), serv = bloco(dps, 'serv'), vD = bloco(dps, 'valores'), trib = bloco(vD, 'trib'), tMun = bloco(trib, 'tribMun'), tFed = bloco(trib, 'tribFed'), pc = bloco(tFed, 'piscofins');
  const iss = numN(val(vN, 'vISSQN')), tpRet = val(tMun, 'tpRetISSQN'), issRet = tpRet === '2' || tpRet === '3';
  const ret = { iss: issRet ? iss : 0, inss: numN(val(tFed, 'vRetCP')), irrf: numN(val(tFed, 'vRetIRRF')), csll: numN(val(tFed, 'vRetCSLL')), pis: 0, cofins: 0, outras: 0 };
  const totRetX = numN(val(vN, 'vTotalRet')), conhec = r2(ret.iss + ret.inss + ret.irrf + ret.csll), resto = r2(totRetX - conhec);
  /* PIS/COFINS retidos: o total de retenções da nota (vTotalRet) manda; o que sobra é PIS+COFINS quando bate com o grupo piscofins */
  if (resto > 0.004) { const vp = numN(val(pc, 'vPis')), vc = numN(val(pc, 'vCofins')); if (Math.abs(vp + vc - resto) <= 0.05) { ret.pis = vp; ret.cofins = vc; } else ret.outras = resto; }
  const totRet = totRetX || conhec, bruto = numN(val(bloco(vD, 'vServPrest'), 'vServ')), dci = bloco(vD, 'vDescCondIncond'), desconto = r2(numN(val(dci, 'vDescIncond')) + numN(val(dci, 'vDescCond')));
  const tomCnpj = normDoc(val(toma, 'CNPJ')), tomCpf = normDoc(val(toma, 'CPF')), ibsD = bloco(dps, 'IBSCBS');
  return { padrao: 'nacional', chave: idm ? idm[1] : '', numero: semZeros(val(cab, 'nNFSe')), nDFSe: val(cab, 'nDFSe'), cStat: val(cab, 'cStat'), dhProc: val(cab, 'dhProc'),
    dhEmi: val(dps, 'dhEmi'), emissao: (val(dps, 'dhEmi') || val(cab, 'dhProc')).slice(0, 10), competencia: val(dps, 'dCompet'), rps: semZeros(val(dps, 'nDPS')), serieRps: val(dps, 'serie'), dpsId,
    prestDoc: normDoc(val(emit, 'CNPJ') || val(emit, 'CPF')), prestIm: val(emit, 'IM'), prestNome: txN(emit, 'xNome'), cMun: val(bloco(emit, 'enderNac'), 'cMun') || val(dps, 'cLocEmi'),
    tomDoc: tomCnpj || tomCpf, tomPf: !tomCnpj && !!tomCpf, tomNome: txN(toma, 'xNome'),
    desc: txN(serv, 'xDescServ'), codServico: val(serv, 'cTribNac'), nbs: val(serv, 'cNBS'), localPrest: val(bloco(serv, 'locPrest'), 'cLocPrestacao'),
    bruto, deducoes: numN(val(bloco(vD, 'vDedRed'), 'vDR')), desconto, base: numN(val(vN, 'vBC')), aliq: numN(val(vN, 'pAliqAplic') || val(tMun, 'pAliq')), iss, issRetido: issRet, ret, totRet,
    liq: numN(val(vN, 'vLiq')) || r2(bruto - totRet - desconto),
    ibs: numN(val(tot, 'vIBSTot')), ibsUf: numN(val(tot, 'vIBSUF')), ibsMun: numN(val(tot, 'vIBSMun')), cbs: numN(val(tot, 'vCBS')), vTotNF: numN(val(tot, 'vTotNF')),
    cClassTrib: val(ibsD, 'cClassTrib'), cstIbs: val(bloco(ibsD, 'gIBSCBS'), 'CST') };
}
/* evento do Padrão Nacional (101101 cancelamento; 105102 cancelamento por substituição) */
function lerEventoNacional(x) {
  const ev = bloco(x, 'infEvento'), ped = bloco(x, 'infPedReg') || x, tp = (ped.match(/<(?:\w+:)?e(\d{6})[\s>]/) || [])[1] || '';
  return { chave: normDoc(val(ped, 'chNFSe')), tp, dh: val(ev, 'dhProc') || val(ped, 'dhEvento'), registrado: !!ev && !!val(ev, 'dhProc'), seq: val(ev, 'nSeqEvento') || '1', motivo: txN(ped, 'xMotivo') || txN(ped, 'xDesc'), autor: normDoc(val(ped, 'CNPJAutor')) };
}
/* resposta de cancelamento ABRASF: vale só com a Confirmacao (data e hora) da prefeitura */
function lerCancAbrasf(x) {
  const conf = bloco(x, 'Confirmacao') || bloco(x, 'NfseCancelamento'), idn = bloco(conf, 'IdentificacaoNfse');
  return { numero: semZeros(val(idn, 'Numero')) ? val(idn, 'Numero') : '', cnpj: normDoc(val(bloco(idn, 'CpfCnpj'), 'Cnpj')), im: val(idn, 'InscricaoMunicipal'), cMun: val(idn, 'CodigoMunicipio'), dh: val(conf, 'DataHora'), codigo: val(conf, 'CodigoCancelamento'),
    ok: !!conf && !!val(conf, 'DataHora') && !!val(idn, 'Numero'), erro: txN(x, 'Mensagem') };
}
/* textos de um PDF simples (fluxos FlateDecode com "(...) Tj"): só para achar o código de verificação no demonstrativo */
function pdfTextos(buf) {
  const s = buf.toString('latin1'), out = []; let i = 0, n = 0;
  while ((i = s.indexOf('stream', i)) >= 0 && n < 40) {
    let a = i + 6; if (s[a] === '\r') a++; if (s[a] === '\n') a++; const f = s.indexOf('endstream', a); if (f < 0) break; n++;
    try { const t = zlib.inflateSync(buf.subarray(a, f), { maxOutputLength: 2 * 1048576 }).toString('latin1'); const re = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g; let m; while ((m = re.exec(t)) && out.length < 5000) out.push(m[1].replace(/\\(.)/g, '$1').trim()); } catch (e) { }
    i = f + 9;
  }
  return out;
}
function pdfCodVerif(buf) {
  const t = pdfTextos(buf), i = t.findIndex(x => /^C.{0,3}digo de Verifica/i.test(x)); if (i < 0) return '';
  return t.slice(i + 1, i + 9).find(x => /^[0-9a-fA-F]{6,12}$/.test(x)) || '';
}
/* casamento NFS-e × contas a receber (função pura, também usada pelo teste do cliente).
   Regra: mesmo CNPJ do tomador; valor do título igual ao bruto OU ao líquido da nota (ou valor + retido = bruto), com tolerância
   (padrão R$ 0,05); vencimento ou competência até ±N dias da emissão (padrão 60). Exatamente 1 candidato, que não sirva também
   para outra nota → liga sozinho. 0 ou mais de 1 → "Conferir" com as sugestões (a mais próxima primeiro). Nota cancelada nunca liga.
   Título lançado pelo próprio sistema para esta NFS-e (nfseId) liga direto. Parcelas do mesmo documento que somam a nota viram sugestão. */
function diasN(a, b) { return Math.abs((Date.parse(String(a).slice(0, 10) + 'T12:00:00Z') - Date.parse(String(b).slice(0, 10) + 'T12:00:00Z')) / 864e5); }
function distData(l, em) {
  const ds = []; if (/^\d{4}-\d{2}-\d{2}/.test(l.venc || '')) ds.push(diasN(l.venc, em));
  const c = String(l.comp || '').slice(0, 7); if (/^\d{4}-\d{2}$/.test(c)) { const ini = c + '-01', d = new Date(Date.parse(ini + 'T12:00:00Z')); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); const fim = d.toISOString().slice(0, 10); ds.push(em >= ini && em <= fim ? 0 : Math.min(diasN(ini, em), diasN(fim, em))); }
  return ds.length ? Math.min(...ds) : Infinity;
}
function casarNfse(notas, lancs, parcDoc, par) {
  par = par || {}; const tol = par.tol == null ? 0.05 : +par.tol, dias = par.dias == null ? 60 : +par.dias, out = {};
  const docDe = l => l.parcId ? parcDoc.get(l.parcId) : '';
  const baseDesc = l => String(l.desc || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim().toLowerCase();
  const vivos = lancs.filter(l => l.tipo === 'receber' && l.status !== 'cancelado' && !l.transf && !l.guia);
  const quer = new Map();
  for (const n of notas) {
    const livre = l => (!l.arqf || !l.arqf.ch || normCh(l.arqf.ch) === n.chave) && (!l.nfseId || l.nfseId === n.docId);
    if (n.situacao === 'cancelada') { out[n.id] = { conf: 'cancelada', motivo: 'nota cancelada: não liga a título' }; continue; }
    const diretos = n.docId ? vivos.filter(l => l.nfseId === n.docId && (!l.arqf || !l.arqf.ch || normCh(l.arqf.ch) === n.chave)) : [];
    if (diretos.length) { out[n.id] = { conf: 'alta', lancs: diretos.map(l => l.id), motivo: 'título lançado pelo sistema para esta NFS-e' }; continue; }
    const doCli = vivos.filter(l => livre(l) && n.parcDoc && docDe(l) === n.parcDoc);
    const vOk = l => { const v = +l.valor || 0, b = v + (+l.retido || 0); return Math.abs(v - n.bruto) <= tol + 1e-9 ? 'bruto' : Math.abs(v - n.liq) <= tol + 1e-9 ? 'líquido' : (+l.retido && Math.abs(b - n.bruto) <= tol + 1e-9) ? 'líquido + retenções' : ''; };
    const cands = doCli.map(l => ({ l, como: vOk(l), dist: distData(l, n.emissao) })).filter(c => c.como && c.dist <= dias).sort((a, b) => a.dist - b.dist || String(a.l.venc || '').localeCompare(String(b.l.venc || '')));
    const sug = cands.slice(0, 5).map((c, i) => ({ lancs: [c.l.id], motivo: 'mesmo cliente, valor igual ao ' + c.como + ', ' + (c.dist === 0 ? 'mesma data/competência' : Math.round(c.dist) + ' dia(s) da emissão') + (i === 0 && cands.length > 1 ? ' (a mais próxima)' : ''), dist: c.dist }));
    /* parcelas do mesmo documento que, somadas, dão o valor da nota */
    const grupos = new Map(); for (const l of doCli) { const k = baseDesc(l); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(l); }
    for (const [, ls] of grupos) { if (ls.length < 2) continue; const sv = r2(ls.reduce((s, l) => s + (+l.valor || 0), 0)), sb = r2(ls.reduce((s, l) => s + (+l.valor || 0) + (+l.retido || 0), 0));
      if ((Math.abs(sv - n.bruto) <= tol || Math.abs(sv - n.liq) <= tol || Math.abs(sb - n.bruto) <= tol) && Math.min(...ls.map(l => distData(l, n.emissao))) <= dias) sug.push({ lancs: ls.map(l => l.id), motivo: ls.length + ' parcelas do mesmo documento somam o valor da nota: confira', parcelas: true }); }
    out[n.id] = { conf: cands.length === 1 ? 'unico' : cands.length ? 'ambigua' : sug.length ? 'sugestao' : 'sem', cand: cands.map(c => c.l.id), sug,
      motivo: cands.length > 1 ? cands.length + ' títulos do cliente servem: escolha' : cands.length ? '' : !n.parcDoc ? 'nota sem CNPJ/CPF do tomador' : !doCli.length ? 'nenhum título em aberto deste cliente (CNPJ ' + n.parcDoc + ')' : 'há títulos do cliente, mas nenhum com o valor bruto ou líquido e a data perto da emissão' };
    for (const id of out[n.id].cand) { if (!quer.has(id)) quer.set(id, []); quer.get(id).push(n.id); }
  }
  for (const n of notas) { const r = out[n.id]; if (!r || r.conf !== 'unico') continue; const id = r.cand[0], q = quer.get(id) || [];
    if (q.length === 1) { r.conf = 'alta'; r.lancs = [id]; r.motivo = 'mesmo cliente, valor e data: único título que serve'; } else { r.conf = 'ambigua'; r.motivo = 'o mesmo título também serve para outra nota (' + (q.length - 1) + '): escolha'; } }
  return out;
}
const mascaraCpf = d => { d = String(d || '').replace(/\D/g, ''); return d.length === 11 ? '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-**' : d; };
/* ===== fim v135 (leitura) ===== */

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
  /* v135: NFS-e no mesmo arquivo (modelo 'nfse', tipo 'saida'); os dados próprios da NFS-e (código de verificação, retenções,
     IBS/CBS, tomador, "ignorada" na conferência…) ficam em JSON na coluna nfse. A coluna é criada uma vez, sem mexer nas linhas antigas. */
  try { if (!db.prepare('PRAGMA table_info(arqf)').all().some(c => c.name === 'nfse')) db.exec('ALTER TABLE arqf ADD COLUMN nfse TEXT'); db.exec('CREATE INDEX IF NOT EXISTS arqf_modelo ON arqf(modelo)'); } catch (e) { console.error('[arquivo fiscal] v135 coluna nfse', e.message); }
  const stOrig = db.prepare('INSERT OR IGNORE INTO arqf_origem(chave, origem, em, ref) VALUES(?,?,?,?)');
  const regOrigem = (ch, origem, ref) => { try { if (ch && origem) stOrig.run(ch, origem, Date.now(), ref || null); } catch (e) { } };
  const st = {
    porChave: db.prepare('SELECT id, chave, situacao, vinc, tipo FROM arqf WHERE chave=?'),
    porId: db.prepare('SELECT id, chave, tipo, numero, serie, emissao, valor, situacao, sit_fonte, sit_em, sit_msg, parc_doc, parc_nome, emit_doc, emit_nome, dest_doc, dest_nome, origem, vinc, vinc_conf, sugest, parcelas, em, por, arquivo, ass, prot, fin, tpnf, modelo, nfse FROM arqf WHERE id=?'), /* v135: + modelo, nfse */
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
  /* ===== v134: PDF original do fornecedor (o DANFE que o emitente mandou), 1 por nota, pela chave =====
     Origens: 'email' (caixa nfe@, copiado da tabela caixa_pdf do caixanfe.js), 'manual' (anexado na nota/título) e 'lote'
     (ZIP de PDFs cujo nome tem a chave). O PDF não vale como nota: a nota é o XML; o PDF fica ligado a ela. */
  const PDF_MAX = Math.round(Math.min(5, Math.max(0.1, +E.ARQF_PDF_MAX_MB || 3)) * 1048576);
  const PDF_ZIP_MAX = Math.max(1, +E.ARQF_PDF_ZIP_MB || 200) * 1048576;
  db.exec(`CREATE TABLE IF NOT EXISTS arqf_pdf(chave TEXT PRIMARY KEY, origem TEXT NOT NULL, nome TEXT, tam INTEGER, sha TEXT, pdf BLOB NOT NULL, em INTEGER, por TEXT, ref TEXT);
    CREATE TABLE IF NOT EXISTS arqf_pdf_rem(chave TEXT PRIMARY KEY, em INTEGER, por TEXT);`);
  const stPdf = {
    info: db.prepare('SELECT chave, origem, nome, tam, sha, em, por FROM arqf_pdf WHERE chave=?'),
    get: db.prepare('SELECT chave, origem, nome, tam, pdf FROM arqf_pdf WHERE chave=?'),
    novo: db.prepare('INSERT OR IGNORE INTO arqf_pdf(chave, origem, nome, tam, sha, pdf, em, por, ref) VALUES(?,?,?,?,?,?,?,?,?)'),
    troca: db.prepare('UPDATE arqf_pdf SET origem=?, nome=?, tam=?, sha=?, pdf=?, em=?, por=?, ref=NULL WHERE chave=?'),
    del: db.prepare('DELETE FROM arqf_pdf WHERE chave=?'),
    remNovo: db.prepare('INSERT OR REPLACE INTO arqf_pdf_rem(chave, em, por) VALUES(?,?,?)'),
    remDel: db.prepare('DELETE FROM arqf_pdf_rem WHERE chave=?')
  };
  let temCaixaPdf = false;
  const caixaPdfExiste = () => { if (!temCaixaPdf) { try { temCaixaPdf = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='caixa_pdf'").get(); } catch (e) { } } return temCaixaPdf; };
  /* une o "DANFE do e-mail" (caixa_pdf) ao arquivo: copia o 1º PDF de cada chave que está no arquivo e ainda não tem PDF */
  function pdfDoEmail(chaves) {
    if (!caixaPdfExiste()) return 0;
    const base = `INSERT OR IGNORE INTO arqf_pdf(chave, origem, nome, tam, sha, pdf, em, por, ref)
      SELECT c.chave, 'email', c.nome, c.tam, c.sha, c.pdf, c.em, NULL, c.msg_id FROM caixa_pdf c
      WHERE c.chave IN (SELECT chave FROM arqf) AND c.chave NOT IN (SELECT chave FROM arqf_pdf) AND c.chave NOT IN (SELECT chave FROM arqf_pdf_rem)`;
    try {
      if (!chaves) return db.prepare(base + ' ORDER BY c.em').run().changes;
      const cs = [...new Set(chaves.map(normCh))].filter(x => x.length === 44).slice(0, 500); if (!cs.length) return 0;
      return db.prepare(base + ' AND c.chave IN (' + cs.map(() => '?').join(',') + ') ORDER BY c.em').run(...cs).changes;
    } catch (e) { return 0; }
  }
  setTimeout(() => { try { const n = pdfDoEmail(null); if (n) console.log('Arquivo fiscal: ' + n + ' PDF(s) do e-mail ligados às notas.'); } catch (e) { } }, 0).unref();
  const pdfInfo = ch => { let r = stPdf.info.get(ch); if (!r && pdfDoEmail([ch])) r = stPdf.info.get(ch); return r ? { origem: r.origem, nome: r.nome, tam: r.tam, em: r.em, por: r.por || undefined } : null; };
  /* chave de acesso válida: 44 dígitos, UF, modelo 55 e dígito verificador (módulo 11) */
  function chaveOk(ch) {
    if (!/^\d{44}$/.test(ch) || ch.slice(20, 22) !== '55' || !/^(1[1-7]|2[1-9]|3[1-35]|4[1-3]|5[0-3])$/.test(ch.slice(0, 2))) return false;
    let s = 0, p = 2; for (let i = 42; i >= 0; i--) { s += (+ch[i]) * p; p = p === 9 ? 2 : p + 1; }
    const d = s % 11; return (d < 2 ? 0 : 11 - d) === +ch[43];
  }
  /* chave a partir do nome do arquivo (ex.: 2124…0005.pdf, NFe3526…-danfe.pdf) */
  function chaveDoNome(nome) {
    const base = String(nome || '').split('/').pop(), runs = base.match(/\d{44,}/g) || [], achou = new Set();
    for (const r of runs) for (let i = 0; i + 44 <= r.length; i++) { const c = r.slice(i, i + 44); if (chaveOk(c)) achou.add(c); }
    if (achou.size === 1) return { ch: [...achou][0] };
    if (achou.size > 1) return { motivo: 'o nome tem mais de uma chave de acesso' };
    return { motivo: runs.length ? 'chave de acesso inválida no nome (dígito verificador não confere)' : 'o nome do arquivo não tem a chave de acesso de 44 dígitos' };
  }
  const ehPdf = b => !!b && b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-';
  const mb = n => (Math.round(n / 104857.6) / 10).toString().replace('.', ',') + ' MB';
  /* guarda o PDF de uma nota. Já tem PDF: 'existente' (nada muda), a não ser que substituir=true (anexo manual de quem tem acesso total) */
  function pdfGuardar(row, buf, nome, origem, conta, substituir) {
    if (!ehPdf(buf)) return { r: 'ignorado', motivo: 'não é um PDF (o arquivo não começa com %PDF)' };
    if (buf.length > PDF_MAX) return { r: 'ignorado', motivo: 'PDF maior que ' + mb(PDF_MAX) };
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    pdfDoEmail([row.chave]);
    const ja = stPdf.info.get(row.chave);
    if (ja) {
      if (ja.sha === sha) return { r: 'existente', motivo: 'o mesmo PDF já está ligado a esta nota' };
      if (!substituir) return { r: 'existente', motivo: 'a nota já tem um PDF do fornecedor (' + (ja.origem === 'email' ? 'veio por e-mail' : ja.origem === 'lote' ? 'importado em lote' : 'anexado') + ')' };
      stPdf.troca.run(origem, String(nome || '').slice(0, 200), buf.length, sha, buf, Date.now(), conta ? conta.id : null, row.chave);
      return { r: 'trocado', antes: { origem: ja.origem, nome: ja.nome, sha: ja.sha } };
    }
    stPdf.novo.run(row.chave, origem, String(nome || '').slice(0, 200), buf.length, sha, buf, Date.now(), conta ? conta.id : null, null);
    stPdf.remDel.run(row.chave);
    return { r: 'novo' };
  }
  /* ZIP de PDFs: cada PDF é ligado à nota pela chave que está no nome do arquivo */
  async function pdfLote(arq, conta, total) {
    const rel = { total: 0, novos: 0, existentes: 0, ignorados: 0, motivos: {}, lista: [], ligados: [] };
    const conta1p = (nome, r, ch) => {
      if (r.r === 'novo') { rel.novos++; if (rel.ligados.length < 2000) rel.ligados.push({ arquivo: String(nome).slice(0, 200), chave: ch }); return; }
      const k = r.r === 'existente' ? 'existentes' : 'ignorados'; rel[k]++;
      if (k === 'ignorados') { const mo = r.motivo.replace(/\s*\(.*$/, ''); rel.motivos[mo] = (rel.motivos[mo] || 0) + 1; }
      if (rel.lista.length < 2000) rel.lista.push({ arquivo: String(nome).slice(0, 200), r: r.r === 'existente' ? 'existente' : 'ignorado', motivo: r.motivo, chave: ch || undefined });
    };
    const z = zipAbrir(arq); let lidos = 0;
    try {
      const ents = z.entradas.filter(e => !/\/$/.test(e.nome) && !/(^|\/)(__MACOSX|\.)/.test(e.nome)); rel.total = ents.length;
      for (let i = 0; i < ents.length; i += 50) {
        db.exec('BEGIN');
        try {
          for (const en of ents.slice(i, i + 50)) {
            const nome = en.nome.split('/').pop();
            if (!/\.pdf$/i.test(nome)) { conta1p(en.nome, { r: 'ignorado', motivo: 'não é arquivo .pdf' }); continue; }
            if (en.cript) { conta1p(en.nome, { r: 'ignorado', motivo: 'arquivo protegido por senha dentro do ZIP' }); continue; }
            if (en.orig > PDF_MAX) { conta1p(en.nome, { r: 'ignorado', motivo: 'PDF maior que ' + mb(PDF_MAX) }); continue; }
            const c = chaveDoNome(nome); if (!c.ch) { conta1p(en.nome, { r: 'ignorado', motivo: c.motivo }); continue; }
            const row = st.porChave.get(c.ch);
            if (!row) { conta1p(en.nome, { r: 'ignorado', motivo: 'nota não encontrada no arquivo fiscal — importe o XML antes' }, c.ch); continue; }
            if (!total && row.tipo !== 'entrada') { conta1p(en.nome, { r: 'ignorado', motivo: 'seu perfil envia só PDFs de notas de entrada' }, c.ch); continue; }
            let buf; try { buf = z.ler(en); } catch (e) { conta1p(en.nome, { r: 'ignorado', motivo: 'não foi possível ler do ZIP: ' + (e.msg || e.message || 'erro') }, c.ch); continue; }
            lidos += buf.length; if (lidos > PDF_ZIP_MAX * 3) throw { st: 413, msg: 'conteúdo do ZIP grande demais' };
            conta1p(en.nome, pdfGuardar(row, buf, nome, 'lote', conta, false), c.ch);
          }
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
        await new Promise(r => setImmediate(r));
      }
    } finally { z.fechar(); }
    return rel;
  }
  /* ===== fim v134 (tabela e funções) ===== */
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
    if (d.tipo !== 'nfe' && ['nacional', 'abrasf'].includes(tipoNfse(xml))) return { r: 'ignorada', motivo: 'é NFS-e (nota de serviço): use o botão "Importar NFS-e emitidas (ZIP do Omie)"' }; /* v135 */
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
    /* v135: NFS-e — "conferir" (sem título, autorizada, não ignorada) e "ignoradas" na conferência; filtro por modelo */
    else if (v === 'conferir') w.push("vinc IS NULL AND situacao='autorizada' AND json_extract(nfse,'$.ign') IS NULL");
    else if (v === 'ignorada') w.push("json_extract(nfse,'$.ign') IS NOT NULL");
    const mod = g('modelo'); if (mod === 'nfse') w.push("modelo='nfse'"); else if (mod === 'nfe') w.push("coalesce(modelo,'55')<>'nfse'");
    const org = g('origem'); if (['historico', 'upload', 'sefaz'].includes(org)) { w.push('origem=?'); a.push(org); }
    else if (org === 'email') w.push("chave IN (SELECT chave FROM arqf_origem WHERE origem='email')"); /* v130: recebida (também) por e-mail */
    const vmin = parseFloat(g('vmin').replace(',', '.')), vmax = parseFloat(g('vmax').replace(',', '.'));
    if (isFinite(vmin)) { w.push('valor>=?'); a.push(vmin); } if (isFinite(vmax)) { w.push('valor<=?'); a.push(vmax); }
    const qq = g('q'); if (qq) {
      const d = normDoc(qq), n = semZeros(qq), lk = '%' + qq.replace(/[\\%_]/g, '\\$&').toLowerCase() + '%';
      const ors = ["lower(parc_nome) LIKE ? ESCAPE '\\'", "lower(emit_nome) LIKE ? ESCAPE '\\'", "lower(dest_nome) LIKE ? ESCAPE '\\'"]; a.push(lk, lk, lk);
      if (d.length >= 4) { ors.push('chave LIKE ?', 'parc_doc LIKE ?', 'emit_doc LIKE ?', 'dest_doc LIKE ?'); a.push('%' + d + '%', d + '%', d + '%', d + '%'); }
      if (n && /^\d{1,15}$/.test(n)) { ors.push("ltrim(numero,'0')=?"); a.push(n); } /* v135: até 15 dígitos (NFS-e ABRASF) */
      w.push('(' + ors.join(' OR ') + ')');
    }
    return { wh: w.length ? ' WHERE ' + w.join(' AND ') : '', a };
  }
  let linha = r => ({ id: r.id, chave: r.chave, tipo: r.tipo, numero: r.numero, serie: r.serie, emissao: r.emissao, valor: r.valor, parcDoc: r.parc_doc, parcNome: r.parc_nome,
    situacao: r.situacao, sitFonte: r.sit_fonte, sitMsg: r.sit_msg || undefined, sitEm: r.sit_em, origem: r.origem, vinc: r.vinc ? JSON.parse(r.vinc) : [], vincConf: r.vinc_conf || undefined,
    sug: r.sugest ? JSON.parse(r.sugest) : undefined, guardaAte: guardaAte(r.emissao), em: r.em, ass: r.ass, fila: r.sit_fila ? 1 : undefined,
    modelo: r.modelo || undefined, nfse: r.modelo === 'nfse' ? nfseResumo(r.nfse) : undefined }); /* v135 */
  { const l0 = linha; linha = r => { const o = l0(r); if (r.modelo === 'nfsef') { o.parcDoc = mascaraCpf(r.parc_doc); try { const j = JSON.parse(r.nfse || '{}'); o.nfsef = { bruto: j.bruto, liq: j.liq, ret: j.ret, lig: j.lig ? { tipo: j.lig.tipo, numero: j.lig.numero, div: (j.lig.div || []).length, aceita: !!j.lig.aceita } : null, semXml: !!j.semXml }; } catch (e) { } } return o; }; } /* v141: NFS-e de fornecedor (CPF mascarado) */
  function listar(u, acc) {
    const f = filtros(u, acc), pg = Math.max(0, +u.searchParams.get('pg') || 0), n = Math.min(PAG_MAX, Math.max(10, +u.searchParams.get('n') || 50));
    const ord = u.searchParams.get('ord') === 'valor' ? 'valor DESC' : u.searchParams.get('ord') === 'antigas' ? 'emissao ASC, numero ASC' : 'emissao DESC, numero DESC';
    const total = db.prepare('SELECT count(*) AS n, coalesce(sum(valor),0) AS v FROM arqf' + f.wh).get(...f.a);
    const ls = db.prepare('SELECT id,chave,tipo,numero,serie,emissao,valor,parc_doc,parc_nome,situacao,sit_fonte,sit_msg,sit_em,sit_fila,origem,vinc,vinc_conf,sugest,em,ass,modelo,nfse FROM arqf' + f.wh + ' ORDER BY ' + ord + ' LIMIT ? OFFSET ?').all(...f.a, n, pg * n);
    const tp = acc === 'entradas' ? " WHERE tipo='entrada'" : '';
    const res = db.prepare("SELECT count(*) AS total, sum(tipo='entrada') AS entradas, sum(tipo='saida') AS saidas, sum(vinc IS NOT NULL) AS ligadas, sum(vinc IS NULL) AS pendentes, sum(vinc IS NULL AND sugest IS NOT NULL) AS sugestoes, sum(situacao='cancelada') AS canceladas, sum(situacao='cancelada' AND vinc IS NOT NULL) AS cancLigadas, sum(modelo='nfse') AS nfse, sum(modelo='nfse' AND vinc IS NULL AND situacao='autorizada' AND json_extract(nfse,'$.ign') IS NULL) AS nfseConferir, sum(modelo='nfse' AND vinc IS NOT NULL) AS nfseLigadas, sum(modelo='nfse' AND situacao='cancelada' AND vinc IS NOT NULL) AS nfseCancLig, min(emissao) AS primeira, max(emissao) AS ultima FROM arqf" + tp).get();
    for (const k of Object.keys(res)) if (res[k] == null && k !== 'primeira' && k !== 'ultima') res[k] = 0;
    const itens = ls.map(linha);
    /* v130: todas as origens de cada nota da página (uma consulta só) */
    if (itens.length) { const og = new Map(); for (const o of db.prepare('SELECT chave, origem, em FROM arqf_origem WHERE chave IN (' + itens.map(() => '?').join(',') + ') ORDER BY em').all(...itens.map(x => x.chave))) { if (!og.has(o.chave)) og.set(o.chave, []); og.get(o.chave).push({ origem: o.origem, em: o.em }); } for (const x of itens) x.origens = og.get(x.chave) || [{ origem: x.origem, em: x.em }]; }
    /* v134: marca as notas da página que têm o PDF original do fornecedor (une antes o que veio por e-mail) */
    if (itens.length) { pdfDoEmail(itens.map(x => x.chave)); const tp = new Map(db.prepare('SELECT chave, origem FROM arqf_pdf WHERE chave IN (' + itens.map(() => '?').join(',') + ')').all(...itens.map(x => x.chave)).map(r => [r.chave, r.origem])); for (const x of itens) if (tp.has(x.chave)) x.pdf = tp.get(x.chave); }
    return { itens, total: total.n, soma: r2(total.v), pg, n, resumo: res, acesso: acc, hoje: hojeBr() };
  }

  /* ===== v135: NFS-e emitidas pela empresa (ZIP do Omie) → arquivo fiscal + coleção 'nfse' do app + ligação com Contas a receber =====
     - cada NFS-e vira uma linha do arquivo (modelo 'nfse', tipo 'saida') com o XML ORIGINAL em gzip; a chave é a chave nacional de
       50 dígitos ou, no padrão ABRASF, "NFSE-<CNPJ>-<município>-<número>"; o PDF (DANFSe ou demonstrativo) vai para arqf_pdf;
     - o cancelamento (resposta da prefeitura ou evento 101101/105102 do Padrão Nacional) fica em arqf_evento e marca a nota;
     - a nota aparece em Fiscal › NFS-e (coleção 'nfse', origem 'omie'); se a mesma nota já foi registrada pelo próprio sistema
       (mesmo número e ano, mesmo código de verificação/chave), só liga aquele registro ao arquivo — não duplica;
     - reimportar não duplica nada e completa o que faltava (PDF, XML autorizado de nota guardada "sem XML", registro no app);
     - não cria títulos; liga sozinho só quando há exatamente 1 título que serve (veja casarNfse). */
  const NFSE_ZIP_MAX = Math.max(1, +E.ARQF_NFSE_ZIP_MB || 100) * 1048576;
  let nfseRodando = false;
  const shaB = b => crypto.createHash('sha256').update(b).digest('hex');
  function parNfse() { const c = docGet('cfg/empresa') || {}; return { tol: Math.min(50, Math.max(0, c.nfseTol == null || c.nfseTol === '' ? 0.05 : +c.nfseTol || 0)), dias: Math.min(365, Math.max(1, +c.nfseDias || 60)) }; }
  function nfseResumo(js) {
    let d; try { d = JSON.parse(js || '{}'); } catch (e) { d = {}; }
    return { padrao: d.padrao, cv: d.codVerif || undefined, rps: d.rps || undefined, tomDoc: d.tomPf ? mascaraCpf(d.tomDoc) : d.tomDoc, tomPf: d.tomPf || undefined, tomNome: d.tomNome, parcId: d.parcId || undefined,
      bruto: d.bruto, liq: d.liq, totRet: d.totRet, ret: d.ret, iss: d.iss, issRetido: d.issRetido || undefined, ibs: d.ibs || undefined, cbs: d.cbs || undefined, semXml: d.semXml || undefined,
      ign: d.ign || undefined, canc: d.canc || undefined, docId: d.docId || undefined, competencia: d.competencia, lig: d.lig || undefined, desc: String(d.desc || '').slice(0, 160) };
  }
  function nfseDetalhe(js) { let d; try { d = JSON.parse(js || '{}'); } catch (e) { d = {}; } if (d.tomPf) d.tomDoc = mascaraCpf(d.tomDoc); return d; }
  const gravaNj = (id, nj) => db.prepare('UPDATE arqf SET nfse=? WHERE id=?').run(JSON.stringify(nj), id);
  /* registros da coleção 'nfse' do app */
  function nfseDocsIdx() { const docs = col('nfse'); return { docs, porArqf: new Map(docs.filter(d => d.arqf && d.arqf.id).map(d => [d.arqf.id, d])), porCh: new Map(docs.filter(d => d.chave).map(d => [normCh(d.chave), d])) }; }
  const anoDe = s => String(s || '').slice(0, 4);
  function mesmaNota(d, n) {
    if (!d || d.status === 'rascunho' || !d.numOficial || anoDe(d.emissaoReal || d.emissao) !== anoDe(n.emissao)) return false;
    const a = semZeros(d.numOficial); let igual = a === semZeros(n.numero);
    if (!igual && n.padrao === 'abrasf' && /^\d{15}$/.test(String(n.numero)) && anoDe(n.numero) === anoDe(n.emissao)) igual = a === semZeros(String(n.numero).slice(4));
    if (!igual) return false;
    if (d.codVerif && n.codVerif && String(d.codVerif).trim().toLowerCase() !== String(n.codVerif).trim().toLowerCase()) return false;
    if (d.chave && normCh(d.chave) !== n.chave) return false;
    return true;
  }
  function docPutAv(p, d, avisos) { const ts = Date.now(), s = p.split('/'); q.docPut.run(p, s[0], s[1], JSON.stringify(d), ts); avisos.push(['set', p, d, ts]); }
  /* cria/atualiza o registro do app; devolve { doc, mudou } */
  function nfseDocGravar(row, nj, ix, avisos, conta) {
    let d = (nj.docId && ix.docs.find(x => x.id === nj.docId)) || ix.porArqf.get(row.id) || ix.porCh.get(row.chave) || ix.docs.find(x => !(x.arqf && x.arqf.id) && mesmaNota(x, Object.assign({ chave: row.chave }, nj)));
    const canc = row.situacao === 'cancelada', ref = { id: row.id, ch: row.chave, pdf: !!stPdf.info.get(row.chave), semXml: !!nj.semXml || undefined };
    let novo;
    if (d && d.origem !== 'omie') { /* emitida pelo próprio sistema: liga ao arquivo; se a prefeitura cancelou, sinaliza (o cancelamento do app segue o fluxo dele) */
      novo = Object.assign({}, d, { arqf: ref, chave: row.chave, codVerif: d.codVerif || nj.codVerif || '' });
      if (canc && d.status === 'emitida') novo.cancPref = { dh: (nj.canc && nj.canc.dh) || '', em: (d.cancPref && d.cancPref.em) || Date.now() }; else delete novo.cancPref;
    } else {
      const b = d || { id: 'nfsimp' + row.id, criadoEm: Date.now(), impPor: conta ? conta.id : null };
      novo = Object.assign({}, b, { numero: 'Omie-' + (nj.rps || nj.numero), emissao: nj.emissao, emissaoReal: nj.emissao, numOficial: nj.numero, codVerif: nj.codVerif || '', parcId: nj.parcId || b.parcId || '',
        tomDoc: nj.tomPf ? mascaraCpf(nj.tomDoc) : nj.tomDoc, tomNome: nj.tomNome || '', projId: b.projId || '', desc: String(nj.desc || '').slice(0, 2000), codServico: nj.codServico || '', cnae: b.cnae || '',
        aliqIss: nj.aliq || 0, valor: nj.bruto, deducoes: nj.deducoes || 0, desconto: nj.desconto || 0, issRetido: !!nj.issRetido, irrf: 0, pis: 0, cofins: 0, csll: 0, inss: 0, localPrest: nj.localPrest || '',
        venc: b.venc || '', status: canc ? 'cancelada' : 'emitida', canceladaEm: canc ? (String((nj.canc && nj.canc.dh) || '').slice(0, 10) || b.canceladaEm || hojeBr()) : '', obs: 'Importada do Omie (arquivo fiscal).', link: b.link || '',
        origem: 'omie', chave: row.chave, arqf: ref, nbs: nj.nbs || '', cClassTrib: nj.cClassTrib || '', cstIbs: nj.cstIbs || '', lancId: b.lancId || '',
        imp: { padrao: nj.padrao, bruto: nj.bruto, ded: nj.deducoes || 0, desc: nj.desconto || 0, base: nj.base, aliq: nj.aliq, iss: nj.iss, issRetido: !!nj.issRetido, ret: nj.ret, totRet: nj.totRet, liq: nj.liq, ibs: nj.ibs || 0, cbs: nj.cbs || 0, vTotNF: nj.vTotNF || 0, semXml: !!nj.semXml, competencia: nj.competencia || '' } });
    }
    if (d && JSON.stringify(novo) === JSON.stringify(d)) return { doc: d, mudou: false };
    docPutAv('nfse/' + novo.id, novo, avisos);
    if (d) { const k = ix.docs.indexOf(d); if (k >= 0) ix.docs[k] = novo; } else ix.docs.push(novo);
    ix.porArqf.set(row.id, novo); ix.porCh.set(row.chave, novo);
    return { doc: novo, mudou: true };
  }
  /* vínculo nota ↔ título(s): campo leve no título (lanc.arqf com mod 'nfse', + nfseId) e no arquivo; quem ligou e quando */
  function gravarVincNfse(row, nj, ids, conf, conta, avisos) {
    const ts = Date.now(), ant = row.vinc ? JSON.parse(row.vinc) : [], docId = nj.docId || '';
    for (const id of ant) if (!ids.includes(id)) { const p = 'lanc/' + id, l = docGet(p); if (l && l.arqf && normCh(l.arqf.ch) === row.chave) { const setN = l.arqf.setNfse; delete l.arqf; if (setN && l.nfseId === docId) delete l.nfseId; docPutAv(p, l, avisos); } }
    const retV = {}; for (const k of Object.keys(nj.ret || {})) if (+nj.ret[k]) retV[k] = nj.ret[k];
    for (const id of ids) {
      const p = 'lanc/' + id, l = docGet(p); if (!l) continue;
      const jaMeu = l.arqf && normCh(l.arqf.ch) === row.chave, setNfse = !!docId && (!l.nfseId || (jaMeu && l.arqf.setNfse));
      l.arqf = { id: row.id, ch: row.chave, n: String(row.numero || ''), sit: row.situacao || 'autorizada', conf, em: ts, por: conta ? conta.id : null, mod: 'nfse', bruto: nj.bruto, liq: nj.liq, ret: retV, setNfse: setNfse || undefined };
      if (setNfse) l.nfseId = docId;
      docPutAv(p, l, avisos);
    }
    st.vinc.run(ids.length ? JSON.stringify(ids) : null, ids.length ? conf : null, ids.length ? ts : null, conta ? conta.id : null, null, row.id);
    if (docId) { const p = 'nfse/' + docId, d = docGet(p); if (d) { const d2 = Object.assign({}, d, { lancId: ids[0] || (d.origem === 'omie' ? '' : d.lancId || ''), lancIds: ids.length > 1 ? ids : undefined }); if (JSON.stringify(d2) !== JSON.stringify(d)) docPutAv(p, d2, avisos); } }
  }
  /* procura títulos para as NFS-e sem ligação (todas, ou só as pedidas); atualiza o cliente (parcId) quando o cadastro aparece */
  function religarNfse(conta, avisos, soIds) {
    const par = parNfse(), parcDoc = new Map(), parcPorDoc = new Map();
    for (const p of col('parc')) { const d = normDoc(p.doc || p.cnpj || p.cpf); if (d) { parcDoc.set(p.id, d); if (!parcPorDoc.has(d)) parcPorDoc.set(d, p.id); } }
    const rows = db.prepare("SELECT id, chave, numero, emissao, valor, parc_doc, situacao, vinc, nfse FROM arqf WHERE modelo='nfse' AND vinc IS NULL").all().filter(r => !soIds || soIds.includes(r.id));
    const notas = rows.map(r => { const nj = JSON.parse(r.nfse || '{}'); return { id: r.id, chave: r.chave, parcDoc: r.parc_doc, bruto: nj.bruto != null ? nj.bruto : r.valor, liq: nj.liq != null ? nj.liq : r.valor, emissao: r.emissao, docId: nj.docId, situacao: r.situacao, nj, row: r }; });
    const res = casarNfse(notas.filter(n => !n.nj.ign), col('lanc'), parcDoc, par);
    let lig = 0, conf = 0;
    for (const n of notas) {
      const nj = n.nj, pid = parcPorDoc.get(n.parcDoc) || '';
      if (pid !== (nj.parcId || '')) { nj.parcId = pid; if (nj.docId) { const p = 'nfse/' + nj.docId, d = docGet(p); if (d && d.origem === 'omie' && d.parcId !== pid) docPutAv(p, Object.assign({}, d, { parcId: pid }), avisos); } }
      const m = res[n.id];
      if (m && m.conf === 'alta' && !nj.semAuto) { gravarVincNfse(n.row, nj, m.lancs, 'auto', conta, avisos); nj.lig = { conf: 'auto', motivo: m.motivo }; lig++; }
      else if (m) { const sug = (m.sug || []).concat(m.conf === 'alta' ? [{ lancs: m.lancs, motivo: m.motivo + ' (ligação automática desligada para esta nota)' }] : []); st.sugest.run(sug.length ? JSON.stringify(sug) : null, n.id); nj.lig = { conf: m.conf, motivo: m.motivo }; if (m.conf !== 'cancelada') conf++; }
      gravaNj(n.id, nj);
    }
    return { vistas: notas.length, ligadas: lig, conferir: conf };
  }
  /* ---------- importação do ZIP do Omie ---------- */
  async function nfseLote(arq, conta, nomeZ) {
    const emp = empresa(), ini = Date.now();
    const rel = { arquivo: nomeZ, total: 0, notasLidas: 0, novas: 0, existentes: 0, completadas: 0, canceladas: 0, cancNovas: 0, ignoradas: 0, apoio: 0, semXml: 0, pdfs: 0, ligadas: 0, conferir: 0,
      motivos: {}, apoioMot: {}, lista: [], notas: [], rejeitadas: [], dpsSemNota: [], rpsSemNota: [], cancSemNota: 0 };
    const ign = (nome, motivo) => { rel.ignoradas++; const k = motivo.replace(/\s*\(.*$/, '').replace(/[:—].*$/, '').trim(); rel.motivos[k] = (rel.motivos[k] || 0) + 1; if (rel.lista.length < 2000) rel.lista.push({ arquivo: String(nome).slice(0, 200), r: 'ignorado', motivo }); };
    const apoio = (nome, motivo) => { rel.apoio++; rel.apoioMot[motivo] = (rel.apoioMot[motivo] || 0) + 1; };
    const notas = new Map(), cancs = [], rpsList = [], dpsList = [], pdfs = [], PRIO = { distribuicao: 3, xml: 2, json: 1 };
    const addNota = (n, dd, nome) => {
      rel.notasLidas++;
      if (!emp.cnpjs.has(n.prestDoc)) { ign(nome, 'prestador não é a empresa: CNPJ ' + (n.prestDoc || '?') + ' (só entram NFS-e emitidas pela empresa)'); return; }
      if (n.padrao === 'nacional') {
        if (!/^\d{50}$/.test(n.chave)) { ign(nome, 'chave da NFS-e nacional inválida'); return; }
        if (n.cStat && n.cStat !== '100') { ign(nome, 'NFS-e não gerada (cStat ' + n.cStat + ')'); return; }
      } else {
        if (n.sitLote && n.sitLote !== '4') { ign(nome, 'lote não processado pela prefeitura (Situação ' + n.sitLote + ')'); return; }
        if (!semZeros(n.numero)) { ign(nome, 'NFS-e sem número'); return; }
        n.chave = normCh('NFSE-' + n.prestDoc + '-' + (n.cMun || '0000000') + '-' + n.numero);
      }
      const ja = notas.get(n.chave); if (ja && (PRIO[ja.fonte] || 0) >= (PRIO[dd.fonte] || 0)) { apoio(nome, 'outra cópia da mesma nota (fica o XML da distribuição/consulta)'); return; }
      if (ja) apoio(ja.nome, 'outra cópia da mesma nota (fica o XML da distribuição/consulta)');
      notas.set(n.chave, { n, buf: dd.buf, fonte: dd.fonte, nome });
    };
    if (nfseRodando) throw { st: 429, msg: 'Já há uma importação de NFS-e em andamento. Espere terminar.' };
    nfseRodando = true;
    try { /* o "em andamento" sempre é solto no fim, mesmo com erro */
    const z = zipAbrir(arq); let lidos = 0;
    try {
      const ents = z.entradas.filter(e => !/\/$/.test(e.nome));
      for (const en of ents) {
        const nome = en.nome, base = nome.split(/[\/\\]/).pop(), e = ((base.match(/\.([A-Za-z0-9]{1,5})$/) || [])[1] || '').toLowerCase();
        if (/(^|[\/\\])\.\.([\/\\]|$)/.test(nome) || /^([\/\\]|[A-Za-z]:)/.test(nome) || /[\0]/.test(nome)) { rel.total++; ign(nome, 'caminho inválido dentro do ZIP (../ ou caminho absoluto): arquivo não lido'); continue; }
        if (/(^|\/)(__MACOSX|\.)/.test(nome)) continue; /* lixo do Mac e arquivos ocultos: fora, sem contar */
        rel.total++;
        if (!['xml', 'txt', 'pdf'].includes(e)) { ign(nome, e === 'html' || e === 'htm' ? 'página HTML (erro de comunicação do Omie com a prefeitura), não é nota: não guardada' : 'tipo de arquivo não aceito (só .xml, .txt do Omie e .pdf)'); continue; }
        if (en.cript) { ign(nome, 'arquivo protegido por senha dentro do ZIP'); continue; }
        const lim = e === 'pdf' ? PDF_MAX : MAX_XML;
        if (en.orig > lim) { ign(nome, 'arquivo maior que o limite (' + mb(lim) + ')'); continue; }
        if (en.comp > 0 && en.orig > 1048576 && en.orig / en.comp > 300) { ign(nome, 'compressão suspeita (possível ZIP-bomba): arquivo não lido'); continue; }
        let buf; try { buf = z.ler(en); } catch (x) { ign(nome, 'não foi possível ler do ZIP: ' + (x.msg || x.message || 'erro')); continue; }
        if (buf.length > lim) { ign(nome, 'arquivo maior que o limite (' + mb(lim) + ')'); continue; }
        lidos += buf.length; if (lidos > NFSE_ZIP_MAX * 4) throw { st: 413, msg: 'conteúdo do ZIP grande demais depois de descompactado (possível ZIP-bomba)' };
        const oid = (base.match(/_(\d{6,})\.[A-Za-z0-9]+$/) || [])[1] || '', numNome = (base.match(/^(?:nfse|demonstrativo)_(\d+)_/i) || [])[1] || '', ehOs = /^os_/i.test(base);
        if (e === 'pdf') { if (!ehPdf(buf)) { ign(nome, 'não é um PDF (o arquivo não começa com %PDF)'); continue; } pdfs.push({ nome, base, buf, oid, num: semZeros(numNome), danfse: !/^demonstrativo_/i.test(base) }); continue; }
        const docs = [];
        if (e === 'txt') {
          let j; try { j = JSON.parse(textoNfse(buf)); } catch (x) { ign(nome, 'arquivo .txt que não é a resposta (JSON) do Omie'); continue; }
          if (!j || !Array.isArray(j.lote)) { apoio(nome, 'consulta enviada pelo Omie (solicitação)'); continue; }
          for (const it of j.lote) {
            if (it && it.xmlGZipB64) { try { const xb = zlib.gunzipSync(Buffer.from(String(it.xmlGZipB64), 'base64'), { maxOutputLength: MAX_XML }); docs.push({ x: textoNfse(xb), buf: xb, fonte: 'json' }); } catch (x) { ign(nome, 'XML compactado (xmlGZipB64) ilegível ou grande demais'); } }
            else if (it) rel.rejeitadas.push({ arquivo: String(nome).slice(0, 200), dps: String(it.id || '').slice(0, 60), oid, os: ehOs || undefined, status: String(it.statusProcessamento || '').slice(0, 30),
              erros: (it.erros || it.alertas || []).slice(0, 5).map(x => ({ codigo: String((x && (x.codigo || x.Codigo)) || '').slice(0, 20), msg: reparaAcento(String((x && (x.descricao || x.Descricao || x.mensagem)) || '')).slice(0, 400) })) });
          }
          if (!docs.length) { apoio(nome, 'resposta do Omie sem XML de nota (rejeição: veja abaixo)'); continue; }
        } else docs.push({ x: textoNfse(buf), buf, fonte: /(^|\/)distribuicao\//i.test(nome) ? 'distribuicao' : 'xml' });
        for (const dd of docs) {
          const t = tipoNfse(dd.x);
          if (t === 'nacional') { const n = lerNacional(dd.x); n.oid = oid; addNota(n, dd, nome); }
          else if (t === 'abrasf') { const ns = lerAbrasf(dd.x); if (!ns.length) ign(nome, 'XML de NFS-e sem dados da nota'); for (const n of ns) { n.oid = oid; addNota(n, dd, nome); } }
          else if (t === 'canc_abrasf') { const c = lerCancAbrasf(dd.x); if (!c.ok) ign(nome, 'cancelamento sem a confirmação da prefeitura' + (c.erro ? ' (' + c.erro.slice(0, 120) + ')' : '')); else cancs.push({ tipo: 'abrasf', c, buf: dd.buf, nome }); }
          else if (t === 'canc_nacional') { const c = lerEventoNacional(dd.x); if (!c.registrado || !/^\d{50}$/.test(c.chave)) ign(nome, 'evento da NFS-e sem o registro do Ambiente Nacional'); else if (!['101101', '105102'].includes(c.tp)) apoio(nome, 'evento da NFS-e que não é cancelamento'); else cancs.push({ tipo: 'nacional', c, buf: dd.buf, nome }); }
          else if (t === 'pedido_evento') apoio(nome, 'pedido de cancelamento enviado (vale a resposta da prefeitura)');
          else if (t === 'rps_abrasf') { const r = lerRpsAbrasf(dd.x); if (r) rpsList.push({ r, oid, buf: dd.buf, nome }); apoio(nome, 'RPS/DPS enviado ao provedor (solicitação)'); }
          else if (t === 'dps') { dpsList.push({ id: (dd.x.match(/<(?:\w+:)?infDPS\s[^>]*\bId\s*=\s*["']([^"']+)["']/) || [])[1] || '', nDPS: semZeros(val(dd.x, 'nDPS')), oid, os: ehOs, nome, vServ: numN(val(dd.x, 'vServ')), dhEmi: val(dd.x, 'dhEmi'), tomDoc: normDoc(val(bloco(dd.x, 'toma'), 'CNPJ') || val(bloco(dd.x, 'toma'), 'CPF')) }); apoio(nome, 'RPS/DPS enviado ao provedor (solicitação)'); }
          else if (t === 'consulta_sem_nota') ign(nome, 'resposta da prefeitura sem nota' + (val(dd.x, 'Mensagem') ? ' (' + txN(dd.x, 'Mensagem').slice(0, 120) + ')' : ''));
          else if (t === 'apoio') apoio(nome, 'protocolo/consulta do Omie com a prefeitura (não é a nota)');
          else if (t === 'nfe') ign(nome, 'é NF-e (nota de produto): use "Importar histórico (ZIP)"');
          else ign(nome, 'não é XML de NFS-e');
        }
      }
    } finally { z.fechar(); }
    {
      /* RPS ABRASF sem o XML autorizado, mas com o PDF da nota no ZIP (mesma transação do Omie): a nota existe; guarda o RPS + PDF */
      const oidsNota = new Set([...notas.values()].map(x => x.n.oid).filter(Boolean)), numsNota = new Set([...notas.values()].map(x => semZeros(x.n.numero)));
      const cMunPadrao = (() => { const c = {}; for (const x of notas.values()) if (x.n.padrao === 'abrasf' && x.n.cMun) c[x.n.cMun] = (c[x.n.cMun] || 0) + 1; return (Object.entries(c).sort((a, b) => b[1] - a[1])[0] || [''])[0]; })();
      for (const rp of rpsList) {
        if (rp.oid && oidsNota.has(rp.oid)) continue;
        const pdf = pdfs.find(p => p.oid && p.oid === rp.oid && p.num);
        if (!pdf || numsNota.has(pdf.num)) { if (!pdf) rel.rpsSemNota.push({ arquivo: String(rp.nome).slice(0, 200), rps: rp.r.rps, valor: rp.r.bruto }); continue; }
        if (!emp.cnpjs.has(rp.r.prestDoc)) continue;
        const numero = (rp.nome.match(/_(\d{6,})_/) || [])[1] || pdf.num, n = Object.assign({}, rp.r, { numero, codVerif: pdfCodVerif(pdf.buf), emissao: rp.r.dataRps || rp.r.competencia, cMun: cMunPadrao, semXml: true, oid: rp.oid });
        n.chave = normCh('NFSE-' + n.prestDoc + '-' + (n.cMun || '0000000') + '-' + n.numero);
        if (!notas.has(n.chave)) { notas.set(n.chave, { n, buf: rp.buf, fonte: 'rps', nome: rp.nome }); numsNota.add(semZeros(numero)); }
      }
      /* DPS do Padrão Nacional sem nota no ZIP (rejeitada ou não autorizada) */
      const dpsNota = new Set([...notas.values()].map(x => x.n.dpsId).filter(Boolean));
      for (const d of dpsList) if (!dpsNota.has(d.id)) { const rj = rel.rejeitadas.find(r => (d.oid && r.oid === d.oid) || (d.id && r.dps === d.id)); rel.dpsSemNota.push({ arquivo: String(d.nome).slice(0, 200), dps: d.nDPS, valor: d.vServ, emissao: String(d.dhEmi).slice(0, 10), os: d.os || undefined, rejeicao: rj ? rj.erros : undefined,
        reemitida: [...notas.values()].filter(x => x.n.padrao === 'nacional' && Math.abs(x.n.bruto - d.vServ) < 0.01 && x.n.tomDoc === d.tomDoc && x.n.emissao >= String(d.dhEmi).slice(0, 10)).map(x => x.n.numero).slice(0, 3) }); }
      /* PDFs: o da mesma transação do Omie (número no nome do arquivo); o DANFSe oficial antes do demonstrativo */
      const usados = new Set();
      const pdfDe = n => { const cs = pdfs.filter(p => (n.oid && p.oid === n.oid) || (p.num && p.num === semZeros(n.numero))); cs.sort((a, b) => (b.danfse - a.danfse) || ((b.oid === n.oid) - (a.oid === n.oid))); return cs[0] || null; };
      const ix = nfseDocsIdx(), avisos = [], parcPorDoc = new Map(); for (const p of col('parc')) { const d = normDoc(p.doc || p.cnpj || p.cpf); if (d && !parcPorDoc.has(d)) parcPorDoc.set(d, p.id); }
      const evCancN = db.prepare("SELECT dh FROM arqf_evento WHERE chave=? AND tp IN ('101101','105102','CANC-ABRASF') ORDER BY dh LIMIT 1");
      const lista = [...notas.values()].sort((a, b) => String(a.n.emissao).localeCompare(String(b.n.emissao)) || String(a.n.numero).localeCompare(String(b.n.numero), undefined, { numeric: true }));
      const doZip = new Set();
      const gravarNota = it => {
        const n = it.n; n.parcId = parcPorDoc.get(n.tomDoc) || '';
        const pdf = pdfDe(n); if (pdf) usados.add(pdf);
        const ja = st.porChave.get(n.chave); let row, res;
        if (ja) { row = st.porId.get(ja.id); if (row.modelo !== 'nfse') { ign(it.nome, 'a chave já está no arquivo como outro documento'); return; } res = 'existente'; }
        else {
          const id = uid(16), ts = Date.now();
          st.novo.run(id, n.chave, 'nfse', 'saida', '1', null, n.prestDoc, n.prestNome || '', n.tomDoc, n.tomNome, n.tomDoc, n.tomNome, n.numero, '', n.emissao, n.bruto, 'autorizada',
            n.semXml ? 'sem XML autorizado no ZIP: guardados o RPS enviado e o PDF da nota' : n.padrao === 'nacional' ? 'NFS-e gerada no Ambiente Nacional (cStat ' + (n.cStat || '100') + ')' : 'NFS-e autorizada pela prefeitura (código de verificação ' + (n.codVerif || '—') + ')',
            ts, 0, n.padrao === 'nacional' ? n.nDFSe || null : n.codVerif || null, n.semXml ? 'sem_xml_autorizado' : 'nfse', shaB(it.buf), zlib.gzipSync(it.buf, { level: 9 }), it.buf.length, 'historico', String(it.nome).slice(0, 200), ts, conta ? conta.id : null, '[]', null, null, null);
          row = st.porId.get(id); res = 'nova';
        }
        doZip.add(row.id);
        let nj = row.nfse ? JSON.parse(row.nfse) : null, mudou = false;
        /* completa: chegou o XML autorizado de uma nota guardada "sem XML" */
        if (res === 'existente' && nj && nj.semXml && !n.semXml) {
          db.prepare("UPDATE arqf SET xml=?, tam=?, sha=?, ass='nfse', sit_fonte=?, arquivo=?, valor=?, prot=? WHERE id=?").run(zlib.gzipSync(it.buf, { level: 9 }), it.buf.length, shaB(it.buf), n.padrao === 'nacional' ? 'NFS-e gerada no Ambiente Nacional (XML recebido depois)' : 'NFS-e autorizada pela prefeitura (XML recebido depois)', String(it.nome).slice(0, 200), n.bruto, n.codVerif || n.nDFSe || null, row.id);
          nj = Object.assign({}, nj, { semXml: false, _troca: true }); mudou = true;
        }
        const campos = { padrao: n.padrao, numero: n.numero, codVerif: n.codVerif || '', rps: n.rps || '', serieRps: n.serieRps || '', dpsId: n.dpsId || '', emissao: n.emissao, competencia: n.competencia || '', dhEmi: n.dhEmi || '', cMun: n.cMun || '', prestIm: n.prestIm || '',
          tomDoc: n.tomDoc, tomPf: !!n.tomPf, tomNome: n.tomNome, parcId: n.parcId, desc: String(n.desc || '').slice(0, 4000), codServico: n.codServico || '', nbs: n.nbs || '', localPrest: n.localPrest || '',
          bruto: n.bruto, deducoes: n.deducoes || 0, desconto: n.desconto || 0, base: n.base, aliq: n.aliq, iss: n.iss, issRetido: !!n.issRetido, ret: n.ret, totRet: n.totRet, liq: n.liq,
          ibs: n.ibs || 0, ibsUf: n.ibsUf || 0, ibsMun: n.ibsMun || 0, cbs: n.cbs || 0, vTotNF: n.vTotNF || 0, cClassTrib: n.cClassTrib || '', cstIbs: n.cstIbs || '', semXml: !!n.semXml };
        if (!nj || nj._troca) { const ant = nj || {}; nj = Object.assign(campos, { docId: ant.docId, ign: ant.ign, canc: ant.canc, lig: ant.lig, semAuto: ant.semAuto }); mudou = true; }
        else { if (!nj.codVerif && n.codVerif) { nj.codVerif = n.codVerif; mudou = true; } if (n.parcId && nj.parcId !== n.parcId) nj.parcId = n.parcId; }
        if (n.padrao === 'abrasf' && n.cancelada && !nj.canc) nj.canc = { dh: n.dhCanc || '', fonte: 'XML da nota' };
        /* cancelamento que chegou antes (outro ZIP) ou dentro do próprio XML */
        const ev = evCancN.get(row.chave);
        if (row.situacao !== 'cancelada' && (ev || nj.canc)) { const dh = (ev && ev.dh) || (nj.canc && nj.canc.dh) || ''; st.sit.run('cancelada', 'cancelada na prefeitura' + (dh ? ' em ' + String(dh).slice(0, 10).split('-').reverse().join('/') : ''), Date.now(), null, row.id); nj.canc = nj.canc || { dh }; row = st.porId.get(row.id); }
        if (pdf && !stPdf.info.get(row.chave)) { const r = pdfGuardar(row, pdf.buf, pdf.base, 'lote', conta, false); if (r.r === 'novo') { rel.pdfs++; mudou = true; } }
        const g = nfseDocGravar(row, nj, ix, avisos, conta); if (nj.docId !== g.doc.id) { nj.docId = g.doc.id; } if (g.mudou && res === 'existente') mudou = true;
        gravaNj(row.id, nj); regOrigem(row.chave, 'historico', nomeZ);
        if (res === 'nova') { rel.novas++; if (n.semXml) rel.semXml++; } else if (mudou) rel.completadas++; else rel.existentes++;
        it.res = res === 'nova' ? 'nova' : mudou ? 'completada' : 'existente'; it.id = row.id;
      };
      for (let i = 0; i < lista.length; i += 50) {
        db.exec('BEGIN'); try { for (const it of lista.slice(i, i + 50)) gravarNota(it); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
        soltar(avisos.splice(0)); await new Promise(r => setImmediate(r));
      }
      for (const p of pdfs) if (!usados.has(p)) { if ([...notas.values()].some(x => (x.n.oid && x.n.oid === p.oid) || semZeros(x.n.numero) === p.num)) apoio(p.nome, 'outro PDF da mesma nota (fica o DANFSe oficial; o demonstrativo do Omie fica de fora)'); else ign(p.nome, 'PDF sem a nota correspondente no ZIP'); }
      /* cancelamentos (depois das notas: a ordem dos arquivos no ZIP não importa) */
      db.exec('BEGIN');
      try {
        for (const cc of cancs) {
          const chave = cc.tipo === 'nacional' ? cc.c.chave : normCh('NFSE-' + cc.c.cnpj + '-' + (cc.c.cMun || cMunPadrao || '0000000') + '-' + cc.c.numero);
          const cnpjDe = cc.tipo === 'nacional' ? (cc.c.autor || chave.slice(9, 23)) : cc.c.cnpj;
          if (!emp.cnpjs.has(cnpjDe)) { ign(cc.nome, 'cancelamento de nota de outro prestador (CNPJ ' + cnpjDe + ')'); continue; }
          st.evNovo.run(uid(16), chave, cc.tipo === 'nacional' ? cc.c.tp : 'CANC-ABRASF', cc.c.seq || '1', cc.c.dh, '100', null, shaB(cc.buf), zlib.gzipSync(cc.buf, { level: 9 }), 'historico', String(cc.nome).slice(0, 200), Date.now(), conta ? conta.id : null);
          const r0 = st.porChave.get(chave);
          if (!r0) { rel.cancSemNota++; if (rel.lista.length < 2000) rel.lista.push({ arquivo: String(cc.nome).slice(0, 200), r: 'guardado', motivo: 'cancelamento guardado; a nota ainda não está no arquivo (será marcada quando chegar)' }); continue; }
          const row = st.porId.get(r0.id), nj = JSON.parse(row.nfse || '{}');
          if (row.situacao === 'cancelada' && nj.canc && nj.canc.dh) continue;
          nj.canc = { dh: cc.c.dh, codigo: cc.c.codigo || undefined, motivo: cc.c.motivo || undefined, tp: cc.tipo === 'nacional' ? cc.c.tp : 'abrasf' };
          if (row.situacao !== 'cancelada') { st.sit.run('cancelada', 'cancelada na prefeitura em ' + String(cc.c.dh).slice(0, 10).split('-').reverse().join('/'), Date.now(), null, row.id); rel.cancNovas++; }
          gravaNj(row.id, nj); const row2 = st.porId.get(row.id);
          if (row2.vinc) marcarSitNosTitulos(row2, 'cancelada', avisos);
          nfseDocGravar(row2, nj, ix, avisos, conta);
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
      soltar(avisos.splice(0));
      /* ligação com Contas a receber (todas as NFS-e ainda sem título) */
      db.exec('BEGIN'); let rl; try { rl = religarNfse(conta, avisos, null); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
      soltar(avisos.splice(0));
      /* relatório: uma linha por nota do ZIP, com o estado final */
      const anos = {};
      for (const it of lista) {
        if (!it.id) continue; const r = st.porId.get(it.id), nj = JSON.parse(r.nfse || '{}'), vinc = r.vinc ? JSON.parse(r.vinc) : [];
        const lig = vinc.length ? (r.vinc_conf === 'manual' ? 'ligada à mão' : 'ligada') : r.situacao === 'cancelada' ? 'cancelada (não liga)' : nj.ign ? 'ignorada na conferência' : 'conferir';
        if (doZip.has(r.id)) { if (r.situacao === 'cancelada') rel.canceladas++; if (vinc.length && r.situacao !== 'cancelada') rel.ligadas++; else if (lig === 'conferir') rel.conferir++; }
        const a = anoDe(r.emissao); anos[a] = anos[a] || { notas: 0, canceladas: 0, bruto: 0, brutoValidas: 0, liqValidas: 0, tomadores: {} }; const A = anos[a];
        A.notas++; A.bruto = r2(A.bruto + (+nj.bruto || 0)); if (r.situacao === 'cancelada') A.canceladas++; else { A.brutoValidas = r2(A.brutoValidas + (+nj.bruto || 0)); A.liqValidas = r2(A.liqValidas + (+nj.liq || 0)); } const tk = (nj.tomPf ? mascaraCpf(nj.tomDoc) : nj.tomDoc) + ' ' + (nj.tomNome || ''); A.tomadores[tk] = (A.tomadores[tk] || 0) + 1;
        if (rel.notas.length < 5000) rel.notas.push({ id: r.id, numero: r.numero, chave: r.chave, emissao: r.emissao, padrao: nj.padrao, tomador: nj.tomNome || '', tomDoc: nj.tomPf ? mascaraCpf(nj.tomDoc) : nj.tomDoc, bruto: nj.bruto, liq: nj.liq, totRet: nj.totRet,
          situacao: r.situacao, resultado: it.res, semXml: nj.semXml || undefined, pdf: !!stPdf.info.get(r.chave), ligacao: lig, motivoLig: (nj.lig && nj.lig.motivo) || '' });
      }
      rel.anos = anos; rel.religar = rl; rel.segundos = Math.round((Date.now() - ini) / 100) / 10;
      return rel;
    }
    } finally { nfseRodando = false; }
  }
  /* ligar/desligar à mão (rota /api/arqfiscal/<id>/ligar|desligar quando a linha é NFS-e) */
  async function ligarNfseRota(row, acao, req, res, conta) {
    const b = await lerJsonLim(req, 100000), ids = acao === 'ligar' ? [...new Set(Array.isArray(b.lancIds) ? b.lancIds.map(String).filter(x => /^[\w-]{1,80}$/.test(x)).slice(0, 60) : [])] : [];
    const nj = JSON.parse(row.nfse || '{}'), par = parNfse();
    if (acao === 'ligar') {
      if (!ids.length) { json(res, 400, { code: 'invalid_argument', erro: 'Escolha ao menos um título.' }); return; }
      if (row.situacao === 'cancelada') { json(res, 409, { code: 'failed_precondition', erro: 'Esta NFS-e foi cancelada na prefeitura: nota cancelada não liga a título.' }); return; }
      let sv = 0, sb = 0;
      for (const id of ids) {
        const l = docGet('lanc/' + id);
        if (!l || l.tipo !== 'receber' || l.status === 'cancelado') { json(res, 400, { code: 'invalid_argument', erro: 'Título inválido para esta nota (' + id + '): só conta a receber em aberto ou recebida, não cancelada.' }); return; }
        if (l.arqf && l.arqf.ch && normCh(l.arqf.ch) !== row.chave) { json(res, 409, { code: 'conflict', erro: 'O título "' + (l.desc || id) + '" já está ligado a outra nota (' + (l.arqf.n || '') + '). Desligue lá antes.' }); return; }
        if (l.nfseId && nj.docId && l.nfseId !== nj.docId) { const o = docGet('nfse/' + l.nfseId); if (o && o.status !== 'rascunho') { json(res, 409, { code: 'conflict', erro: 'O título "' + (l.desc || id) + '" já é da NFS-e ' + (o.numOficial || o.numero || '') + '.' }); return; } }
        sv += +l.valor || 0; sb += (+l.valor || 0) + (+l.retido || 0);
      }
      if (ids.length > 1) { sv = r2(sv); sb = r2(sb); const t = Math.max(0.05, par.tol); if (!(Math.abs(sv - nj.bruto) <= t || Math.abs(sv - nj.liq) <= t || Math.abs(sb - nj.bruto) <= t)) {
        const brl = v => 'R$ ' + (+v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        json(res, 400, { code: 'invalid_argument', erro: 'A soma dos ' + ids.length + ' títulos (' + brl(sv) + ') não bate com a nota (bruto ' + brl(nj.bruto) + ', líquido ' + brl(nj.liq) + '). Uma nota liga a um título, ou às parcelas que somam o valor dela.' }); return; } }
    }
    const antes = row.vinc ? JSON.parse(row.vinc) : [], avisos = [];
    db.exec('BEGIN');
    try { gravarVincNfse(row, nj, ids, 'manual', conta, avisos); if (acao === 'ligar') { delete nj.ign; nj.semAuto = undefined; nj.lig = { conf: 'manual', motivo: 'ligada à mão' }; } else { nj.semAuto = true; nj.lig = { conf: 'desligada', motivo: 'desligada à mão: o sistema não liga de novo sozinho' }; } gravaNj(row.id, nj); db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
    soltar(avisos);
    auditar(conta, req, acao === 'ligar' ? 'ARQF_NFSE_LIGAR' : 'ARQF_NFSE_DESLIGAR', 'arqfiscal/' + row.chave, { titulos: antes }, { titulos: ids });
    json(res, 200, linha(st.porId.get(row.id)));
  }
  /* ===== fim v135 (funções) ===== */

  /* ===== v141 (relatorios/feito_v141_p2p2.md): NFS-e RECEBIDAS de fornecedores e empreiteiros (tomador = a empresa) =====
     Mesmos leitores da v135 (ABRASF 2.03 e Padrão Nacional) ou PDF com os dados digitados. Ficam no arquivo fiscal como
     entrada de serviço (modelo 'nfsef', tipo 'entrada'), com o XML original (ou o PDF) e o resumo em arqf.nfse.
     Ligação: à medição do empreiteiro (mesmo CNPJ/CPF do contrato e valor bruto igual, medição aprovada ou aguardando) — as
     retenções da nota são conferidas contra as calculadas na medição (P2.retConf) e a diferença fica na fila do recebimento;
     ou à nota de entrada criada a partir dela (pedido de serviço, compra pequena ou sem pedido), que segue o lançamento normal.
     A conta a pagar do serviço continua nascendo na aprovação da medição ou no lançamento da nota (rota do servidor). */
  const P2 = require('./p2p.js');
  /* chave sem o CPF do prestador pessoa física (LGPD): no lugar do CPF vai um resumo (hash) dele */
  const nfsefChave = d => d.chave ? normCh(d.chave) : normCh('NFSE-' + (String(d.prestDoc || '').length === 11 ? 'PF' + crypto.createHash('sha256').update('nfsef:' + d.prestDoc).digest('hex').slice(0, 14).toUpperCase() : d.prestDoc) + '-' + (d.cMun || '0') + '-' + semZeros(d.numero || '0'));
  function nfsefJson(d, extra) {
    return Object.assign({ padrao: d.padrao, numero: d.numero, codVerif: d.codVerif || '', competencia: d.competencia || '', desc: String(d.desc || '').slice(0, 2000), bruto: r2(d.bruto), liq: r2(d.liq), base: r2(d.base),
      ret: { iss: r2((d.ret || {}).iss), inss: r2((d.ret || {}).inss), irrf: r2((d.ret || {}).irrf), csll: r2((d.ret || {}).csll), pis: r2((d.ret || {}).pis), cofins: r2((d.ret || {}).cofins) }, totRet: r2(d.totRet), iss: r2(d.iss), issRetido: !!d.issRetido,
      prestPf: String(d.prestDoc || '').length === 11 || undefined, lig: null }, extra || {});
  }
  function nfsefMedCands(docP, bruto) {
    const out = [], cs = new Map(col('ctremp').map(c => [c.id, c])), ps = new Map(col('parc').map(p => [p.id, p]));
    for (const m of col('medemp')) {
      if (!['aprovada', 'aguardando'].includes(m.status) || m.nfsef) continue;
      const c = cs.get(m.ctrId), pa = c && ps.get(c.parcId); if (!pa || normDoc(pa.doc) !== docP) continue;
      const k = P2.meCalc(m, c); if (Math.abs(k.bruto - bruto) <= Math.max(0.05, k.bruto * 0.005)) out.push({ m, c, k });
    }
    return out;
  }
  function nfsefLigarMed(row, nj, x, conta, conf, avisos) {
    const div = P2.retConf(nj, x.k), ts = Date.now(), lig = { tipo: 'medicao', id: x.m.id, numero: x.m.numero || '', ctr: x.c.numero || '', ctrId: x.c.id, status: x.m.status, k: x.k, div, conf, em: ts, por: conta ? conta.id : null, aceita: null };
    const m2 = Object.assign({}, docGet('medemp/' + x.m.id) || x.m, { nfsef: { id: row.id, ch: row.chave, numero: row.numero, emissao: row.emissao, bruto: nj.bruto, liq: nj.liq, ret: nj.ret, div, conf, em: ts, por: conta ? conta.id : null } });
    docPutAv('medemp/' + x.m.id, m2, avisos);
    const ls = (Array.isArray(x.m.lancIds) ? x.m.lancIds : []).map(id => docGet('lanc/' + id)).filter(l => l && l.parcId === x.c.parcId && !l.retencaoDe && !l.retPendDe);
    if (ls[0]) docPutAv('lanc/' + ls[0].id, Object.assign({}, ls[0], { arqf: { id: row.id, ch: row.chave, n: String(row.numero || ''), sit: row.situacao || 'autorizada', conf, em: ts, mod: 'nfsef', bruto: nj.bruto, liq: nj.liq } }), avisos);
    const nj2 = Object.assign({}, nj, { lig });
    db.prepare('UPDATE arqf SET nfse=?, vinc=?, vinc_conf=?, vinc_em=?, vinc_por=? WHERE id=?').run(JSON.stringify(nj2), ls[0] ? JSON.stringify([ls[0].id]) : null, ls[0] ? 'medicao' : null, ts, conta ? conta.id : null, row.id);
    return nj2;
  }
  /* guarda uma NFS-e recebida (d = leitura v135 ou dados do PDF); devolve {r, id, chave, motivo, lig} */
  function nfsefGuardar(nome, buf, d, conta, emp, semXml) {
    if (!d.prestDoc || !/^\d{11}$|^\d{14}$/.test(d.prestDoc)) return { r: 'ignorada', motivo: 'sem o CNPJ/CPF do prestador' };
    if (emp.cnpjs.has(d.prestDoc)) return { r: 'ignorada', motivo: 'o prestador é a própria empresa: é NFS-e emitida (use "Importar NFS-e emitidas")' };
    if (!semXml && !emp.cnpjs.has(d.tomDoc)) return { r: 'ignorada', motivo: 'o tomador não é a empresa (CNPJ ' + (d.tomPf ? mascaraCpf(d.tomDoc) : d.tomDoc || '?') + ')' };
    if (d.padrao === 'nacional' && d.cStat && d.cStat !== '100') return { r: 'ignorada', motivo: 'NFS-e não gerada (cStat ' + d.cStat + ')' };
    if (!(+d.bruto > 0)) return { r: 'ignorada', motivo: 'sem valor dos serviços' };
    const chave = nfsefChave(d), ja = st.porChave.get(chave);
    if (ja) return { r: 'existente', id: ja.id, chave };
    const id = uid(16), ts = Date.now(), sit = d.cancelada ? 'cancelada' : 'autorizada', nj = nfsefJson(d, semXml ? { semXml: true } : {});
    st.novo.run(id, chave, 'nfsef', 'entrada', null, null, mascaraCpf(d.prestDoc), d.prestNome || '', d.tomDoc || '', d.tomNome || '', d.prestDoc, d.prestNome || '', String(d.numero || ''), '', d.emissao || '', r2(d.bruto),
      sit, semXml ? 'sem XML: dados digitados a partir do PDF da nota' : d.padrao === 'nacional' ? 'NFS-e do Ambiente Nacional (cStat ' + (d.cStat || '100') + ')' : 'NFS-e da prefeitura (código de verificação ' + (d.codVerif || '—') + ')',
      ts, 0, d.codVerif || d.nDFSe || null, semXml ? 'pdf' : 'nfse', crypto.createHash('sha256').update(buf).digest('hex'), zlib.gzipSync(buf, { level: 9 }), buf.length, 'upload', String(nome || '').slice(0, 200), ts, conta ? conta.id : null, '[]', null, null, null);
    db.prepare('UPDATE arqf SET nfse=? WHERE id=?').run(JSON.stringify(nj), id);
    regOrigem(chave, 'upload');
    const avisos = []; let lig = 'sem';
    if (sit === 'autorizada') { const cs = nfsefMedCands(d.prestDoc, r2(d.bruto)); if (cs.length === 1) { const row = st.porId.get(id); const nj2 = nfsefLigarMed(row, nj, cs[0], conta, 'auto', avisos); lig = nj2.lig.div.length ? 'divergente' : 'ligada'; } else if (cs.length > 1) lig = 'varias'; }
    return { r: 'nova', id, chave, lig, avisos };
  }
  const nfsefLinha = r => { let j = {}; try { j = JSON.parse(r.nfse || '{}'); } catch (e) { } return { id: r.id, chave: r.chave, numero: r.numero, emissao: r.emissao, valor: r.valor, parcDoc: mascaraCpf(r.parc_doc), parcNome: r.parc_nome, situacao: r.situacao, nfse: Object.assign({}, j, { desc: String(j.desc || '').slice(0, 400) }) }; };
  async function rotaNfsef(p, m, req, res, conta, acc) {
    const total = acc === 'total';
    if (p === '/api/arqfiscal/nfsef' && m === 'POST') {
      const b = await lerJsonLim(req, 16 * 1024 * 1024), emp = empresa();
      if (!emp.cnpjs.size) { json(res, 409, { code: 'failed_precondition', erro: 'Informe o CNPJ da empresa em Sistema › Configurações antes de guardar notas no arquivo fiscal.' }); return true; }
      const out = [], avisos = [];
      db.exec('BEGIN');
      try {
        if (b.pdf) {
          const buf = Buffer.from(String(b.pdf.b64 || ''), 'base64'), x = b.dados || {};
          if (!ehPdf(buf)) throw { st: 400, msg: 'O arquivo não é um PDF.' }; if (buf.length > PDF_MAX) throw { st: 413, msg: 'PDF maior que ' + Math.round(PDF_MAX / 1048576) + ' MB.' };
          const num = (n => isFinite(n) ? r2(n) : 0), d = { padrao: 'pdf', numero: String(x.numero || '').replace(/[^\w.\-\/]/g, '').slice(0, 30), prestDoc: normDoc(x.prestDoc).replace(/\D/g, ''), prestNome: String(x.prestNome || '').slice(0, 120), tomDoc: [...emp.cnpjs][0], emissao: /^\d{4}-\d{2}-\d{2}$/.test(String(x.emissao || '')) ? x.emissao : '', competencia: String(x.competencia || '').slice(0, 10),
            bruto: num(+x.bruto), ret: {}, desc: String(x.desc || '').slice(0, 2000), cMun: 'PDF' };
          ['iss', 'inss', 'irrf', 'csll', 'pis', 'cofins'].forEach(k => { d.ret[k] = num(+((x.ret || {})[k]) || 0); }); d.totRet = r2(Object.values(d.ret).reduce((s, v) => s + v, 0)); d.liq = num(+x.liq) || r2(d.bruto - d.totRet); d.issRetido = d.ret.iss > 0; d.iss = d.ret.iss;
          if (!d.numero || !d.emissao) throw { st: 400, msg: 'Informe o número e a data de emissão da NFS-e.' };
          const r = nfsefGuardar(b.pdf.nome || 'nfse.pdf', Buffer.from(''), d, conta, emp, true);
          if (r.r === 'nova') { const row = st.porId.get(r.id); pdfGuardar(row, buf, String(b.pdf.nome || 'nfse.pdf'), 'manual', conta); }
          out.push(Object.assign({ arquivo: b.pdf.nome || 'nfse.pdf' }, r, { avisos: undefined })); (r.avisos || []).forEach(a => avisos.push(a));
        } else {
          const arqs = Array.isArray(b.arquivos) ? b.arquivos.slice(0, 50) : [];
          if (!arqs.length) throw { st: 400, msg: 'Envie de 1 a 50 arquivos XML de NFS-e.' };
          for (const a of arqs) {
            const buf = Buffer.from(String(a.xml || ''), 'utf8'); if (!buf.length || buf.length > MAX_XML) { out.push({ arquivo: a.nome, r: 'ignorada', motivo: 'arquivo vazio ou grande demais' }); continue; }
            const x = textoNfse(buf), t = tipoNfse(x), ds = t === 'nacional' ? [lerNacional(x)] : t === 'abrasf' ? lerAbrasf(x) : [];
            if (!ds.length) { out.push({ arquivo: a.nome, r: 'ignorada', motivo: t === 'nfe' ? 'é NF-e (mercadoria): use "Receber XML do fornecedor"' : 'não é XML de NFS-e (ABRASF ou Padrão Nacional)' }); continue; }
            for (const d of ds) { const r = nfsefGuardar(a.nome, buf, d, conta, emp, false); (r.avisos || []).forEach(v => avisos.push(v)); out.push(Object.assign({ arquivo: a.nome }, r, { avisos: undefined })); }
          }
        }
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } if (e && e.st) { json(res, e.st, { code: 'invalid_argument', erro: e.msg }); return true; } throw e; }
      soltar(avisos);
      auditar(conta, req, 'ARQF_NFSEF_IMPORTAR', 'arqfiscal/nfsef', null, { novas: out.filter(x => x.r === 'nova').length, existentes: out.filter(x => x.r === 'existente').length, ignoradas: out.filter(x => x.r === 'ignorada').length, chaves: out.filter(x => x.r === 'nova').map(x => x.chave).slice(0, 50), pdf: !!b.pdf });
      json(res, 200, { itens: out, linhas: out.filter(x => x.id).map(x => nfsefLinha(st.porId.get(x.id))) }); return true;
    }
    const mm = p.match(/^\/api\/arqfiscal\/([A-Za-z0-9]{8,40})\/nfsef-(ligar|aceitar|cands)$/); if (!mm) return false;
    const row = st.porId.get(mm[1]); if (!row || row.modelo !== 'nfsef') { json(res, 404, { code: 'not_found', erro: 'NFS-e de fornecedor não encontrada.' }); return true; }
    let nj = {}; try { nj = JSON.parse(row.nfse || '{}'); } catch (e) { }
    if (mm[2] === 'cands' && m === 'GET') { const cs = nfsefMedCands(row.parc_doc, r2(nj.bruto)), lim = col('medemp').filter(x => !x.nfsef && ['aprovada', 'aguardando'].includes(x.status));
      json(res, 200, { cands: cs.map(x => ({ id: x.m.id, numero: x.m.numero, ctr: x.c.numero, status: x.m.status, k: x.k, div: P2.retConf(nj, x.k) })), outras: lim.length }); return true; }
    const b = await lerJsonLim(req, 100000), avisos = [];
    if (mm[2] === 'ligar' && m === 'POST') {
      if (b.medempId) {
        if (!total) { negar(res, conta, req, p, 'Seu perfil não liga NFS-e à medição.'); return true; }
        const md = docGet('medemp/' + String(b.medempId)), c = md && docGet('ctremp/' + String(md.ctrId || ''));
        if (!md || !c || !['aprovada', 'aguardando'].includes(md.status)) { json(res, 400, { code: 'invalid_argument', erro: 'Escolha uma medição aprovada ou aguardando aprovação.' }); return true; }
        if (md.nfsef && md.nfsef.id !== row.id) { json(res, 409, { code: 'conflict', erro: 'Esta medição já tem NFS-e ligada.' }); return true; }
        const pa = docGet('parc/' + String(c.parcId || '')) || {}; if (normDoc(pa.doc) !== row.parc_doc) { json(res, 409, { code: 'conflict', erro: 'O empreiteiro do contrato não é o prestador da NFS-e.' }); return true; }
        db.exec('BEGIN'); try { nj = nfsefLigarMed(row, nj, { m: md, c, k: P2.meCalc(md, c) }, conta, 'manual', avisos); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } throw e; }
      } else if (b.notaId) {
        const n = docGet('notas/' + String(b.notaId)); if (!n || n.tipo !== 'entrada' || normCh(n.nfseChave || '') !== row.chave) { json(res, 400, { code: 'invalid_argument', erro: 'A nota não foi criada a partir desta NFS-e.' }); return true; }
        nj = Object.assign({}, nj, { lig: { tipo: 'nota', id: n.id, pedId: n.pedId || '', em: Date.now(), por: conta.id, conf: 'manual' } });
        db.prepare('UPDATE arqf SET nfse=? WHERE id=?').run(JSON.stringify(nj), row.id);
      } else if (b.desligar) {
        if (!total) { negar(res, conta, req, p); return true; }
        const lg = nj.lig; if (lg && lg.tipo === 'medicao') { const md = docGet('medemp/' + lg.id); if (md && md.nfsef && md.nfsef.id === row.id) { const m2 = Object.assign({}, md); delete m2.nfsef; docPutAv('medemp/' + md.id, m2, avisos); } }
        nj = Object.assign({}, nj, { lig: null }); db.prepare('UPDATE arqf SET nfse=?, vinc=NULL, vinc_conf=NULL WHERE id=?').run(JSON.stringify(nj), row.id);
      } else { json(res, 400, { code: 'invalid_argument', erro: 'Escolha a medição ou a nota.' }); return true; }
      soltar(avisos); auditar(conta, req, 'ARQF_NFSEF_LIGAR', 'arqfiscal/' + row.chave, null, { lig: nj.lig ? { tipo: nj.lig.tipo, id: nj.lig.id, div: (nj.lig.div || []).length } : null });
      json(res, 200, nfsefLinha(st.porId.get(row.id))); return true;
    }
    if (mm[2] === 'aceitar' && m === 'POST') {
      if (!total) { negar(res, conta, req, p, 'Quem aceita a diferença de retenção é o Fiscal ou um administrador.'); return true; }
      const lg = nj.lig; if (!lg || lg.tipo !== 'medicao' || !(lg.div || []).length) { json(res, 409, { code: 'conflict', erro: 'Esta NFS-e não tem diferença de retenção a aceitar.' }); return true; }
      const obs = String(b.obs || '').trim().slice(0, 500); if (!obs) { json(res, 400, { code: 'invalid_argument', erro: 'Explique por que a retenção da nota pode ser aceita (ex.: a contabilidade confirmou).' }); return true; }
      const ac = { por: conta.id, em: Date.now(), obs }; nj = Object.assign({}, nj, { lig: Object.assign({}, lg, { aceita: ac }) });
      db.prepare('UPDATE arqf SET nfse=? WHERE id=?').run(JSON.stringify(nj), row.id);
      const md = docGet('medemp/' + lg.id); if (md && md.nfsef && md.nfsef.id === row.id) docPutAv('medemp/' + md.id, Object.assign({}, md, { nfsef: Object.assign({}, md.nfsef, { aceita: ac }) }), avisos);
      soltar(avisos); auditar(conta, req, 'ARQF_NFSEF_ACEITAR', 'arqfiscal/' + row.chave, null, { div: lg.div, obs });
      json(res, 200, nfsefLinha(st.porId.get(row.id))); return true;
    }
    return false;
  }
  /* ===== fim v141 (funções) ===== */
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
      const f = filtros(u, acc), ids = db.prepare('SELECT id, chave, tipo, numero, serie, emissao, valor, parc_doc, parc_nome, situacao, modelo FROM arqf' + f.wh + ' ORDER BY emissao, numero').all(...f.a);
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
          await z.addGz(pasta + r.chave + (r.modelo === 'nfse' || r.modelo === 'nfsef' ? '-nfse.xml' : '-nfe.xml'), gx.get(r.id).xml); /* v135; v141: nfsef */
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
      const rows0 = chs ? chs.map(ch => st.porChave.get(ch)).filter(Boolean).map(r => st.porId.get(r.id)) : db.prepare("SELECT id,chave,tipo,numero,serie,emissao,valor,parc_doc,situacao,vinc,modelo FROM arqf WHERE vinc IS NULL").all();
      const rows = rows0.filter(r => r.modelo !== 'nfse'), nfseIds = rows0.filter(r => r.modelo === 'nfse').map(r => r.id); /* v135: NFS-e têm regra própria */
      for (let i = 0; i < rows.length; i += 200) {
        db.exec('BEGIN');
        try { for (const r of rows.slice(i, i + 200)) { if (r.vinc) continue; vist++; const mm = casar(r, ix, emp); if (mm.conf === 'alta') { gravarVinc(r, mm.lancs, 'auto', conta, avisos); mm.lancs.forEach(l => marcarUsado(ix, l, r.chave)); lig++; if (r.situacao === 'cancelada') marcarSitNosTitulos(Object.assign({}, r, { vinc: JSON.stringify(mm.lancs) }), 'cancelada', avisos); } else { st.sugest.run(mm.conf === 'sugestao' ? JSON.stringify(mm.sug) : null, r.id); if (mm.conf === 'sugestao') sug++; } } db.exec('COMMIT'); }
        catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
        soltar(avisos.splice(0)); await new Promise(r => setImmediate(r));
      }
      if (!chs || nfseIds.length) { db.exec('BEGIN'); let rn; try { rn = religarNfse(conta, avisos, chs ? nfseIds : null); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; } soltar(avisos.splice(0)); vist += rn.vistas; lig += rn.ligadas; sug += rn.conferir; } /* v135 */
      auditar(conta, req, 'ARQF_RELIGAR', 'arqfiscal/religar', null, { vistas: vist, ligadas: lig, sugestoes: sug });
      json(res, 200, { vistas: vist, ligadas: lig, sugestoes: sug }); return true;
    }
    /* ===== v135: NFS-e emitidas (ZIP do Omie) ===== */
    if (p === '/api/arqfiscal/nfse/config' && m === 'GET') { const pn = parNfse(); json(res, 200, { zipMaxMb: NFSE_ZIP_MAX / 1048576, tol: pn.tol, dias: pn.dias, acesso: acc, rodando: nfseRodando }); return true; }
    if (p === '/api/arqfiscal/nfse/lote' && m === 'POST') {
      if (!total) { negar(res, conta, req, p, 'Seu perfil não importa NFS-e emitidas.'); return true; }
      const emp = empresa(); if (!emp.cnpjs.size) { json(res, 409, { code: 'failed_precondition', erro: 'Informe o CNPJ da empresa em Sistema › Configurações antes de importar.' }); return true; }
      if (nfseRodando) { json(res, 429, { code: 'resource_exhausted', erro: 'Já há uma importação de NFS-e em andamento. Espere terminar.' }); return true; }
      const nomeZ = String(u.searchParams.get('nome') || 'nfse.zip').slice(0, 200), len = +req.headers['content-length'] || 0;
      if (len > NFSE_ZIP_MAX) { auditar(conta, req, 'ARQF_NFSE_RECUSADO', p, null, { arquivo: nomeZ, motivo: 'ZIP grande demais', bytes: len }); json(res, 413, { code: 'invalid_argument', erro: 'ZIP grande demais (limite ' + mb(NFSE_ZIP_MAX) + '). Exporte por período menor no Omie.' }); return true; }
      const tmp = path.join(DATA, 'tmp', 'arqfnfse-' + uid(16) + '.zip'); try { fs.mkdirSync(path.dirname(tmp), { recursive: true }); } catch (e) { }
      try {
        await new Promise((ok, err) => { let n = 0; const w = fs.createWriteStream(tmp); req.on('data', d => { n += d.length; if (n > NFSE_ZIP_MAX) { req.unpipe(w); w.destroy(); err({ st: 413, msg: 'ZIP grande demais (limite ' + mb(NFSE_ZIP_MAX) + ').' }); req.resume(); } }); req.pipe(w); w.on('finish', ok); w.on('error', err); req.on('error', err); });
      } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { } auditar(conta, req, 'ARQF_NFSE_RECUSADO', p, null, { arquivo: nomeZ, motivo: e.msg || 'falha ao receber' }); json(res, e.st || 400, { erro: e.msg || 'Falha ao receber o arquivo.' }); return true; }
      let cab = Buffer.alloc(0); try { const fd = fs.openSync(tmp, 'r'); cab = Buffer.alloc(4); fs.readSync(fd, cab, 0, 4, 0); fs.closeSync(fd); } catch (e) { }
      if (cab.readUInt32LE(0) !== 0x04034b50) { try { fs.unlinkSync(tmp); } catch (x) { } auditar(conta, req, 'ARQF_NFSE_RECUSADO', p, null, { arquivo: nomeZ, motivo: 'não é ZIP' }); json(res, 400, { code: 'invalid_argument', erro: 'Envie o arquivo .zip exportado do Omie (NFS-e emitidas).' }); return true; }
      let rel; try { rel = await nfseLote(tmp, conta, nomeZ); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (x) { } auditar(conta, req, 'ARQF_NFSE_RECUSADO', p, null, { arquivo: nomeZ, motivo: e.msg || e.message }); if (!e.st) console.error('[arquivo fiscal] nfse', e); json(res, e.st || 400, { erro: e.msg || 'Arquivo ZIP inválido.' }); return true; }
      try { fs.unlinkSync(tmp); } catch (x) { }
      auditar(conta, req, 'ARQF_NFSE_IMPORTAR', 'arqfiscal/nfse/lote', null, { arquivo: nomeZ, total: rel.total, novas: rel.novas, existentes: rel.existentes, completadas: rel.completadas, canceladas: rel.canceladas, cancNovas: rel.cancNovas, ignoradas: rel.ignoradas, semXml: rel.semXml, pdfs: rel.pdfs, ligadas: rel.ligadas, conferir: rel.conferir, motivos: rel.motivos, chaves: rel.notas.filter(x => x.resultado === 'nova').slice(0, 50).map(x => x.chave) });
      json(res, 200, rel); return true;
    }
    const mni = p.match(/^\/api\/arqfiscal\/([A-Za-z0-9]{8,40})\/nfse-ignorar$/);
    if (mni && m === 'POST') {
      if (!total) { negar(res, conta, req, p); return true; }
      const row = st.porId.get(mni[1]); if (!row || row.modelo !== 'nfse') { json(res, 404, { code: 'not_found', erro: 'NFS-e não encontrada no arquivo fiscal.' }); return true; }
      const b = await lerJsonLim(req, 10000), nj = JSON.parse(row.nfse || '{}');
      if (b.ignorar) nj.ign = { por: conta.id, em: Date.now(), motivo: String(b.motivo || '').slice(0, 200) || undefined }; else delete nj.ign;
      gravaNj(row.id, nj); auditar(conta, req, b.ignorar ? 'ARQF_NFSE_IGNORAR' : 'ARQF_NFSE_REVER', 'arqfiscal/' + row.chave, null, { motivo: nj.ign && nj.ign.motivo });
      json(res, 200, linha(st.porId.get(row.id))); return true;
    }
    /* ===== fim v135 (rotas) ===== */
    if (await rotaNfsef(p, m, req, res, conta, acc)) return true; /* v141: NFS-e de fornecedor */
    /* ===== v134: PDF original do fornecedor ===== */
    if (p === '/api/arqfiscal/pdf/config' && m === 'GET') { json(res, 200, { pdfMaxMb: PDF_MAX / 1048576, zipMaxMb: PDF_ZIP_MAX / 1048576, acesso: acc }); return true; }
    /* importar DANFEs em lote: o corpo é um ZIP de PDFs; cada PDF liga à nota pela chave do nome do arquivo */
    if (p === '/api/arqfiscal/pdf/lote' && m === 'POST') {
      const len = +req.headers['content-length'] || 0;
      if (len > PDF_ZIP_MAX) { auditar(conta, req, 'ARQF_PDF_LOTE_RECUSADO', p, null, { motivo: 'ZIP grande demais', bytes: len }); json(res, 413, { code: 'invalid_argument', erro: 'ZIP grande demais (limite ' + mb(PDF_ZIP_MAX) + '). Divida em arquivos menores.' }); return true; }
      const nomeZ = String(u.searchParams.get('nome') || 'danfes.zip').slice(0, 200), tmp = path.join(DATA, 'tmp', 'arqfpdf-' + uid(16) + '.zip');
      try { fs.mkdirSync(path.dirname(tmp), { recursive: true }); } catch (e) { }
      try {
        await new Promise((ok, err) => { let n = 0; const w = fs.createWriteStream(tmp); req.on('data', d => { n += d.length; if (n > PDF_ZIP_MAX) { req.unpipe(w); w.destroy(); err({ st: 413, msg: 'ZIP grande demais (limite ' + mb(PDF_ZIP_MAX) + ').' }); req.resume(); } }); req.pipe(w); w.on('finish', ok); w.on('error', err); req.on('error', err); });
      } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { } json(res, e.st || 400, { erro: e.msg || 'Falha ao receber o arquivo.' }); return true; }
      const ini = Date.now(); let rel;
      try { rel = await pdfLote(tmp, conta, total); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (x) { } auditar(conta, req, 'ARQF_PDF_LOTE_RECUSADO', p, null, { arquivo: nomeZ, motivo: e.msg || e.message }); json(res, e.st || 400, { erro: e.msg || 'Arquivo ZIP inválido.' }); return true; }
      try { fs.unlinkSync(tmp); } catch (x) { }
      rel.arquivo = nomeZ; rel.segundos = Math.round((Date.now() - ini) / 100) / 10;
      auditar(conta, req, 'ARQF_PDF_LOTE', 'arqfiscal/pdf/lote', null, { arquivo: nomeZ, total: rel.total, novos: rel.novos, existentes: rel.existentes, ignorados: rel.ignorados, motivos: rel.motivos, chaves: rel.ligados.slice(0, 50).map(x => x.chave) });
      json(res, 200, rel); return true;
    }
    /* nota pela chave (botão DANFE das telas que só conhecem a chave, ex.: Notas para lançar) */
    const mch = p.match(/^\/api\/arqfiscal\/ch\/(\d{44})$/);
    if (mch && m === 'GET') {
      const r0 = st.porChave.get(mch[1]), row = r0 ? st.porId.get(r0.id) : null;
      if (!row || (!total && row.tipo !== 'entrada')) { json(res, 404, { code: 'not_found', erro: 'Nota não encontrada no arquivo fiscal.' }); return true; }
      json(res, 200, Object.assign(linha(row), { pdf: pdfInfo(row.chave) })); return true;
    }
    const mpd = p.match(/^\/api\/arqfiscal\/([A-Za-z0-9]{8,40})\/pdf$/);
    if (mpd) {
      const row = st.porId.get(mpd[1]);
      if (!row || (!total && row.tipo !== 'entrada')) { json(res, 404, { code: 'not_found', erro: 'Nota não encontrada no arquivo fiscal.' }); return true; }
      if (m === 'GET') {
        pdfDoEmail([row.chave]); const r = stPdf.get.get(row.chave);
        if (!r) { json(res, 404, { code: 'not_found', erro: 'Esta nota não tem o PDF do fornecedor.' }); return true; }
        const b = Buffer.isBuffer(r.pdf) ? r.pdf : Buffer.from(r.pdf.buffer, r.pdf.byteOffset, r.pdf.byteLength);
        const baixar = !!u.searchParams.get('baixar');
        if (baixar) auditar(conta, req, 'ARQF_PDF_BAIXAR', 'arqfiscal/' + row.chave, null, { origem: r.origem });
        /* arquivo vindo de fora: nunca vira página do sistema (sandbox, nosniff); o navegador mostra pelo leitor de PDF */
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': b.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-disposition': (baixar ? 'attachment' : 'inline') + '; filename="danfe-' + row.chave + '.pdf"', 'content-security-policy': "default-src 'none'; sandbox" });
        res.end(b); return true;
      }
      if (m === 'POST') { /* anexo manual: o corpo é o PDF */
        const substituir = total && !!u.searchParams.get('substituir');
        if ((+req.headers['content-length'] || 0) > PDF_MAX) { auditar(conta, req, 'ARQF_PDF_RECUSADO', 'arqfiscal/' + row.chave, null, { motivo: 'PDF maior que o limite' }); json(res, 413, { code: 'invalid_argument', erro: 'PDF maior que ' + mb(PDF_MAX) + '.' }); return true; }
        let buf; try { buf = await lerCorpo(req, PDF_MAX + 1); } catch (e) { auditar(conta, req, 'ARQF_PDF_RECUSADO', 'arqfiscal/' + row.chave, null, { motivo: 'PDF maior que o limite' }); json(res, 413, { code: 'invalid_argument', erro: 'PDF maior que ' + mb(PDF_MAX) + '.' }); return true; }
        if (buf.length > PDF_MAX) { json(res, 413, { code: 'invalid_argument', erro: 'PDF maior que ' + mb(PDF_MAX) + '.' }); return true; }
        const nome = String(u.searchParams.get('nome') || 'danfe.pdf').slice(0, 200);
        let r; db.exec('BEGIN'); try { r = pdfGuardar(row, buf, nome, 'manual', conta, substituir); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
        if (r.r === 'ignorado') { auditar(conta, req, 'ARQF_PDF_RECUSADO', 'arqfiscal/' + row.chave, null, { motivo: r.motivo, nome }); json(res, 400, { code: 'invalid_argument', erro: 'Arquivo recusado: ' + r.motivo + '.' }); return true; }
        if (r.r === 'existente') { json(res, 409, { code: 'already_exists', erro: 'Não anexado: ' + r.motivo + '.', r: 'existente' }); return true; }
        auditar(conta, req, r.r === 'trocado' ? 'ARQF_PDF_TROCAR' : 'ARQF_PDF_ANEXAR', 'arqfiscal/' + row.chave, r.antes || null, { nome, tam: buf.length });
        json(res, 200, { ok: true, r: r.r, pdf: pdfInfo(row.chave) }); return true;
      }
      if (m === 'DELETE') {
        if (!total) { negar(res, conta, req, p, 'Seu perfil não remove o PDF do fornecedor.'); return true; }
        const ja = stPdf.info.get(row.chave); if (!ja) { json(res, 404, { erro: 'Esta nota não tem o PDF do fornecedor.' }); return true; }
        db.exec('BEGIN'); try { stPdf.del.run(row.chave); stPdf.remNovo.run(row.chave, Date.now(), conta.id); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { } throw e; }
        auditar(conta, req, 'ARQF_PDF_REMOVER', 'arqfiscal/' + row.chave, { origem: ja.origem, nome: ja.nome, sha: ja.sha }, null);
        json(res, 200, { ok: true }); return true;
      }
      json(res, 405, { erro: 'Método não permitido.' }); return true;
    }
    /* ===== fim v134 (rotas) ===== */
    const mi = p.match(/^\/api\/arqfiscal\/([A-Za-z0-9]{8,40})(\/(xml|ligar|desligar|situacao|eventos))?$/);
    if (!mi) { json(res, 404, { erro: 'Não encontrado.' }); return true; }
    const row = st.porId.get(mi[1]);
    if (!row || (!total && row.tipo !== 'entrada')) { json(res, 404, { code: 'not_found', erro: 'Nota não encontrada no arquivo fiscal.' }); return true; }
    const acao = mi[3] || '';
    if (!acao && m === 'GET') { json(res, 200, Object.assign(linha(row), { emitDoc: row.emit_doc, emitNome: row.emit_nome, destDoc: row.dest_doc, destNome: row.dest_nome, parcelas: JSON.parse(row.parcelas || '[]'), arquivo: row.arquivo, por: row.por, prot: row.prot, fin: row.fin, eventos: st.evDa.all(row.chave), pdf: pdfInfo(row.chave) /* v134 */, nfseDet: row.modelo === 'nfse' ? nfseDetalhe(row.nfse) : undefined /* v135 */ })); return true; }
    if (acao === 'xml' && m === 'GET') {
      const x = st.xml.get(row.id), b = zlib.gunzipSync(x.xml);
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store', 'content-disposition': (u.searchParams.get('baixar') ? 'attachment' : 'inline') + '; filename="' + row.chave + (row.modelo === 'nfse' ? '-nfse.xml' : '-nfe.xml') + '"' /* v135 */, 'content-security-policy': "default-src 'none'; sandbox" });
      res.end(b); return true;
    }
    if (acao === 'situacao' && m === 'POST') { if (!total) { negar(res, conta, req, p); return true; } const r = await consultarSituacao(row, conta, req, true); json(res, r.ok ? 200 : 409, r.ok ? r : { erro: r.msg }); return true; }
    if ((acao === 'ligar' || acao === 'desligar') && m === 'POST') {
      if (!total) { negar(res, conta, req, p, 'Seu perfil não liga notas a títulos.'); return true; }
      if (row.modelo === 'nfse') { await ligarNfseRota(row, acao, req, res, conta); return true; } /* v135 */
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
    /* v134 */ pdfDoEmail, pdfInfo, chaveDoNome, chaveOk,
    /* v135 */ religarNfse,
    /* v130: usados pela leitura da caixa nfe@ (caixanfe.js) */
    processar, evento, indice, novoRel, conta1, linha, enfileirar, soltar, regOrigem, normCh, hojeBr, diasEntre, temConector: !!FISCAL_URL };
};
module.exports.util = { c14nInfNFe, conferirAssinatura, lerDoc, guardaAte, textoXml,
  /* v135 */ lerNacional, lerAbrasf, lerRpsAbrasf, lerEventoNacional, lerCancAbrasf, tipoNfse, reparaAcento, textoNfse, casarNfse, pdfCodVerif, mascaraCpf, normCh };

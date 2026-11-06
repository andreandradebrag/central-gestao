'use strict';
/* v162 (relatorios/feito_v162.md): medições lidas de PDF pela IA. Ligado por v162/ed_v162.py em server.js e regras.js.
   1. Rota POST /api/ia/medicao-pdf { ctrId, arqId } (server.js, logo depois de /api/ia; o mesmo limite de uso por hora da
      /api/ia vale aqui: cada PDF é UMA chamada). O PDF já está guardado como anexo (POST /api/assets) e foi enviado pela
      própria pessoa. O servidor:
      - confere a permissão: a mesma de criar medição ao cliente no contrato (lê o contrato e grava "med", com as regras do
        servidor para uma medição nova em rascunho);
      - confere o arquivo: PDF de até 20 MB e até 50 páginas;
      - manda à IA (modelo "complex", função ia() de server.js) SÓ o PDF (bloco "document", base64; serve também para PDF
        escaneado) e os itens do contrato (código, descrição, unidade, preço unitário). Nada do cliente, do contrato ou de
        quem pede vai junto (LGPD);
      - devolve o JSON lido (período, número, data, itens, total, dúvidas), normalizado. Não grava medição: o navegador cria
        a medição em RASCUNHO, com o PDF anexado, para a revisão.
      - auditoria: auditarIa de sempre (IA_USO, sem conteúdo) e MEDICAO_PDF_IA (contrato, anexo, páginas, tamanho, itens lidos).
   2. Regra da gravação da medição (regras.js, antesGravar de "med"), para o campo imp162 (importação de PDF):
      - quem importou (porImp/emImp) e quem aprovou a importação (aprovPor/aprovEm) são carimbados pelo servidor;
      - medição importada ainda em revisão (imp162.st 'revisar') não vai para aprovação nem é aprovada;
      - "Aprovar e criar medição" (st 'revisar' → 'aprovada') não deixa a medição aprovada: ela continua em rascunho e segue o
        fluxo de sempre (enviar para aprovação → Comercial aprova). O teto do contrato sob demanda (demanda161.js) vale igual. */
const fs = require('node:fs'), path = require('node:path');
const MAX_MB = 20, MAX_PAG = 50;
const r2 = v => Math.round((+v || 0) * 100) / 100;
function paginas(buf) {
  const s = buf.toString('latin1');
  const a = (s.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  let b = 0; const re = /\/Count\s+(\d+)/g; let m; while ((m = re.exec(s))) b = Math.max(b, +m[1]);
  return Math.max(a, b);
}
/* número em texto brasileiro ("1.234,56") ou JSON */
function num(v) {
  if (v === null || v === undefined || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d,.\-]/g, ''); if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = parseFloat(s); return isFinite(n) ? n : null;
}
function dataIso(v) {
  const s = String(v || '').trim(); let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}
const txt = (v, n) => v === null || v === undefined ? '' : String(v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n || 300);
function jsonDe(t) {
  t = String(t || ''); try { return JSON.parse(t); } catch (e) { }
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { } }
  return null;
}
function normaliza(j) {
  const p = j.periodo && typeof j.periodo === 'object' ? j.periodo : { texto: j.periodo };
  const itens = (Array.isArray(j.itens) ? j.itens : []).slice(0, 500).filter(x => x && typeof x === 'object').map(x => ({
    item: txt(x.item ?? x.item_contrato ?? x.codigo, 40), descricao: txt(x.descricao ?? x.descricao_lida ?? x.desc, 300), un: txt(x.un ?? x.unidade, 20),
    qtd: num(x.qtd ?? x.quantidade), pu: num(x.preco_unit ?? x.preco_unit_lido ?? x.pu), total: num(x.total)
  }));
  return { periodo: { ini: dataIso(p.inicio || p.ini), fim: dataIso(p.fim), texto: txt(p.texto, 120) }, numero: txt(j.numero ?? j.numero_medicao, 30), data: dataIso(j.data),
    itens, total: num(j.total), duvidas: (Array.isArray(j.duvidas) ? j.duvidas : j.duvidas ? [j.duvidas] : []).map(d => txt(d, 400)).filter(Boolean).slice(0, 30) };
}
function prompt(itens) {
  const lista = itens.map(i => JSON.stringify({ codigo: txt(i.item, 40), descricao: txt(i.desc, 300), un: txt(i.un, 20), preco_unit: r2(i.pu) })).join('\n');
  return 'O PDF anexo é um boletim de medição de serviços de um contrato. Leia o documento (ele pode ser escaneado) e extraia a medição.\n\n' +
    'Itens do contrato (um por linha, JSON):\n' + (lista || '(o contrato não tem planilha de itens)') + '\n\n' +
    'Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois e sem markdown, exatamente neste formato:\n' +
    '{"periodo":{"inicio":"AAAA-MM-DD","fim":"AAAA-MM-DD","texto":"período como escrito no documento"},"numero":"número da medição","data":"AAAA-MM-DD",' +
    '"itens":[{"item":"código do item do contrato correspondente (ou o mais parecido); null se nenhum servir","descricao":"descrição como lida no PDF","un":"unidade lida","qtd":0,"preco_unit":0,"total":0}],' +
    '"total":0,"duvidas":["o que não ficou claro"]}\n\n' +
    'Regras: números em JSON com ponto decimal (1234.56), sem separador de milhar nem "R$". "qtd" é a quantidade medida NO PERÍODO (não o acumulado). ' +
    '"preco_unit" e "total" são os valores lidos no PDF, mesmo que sejam diferentes do contrato. Não invente valores: o que não estiver no documento fica null e vai para "duvidas". ' +
    'Inclua só as linhas com quantidade medida no período. Use os códigos da lista acima no campo "item".';
}
module.exports = function (ctx) {
  /* ---------- rota ---------- */
  async function rota(conta, req, res) {
    const F = ctx.fn(), { json, lerJson, REG } = F;
    let corpo = {}; try { corpo = await lerJson(req); } catch (e) { return json(res, 400, { code: 'invalid_argument', erro: 'Pedido inválido.' }); }
    const ctrId = String(corpo.ctrId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64), arqId = String(corpo.arqId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!ctrId || !arqId) return json(res, 400, { code: 'invalid_argument', erro: 'Informe o contrato e o arquivo.' });
    const rc = F.q.docGet.get('ctr/' + ctrId); let c = null; try { c = rc ? JSON.parse(rc.data) : null; } catch (e) { }
    if (!c || !F.podeVer(conta, 'ctr/' + ctrId, c, new Map())) return json(res, 404, { code: 'not_found', erro: 'Contrato não encontrado.' });
    /* mesma permissão de criar a medição: grava "med" (nível, perfil e módulo) e passa nas regras do servidor como medição nova em rascunho */
    const pm = 'med/imp162' + Date.now().toString(36);
    if (!F.pode(conta, pm, 'w') || !F.perfilPermite(conta, pm, 'w') || (!F.gravacaoPermitida(conta, pm) && F.MODO_GRAV === 'bloquear'))
      return json(res, 403, { code: 'not_granted', erro: 'Seu perfil não cria medição neste contrato.' });
    { const v = REG.antesGravar(conta, pm, null, { ctrId, numero: 0, ini: '', fim: '', status: 'rascunho', itens: [], valor: '', imp162: { st: 'revisar' } }, req);
      if (v && v.erro) return json(res, v.st === 409 ? 409 : 403, { code: 'not_granted', erro: v.erro }); }
    const a = F.q.arqGet.get(arqId);
    if (!a || a.lixo || (a.por !== conta.id && conta.nivel !== 'owner')) return json(res, 404, { code: 'not_found', erro: 'Arquivo não encontrado. Envie o PDF de novo.' });
    if ((+a.tam || 0) > MAX_MB * 1024 * 1024) return json(res, 413, { code: 'too_large', erro: 'O PDF passa de ' + MAX_MB + ' MB. Divida o arquivo ou reduza a resolução.' });
    let buf; try { buf = fs.readFileSync(path.join(F.DATA, 'blobs', arqId)); } catch (e) { return json(res, 404, { code: 'not_found', erro: 'Arquivo não encontrado.' }); }
    if (buf.length > MAX_MB * 1024 * 1024) return json(res, 413, { code: 'too_large', erro: 'O PDF passa de ' + MAX_MB + ' MB.' });
    if (buf.slice(0, 1024).toString('latin1').indexOf('%PDF-') < 0) return json(res, 400, { code: 'invalid_argument', erro: 'O arquivo não é um PDF.' });
    const pg = paginas(buf);
    if (pg > MAX_PAG) return json(res, 413, { code: 'too_large', erro: 'O PDF tem ' + pg + ' páginas; o limite é ' + MAX_PAG + '. Separe as medições em arquivos menores.' });
    const itens = (Array.isArray(c.itens) ? c.itens : []).filter(i => i && (i.desc || +i.qtd));
    const pr = prompt(itens), auditCorpo = { input: pr, modelTier: 'complex', funcao: 'medicao-pdf' };
    const aud = (ok, extra) => { try { REG.auditar(conta, req, 'MEDICAO_PDF_IA', 'ctr/' + ctrId, null, Object.assign({ ctr: c.numero || ctrId, arquivo: arqId, paginas: pg, kb: Math.round(buf.length / 1024), ok: !!ok }, extra || {})); } catch (e) { } };
    let r;
    try { r = await F.ia({ input: pr }, { docs: [buf.toString('base64')], tier: 'complex' }); }
    catch (e) {
      REG.auditarIa(conta, req, auditCorpo, false, e.msg || e.message); aud(false, { erro: String(e.msg || e.message || '').slice(0, 200) });
      return json(res, e.st || 500, { code: e.code || (e.st === 503 ? 'capability_disabled' : 'upstream_error'), erro: e.st === 503 ? 'A IA não está configurada no servidor. Peça ao administrador para ligar a IA (ANTHROPIC_API_KEY).' : e.st === 429 ? 'A IA está com muitos pedidos agora (limite de uso). Tente de novo em alguns minutos.' : (e.msg || 'Falha na IA.') });
    }
    const j = jsonDe(r && r.text);
    if (!j || typeof j !== 'object') { REG.auditarIa(conta, req, auditCorpo, false, 'resposta fora do formato'); aud(false, { erro: 'resposta fora do formato' }); return json(res, 502, { code: 'transform_error', erro: 'A IA não devolveu a medição no formato esperado. Tente de novo ou lance a medição à mão.' }); }
    const d = normaliza(j);
    REG.auditarIa(conta, req, auditCorpo, true); aud(true, { itensLidos: d.itens.length });
    return json(res, 200, { ok: true, dados: d, paginas: pg, truncado: !!(r && r.truncated) });
  }
  /* ---------- regra da gravação (regras.js) ---------- */
  function antesMed(conta, req, id, velho, novo, erro, auditar) {
    if (!novo) return null;
    const vi = velho && velho.imp162 && typeof velho.imp162 === 'object' ? velho.imp162 : null;
    let ni = novo.imp162 && typeof novo.imp162 === 'object' ? novo.imp162 : null;
    if (!vi && !ni) return null;
    if (vi && !ni) { novo.imp162 = vi; ni = vi; } /* a marca da importação não some */
    if (!vi) { ni.porImp = conta.id; ni.emImp = Date.now(); ni.st = 'revisar'; delete ni.aprovPor; delete ni.aprovEm; } /* nasce em revisão; quem importou é quem gravou */
    else {
      ni.porImp = vi.porImp; ni.emImp = vi.emImp;
      if (vi.st === 'aprovada') { ni.st = 'aprovada'; ni.aprovPor = vi.aprovPor; ni.aprovEm = vi.aprovEm; }
      else if (ni.st === 'aprovada') { ni.aprovPor = conta.id; ni.aprovEm = Date.now();
        try { auditar(conta, req, 'MEDICAO_PDF_APROVADA', 'med/' + id, null, { importadaPor: vi.porImp || '', arquivo: (ni.arq && ni.arq.id) || '' }); } catch (e) { } }
      else { ni.st = 'revisar'; delete ni.aprovPor; delete ni.aprovEm; }
    }
    if (ni.st !== 'aprovada') {
      if ((novo.status || 'rascunho') !== 'rascunho') return erro('Medição importada de PDF ainda em revisão: use "Aprovar e criar medição" antes de aprovar.', 409);
      if (novo.aprovSt === 'enviada' && !(velho && velho.aprovSt === 'enviada')) return erro('Medição importada de PDF ainda em revisão: use "Aprovar e criar medição" antes de enviar para aprovação.', 409);
    }
    return null;
  }
  return { rota, antesMed, paginas, normaliza, prompt, MAX_MB, MAX_PAG };
};

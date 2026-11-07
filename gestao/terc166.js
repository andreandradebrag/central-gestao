'use strict';
/* v166 (relatorios/feito_v166.md): núcleo de "Terceiros e locações" — o MESMO arquivo roda no servidor (ajuste166.js) e vai
   embutido no navegador (patch148.py → V166C). Só contas e regras, sem banco: quem chama monta o contexto X
   { cfg (cfg/empresa), ter, tdc, tdoc, tterc, ctremp, medemp, loc, leq, rdo, notas, tnl, integ, proj, parc, hoje }.
   1. Empresa terceira (ter166, id = fornecedor do cadastro): documentos da empresa com tipo, arquivo, emissão e validade
      (tdc166 escopo 'emp'); certidões antigas do checklist mensal (tdoc) valem como aprovadas até a validade.
   2. Obrigações do mês por contrato (tdc166 escopo 'mes'): folha, FGTS, INSS (DCTFWeb/eSocial), holerites e ponto;
      situação entregue / aprovado / pendente / recusado. Folha e guias marcadas no tdoc antigo valem como aprovadas.
   3. Trabalhadores do terceiro (tterc + tdc166 escopo 'trab'): ASO, NRs da função (configurável), registro (CTPS/eSocial),
      CNH do operador, integração e ficha de EPI; "liberado" ou "não liberado" por obra (integração do cliente da obra).
   4. Locação de equipamentos (loc166 contrato, leq166 equipamento): valor previsto (dias × diária/semana/mês, o mais barato
      que cobre o período, + horas acima da franquia) e os alertas (fim do período e atraso).
   5. Pagamento: bloqueio(X, lanc) diz se a conta a pagar de um terceiro sob contrato está "Bloqueada por documentação" e o
      que falta exatamente (documento da empresa vencido, obrigação do mês não aprovada, trabalhador não liberado). */

const DOC_EMP = [ /* [chave, nome, tem validade, exigido por padrão, nome na lista de certidões (links oficiais)] */
  ['contrato', 'Contrato social (última alteração)', false, true, ''],
  ['cnpj', 'Cartão CNPJ', false, true, 'Cartão CNPJ'],
  ['cnd', 'CND federal (Receita/PGFN)', true, true, 'CND federal (Receita/PGFN)'],
  ['crf', 'CRF do FGTS', true, true, 'CRF do FGTS'],
  ['cndt', 'CNDT (débitos trabalhistas)', true, true, 'CNDT (débitos trabalhistas)'],
  ['estadual', 'Certidão estadual', true, true, 'Certidão estadual'],
  ['municipal', 'Certidão municipal', true, true, ''],
  ['falencia', 'Certidão de falência e recuperação judicial', true, false, 'Certidão de falência e recuperação judicial'],
  ['seguro', 'Apólice de seguro', true, false, ''],
  ['alvara', 'Alvará de funcionamento', true, false, ''],
  ['outro', 'Outro documento', true, false, '']];
const OBRIG = [['folha', 'Folha de pagamento do mês'], ['fgts', 'Guia e comprovante do FGTS (FGTS Digital)'], ['inss', 'Guia e comprovante do INSS (DCTFWeb/eSocial)'], ['holerites', 'Holerites dos trabalhadores da obra'], ['ponto', 'Ponto dos trabalhadores da obra']];
const DOC_TRAB = [['registro', 'Registro (CTPS digital ou eSocial)', false], ['aso', 'ASO', true], ['nr', 'Certificado de NR', true], ['cnh', 'CNH (operador)', true], ['integ', 'Integração de SST', true], ['epi', 'Ficha de EPI', true]];
const ST_DOC = { aguardando: ['Aguardando conferência', 'warn'], aprovado: ['Aprovado', 'pos'], recusado: ['Recusado', 'neg'], pendente: ['Pendente', 'neg'], entregue: ['Entregue', 'warn'] };
const LOC_ST = { aguardando: ['Aguardando retirada', ''], retirado: ['Na obra', 'acc'], devolvido: ['Devolvido', 'pos'] };
const VIST_PAD = ['Estrutura e lataria', 'Pneus ou esteiras', 'Vazamentos (óleo, combustível)', 'Comandos e painel', 'Iluminação e alarme de ré', 'Acessórios e manual', 'Limpeza'];
const NR_FUNC_PAD = [{ f: '*', nrs: ['NR-18'] }, { f: 'operador', nrs: ['NR-11', 'NR-12'] }, { f: 'montador', nrs: ['NR-35'] }, { f: 'eletric', nrs: ['NR-10'] }];

const s = v => String(v == null ? '' : v).trim();
const num = v => { if (typeof v === 'number') return isFinite(v) ? v : 0; const t = s(v).replace(/\s/g, ''); if (!t) return 0; const x = /,\d{1,4}$/.test(t) ? +t.replace(/\./g, '').replace(',', '.') : +t.replace(/,/g, ''); return isFinite(x) ? x : 0; };
const r2 = v => Math.round((+v || 0) * 100) / 100;
const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(s(d));
const ym = d => /^\d{4}-\d{2}/.test(s(d)) ? s(d).slice(0, 7) : '';
const maisDias = (d, n) => { const x = new Date(s(d).slice(0, 10) + 'T12:00:00Z'); if (isNaN(x)) return ''; x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dias = (a, b) => Math.round((Date.parse(s(b).slice(0, 10) + 'T12:00:00Z') - Date.parse(s(a).slice(0, 10) + 'T12:00:00Z')) / 864e5);
const maisMeses = (m, n) => { const p = s(m).split('-').map(Number); if (!p[0] || !p[1]) return ''; const i = p[0] * 12 + (p[1] - 1) + n; return Math.floor(i / 12) + '-' + String(i % 12 + 1).padStart(2, '0'); };
const br = d => dataOk(s(d).slice(0, 10)) ? s(d).slice(8, 10) + '/' + s(d).slice(5, 7) + '/' + s(d).slice(0, 4) : '';
const brYm = m => /^\d{4}-\d{2}$/.test(s(m)) ? s(m).slice(5, 7) + '/' + s(m).slice(0, 4) : '';
const norm = v => s(v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const digitos = v => s(v).replace(/\D/g, '');
/* LGPD: o CPF aparece sempre mascarado (só os 3 dígitos do meio e os 2 do fim) */
const mascCpf = v => { const d = digitos(v); return d.length === 11 ? '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9) : d ? '***' : ''; };
const uniq = a => [...new Set(a.filter(Boolean))];
/* a chave do cadastro antigo (SST › Trabalhadores terceiros) tem dois dígitos: NR-06 → nr_06, NR-35 → nr_35 */
const nrKey = t => { const m = s(t).match(/^NR\s*-?\s*(\d{1,2})/i); return m ? 'nr_' + String(+m[1]).padStart(2, '0') : 'nr_' + s(t); };
const nrCurto = t => { const m = s(t).match(/^NR\s*-?\s*(\d{1,2})/i); return m ? 'NR-' + String(+m[1]).padStart(2, '0') : s(t); };

function cfgPad(c) {
  c = c && typeof c === 'object' ? c : {};
  const ex = {}; DOC_EMP.forEach(d => { ex[d[0]] = c.exigEmp && typeof c.exigEmp[d[0]] === 'boolean' ? c.exigEmp[d[0]] : d[3]; }); ex.outro = false;
  const ob = {}; OBRIG.forEach(o => { ob[o[0]] = !(c.obrigExig && c.obrigExig[o[0]] === false); });
  const nf = Array.isArray(c.nrFunc) && c.nrFunc.length ? c.nrFunc.filter(x => x && s(x.f) && Array.isArray(x.nrs)).map(x => ({ f: s(x.f).slice(0, 60), nrs: uniq(x.nrs.map(n => nrCurto(s(n).toUpperCase()))).slice(0, 12) })) : NR_FUNC_PAD;
  const av = (Array.isArray(c.avisoDias) ? c.avisoDias : [30, 15, 0]).map(n => Math.round(+n)).filter(n => n >= 0 && n <= 120);
  return {
    avisoDias: uniq(av.length ? av : [30, 15, 0]).sort((a, b) => b - a), locAviso: Math.min(30, Math.max(0, Math.round(c.locAviso == null || c.locAviso === '' ? 3 : +c.locAviso || 0))),
    defas: Math.min(3, Math.max(0, Math.round(c.defas == null || c.defas === '' ? 1 : +c.defas || 0))), tolPct: Math.min(50, Math.max(0, c.tolPct == null || c.tolPct === '' ? 2 : +c.tolPct || 0)),
    exigeRegistro: c.exigeRegistro !== false, bloqDiario: c.bloqDiario !== false, locSemOpDocs: c.locSemOpDocs !== false, exigeTrab: c.exigeTrab !== false,
    operador: s(c.operador) || 'operador|motorista|munck|guindast|retro|escavad|empilhad', exigEmp: ex, obrigExig: ob, nrFunc: nf,
    vist: Array.isArray(c.vist) && c.vist.length ? c.vist.map(x => s(x).slice(0, 60)).filter(Boolean).slice(0, 30) : VIST_PAD.slice()
  };
}
const C6 = X => cfgPad((X.cfg || {}).ter166);
const nomeDoc = k => (DOC_EMP.find(d => d[0] === k) || [k, k])[1];
const nomeObrig = k => (OBRIG.find(d => d[0] === k) || [k, k])[1];
const nomeTrab = (k, nr) => k === 'nr' ? 'Certificado ' + (nrCurto(nr) || 'de NR') : (DOC_TRAB.find(d => d[0] === k) || [k, k])[1];
const temVal = k => { const d = DOC_EMP.find(x => x[0] === k); return d ? d[2] : true; };
/* o documento mais recente que serve (enviado por último) */
const maisNovo = L => L.slice().sort((a, b) => (+b.enviadoEm || 0) - (+a.enviadoEm || 0) || s(b.id).localeCompare(s(a.id)))[0] || null;

/* =================================================================== 1. documentos da empresa */
function exigidos(X, parcId) {
  const c = C6(X), t = (X.ter || []).find(x => x.id === parcId || x.parcId === parcId) || {}, ex = Object.assign({}, c.exigEmp);
  if (t.exig && typeof t.exig === 'object') Object.keys(t.exig).forEach(k => { if (k !== 'outro' && typeof t.exig[k] === 'boolean' && k in ex) ex[k] = t.exig[k]; });
  return ex;
}
const TD_LEGADO = { cnd: 'cnd', crf: 'crf', cndt: 'cndt' };
function empDoc(X, parcId, k) {
  const hoje = X.hoje, L = (X.tdc || []).filter(d => d.parcId === parcId && d.escopo === 'emp' && d.tipo === k && d.st !== 'cancelado');
  let ap = maisNovo(L.filter(d => d.st === 'aprovado')), ult = maisNovo(L);
  if (TD_LEGADO[k]) { /* certidão marcada no checklist mensal antigo (tdoc) */
    for (const t of (X.tdoc || [])) { const it = t && t.parcId === parcId && t.itens && t.itens[TD_LEGADO[k]]; if (it && it.ok && dataOk(it.val) && (!ap || s(it.val) > s(ap.validade))) ap = { id: 'tdoc_' + t.id, tipo: k, st: 'aprovado', validade: it.val, legado: true, arqs: it.arqs || [] }; }
  }
  const tv = temVal(k), valido = !!ap && (!tv || (dataOk(ap.validade) && ap.validade >= hoje));
  const d = ap && dataOk(ap.validade) ? dias(hoje, ap.validade) : null;
  let st = valido ? (d != null && d <= 30 ? 'vence' : 'ok') : ap ? 'vencido' : 'falta';
  const pend = ult && ult.st !== 'aprovado' && (!ap || (+ult.enviadoEm || 0) >= (+ap.enviadoEm || 0)) ? ult : null;
  return { k, nome: nomeDoc(k), ap, ult, pend, valido, st, validade: ap ? ap.validade || '' : '', dias: d };
}
function empDocs(X, parcId) { const ex = exigidos(X, parcId); return DOC_EMP.map(d => Object.assign(empDoc(X, parcId, d[0]), { exig: !!ex[d[0]] })); }
function empFaltas(X, parcId) {
  const out = [];
  for (const d of empDocs(X, parcId)) {
    if (!d.exig || d.valido) continue;
    const ag = d.pend && d.pend.st === 'aguardando' ? ' (enviado, aguardando conferência)' : d.pend && d.pend.st === 'recusado' ? ' (recusado: ' + s(d.pend.motivo).slice(0, 80) + ')' : '';
    out.push(d.ap ? d.nome + ' vencida em ' + br(d.ap.validade) + ag : d.nome + ' não entregue' + ag);
  }
  return out;
}

/* =================================================================== 2. obrigações do mês (por contrato) */
const ctrDe = (X, col, id) => col === 'loc166' ? (X.loc || []).find(x => x.id === id) : (X.ctremp || []).find(x => x.id === id);
const TD_MES = { folha: 'folha', fgts: 'gfgts', inss: 'gdctf' };
function mesItens(X, ctrCol, ctrId, parcId, mes) {
  const c = C6(X), L = (X.tdc || []).filter(d => d.escopo === 'mes' && d.ctrId === ctrId && (d.ctrCol || 'ctremp') === ctrCol && d.mes === mes && d.st !== 'cancelado');
  const td = (X.tdoc || []).find(t => t.id === 'td_' + parcId + '_' + mes);
  return OBRIG.map(([k, nome]) => {
    const ds = L.filter(d => d.tipo === k), ap = maisNovo(ds.filter(d => d.st === 'aprovado')), ult = maisNovo(ds);
    let st = ap ? 'aprovado' : ult ? (ult.st === 'aguardando' ? 'entregue' : ult.st) : 'pendente';
    if (st !== 'aprovado' && TD_MES[k] && td && td.itens && td.itens[TD_MES[k]] && td.itens[TD_MES[k]].ok) st = 'aprovado';
    return { k, nome, exig: c.obrigExig[k] !== false, st, doc: ult, ap, motivo: ult && ult.st === 'recusado' ? s(ult.motivo) : '' };
  });
}
function mesFaltas(X, ctrCol, ctrId, parcId, mes, temTrab) {
  return mesItens(X, ctrCol, ctrId, parcId, mes).filter(i => i.exig && i.st !== 'aprovado' && (temTrab || !['holerites', 'ponto'].includes(i.k)))
    .map(i => i.nome + ' de ' + brYm(mes) + ': ' + (i.st === 'pendente' ? 'não entregue' : i.st === 'entregue' ? 'aguardando conferência' : 'recusado' + (i.motivo ? ' (' + i.motivo.slice(0, 80) + ')' : '')));
}

/* =================================================================== 3. trabalhadores */
function nrsDaFuncao(c, funcao) {
  const f = norm(funcao), out = [];
  for (const r of c.nrFunc) { const k = norm(r.f); if (k === '*' || (k && f.includes(k))) out.push(...r.nrs); }
  return uniq(out);
}
const ehOperador = (c, funcao) => { try { return new RegExp(c.operador, 'i').test(norm(funcao)); } catch (e) { return /operador/.test(norm(funcao)); } };
/* pendências do trabalhador (as mensagens do ASO, integração, EPI e NRs são as mesmas da tela antiga de SST) */
function trabPend(cfgEmp, t, hoje, extra) {
  const out = []; if (!t) return out; const c = cfgPad((cfgEmp || {}).ter166);
  if (!t.asoVal) out.push('sem ASO'); else if (t.asoVal < hoje) out.push('ASO vencido');
  if (!t.integVal) out.push('sem integração'); else if (t.integVal < hoje) out.push('integração vencida');
  if (!t.epiVal) out.push('sem ficha de EPI'); else if (t.epiVal < hoje) out.push('EPI vencido');
  const mat = ((cfgEmp || {}).matrizTrein || {})[t.funcao || ''] || [];
  const req = uniq(mat.concat(extra || []).concat(nrsDaFuncao(c, t.funcao)));
  const reqK = new Set(req.map(nrKey));
  const visto = new Set();
  req.forEach(nr => { const k = nrKey(nr); if (visto.has(k)) return; visto.add(k); const v = t[k]; if (!v) out.push(nrCurto(nr) + ' falta'); else if (v < hoje) out.push(nrCurto(nr) + ' vencido'); });
  Object.keys(t).filter(k => /^nr_\d+$/.test(k) && !reqK.has(k)).sort().forEach(k => { const v = t[k]; if (v && dataOk(v) && v < hoje) out.push('NR-' + k.slice(3) + ' vencido'); });
  if (c.exigeRegistro && !s(t.registro166)) out.push('sem registro (CTPS digital ou eSocial)');
  if (ehOperador(c, t.funcao)) { if (!s(t.cnhCat166) || !t.cnhVal166) out.push('sem CNH (operador)'); else if (t.cnhVal166 < hoje) out.push('CNH vencida'); }
  return out;
}
/* integração do cliente da obra: se a obra (ou o cliente) tem integração externa registrada, o trabalhador precisa estar nela */
function integObra(X, t, projId) {
  if (!projId) return '';
  const p = (X.proj || []).find(x => x.id === projId), ex = (X.integ || []).filter(i => i && i.tipo === 'externa' && ((p && p.parcId && i.parcId === p.parcId) || i.projId === projId));
  if (!ex.length) return '';
  const meu = ex.filter(i => i.tercId === t.id || (Array.isArray(i.tercIds) && i.tercIds.includes(t.id))).sort((a, b) => s(b.validade || '9999').localeCompare(s(a.validade || '9999')))[0];
  if (!meu) return 'sem integração do cliente da obra'; if (meu.validade && meu.validade < X.hoje) return 'integração do cliente vencida'; return '';
}
function trabStatus(X, t, projId) {
  if (!t) return { lib: false, motivos: ['trabalhador não cadastrado'] };
  const m = trabPend(X.cfg, t, X.hoje);
  if (t.ativo === false) m.unshift('inativo');
  if (projId && t.projId && t.projId !== projId) m.push('ligado a outra obra');
  const io = integObra(X, t, projId); if (io) m.push(io);
  return { lib: !m.length, motivos: uniq(m) };
}
const tercsDe = (X, parcId) => (X.tterc || []).filter(t => t.parcId === parcId);
/* trabalhadores do contrato no período: os ativos do cadastro (da obra ou de todas as obras) e os que estiveram no diário da obra no mês */
function trabsPeriodo(X, alvo) {
  const ids = new Set(), out = [];
  const add = t => { if (t && !ids.has(t.id)) { ids.add(t.id); out.push(t); } };
  if (alvo.tipo === 'loccom') { const lc = (X.loc || []).find(x => x.id === alvo.ctrId); (lc && Array.isArray(lc.operadores) ? lc.operadores : []).forEach(id => add((X.tterc || []).find(t => t.id === id))); }
  else if (alvo.tipo === 'serv') tercsDe(X, alvo.parcId).filter(t => t.ativo !== false && (!t.projId || !alvo.projId || t.projId === alvo.projId)).forEach(add);
  if (alvo.mes && alvo.projId && alvo.tipo !== 'locsem') for (const r of (X.rdo || [])) {
    if (r.projId !== alvo.projId || ym(r.data) !== alvo.mes) continue;
    (Array.isArray(r.efetivo) ? r.efetivo : []).forEach(x => { if (x && x.tercId) { const t = (X.tterc || []).find(w => w.id === x.tercId); if (t && t.parcId === alvo.parcId) add(t); } });
  }
  return out;
}

/* =================================================================== 4. locação */
/* o menor custo que cobre n dias com diária, semana (7) e mês (30): pode sair mais barato fechar uma semana para 5 dias */
function custoDias(n, eq) {
  n = Math.max(0, Math.round(n)); if (!n) return 0;
  const T = [[1, num(eq.vDia)], [7, num(eq.vSem)], [30, num(eq.vMes)]].filter(x => x[1] > 0); if (!T.length) return 0;
  const c = [0]; for (let i = 1; i <= n; i++) { let b = Infinity; for (const [l, v] of T) b = Math.min(b, c[Math.max(0, i - l)] + v); c[i] = b; }
  return r2(c[n]);
}
const inicioEq = eq => (eq.ret && dataOk(eq.ret.data) ? eq.ret.data : '') || s(eq.ini);
const fimEq = (eq, hoje) => eq.st === 'devolvido' && eq.dev && dataOk(eq.dev.data) ? eq.dev.data : hoje;
/* horas de uso: as do diário de obra (equipamento locado escolhido na linha) ou, sem diário, a diferença do horímetro */
function horasEq(X, eq, de, ate) {
  let h = 0, tem = false;
  const obras = new Set([eq.projId].concat((eq.guardaHist || []).flatMap(g => g ? [g.de && g.de.projId, g.para && g.para.projId] : [])).filter(Boolean)); /* transferido entre obras: vale o diário de cada uma */
  for (const r of (X.rdo || [])) { if (r.projId && obras.size && !obras.has(r.projId)) continue; if (de && r.data < de) continue; if (ate && r.data > ate) continue;
    (Array.isArray(r.equip) ? r.equip : []).forEach(x => { if (x && x.leqId === eq.id) { h += num(x.horas); tem = true; } }); }
  if (!tem && eq.ret && eq.dev && num(eq.dev.hor) > num(eq.ret.hor)) { h = num(eq.dev.hor) - num(eq.ret.hor); }
  return Math.round(h * 10) / 10;
}
function previsto(X, eq, de, ate) {
  const ini = inicioEq(eq); if (!dataOk(ini)) return { dias: 0, aluguel: 0, horas: 0, franquia: 0, excedentes: 0, valorExc: 0, total: 0, de: '', ate: '' };
  const a = dataOk(de) && de > ini ? de : ini, f0 = fimEq(eq, X.hoje), b = dataOk(ate) && ate < f0 ? ate : f0;
  const n = b >= a ? dias(a, b) + 1 : 0, alug = custoDias(n, eq), h = horasEq(X, eq, a, b);
  const fr = Math.round(num(eq.franqH) * n / 30 * 10) / 10, ex = Math.max(0, Math.round((h - fr) * 10) / 10), vx = r2(ex * num(eq.vHoraExc));
  return { dias: n, aluguel: alug, horas: h, franquia: fr, excedentes: ex, valorExc: vx, total: r2(alug + vx), de: a, ate: b };
}
function eqAlerta(X, eq) {
  if (eq.st !== 'retirado' || !dataOk(eq.fim)) return null;
  const d = dias(X.hoje, eq.fim), c = C6(X);
  if (d < 0) return { k: 'atraso', dias: -d, txt: 'Devolução atrasada há ' + (-d) + ' dia(s) (fim do período em ' + br(eq.fim) + '): cada dia a mais é cobrado.' };
  if (d <= c.locAviso) return { k: 'fim', dias: d, txt: d === 0 ? 'O período termina hoje: devolva ou renove para não pagar dias a mais.' : 'O período termina em ' + d + ' dia(s) (' + br(eq.fim) + '): devolva ou renove.' };
  return null;
}
const locTipo = (X, eq) => { const l = (X.loc || []).find(x => x.id === eq.locId); return l && l.tipo === 'com' ? 'loccom' : 'locsem'; };

/* =================================================================== 5. bloqueio do pagamento */
function notaValor(n) { if (!n) return 0; if (n.total != null && num(n.total) > 0) return r2(num(n.total)); const it = Array.isArray(n.itens) ? n.itens : []; return r2(it.reduce((t, i) => t + num(i.qtd) * num(i.vUnit), 0) + num(n.frete) + num(n.outras) + num(n.ipi) - num(n.desconto)); }
function eqsDaNota(X, notaId) { return (X.leq || []).filter(e => Array.isArray(e.notas166) && e.notas166.some(x => x && x.notaId === notaId)); }
/* de que contrato de terceiro é esta conta a pagar (medição de empreiteiro, contrato ou nota do locador) */
function alvoDoLanc(X, l) {
  if (!l || l.tipo !== 'pagar' || l.status === 'cancelado') return null;
  if (l.retPendDe && l.retLib && l.retLib.modo === 'compensar') return null; /* retido usado para quitar a guia/folha do terceiro: o dinheiro não vai ao terceiro */
  const medId = s(l.medempId || l.retPendDe), ctrId = s(l.ctrempId);
  if (medId || ctrId) {
    const m = medId ? (X.medemp || []).find(x => x.id === medId) : null, c = (X.ctremp || []).find(x => x.id === (m && m.ctrId ? m.ctrId : ctrId));
    if (!c || !c.parcId) return null;
    return { tipo: 'serv', parcId: c.parcId, ctrCol: 'ctremp', ctrId: c.id, projId: s(c.projId || (m && m.projId)), mes: ym((m && (m.fim || m.ini || m.data)) || l.comp || l.venc), ref: m ? 'Medição nº ' + s(m.numero) : 'Contrato ' + s(c.numero) };
  }
  if (l.notaId) {
    const n = (X.notas || []).find(x => x.id === l.notaId); if (!n) return null;
    const es = eqsDaNota(X, n.id), mes = ym(n.emissao || n.data || l.venc);
    if (es.length) { const e = es[0], lc = (X.loc || []).find(x => x.id === e.locId); return { tipo: locTipo(X, e), parcId: s(e.parcId || (lc && lc.parcId) || n.parcId), ctrCol: 'loc166', ctrId: s(e.locId), projId: s(e.projId), mes, eqIds: es.map(x => x.id), notaId: n.id, ref: 'Nota nº ' + s(n.numero) + ' da locação ' + s(lc && lc.numero) }; }
    if ((X.tnl || []).some(x => x.id === n.id)) return null; /* marcada como "não é da locação" por quem concilia */
    const lcs = (X.loc || []).filter(x => x.parcId === n.parcId && x.st !== 'encerrado' && x.st !== 'cancelado');
    if (lcs.length) return { tipo: 'locnc', parcId: s(n.parcId), ctrCol: 'loc166', ctrId: lcs[0].id, projId: s(lcs[0].projId), mes, notaId: n.id, ref: 'Nota nº ' + s(n.numero) };
  }
  return null;
}
function faltasAlvo(X, alvo) {
  const c = C6(X), out = [];
  if (alvo.tipo === 'locnc') out.push('Nota do locador ainda não conciliada com a locação, o equipamento e a obra (Terceiros e locações › Locações › Conciliar nota)');
  if (alvo.tipo !== 'locsem' && alvo.tipo !== 'locnc' || c.locSemOpDocs) empFaltas(X, alvo.parcId).forEach(f => out.push('Empresa: ' + f));
  if (alvo.tipo === 'serv' || alvo.tipo === 'loccom') {
    const ts = trabsPeriodo(X, alvo), mesRef = alvo.mes ? maisMeses(alvo.mes, -c.defas) : '';
    if (mesRef) mesFaltas(X, alvo.ctrCol, alvo.ctrId, alvo.parcId, mesRef, ts.length > 0).forEach(f => out.push('Obrigação do mês: ' + f));
    if (!ts.length && alvo.tipo === 'serv' && c.exigeTrab && (((X.cfg || {}).rhx || {}).tdExigeTrab !== false)) out.push('Nenhum trabalhador do terceiro cadastrado para a obra');
    if (!ts.length && alvo.tipo === 'loccom') out.push('Locação com operador sem operador cadastrado');
    ts.forEach(t => { const st = trabStatus(X, t, alvo.projId); if (!st.lib) out.push('Trabalhador ' + s(t.nome) + (t.cpf ? ' (' + mascCpf(t.cpf) + ')' : '') + ' não liberado: ' + st.motivos.join(', ')); });
  }
  return out;
}
function bloqueio(X, l) {
  const alvo = alvoDoLanc(X, l); if (!alvo) return { sob: false, bloq: false, faltas: [] };
  const faltas = faltasAlvo(X, alvo), lib = l.lib166 && l.lib166.srv ? l.lib166 : null;
  return { sob: true, alvo, faltas, bloq: faltas.length > 0 && !lib, lib };
}

/* =================================================================== 6. painel */
function painel(X, mesRef) {
  const c = C6(X), hoje = X.hoje, mes = mesRef || maisMeses(ym(hoje), -c.defas), lim = Math.max(30, ...c.avisoDias);
  const docsVenc = [];
  const parcs = uniq((X.ter || []).filter(t => t.ativo !== false).map(t => t.parcId || t.id).concat((X.ctremp || []).filter(x => x.status === 'vigente').map(x => x.parcId)).concat((X.loc || []).filter(x => x.st !== 'encerrado').map(x => x.parcId)));
  for (const p of parcs) for (const d of empDocs(X, p)) { if (!d.exig) continue; if (!d.valido || (d.dias != null && d.dias <= lim)) docsVenc.push({ parcId: p, k: d.k, nome: d.nome, validade: d.validade, dias: d.dias, st: d.st }); }
  for (const t of (X.tterc || [])) { if (t.ativo === false) continue; [['asoVal', 'ASO'], ['integVal', 'Integração'], ['epiVal', 'Ficha de EPI'], ['cnhVal166', 'CNH']].concat(Object.keys(t).filter(k => /^nr_\d+$/.test(k)).map(k => [k, 'NR-' + k.slice(3)])).forEach(([k, n]) => { const v = t[k]; if (dataOk(v) && dias(hoje, v) <= lim) docsVenc.push({ parcId: t.parcId, tercId: t.id, nomeT: t.nome, nome: n, validade: v, dias: dias(hoje, v), st: v < hoje ? 'vencido' : 'vence' }); }); }
  docsVenc.sort((a, b) => (a.dias == null ? -1e9 : a.dias) - (b.dias == null ? -1e9 : b.dias));
  const porObra = {}, devPrev = [], devAtr = [];
  for (const e of (X.leq || [])) {
    if (e.st === 'retirado') { const pv = previsto(X, e, '', hoje), o = porObra[e.projId || ''] = porObra[e.projId || ''] || { projId: e.projId || '', eqs: [], custo: 0 }; o.eqs.push({ id: e.id, desc: e.desc, tipo: e.tipo, parcId: e.parcId, dias: pv.dias, custo: pv.total, fim: e.fim }); o.custo = r2(o.custo + pv.total); }
    const a = eqAlerta(X, e); if (a && a.k === 'atraso') devAtr.push({ id: e.id, desc: e.desc, projId: e.projId, parcId: e.parcId, fim: e.fim, dias: a.dias });
    else if (e.st === 'retirado' && dataOk(e.fim) && dias(hoje, e.fim) <= 7) devPrev.push({ id: e.id, desc: e.desc, projId: e.projId, parcId: e.parcId, fim: e.fim, dias: dias(hoje, e.fim) });
  }
  const naoLib = [];
  for (const t of (X.tterc || [])) { if (t.ativo === false) continue; const st = trabStatus(X, t, t.projId || ''); if (!st.lib) naoLib.push({ id: t.id, nome: t.nome, cpf: mascCpf(t.cpf), funcao: t.funcao || '', parcId: t.parcId, projId: t.projId || '', motivos: st.motivos }); }
  const obrPend = [];
  const ctrs = (X.ctremp || []).filter(x => x.status === 'vigente' && x.parcId).map(x => ({ col: 'ctremp', id: x.id, parcId: x.parcId, projId: x.projId || '', nome: 'Contrato ' + s(x.numero), tipo: 'serv' }))
    .concat((X.loc || []).filter(x => x.tipo === 'com' && x.st !== 'encerrado').map(x => ({ col: 'loc166', id: x.id, parcId: x.parcId, projId: x.projId || '', nome: 'Locação ' + s(x.numero), tipo: 'loccom' })));
  for (const k of ctrs) { const ts = trabsPeriodo(X, { tipo: k.tipo, parcId: k.parcId, ctrId: k.id, projId: k.projId, mes }); const it = mesItens(X, k.col, k.id, k.parcId, mes).filter(i => i.exig && i.st !== 'aprovado' && (ts.length || !['holerites', 'ponto'].includes(i.k))); if (it.length) obrPend.push({ ctrCol: k.col, ctrId: k.id, parcId: k.parcId, projId: k.projId, nome: k.nome, mes, itens: it.map(i => ({ k: i.k, nome: i.nome, st: i.st, motivo: i.motivo })) }); }
  const bloq = [];
  for (const l of (X.lanc || [])) { if (l.tipo !== 'pagar' || l.pago || l.status === 'cancelado') continue; const b = bloqueio(X, l); if (b.sob && (b.bloq || b.lib)) bloq.push({ id: l.id, desc: l.desc, valor: +l.valor || 0, venc: l.venc, parcId: b.alvo.parcId, ref: b.alvo.ref, faltas: b.faltas, lib: !!b.lib }); }
  const aguard = (X.tdc || []).filter(d => d.st === 'aguardando').length;
  return { mes, docsVenc, porObra: Object.values(porObra), devPrev: devPrev.sort((a, b) => a.dias - b.dias), devAtr: devAtr.sort((a, b) => b.dias - a.dias), naoLib, obrPend, bloq, aguard };
}

module.exports = { DOC_EMP, OBRIG, DOC_TRAB, ST_DOC, LOC_ST, VIST_PAD, NR_FUNC_PAD, cfgPad, C6, s, num, r2, br, brYm, ym, dias, maisDias, maisMeses, dataOk, norm, mascCpf, uniq, nrKey, nrCurto,
  nomeDoc, nomeObrig, nomeTrab, temVal, exigidos, empDoc, empDocs, empFaltas, mesItens, mesFaltas, nrsDaFuncao, ehOperador, trabPend, integObra, trabStatus, tercsDe, trabsPeriodo,
  custoDias, previsto, horasEq, eqAlerta, locTipo, notaValor, eqsDaNota, alvoDoLanc, faltasAlvo, bloqueio, painel, ctrDe, maisNovo };

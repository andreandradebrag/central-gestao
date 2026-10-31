/* v140 (relatorios/feito_v140_p2p.md): contas da nota de entrada conferidas pelo servidor.
   Funções puras, iguais às do navegador (app: notaTotais, supConf, supSemPed), para o servidor revalidar as travas do
   lançamento da nota (rota POST /api/nota/lancar em regras.js) sem confiar no que o navegador calculou.
   O teste t/run_p2p.js compara o resultado daqui com o do navegador (mesma assinatura da divergência). */
'use strict';
const r2 = v => Math.round((+v || 0) * 100) / 100;
const r4 = v => Math.round((+v || 0) * 10000) / 10000;
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const TAXES = [['iss', 'ISS', 'rIss'], ['irrf', 'IRRF', 'rIrrf'], ['pis', 'PIS', 'rPis'], ['cofins', 'COFINS', 'rCofins'], ['csll', 'CSLL', 'rCsll'], ['inss', 'INSS', 'rInss']];
const soma = (a, f) => (a || []).reduce((s, x) => s + (+f(x) || 0), 0);

function notaTotais(n) {
  const vProd = r2(soma(n.itens, i => (+i.qtd || 0) * (+i.vUnit || 0)));
  const vNF = r2(vProd + (+n.frete || 0) + (+n.outras || 0) + (+n.ipi || 0) - (+n.desconto || 0));
  let ret = 0; TAXES.forEach(x => { ret += r2(vProd * (+n[x[2]] || 0) / 100); });
  return { vProd, vNF, ret: r2(ret) };
}

/* regras de compras (cfg da empresa), com os mesmos padrões do navegador (SUP_DEF, SUP_QUA) */
const SUP_DEF = { supTolPreco: 2, supTolQtd: 5, supSemPedMin: 1000 };
const SUP_QUA = { supTolPreco: ['tolNota', 2], supTolQtd: ['tolNotaQtd', 0] };
const SUP_ISENTAS_DEF = 'consumo, impostos, aluguel, utilidades, energia, água, telefone, internet';
function supCfg(c) {
  c = c || {}; const q = c.qua || {}, o = {};
  Object.keys(SUP_DEF).forEach(k => {
    let v = c[k];
    if ((v === '' || v == null) && SUP_QUA[k]) { const x = q[SUP_QUA[k][0]]; if (x !== '' && x != null && isFinite(+x) && +x >= 0 && +x !== SUP_QUA[k][1]) v = +x; }
    o[k] = (v === '' || v == null || isNaN(+v)) ? SUP_DEF[k] : +v;
  });
  o.supSemPedIsentas = c.supSemPedIsentas == null ? SUP_ISENTAS_DEF : String(c.supSemPedIsentas);
  return o;
}

/* conferência pedido x recebimento x nota (cópia de supConf do navegador) */
const recs = p => Array.isArray(p && p.recebs) ? p.recebs : [];
const recQ = (p, k, excl) => soma(recs(p).filter(r => r.id !== excl), r => soma((r.itens || []).filter(x => +x.k === k), x => +x.qtd || 0));
function saldo(p, k, excl) { const it = (p.itens || [])[k]; if (!it) return 0; if (p.status === 'recebido' && !recs(p).length) return 0; return Math.max(0, r4((+it.qtd || 0) - recQ(p, k, excl))); }
function matchK(it, p) {
  const its = p.itens || []; if (it.pedK != null && it.pedK !== '') { const k = +it.pedK; return its[k] || k === -1 ? k : -1; }
  let k = -1; if (it.prodId && it.prodId !== '__new') k = its.findIndex(x => x.prodId === it.prodId);
  if (k < 0 && it.sku) k = its.findIndex(x => x.cod && norm(x.cod) === norm(it.sku));
  if (k < 0) k = its.findIndex(x => norm(x.desc) === norm(it.desc)); return k;
}
function supConf(n, p, cfgEmp) {
  if (!p) return null;
  const c = supCfg(cfgEmp), tp = c.supTolPreco / 100, tq = c.supTolQtd / 100;
  const rec = n.recebId ? recs(p).find(r => r.id === n.recebId) || null : null;
  const ref = k => rec ? soma((rec.itens || []).filter(x => +x.k === k), x => +x.qtd || 0) : saldo(p, k);
  const items = (n.xmlItens || n.itens || []).filter(i => i.desc && (+i.qtd > 0));
  const agg = new Map(), fora = [];
  items.forEach(it => { const k = matchK(it, p); if (k < 0) { fora.push(it); return; } const a = agg.get(k) || { q: 0, v: 0 }; a.q += +it.qtd || 0; a.v += (+it.qtd || 0) * (+it.vUnit || 0); agg.set(k, a); });
  const rows = [];
  const legado = !n.recebId && !n.chave && !n.recebida && !n.xmlItens;
  (p.itens || []).forEach((pi, k) => {
    const a = agg.get(k), qn = a ? r4(a.q) : 0, qr = legado ? qn : r4(ref(k)); if (!a && !(rec && qr > 0)) return;
    const pn = a && a.q > 0 ? a.v / a.q : null, pp = +pi.vUnit || 0;
    const divP = pn != null && pn > pp * (1 + tp) + 0.005;
    const divQ = legado ? false : rec ? Math.abs(qn - qr) > qr * tq + 1e-9 : qn > qr * (1 + tq) + 1e-9;
    rows.push({ k, desc: pi.desc, qNota: qn, pNota: pn, divP, divQ, fora: false });
  });
  fora.forEach(it => rows.push({ k: -1, desc: it.desc, qNota: +it.qtd || 0, pNota: +it.vUnit || 0, divP: false, divQ: false, fora: true }));
  const dv = rows.filter(r => r.divP || r.divQ || r.fora);
  const sig = JSON.stringify([p.id, n.recebId || '', dv.map(r => [r.k, r.desc, r2(r.qNota), r2(r.pNota || 0)])]);
  return { div: dv.length, sig, rec };
}

/* nota de entrada sem pedido acima do valor: exige motivo e justificativa (supSemPed do navegador) */
function semPed(n, cfgEmp) {
  if (!n || n.tipo !== 'entrada' || n.pedId || n.status === 'cancelada' || n.ex) return null;
  const c = supCfg(cfgEmp); if (!(c.supSemPedMin > 0)) return null;
  const v = notaTotais(n).vNF, cat = norm(n.categoria || '');
  const isenta = !!cat && String(c.supSemPedIsentas || '').split(/[,;\n]/).map(x => norm(x).trim()).filter(Boolean).some(w => cat.includes(w));
  if (!(v > c.supSemPedMin + 0.004) || isenta) return null;
  return { valor: r2(v), min: c.supSemPedMin, ok: !!(n.semPedMotivo && String(n.semPedJust || '').trim()) };
}

/* conta criada pela conciliação que não precisa de aprovação: pela CATEGORIA (tarifa bancária, impostos e guias) ou
   transferência entre contas. A descrição não conta (não basta escrever "guia" num pagamento a fornecedor). */
const CONC_LIVRE = /tarifa|taxa banc|despesa(s)? banc|iof|cesta de servic|manutencao de conta|imposto|tribut|guia|darf|\bdas\b|gps|fgts|inss|irrf|\biss\b|\bpis\b|cofins|csll|icms|ipva|iptu|retid/;
const concLivre = l => !!(l && (l.criadoPorExtrato || l.concExt) && (l.transf || CONC_LIVRE.test(norm(l.categoria || ''))));

module.exports = { r2, norm, notaTotais, supCfg, supConf, semPed, concLivre, CONC_LIVRE };

/* ===================== v141 (relatorios/feito_v141_p2p2.md) =====================
   1. autoFalta: o que falta para a nota ser lançada sozinha (XML ligado a um único pedido, recebimento físico registrado,
      conferência em três pontas sem divergência, sem item fora do pedido, sem divergência pendente). Duplicidade, aprovação
      do pedido e as demais travas continuam na rota (travas de regras.js).
   2. pequena: compra pequena sem pedido (até o limite, padrão = supSemPedMin): exige categoria, projeto e a aprovação simples
      do nível 1. Não vale para nota criada antes da ativação (cfg.p2pPequenaEm) nem para as categorias isentas.
   3. meCalc / retConf: retenções da medição do empreiteiro (cópia do meCalc do navegador) comparadas com as da NFS-e.
   4. devCalc: valores da devolução ao fornecedor (itens, custo de entrada, líquido a abater). */
function autoFalta(n, p, cfgEmp) {
  const m = [], c = cfgEmp || {};
  if (c.p2pAuto === false) m.push('O lançamento automático está desligado (Suprimentos › Recebimento de notas › Regras).');
  if (!n || n.tipo !== 'entrada') { m.push('Só nota de entrada é lançada automaticamente.'); return m; }
  if (n.ex) m.push('Nota de exemplo.');
  if (!String(n.chave || '').replace(/\D/g, '')) m.push('A nota não veio por XML (sem chave de acesso).');
  if (!n.pedId) { m.push('A nota não está ligada a um pedido de compra.'); return m; }
  if (!p) { m.push('O pedido ligado à nota não foi encontrado.'); return m; }
  if (p.status === 'cancelado') m.push('O pedido está cancelado.');
  if (!n.recebId || !recs(p).some(r => r.id === n.recebId)) m.push('Falta o recebimento físico do pedido nº ' + (p.numero || '') + '.');
  const cf = supConf(n, p, c);
  if (cf && cf.div) m.push('A conferência pedido × recebimento × nota tem ' + cf.div + ' divergência(s) (preço, quantidade ou item fora do pedido).');
  if (n.confPend) m.push('Há divergência do XML aguardando aprovação.');
  return m;
}
const ISENTA = (cat, c) => { const k = norm(cat || ''); return !!k && String(c.supSemPedIsentas || '').split(/[,;\n]/).map(x => norm(x).trim()).filter(Boolean).some(w => k.includes(w)); };
function pequenaCfg(cfgEmp) { const c = cfgEmp || {}, s = supCfg(c); const lim = c.p2pPequenaAte === '' || c.p2pPequenaAte == null || isNaN(+c.p2pPequenaAte) ? s.supSemPedMin : +c.p2pPequenaAte; return { ativo: c.p2pPequena !== false, lim: r2(lim), em: +c.p2pPequenaEm || 0, isentas: s.supSemPedIsentas }; }
/* n: nota (pacote ou guardada); cr: data de criação guardada no servidor; aprov: aprovação guardada (nunca a do pacote) */
function pequena(n, cfgEmp, cr, aprov) {
  if (!n || n.tipo !== 'entrada' || n.pedId || n.status === 'cancelada' || n.ex || n.medempId) return null;
  const q = pequenaCfg(cfgEmp); if (!q.ativo || !(q.lim > 0)) return null;
  if (!q.em || !(+cr >= q.em)) return null; /* nota criada antes da regra (a data de ativação é gravada pelo servidor na subida) */
  const v = notaTotais(n).vNF; if (!(v > 0) || v > q.lim + 0.004 || ISENTA(n.categoria, { supSemPedIsentas: q.isentas })) return null;
  const temProj = !!(n.projId || (Array.isArray(n.rateioProj) && n.rateioProj.length) || n.comum);
  const falta = []; if (!String(n.categoria || '').trim()) falta.push('categoria'); if (!temProj) falta.push('projeto');
  const a = aprov && aprov.ok ? aprov : null, aprovOk = !!(a && v <= (+a.valor || 0) + 0.01);
  return { valor: r2(v), lim: q.lim, falta, aprov: aprovOk, aprovMenor: !!(a && !aprovOk) };
}
/* medição do empreiteiro (navegador: meCalc) */
function meCalc(m, c) {
  if (m && m.fixo && m.status === 'aprovada') return Object.assign({}, m.fixo);
  c = c || {}; const its = Array.isArray(c.itens) ? c.itens : [];
  const bruto = r2(soma(m && m.itens, x => (+x.qtd || 0) * (+((its[+x.i] || {}).pu) || 0)));
  const ret = r2(bruto * (+c.retPct || 0) / 100), inss = c.retInss ? r2(bruto * ((c.inssBase === '' || c.inssBase == null) ? 100 : +c.inssBase) / 100 * 0.11) : 0, iss = r2(bruto * (+c.issPct || 0) / 100), aj = r2(+(m && m.ajuste) || 0);
  return { bruto, ret, inss, iss, aj, liq: r2(bruto - ret - inss - iss - aj) };
}
/* retenções da NFS-e (ret: {iss, inss, irrf, csll, pis, cofins}) contra as calculadas na medição; tolerância de R$ 0,05 */
const RET_NOMES = [['iss', 'ISS'], ['inss', 'INSS'], ['irrf', 'IR'], ['csll', 'CSLL'], ['pis', 'PIS'], ['cofins', 'COFINS']];
function retConf(nf, k, tol) {
  tol = tol == null ? 0.05 : +tol; const r = (nf && nf.ret) || {}, med = { iss: +k.iss || 0, inss: +k.inss || 0, irrf: 0, csll: 0, pis: 0, cofins: 0 }, div = [];
  for (const [x, nome] of RET_NOMES) { const a = r2(r[x]), b = r2(med[x]); if (Math.abs(a - b) > tol + 1e-9) div.push({ imp: x, nome, nota: a, med: b }); }
  if (nf && +nf.bruto > 0 && Math.abs(r2(nf.bruto) - r2(k.bruto)) > Math.max(tol, r2(k.bruto) * 0.005)) div.push({ imp: 'bruto', nome: 'Valor bruto', nota: r2(nf.bruto), med: r2(k.bruto) });
  return div;
}
/* devolução: itens [{k, qtd}] da nota lançada n; movs: movimentos de entrada da nota (para o custo de entrada) */
function devCalc(n, itens, movs) {
  const t = notaTotais(n), fat = t.vProd > 0 ? t.vNF / t.vProd : 1, its = n.itens || [], ja = new Map();
  (Array.isArray(n.devols) ? n.devols : []).forEach(d => (d.itens || []).forEach(x => ja.set(+x.k, (ja.get(+x.k) || 0) + (+x.qtd || 0))));
  const out = [], erros = []; let bruto = 0;
  for (const x of itens || []) {
    const k = +x.k, q = Math.round((+x.qtd || 0) * 10000) / 10000, it = its[k];
    if (!it) { erros.push('Item ' + (k + 1) + ' não existe na nota.'); continue; }
    if (!(q > 0)) continue;
    const disp = Math.round(((+it.qtd || 0) - (ja.get(k) || 0)) * 10000) / 10000;
    if (q > disp + 1e-9) { erros.push('Item ' + (k + 1) + ' (' + (it.desc || '') + '): devolução de ' + q + ', mas só restam ' + disp + ' na nota.'); continue; }
    const mv = it.prodId ? (movs || []).find(m => m.prodId === it.prodId && m.tipo === 'entrada' && !m.recProv) : null;
    const custo = mv ? +mv.custoUnit || 0 : r4((+it.vUnit || 0) * fat);
    const valor = r2(q * (+it.vUnit || 0) * fat);
    bruto += valor; out.push({ k, qtd: q, prodId: it.prodId || '', desc: it.desc || '', custo: r4(custo), valor, pedK: it.pedK });
  }
  bruto = r2(bruto);
  const ret = t.vNF > 0 ? r2(t.ret * bruto / t.vNF) : 0;
  return { itens: out, erros, bruto, ret, liquido: r2(bruto - ret) };
}
const r4x = r4;
module.exports.autoFalta = autoFalta; module.exports.pequena = pequena; module.exports.pequenaCfg = pequenaCfg; module.exports.meCalc = meCalc;
module.exports.retConf = retConf; module.exports.devCalc = devCalc; module.exports.RET_NOMES = RET_NOMES; module.exports.r4 = r4x;
/* ===================== fim v141 ===================== */

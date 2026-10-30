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

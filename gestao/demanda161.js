'use strict';
/* v161 (relatorios/feito_v161.md): contrato sob demanda (valor teto). Ligado por v161/ed_v161.py em regras.js, logo depois
   das regras da medição ao cliente (regraMedCli e medapr.js).
   Contrato com tipoCtr 'demanda': a medição pode passar da quantidade de um item da tabela de preços; o limite é o TOTAL
   medido no contrato, que não passa do teto (teto + aditivos assinados, o mesmo "valor atual" do navegador) ou de 125% dele
   quando acr25 está ligado ("Permitir acréscimo de até 25% sobre o teto").
   Conta: as outras medições do contrato que não estão em rascunho (aprovadas e faturadas) + esta medição (qualquer situação).
   Recusa só a gravação que AUMENTA o total e o deixa acima do limite (mudar só a situação, as observações ou reabrir não é
   barrado, mesmo num contrato que já estava acima, por exemplo depois de baixar o teto). Valor da medição = itens × preço da
   tabela do contrato (ou o valor informado, sem tabela) + reajuste (%), como medTot no navegador. Erro 409
   MEDICAO_ACIMA_TETO na auditoria. */
const r2 = v => Math.round((+v || 0) * 100) / 100;
module.exports = function ({ col, doc, erro, auditar }) {
  const itensDe = c => (Array.isArray(c && c.itens) ? c.itens : []).filter(i => i && (i.desc || +i.qtd));
  const assinado = a => !(a && a.assinado === 'nao');
  const somaAd = (c, t) => (Array.isArray(c.aditivos) ? c.aditivos : []).filter(a => a && a.tipo === t && assinado(a)).reduce((s, a) => s + (+a.valor || 0), 0);
  const ehDemanda = c => !!c && c.tipoCtr === 'demanda';
  function teto(c) { return r2(r2(+c.teto || 0) + r2(somaAd(c, 'acrescimo')) - r2(somaAd(c, 'supressao')) + r2(somaAd(c, 'reajuste'))); }
  function limite(c) { const t = teto(c); return { teto: t, lim: r2(t * (c.acr25 ? 1.25 : 1)) }; }
  function fat(m, c) {
    if (!m) return 0; const it = itensDe(c);
    const b = it.length ? r2((Array.isArray(m.itens) ? m.itens : []).reduce((s, x) => s + (+x.qtd || 0) * (+((it[+x.idx] || {}).pu) || 0), 0)) : (+m.valor || 0);
    return r2(b + r2(b * (+m.reajPct || 0) / 100));
  }
  function outras(c, id) { let t = 0; for (const m of col('med')) if (m && m.ctrId === c.id && m.id !== id && !m.ex && (m.status || 'rascunho') !== 'rascunho') t += fat(m, c); return r2(t); }
  const fmt = v => 'R$ ' + r2(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  function antesMed(conta, req, id, velho, novo) {
    if (!novo || novo.ex) return null;
    const c = novo.ctrId ? doc('ctr/' + novo.ctrId) : null; if (!ehDemanda(c)) return null;
    c.id = novo.ctrId;
    const { teto: t, lim } = limite(c), base = outras(c, id), tot = r2(base + fat(novo, c));
    if (tot <= lim + 0.01) return null;
    const antes = velho && !velho.ex && velho.ctrId === novo.ctrId ? r2(base + fat(velho, c)) : -1;
    if (antes >= 0 && tot <= antes + 0.005) return null; /* não aumenta o medido: situação, observações, reabertura */
    try { if (auditar) auditar(conta, req, 'MEDICAO_ACIMA_TETO', 'med/' + id, null, { ctr: c.numero || c.id, teto: t, limite: lim, medido: tot }); } catch (e) { }
    return erro('Contrato sob demanda ' + (c.numero || '') + ': com esta medição o medido iria a ' + fmt(tot) + ', acima do ' + (c.acr25 ? 'limite de 125% do teto (' + fmt(lim) + ')' : 'teto (' + fmt(t) + ')') + '. Reduza a medição ou faça um aditivo de valor.', 409);
  }
  return { antesMed, teto, limite, fat, ehDemanda };
};

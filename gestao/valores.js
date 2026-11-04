/* v146 (relatorios/feito_v146_perfis.md): VALORES GERENCIAIS só para quem é do setor.
   Ação sensível "Ver valores gerenciais" no perfil (Sistema › Perfis de acesso, junto das ações da v142). Padrão ligado para
   Administrador, Diretoria, Gestor de projetos, Financeiro, Comercial, Fiscal e estoque e Leitura completa; desligado
   (perfis.json › valNao) para Encarregado, Almoxarife, Comprador, RH, Gestor e Técnico de SST, Fábrica, Só ponto, Somente
   leitura e os antigos Comprador/almoxarife e Segurança do trabalho. O ajuste do padrão (perfc/a_<perfil>) e o perfil
   personalizado guardam acoes.valores = true|false (permfn.js › aplicar → valNao).
   Quem não tem a ação:
     - recebe os documentos SEM os campos de valor de obra, contrato, medição, previsão/linha de base, relatório mensal e
       custo de frota (CAMPOS abaixo, também dentro de itens/aditivos);
     - não recebe o custo-hora por função (chora), salvo quem vê dados de RH (o RH usa a tela Custo-hora por função);
     - ao gravar, não muda esses campos: o servidor devolve o valor guardado (e descarta o que vier num documento novo).
   Fica só na tela (máscara do navegador, new_v146perf.js): custo dos movimentos e dos produtos de estoque (a baixa, o
   inventário e o custo médio são calculados com eles), preços de pedido/cotação/nota (o Comprador precisa; o Almoxarife
   recebe "às cegas" na tela) e o que o RH vê no módulo Pessoal. */
'use strict';
/* coleção → campos de valor (nome do campo; vale também dentro de listas e objetos do documento, até 3 níveis) */
const CAMPOS = {
  proj: /^(orcamento|orcMO|orc[A-Z]\w*|valorVenda|valor[A-Z]\w*|margem\w*|custo\w*)$/,
  ctr: /^(valor\w*|bdi|garValor|vUnit|pu|preco\w*|total\w*)$/,
  med: /^(valor\w*|total\w*|vUnit|pu|bruto|liquido|empenhado|medido)$/,
  medemp: /^(valor\w*|total\w*|pu|puFixo|fixo|bruto|liq\w*|retJ4|ajuste)$/,
  ctremp: /^(valor\w*|total\w*|pu|preco\w*)$/,
  eap: /^(pu|preco\w*|valor\w*|custo\w*|bdi)$/,
  obrprev: /^(eac|margem|ctr|orc|gasto|falta|geral|itens)$/,
  obrbase: /^(orc\w*|valor\w*|custo\w*)$/,
  rmesf: /^fin$/,
  vabas: /^valor$/,
  vman: /^valor$/,
  vfrete: /^valor\w*$/,
  multa: /^valor\w*$/,
  veic: /^(obrValor|obrResidual)$/
};
const NUNCA = new Set(['id', 'projId', 'ctrId', 'parcId', 'status', 'ts', 'cr', 'crBy', 'ed', 'edBy', 'hist', 'numero']);
const ehDocDe = p => { const s = String(p || '').split('/'); return s.length === 2 && CAMPOS[s[0]] ? s[0] : ''; };

/* cópia sem os campos de valor; tinha = algum campo foi tirado */
function tirar(o, re, nivel, st) {
  if (Array.isArray(o)) return o.map(x => tirar(x, re, nivel, st));
  if (!o || typeof o !== 'object') return o;
  const out = {};
  for (const k of Object.keys(o)) {
    if (!NUNCA.has(k) && re.test(k)) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') st.tinha = true; continue; }
    out[k] = nivel < 3 && o[k] && typeof o[k] === 'object' ? tirar(o[k], re, nivel + 1, st) : o[k];
  }
  return out;
}
/* novo com os campos de valor do velho (o que a pessoa mandou nesses campos é descartado) */
function repor(novo, velho, re, nivel) {
  if (Array.isArray(novo)) return novo.map((x, i) => repor(x, Array.isArray(velho) ? velho[i] : undefined, re, nivel));
  if (!novo || typeof novo !== 'object') return novo;
  const v = velho && typeof velho === 'object' && !Array.isArray(velho) ? velho : {}, out = {};
  for (const k of Object.keys(novo)) {
    if (!NUNCA.has(k) && re.test(k)) continue;
    out[k] = nivel < 3 && novo[k] && typeof novo[k] === 'object' ? repor(novo[k], v[k], re, nivel + 1) : novo[k];
  }
  for (const k of Object.keys(v)) if (!NUNCA.has(k) && re.test(k)) out[k] = v[k];
  return out;
}

module.exports = function (X) {
  const { perfilDe, veRh } = X, PERM_ = () => (typeof X.PERM === 'function' ? X.PERM() : X.PERM) || { perfis: {} };
  /* a conta não vê valores gerenciais (dono e Administrador sempre veem) */
  /* v146b: valCols = coleções que o perfil recebe sem valores mesmo com a ação ligada (Fiscal: obra e empreiteiros) */
  function ocultaCol(conta, c) {
    if (oculta(conta)) return true;
    if (!conta || conta.nivel === 'owner') return false;
    const pr = (PERM_().perfis || {})[perfilDe(conta)];
    return !!(pr && pr.w !== '*' && Array.isArray(pr.valCols) && pr.valCols.includes(c));
  }
  function oculta(conta) {
    if (!conta || conta.nivel === 'owner') return false;
    const pf = perfilDe(conta), pr = (PERM_().perfis || {})[pf];
    if (!pr) return pf === 'pendente' || pf === 'semnivel' || pf === 'semid';
    if (pr.w === '*') return false;
    return pr.valNao === true;
  }
  /* leitura: o custo-hora por função só para quem vê valores ou dados de RH */
  function podeLer(conta, p) {
    const c0 = String(p || '').split('/')[0];
    if (c0 === 'chora' && oculta(conta) && !veRh(conta)) return false;
    return true;
  }
  /* entrega: tira os campos de valor (também do item na lixeira) */
  function redigir(conta, p, data) {
    if (!data || typeof data !== 'object') return data;
    const c = ehDocDe(p);
    if (c ? !ocultaCol(conta, c) : !(data.col && ocultaCol(conta, data.col))) return data;
    if (c) { const st = {}; const o = tirar(data, CAMPOS[c], 0, st); if (st.tinha) o._valOculto = true; return o; }
    if (/^lixo\/[^/]+$/.test(p) && data.rec && CAMPOS[data.col]) { const st = {}; const o = Object.assign({}, data, { rec: tirar(data.rec, CAMPOS[data.col], 0, st) }); if (st.tinha) o._valOculto = true; return o; }
    return data;
  }
  /* gravação: o perfil sem a ação não muda os campos de valor (o servidor repõe o guardado) */
  function preservar(conta, p, velho, novo) {
    if (!novo || typeof novo !== 'object') return novo;
    const c = ehDocDe(p); if (!c || !ocultaCol(conta, c)) return novo;
    const o = repor(novo, velho || {}, CAMPOS[c], 0); delete o._valOculto; return o;
  }
  return { oculta, ocultaCol, podeLer, redigir, preservar, CAMPOS };
};
module.exports.CAMPOS = CAMPOS;
module.exports.tirar = tirar;
module.exports.repor = repor;

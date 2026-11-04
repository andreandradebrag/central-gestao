/* v142 (relatorios/feito_v142_permfn.md): permissão POR FUNÇÃO dentro de cada módulo (Sistema › Perfis de acesso).
   Função = coleção de dados que um módulo grava (perfis.json › funcoes, gerado por gen_perm.js a partir das telas do
   sistema; sem esse mapa, vale perfis.json › colecoes). Níveis: n (sem acesso), r (consulta), a (cria e altera),
   w (cria, altera e exclui). O perfil guarda só o que difere do nível do módulo (fn: {grupo: {coleção: nível}}).
   O cálculo desce para as regras que o servidor já aplica, sem afrouxar nenhuma:
     - gravação: "so" (dentro do módulo, só estas coleções) e a saída do módulo da lista de gravação quando nenhuma
       função do módulo grava;
     - exclusão: "naoExclui" (regras.js › regraFina, com auditoria);
     - leitura: "leSo" (regras.js › leSoFora). A coleção que outra função do perfil precisa ler (Recebimento lê o pedido,
       Estoque lê o produto) continua liberada, só para leitura, e o que o módulo só consulta (não é função dele) também.
   Ações sensíveis (acoes: {aprovar, lancarNota, cancelar, exportar} = false) só RETIRAM poder: o perfil compilado leva
   acoesNao e as rotas de aprovação, de lançamento da nota e as mudanças para cancelado/estornado recusam.
   Mesmo cálculo do navegador (new_permfn.js › pfAplicar); o teste t/run_permfn.js compara os dois. */
'use strict';
const NIVS = ['n', 'r', 'a', 'w'];
const ni = v => Math.max(0, NIVS.indexOf(v));
const nmax = (a, b) => ni(a) >= ni(b) ? a : b;
const nmin = (a, b) => ni(a) <= ni(b) ? a : b;
const ACOES = ['aprovar', 'lancarNota', 'cancelar', 'exportar']; /* v146: 'valores' (Ver valores gerenciais) é tratada à parte em sanAcoes/aplicar */
/* coleções que nunca são função (leitura livre ou só pelo Administrador) */
const FORA = new Set(['cfg', 'usr', 'lixo', 'lgpdc', 'implog', 'cm', 'pt', 'usrreq', 'perfc', 'treino']); /* v151: treino (próprio progresso) nunca é função */
const ID_OK = /^[a-z][a-zA-Z0-9]{0,30}$/;
const tem = (l, g) => l === '*' || (Array.isArray(l) && l.includes(g));

/* {grupo: {coleção: [coleções que a função lê]}} */
function funcoes(PERM) {
  const F = {};
  const f = PERM && PERM.funcoes && typeof PERM.funcoes === 'object' ? PERM.funcoes : null;
  if (f) { for (const [g, m] of Object.entries(f)) { if (!m || typeof m !== 'object') continue; F[g] = {}; for (const [c, le] of Object.entries(m)) if (!FORA.has(c)) F[g][c] = Array.isArray(le) ? le.filter(x => !FORA.has(x)) : [c]; } return F; }
  for (const [c, gs] of Object.entries((PERM && PERM.colecoes) || {})) { if (FORA.has(c)) continue; for (const g of gs || []) (F[g] = F[g] || {})[c] = [c]; }
  return F;
}
/* grupo → coleções que o módulo lê (perfis.json › leitura, invertido) */
function leituraPorGrupo(PERM) {
  const L = {}, add = (g, c) => { (L[g] = L[g] || new Set()).add(c); };
  const lei = (PERM && PERM.leitura) || {}, col = (PERM && PERM.colecoes) || {};
  for (const c of new Set(Object.keys(lei).concat(Object.keys(col)))) { const gs = lei[c] || col[c] || []; for (const g of gs) add(g, c); }
  return L;
}
/* fn gravado no perfil, conferido: só grupos editáveis, só funções do grupo, só níveis válidos */
function sanFn(fn, F, grupoOk) {
  const out = {}; if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return out;
  for (const [g, m] of Object.entries(fn)) {
    if (!F[g] || (grupoOk && !grupoOk(g)) || !m || typeof m !== 'object' || Array.isArray(m)) continue;
    for (const [c, v] of Object.entries(m)) { if (!Object.prototype.hasOwnProperty.call(F[g], c) || !NIVS.includes(v)) continue; (out[g] = out[g] || {})[c] = v; }
  }
  return out;
}
/* ações sensíveis: só "false" (retira) conta */
function sanAcoes(a) { const out = {}; if (!a || typeof a !== 'object') return out; ACOES.forEach(k => { if (a[k] === false) out[k] = false; });
  /* v146: "Ver valores gerenciais" vale nos dois sentidos (o padrão de cada perfil está em perfis.json › valNao) */
  if (typeof a.valores === 'boolean') out.valores = a.valores; return out; }
/* limites internos levados do perfil padrão na duplicação (só restringem): campos, camposSt, rascunho, cfgNao, aptLibDia, rhdocNr */
function sanLim(l) {
  const out = {}; if (!l || typeof l !== 'object' || Array.isArray(l)) return out;
  const lista = (v, n) => Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && ID_OK.test(x)))].slice(0, n || 60) : null;
  for (const k of ['campos', 'camposSt']) { const o = l[k]; if (!o || typeof o !== 'object' || Array.isArray(o)) continue; const m = {}; for (const [c, v] of Object.entries(o)) { if (!ID_OK.test(c)) continue; const x = lista(v); if (x && x.length) m[c] = x; } if (Object.keys(m).length) out[k] = m; }
  for (const k of ['rascunho', 'cfgNao']) { const x = lista(l[k]); if (x && x.length) out[k] = x; }
  /* v152: camposProprio (o próprio registro, nas situações listadas, fica livre dos campos; só vale onde há campos) */
  if (l.camposProprio && typeof l.camposProprio === 'object' && !Array.isArray(l.camposProprio) && out.campos) { const m = {}; for (const [c, v] of Object.entries(l.camposProprio)) { if (!out.campos[c]) continue; const x = lista(v); if (x && x.length) m[c] = x; } if (Object.keys(m).length) out.camposProprio = m; }
  if (l.aptLibDia === true) out.aptLibDia = true; if (l.rhdocNr === true) out.rhdocNr = true;
  /* v145: telas sem função própria fora do menu (só na tela) e leitura de apoio (leDep: só dentro do que o módulo já lê) */
  const tn = lista(l.telasNao); if (tn && tn.length) out.telasNao = tn;
  /* v146: telas fora do menu (telasFora) e itens de menu fora (itensFora: "menu:tela" ou "menu:tela:tipo"); só na tela */
  const tf = lista(l.telasFora); if (tf && tf.length) out.telasFora = tf;
  if (Array.isArray(l.itensFora)) { const x = [...new Set(l.itensFora.filter(v => typeof v === 'string' && /^[a-z][a-zA-Z0-9]{0,30}(:[a-z][a-zA-Z0-9]{0,30}){1,2}$/.test(v)))].slice(0, 60); if (x.length) out.itensFora = x; }
  /* v146b: leFora (como leDep) e valCols/valTelas (listas) */
  if (l.leFora && typeof l.leFora === 'object' && !Array.isArray(l.leFora)) { const m = {}; for (const [g, v] of Object.entries(l.leFora)) { if (!ID_OK.test(g)) continue; const x = lista(v); if (x && x.length) m[g] = x; } if (Object.keys(m).length) out.leFora = m; }
  for (const k of ['valCols', 'valTelas']) { const x = lista(l[k]); if (x && x.length) out[k] = x; }
  /* v148: leitura mínima (só as coleções e campos de LEMIN_OK) */
  if (l.leMin && typeof l.leMin === 'object' && !Array.isArray(l.leMin)) { const m = {}; for (const [c, v] of Object.entries(l.leMin)) { if (!LEMIN_OK[c] || !Array.isArray(v)) continue; const x = [...new Set(v.filter(k => LEMIN_OK[c].includes(k)))]; if (x.length) m[c] = x; } if (Object.keys(m).length) out.leMin = m; }
  if (l.leDep && typeof l.leDep === 'object' && !Array.isArray(l.leDep)) { const m = {}; for (const [g, v] of Object.entries(l.leDep)) { if (!ID_OK.test(g)) continue; const x = lista(v); if (x && x.length) m[g] = x; } if (Object.keys(m).length) out.leDep = m; }
  return out;
}
/* nível de cada função sem o fn (o que o perfil já fazia): módulo que grava = cria, altera e exclui, menos o que o "so"
   deixa só em consulta e o que "naoExclui" não deixa excluir */
function implicito(p, g, c) {
  if (tem(p.w, g)) { if (p.so && Array.isArray(p.so[g]) && !p.so[g].includes(c)) return 'r'; if (Array.isArray(p.naoExclui) && p.naoExclui.includes(c)) return 'a'; return 'w'; }
  return tem(p.r, g) ? 'r' : 'n';
}
/* v145: fn por cima do nível de fábrica do perfil padrão (padFn), função a função */
function mescla(pad, fn) {
  const o = {};
  for (const x of [pad, fn]) { if (!x || typeof x !== 'object' || Array.isArray(x)) continue; for (const [g, m] of Object.entries(x)) { if (!m || typeof m !== 'object' || Array.isArray(m)) continue; o[g] = Object.assign(o[g] || {}, m); } }
  return o;
}
/* aplica fn e acoes ao perfil compilado p (muda p). o: {PERM, soLeitura, todos: [grupos]}
   v145: perfil padrão com padFn (Gestor e Técnico de SST): o fn do ajuste vale por cima dele; leDep = o que continua
   lido só como apoio das telas que o perfil usa (entra na dependência de leitura; nunca passa do que o módulo já lê) */
function aplicar(p, fn, acoes, o) {
  o = o || {}; const PERM = o.PERM || {};
  /* v146b: o que o ajuste salvo libera (função fora de "Sem acesso") volta a ser entregue e com valores (leFora/valCols) */
  const liberadas = new Set(); { const fa = sanFn(fn, funcoes(o.PERM || {})); for (const m of Object.values(fa)) for (const [c, v] of Object.entries(m)) if (v !== 'n') liberadas.add(c); }
  if (liberadas.size && p.leFora) { const lf = {}; for (const [g, l] of Object.entries(p.leFora)) { const x = (Array.isArray(l) ? l : []).filter(c => !liberadas.has(c)); if (x.length) lf[g] = x; } if (Object.keys(lf).length) p.leFora = lf; else delete p.leFora; }
  if (liberadas.size && Array.isArray(p.valCols)) { p.valCols = p.valCols.filter(c => !liberadas.has(c)); if (!p.valCols.length) delete p.valCols; }
  if (p && !p.custom && p.padFn && p.w !== '*') fn = mescla(p.padFn, fn);
  const sa = sanAcoes(acoes), an = Object.keys(sa).filter(k => k !== 'valores'); if (an.length && p.w !== '*') p.acoesNao = an;
  /* v146: valores gerenciais (valores.js): o ajuste ou o personalizado decide; sem a escolha, fica o padrão do perfil */
  if (p.w === '*') delete p.valNao; else if (sa.valores === true) delete p.valNao; else if (sa.valores === false) p.valNao = true;
  if (p.valNao === true && p.w !== '*') p.acoesNao = [...new Set((p.acoesNao || []).concat(['valores']))]; /* lista das ações desligadas, igual ao navegador */
  const F = funcoes(PERM), f = sanFn(fn, F);
  if (!Object.keys(f).length || p.w === '*') return p;
  const fnNiv = {}, colNiv = {};
  for (const g of Object.keys(F)) {
    if (!tem(p.w, g) && !tem(p.r, g)) continue;
    const teto = tem(p.w, g) && !o.soLeitura ? 'w' : 'r'; fnNiv[g] = {};
    for (const c of Object.keys(F[g])) { let v = implicito(p, g, c); const e = f[g] && f[g][c]; if (e) v = nmin(e, teto); fnNiv[g][c] = v; colNiv[c] = colNiv[c] ? nmax(colNiv[c], v) : v; }
  }
  const todos = o.todos || [];
  let w = p.w === '*' ? todos.slice() : [...(p.w || [])], r = p.r === '*' ? null : [...(p.r || [])];
  const so = {}; Object.keys(p.so || {}).forEach(g => { so[g] = (p.so[g] || []).slice(); });
  const tira = g => { if (r === null) r = todos.slice(); r = r.filter(x => x !== g); };
  for (const [g, m] of Object.entries(fnNiv)) {
    const cs = Object.keys(m); if (!cs.length) continue;
    const mx = cs.map(c => m[c]).reduce(nmax, 'n');
    if (w.includes(g)) {
      if (ni(mx) < 2) { w = w.filter(x => x !== g); delete so[g]; if (mx === 'r' && r !== null && !r.includes(g)) r.push(g); }
      else { const gr = cs.filter(c => ni(m[c]) >= 2), extra = Array.isArray(so[g]) ? so[g].filter(c => !Object.prototype.hasOwnProperty.call(m, c)) : [];
        if (gr.length < cs.length || Array.isArray(so[g])) so[g] = [...new Set(gr.concat(extra))]; }
    }
    if (mx === 'n') { w = w.filter(x => x !== g); tira(g); }
  }
  p.w = w; if (r !== null) p.r = r;
  if (Object.keys(so).length) p.so = so; else delete p.so;
  const nx = [...new Set((p.naoExclui || []).filter(c => colNiv[c] === undefined || colNiv[c] !== 'w').concat(Object.keys(colNiv).filter(c => colNiv[c] === 'a')))];
  if (nx.length) p.naoExclui = nx; else delete p.naoExclui;
  /* leitura: dentro do módulo com função sem acesso, lê só o que não é função dele, as funções com acesso e o que
     as funções com acesso precisam (dependência, só leitura) */
  const dep = new Set();
  for (const [g, m] of Object.entries(fnNiv)) for (const [c, v] of Object.entries(m)) if (v !== 'n') (F[g][c] || [c]).forEach(x => dep.add(x));
  if (p.leDep && typeof p.leDep === 'object') for (const l of Object.values(p.leDep)) if (Array.isArray(l)) l.forEach(x => { if (!FORA.has(x)) dep.add(x); });
  const L = leituraPorGrupo(PERM), leSo = Object.assign({}, p.leSo || {});
  for (const [g, m] of Object.entries(fnNiv)) {
    if (!Object.values(m).includes('n')) continue;
    const pode = [...(L[g] || [])].filter(c => !Object.prototype.hasOwnProperty.call(m, c) || m[c] !== 'n' || dep.has(c));
    leSo[g] = Array.isArray(leSo[g]) ? leSo[g].filter(c => pode.includes(c)) : pode;
  }
  /* v146b: leFora = fora da leitura mesmo como apoio de outra função (Fiscal: relatório mensal, contratos e medições de empreiteiros) */
  if (p.leFora && typeof p.leFora === 'object') for (const [g, l] of Object.entries(p.leFora)) { if (!Array.isArray(l) || !l.length || (!tem(p.w, g) && !tem(p.r, g))) continue; const base = Array.isArray(leSo[g]) ? leSo[g] : [...(L[g] || [])]; leSo[g] = base.filter(c => !l.includes(c)); }
  if (Object.keys(leSo).length) { p.leSo = leSo; if (p.r === '*') p.r = todos.slice(); } /* "*" ignoraria o leSo */
  p.pf = true; p.fnNiv = fnNiv; p.colNiv = colNiv;
  return p;
}
/* v148 (relatorios/feito_v148_regressoes.md): leitura MÍNIMA de apoio (leMin) — o perfil que não lê o módulo da coleção
   recebe só estes campos (Almoxarife: colaboradores para EPI, envio/retorno de ferramentas e romaneio; nada de salário,
   CPF, banco/PIX, endereço, contato ou dado sensível). Só vale para as coleções e os campos de LEMIN_OK; quem já lê o
   módulo (RH, Frota...) continua com a regra de sempre. */
const LEMIN_OK = { func: ['id', 'nome', 'matricula', 'funcao', 'cargo', 'projId', 'status', 'ts', 'ex'] };
function leMinCampos(pr, c0, PERM) {
  if (!pr || pr.w === '*' || pr.r === '*' || !pr.leMin || typeof pr.leMin !== 'object') return null;
  const l = pr.leMin[c0], ok = LEMIN_OK[c0]; if (!Array.isArray(l) || !ok) return null;
  const gs = [...new Set([].concat((PERM && PERM.colecoes && PERM.colecoes[c0]) || [], (PERM && PERM.leitura && PERM.leitura[c0]) || []))];
  if (gs.some(g => tem(pr.w, g) || tem(pr.r, g))) return null; /* lê o módulo: regra de sempre */
  const x = l.filter(k => ok.includes(k)); return x.length ? x : null;
}
const acaoNegada = (p, k) => !!(p && p.w !== '*' && Array.isArray(p.acoesNao) && p.acoesNao.includes(k));
/* mudança de situação que é cancelar ou estornar (ação sensível "cancelar") */
const CANC = ['cancelado', 'cancelada', 'estornado', 'estornada'];
function ehCancelamento(c0, velho, novo) {
  if (!velho || !novo) return false;
  if (CANC.includes(String(novo.status || '')) && !CANC.includes(String(velho.status || ''))) return true;
  if (c0 === 'lanc' && velho.pago && !novo.pago) return true; /* estorno da baixa */
  return false;
}
module.exports = { NIVS, ACOES, FORA, LEMIN_OK, leMinCampos, mescla, funcoes, leituraPorGrupo, sanFn, sanAcoes, sanLim, implicito, aplicar, acaoNegada, ehCancelamento };

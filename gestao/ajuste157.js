'use strict';
/* v157 (relatorios/feito_v157.md): pequenos ajustes conferidos pelo servidor. Ligado por v157/ed_v157.py em regras.js,
   aceite.js e solides.js.
   1. Solicitação de compra em rascunho: o Almoxarife (perfis padrão almoxarife, almoxfab e o antigo "compras") não exclui.
      Para desistir dela: Cancelar (fica guardada como cancelada), quando o perfil puder mudar a situação da SC; senão o
      Comprador ou o Administrador cancelam. Recusa: SC_EXCLUSAO_RECUSADA na auditoria.
   2. Aceite do fornecedor (aceite.js, v150): o link só é gerado, a página só mostra o pedido e o aceite só é gravado quando
      o pedido está aprovado dentro da alçada (mesma regra da tela: acima do limite do pedido precisa de aprovação válida
      para o total atual; pedido criado antes da alçada padrão da v140 não precisa).
   3. Família do produto: o Almoxarife nunca muda a família de um produto que já existe (cadastro, inativar/reativar,
      importação, marcar ou tirar da família EPI, qualquer caminho que grave prod/prodinat). A família fica exatamente como
      estava. Recusa: PRODUTO_FAMILIA_RECUSADA. As famílias (prodfam) ele já não grava desde a v156 (fam156.js).
   4. Aviso repetido no registro do servidor (log): a mesma mensagem (por tipo) aparece uma vez e depois no máximo uma vez a
      cada 6 horas (usado pela integração Sólides). */

/* ---------- 4. aviso repetido no log ---------- */
/* limitador(horas): devolve f(tipo, texto, agora?) que escreve o texto só na primeira vez e depois no máximo uma vez a cada
   "horas" para o mesmo tipo; quando volta a escrever, conta quantas vezes ficou sem escrever. f.zerar() esquece tudo
   (ex.: depois de uma sincronização que deu certo, a próxima falha aparece na hora). */
function limitador(horas, escrever) {
  const jan = Math.max(1, +horas || 6) * 3600e3, vistos = new Map(), out = escrever || (t => console.log(t));
  const f = (tipo, texto, agora) => {
    const t = agora == null ? Date.now() : agora, k = String(tipo || texto || ''), v = vistos.get(k);
    if (v && t - v.em < jan) { v.cal++; return false; }
    out(texto + (v && v.cal ? ' (repetiu ' + v.cal + ' vez(es) nas últimas ' + Math.round((t - v.em) / 3600e3) + ' h sem aparecer aqui)' : ''));
    vistos.set(k, { em: t, cal: 0 }); return true;
  };
  f.zerar = () => vistos.clear();
  return f;
}
/* tipo do aviso da Sólides: endereço não encontrado (404) e falta de configuração contam como um tipo só cada um */
function tipoSolides(msg) {
  const m = String(msg || '');
  if (/\b404\b/.test(m) || /não encontrei o endereço/i.test(m)) return 'solides:404';
  if (/não configurad/i.test(m)) return 'solides:config';
  return 'solides:' + m.replace(/\d+/g, '#').slice(0, 200);
}

module.exports = function (X) {
  const { doc, erro, ehDono, papelConta } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const restrito = c => !!c && !ehDono(c) && ['almoxarife', 'compras'].includes(papelConta(c));
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  /* ---------- 1. SC em rascunho ---------- */
  function antesExcluirSc(conta, req, id, velho) {
    if (!velho || !restrito(conta)) return null;
    if (String(velho.status || 'rascunho') !== 'rascunho') return null;
    auditar(conta, req, 'SC_EXCLUSAO_RECUSADA', 'sc/' + id, null, { numero: String(velho.numero || '') });
    return erro('O Almoxarife não exclui solicitação de compra em rascunho. Para desistir dela, use Cancelar (se o seu perfil não puder, peça ao Comprador ou ao Administrador).');
  }

  /* ---------- 2. pedido aprovado dentro da alçada ---------- */
  /* { ok:true } ou { ok:false, motivo } */
  function pedAprovado(p) {
    if (!p) return { ok: false, motivo: 'Pedido não encontrado.' };
    let A; try { A = X.alcadas(); } catch (e) { return { ok: false, motivo: 'Não foi possível conferir a alçada do pedido.' }; }
    const tot = X.pedTotal(p);
    let antes = false; try { antes = !!X.antesDaAlcada(A.padrao, 'ped', p); } catch (e) { }
    const precisa = A.ped > 0 && p.status !== 'cancelado' && tot > A.ped && !antes;
    if (!precisa) return { ok: true };
    const a = p.aprov;
    if (a && a.ok === true && (a.valor == null || tot <= (+a.valor || 0) + 0.01)) return { ok: true };
    if (a && a.ok === false) return { ok: false, motivo: 'O pedido foi recusado na aprovação.' };
    if (p.aprovParc) return { ok: false, motivo: 'O pedido tem só a primeira das duas aprovações exigidas para este valor.' };
    return { ok: false, motivo: 'O pedido ainda não foi aprovado dentro da alçada (Início › Aprovações).' };
  }

  /* ---------- 3. família do produto ---------- */
  const guardada = new WeakMap();
  /* antes das regras da v156 (fam156.js): recusa a troca e guarda o texto de antes */
  function antesProd(conta, req, c0, id, velho, novo) {
    if (!novo || novo._del === true || !restrito(conta)) return null;
    const ant = velho || doc((c0 === 'prod' ? 'prodinat/' : 'prod/') + id); /* inativar (vai para prodinat) ou reativar */
    if (!ant) return null; /* produto novo: a v156 já recusa para o Almoxarife */
    const fv = ant.familia, f = 'familia' in novo ? novo.familia : fv;
    if (norm(f) !== norm(fv)) {
      auditar(conta, req, 'PRODUTO_FAMILIA_RECUSADA', c0 + '/' + id, null, { de: String(fv || ''), para: String(f || ''), v157: true });
      return erro('O Almoxarife não muda a família do produto. Peça ao Fiscal ou ao Administrador (Cadastros › Produtos ou Cadastros › Famílias de produto).', 409);
    }
    guardada.set(novo, { tem: fv !== undefined, fv });
    if (fv !== undefined) novo.familia = fv; else delete novo.familia;
    return null;
  }
  /* depois das regras da v156: a família fica exatamente como estava (sem trocar a grafia) */
  function depoisProd(novo) {
    const g = novo && guardada.get(novo); if (!g) return;
    if (g.tem) novo.familia = g.fv; else delete novo.familia;
  }

  return { antesExcluirSc, pedAprovado, antesProd, depoisProd, restrito };
};
module.exports.limitador = limitador;
module.exports.tipoSolides = tipoSolides;

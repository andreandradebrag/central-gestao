'use strict';
/* v156 (relatorios/feito_v156.md): Cadastros › Famílias de produto (coleção prodfam), conferidas pelo servidor.
   1. Família = { nome, desc, ativo, epi (marca "É EPI"), juntadaEm/juntadaNome/juntadaPor/juntadaTs quando foi juntada a outra }.
      O produto continua guardando o NOME da família em p.familia (todas as telas, filtros e relatórios usam esse texto); a
      ligação com o cadastro é pelo nome normalizado (sem acento, maiúsculas e espaços repetidos), único no cadastro.
   2. Criar, alterar descrição/ativo/"É EPI" e excluir (só sem produtos) pela gravação comum; quem grava é quem grava o Estoque
      (perfis.json: prodfam no módulo est), MENOS o Almoxarife (perfis padrão almoxarife, almoxfab e o antigo "compras"):
      o servidor recusa (PRODFAM_RECUSADA). Nome repetido (normalizado) é recusado.
   3. Renomear (POST /api/prodfam/renomear {id, nome}): muda o nome da família e de TODOS os produtos dela (ativos e inativos)
      numa transação só (ou tudo, ou nada); a gravação comum não muda o nome (recusa e manda usar Renomear). PRODFAM_RENOMEADA.
   4. Juntar (POST /api/prodfam/juntar {destino, origens:[ids], epi?}): leva os produtos das famílias de origem para a família
      que fica e inativa as de origem marcando juntadaEm (não se reativam); uma transação só. PRODFAM_JUNTADAS.
   5. Criar a partir dos produtos (POST /api/prodfam/migrar {grupos:[{nome, variantes:[textos], epi, desc}]}): cria as famílias
      a partir dos textos usados nos produtos. Cada grupo só junta variações do MESMO nome (maiúsculas/minúsculas, acento,
      espaços); nomes diferentes não se juntam aqui (use Juntar depois). Nome que já existe no cadastro liga ao existente.
      PRODFAM_MIGRACAO.
   6. Produto: o Almoxarife NÃO cria produto (nem direto como inativo); reativar/inativar continua (PRODUTO_CRIACAO_RECUSADA).
      O Almoxarife só põe no produto uma família ATIVA do cadastro (quando o cadastro já tem famílias); manter a família que o
      produto já tinha, ou deixar sem família, continua (PRODUTO_FAMILIA_RECUSADA). Para todos, a família do produto é
      gravada com a grafia do cadastro (ex.: "epi" vira "EPI"; família juntada vira a que ficou).
   7. Família EPI (epi154.js e a tela): família do cadastro vale pela marca "É EPI"; texto que ainda não está no cadastro
      continua pela regra antiga (nome configurado em Configurações › EPI, "EPI"/"EPIs", "Equipamento de Proteção
      Individual") até as famílias serem criadas. */
module.exports = function (X) {
  const { db, q, col, doc, erro, avisarDoc, ehDono, perfilEm, papelConta, gravaCol, cfgEmp } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const depois = (...a) => { try { X.depois(...a); } catch (e) { } };
  const antesGravar = (...a) => X.antesGravar(...a);
  const okW = (conta, p) => { try { return X.pode(conta, p, 'w') && X.perfilPermite(conta, p, 'w') && X.gravacaoPermitida(conta, p); } catch (e) { return false; } };
  let ROTA = false, CACHE = null;
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const limpa = s => String(s || '').replace(/\s+/g, ' ').trim();
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const JUNT = ['juntadaEm', 'juntadaNome', 'juntadaPor', 'juntadaTs'];
  const restrito = c => !!c && !ehDono(c) && ['almoxarife', 'compras'].includes(papelConta(c));
  const podeFam = c => ehDono(c) || (!restrito(c) && gravaCol(c, 'prodfam'));
  const hash = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36); };

  /* cadastro em memória por 2 s (ehEpi é chamado por produto na lista do EPI); qualquer gravação de prodfam limpa */
  function cad() {
    if (CACHE && Date.now() - CACHE.em < 2000) return CACHE;
    const fs = col('prodfam'), byId = new Map(fs.map(f => [f.id, f])), m = new Map();
    fs.filter(f => !f.juntadaEm).forEach(f => m.set(norm(f.nome), f));
    fs.filter(f => f.juntadaEm).forEach(f => { const k = norm(f.nome); if (m.has(k)) return; let d = f, n = 0; while (d && d.juntadaEm && n++ < 20) d = byId.get(d.juntadaEm); if (d && !d.juntadaEm) m.set(k, d); });
    CACHE = { em: Date.now(), fs, byId, m }; return CACHE;
  }
  const limpaCache = () => { CACHE = null; };
  const daFamilia = f => { const k = norm(f); return k ? (cad().m.get(k) || null) : null; };
  /* null = texto fora do cadastro (vale a regra antiga); true/false = marca "É EPI" da família */
  function ehFamEpi(f) { const fm = daFamilia(f); return fm ? fm.epi === true : null; }
  function nomeEpi() {
    const l = cad().fs.filter(f => !f.juntadaEm && f.ativo !== false && f.epi === true).sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
    if (!l.length) return ''; const leg = norm(String((cfgEmp() || {}).epiFamilia || '').trim() || 'EPI');
    return (l.find(f => norm(f.nome) === leg) || l[0]).nome;
  }
  const produtos = nomes => { const ks = new Set(nomes.map(norm).filter(Boolean)), o = [];
    for (const c of ['prod', 'prodinat']) for (const p of col(c)) if (ks.has(norm(p.familia))) o.push({ c, p }); return o; };

  /* ---------- gravação comum ---------- */
  function antesFam(conta, req, id, velho, novo) {
    limpaCache();
    if (ROTA) return null;
    if (restrito(conta)) { auditar(conta, req, 'PRODFAM_RECUSADA', 'prodfam/' + id, null, { nome: limpa(novo.nome || (velho || {}).nome) }); return erro('O Almoxarife não cria nem altera famílias de produto: ele escolhe a família entre as cadastradas. Quem cadastra é o Fiscal ou o Administrador.'); }
    const nome = limpa(novo.nome);
    if (nome.length < 2 || nome.length > 80) return erro('Informe o nome da família (de 2 a 80 letras).', 400);
    novo.nome = nome; novo.desc = String(novo.desc || '').slice(0, 300); novo.epi = novo.epi === true; novo.ativo = novo.ativo !== false;
    if (!velho) {
      JUNT.forEach(k => delete novo[k]);
      const dup = cad().fs.find(f => f.id !== id && norm(f.nome) === norm(nome));
      if (dup) return erro('Já existe a família "' + dup.nome + '"' + (dup.juntadaEm ? ' (juntada a "' + (dup.juntadaNome || '') + '")' : dup.ativo === false ? ' (inativa: reative-a em Cadastros › Famílias de produto)' : '') + '.', 409);
      novo.crPor = conta.id; novo.crEm = Date.now();
      auditar(conta, req, 'PRODFAM_CRIADA', 'prodfam/' + id, null, { nome, epi: novo.epi });
      return null;
    }
    if (limpa(velho.nome) !== nome) return erro('Para mudar o nome use Renomear em Cadastros › Famílias de produto: o nome muda também em todos os produtos da família, de uma vez.', 409);
    if (String(velho.juntadaEm || '') !== String(novo.juntadaEm || '')) return erro('Juntar famílias só pela opção Juntar famílias.', 409);
    JUNT.forEach(k => { if (velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; });
    if (velho.juntadaEm && novo.ativo) return erro('Esta família foi juntada a "' + (velho.juntadaNome || '') + '" e não se reativa.', 409);
    ['crPor', 'crEm'].forEach(k => { if (velho[k] !== undefined) novo[k] = velho[k]; });
    if ((velho.epi === true) !== novo.epi) auditar(conta, req, 'PRODFAM_EPI', 'prodfam/' + id, null, { nome, epi: novo.epi });
    if ((velho.ativo !== false) !== novo.ativo) auditar(conta, req, novo.ativo ? 'PRODFAM_REATIVADA' : 'PRODFAM_INATIVADA', 'prodfam/' + id, null, { nome });
    return null;
  }
  function antesProd(conta, req, c0, id, velho, novo) {
    if (ROTA || !novo || novo._del === true) return null;
    if (!velho && restrito(conta) && novo.ex !== true && !doc((c0 === 'prod' ? 'prodinat/' : 'prod/') + id)) {
      auditar(conta, req, 'PRODUTO_CRIACAO_RECUSADA', c0 + '/' + id, null, { produto: String(novo.sku ? novo.sku + ' · ' : '') + String(novo.nome || '').slice(0, 160) });
      return erro('O Almoxarife não cadastra produto. Quem cadastra é o Fiscal (Cadastros › Produtos ou a entrada da nota fiscal) ou o Administrador.');
    }
    if (restrito(conta) && velho && !('familia' in novo) && velho.familia !== undefined) novo.familia = velho.familia; /* não veio: mantém */
    const f = limpa(novo.familia), fv = velho ? limpa(velho.familia) : '';
    if ('familia' in novo) novo.familia = f;
    if (!f) return null;
    const fm = daFamilia(f);
    if (restrito(conta) && norm(f) !== norm(fv) && cad().fs.length && !(fm && fm.ativo !== false)) {
      auditar(conta, req, 'PRODUTO_FAMILIA_RECUSADA', c0 + '/' + id, null, { familia: f });
      return erro('A família "' + f + '" não está no cadastro de famílias de produto (ou está inativa). Escolha uma família da lista; família nova quem cria é o Fiscal ou o Administrador.', 409);
    }
    if (fm) novo.familia = fm.nome; /* grafia do cadastro (família juntada: a que ficou) */
    return null;
  }
  function antes(conta, req, c0, id, velho, novo) {
    if (c0 === 'prodfam') return antesFam(conta, req, id, velho, novo);
    if (c0 === 'prod' || c0 === 'prodinat') return antesProd(conta, req, c0, id, velho, novo);
    return null;
  }
  function antesExcluir(conta, req, c0, id, velho) {
    if (c0 !== 'prodfam' || !velho) return null;
    limpaCache();
    if (ROTA) return null;
    if (restrito(conta)) { auditar(conta, req, 'PRODFAM_RECUSADA', 'prodfam/' + id, null, { nome: velho.nome, exclusao: true }); return erro('O Almoxarife não exclui famílias de produto.'); }
    const n = velho.juntadaEm ? 0 : produtos([velho.nome]).length;
    if (n) return erro('A família "' + velho.nome + '" tem ' + n + ' produto(s): use Juntar famílias para levá-los a outra família, ou Inativar.', 409);
    auditar(conta, req, 'PRODFAM_EXCLUIDA', 'prodfam/' + id, null, { nome: velho.nome });
    return null;
  }

  /* ---------- rotas (uma transação cada) ---------- */
  function gravar(conta, req, itens, metodoAud, caminho, resumo) {
    const prep = [];
    for (const x of itens) if (!okW(conta, x.p)) return erro('Seu perfil não grava ' + x.p.split('/')[0] + ' (' + x.p.split('/')[1] + ').');
    ROTA = true;
    try {
      for (const x of itens) {
        const v = antesGravar(conta, x.p, x.velho || null, x.data, req);
        if (v && v.reauth) return erro('Confirme a senha e tente de novo.', 409);
        if (v && v.erro) return erro((x.p.startsWith('prod/') || x.p.startsWith('prodinat/') ? 'Produto ' + (x.data.nome || '') + ': ' : '') + v.erro, v.st);
        prep.push({ x, v: v || { data: x.data } });
      }
    } finally { ROTA = false; }
    const ts = Date.now();
    db.exec('BEGIN');
    try {
      for (const { x, v } of prep) { const s = x.p.split('/'); q.docPut.run(x.p, s[0], s[1], JSON.stringify(v.data || x.data), ts); }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } limpaCache(); return erro('Falha ao gravar. Nada foi gravado; tente de novo.', 500); }
    limpaCache();
    for (const { x, v } of prep) { avisarDoc('set', x.p, v.data || x.data, ts); depois(conta, req, 'PUT', x.p, x.velho || null, v.data || x.data, v); }
    auditar(conta, req, metodoAud, caminho, null, resumo || null);
    return { ok: true, docs: prep.map(o => { const s = o.x.p.split('/'); return { col: s[0], id: s[1], data: o.v.data || o.x.data }; }) };
  }
  const semPerm = (conta, req, oq) => { auditar(conta, req, 'PRODFAM_RECUSADA', '/api/prodfam/' + oq, null, null); return erro(restrito(conta) ? 'O Almoxarife não cria, renomeia nem junta famílias de produto. Quem faz é o Fiscal ou o Administrador.' : 'Seu perfil não altera o cadastro de famílias de produto.'); };
  const prodItens = (lista, nome) => lista.filter(o => limpa(o.p.familia) !== nome).map(o => ({ p: o.c + '/' + o.p.id, velho: o.p, data: Object.assign({}, o.p, { familia: nome }) }));
  function nomeOk(n) { const nome = limpa(n); return nome.length < 2 || nome.length > 80 ? null : nome; }

  function rotaRenomear(conta, req, b) {
    if (!podeFam(conta)) return semPerm(conta, req, 'renomear');
    const id = String(b.id || ''); if (!ID_OK.test(id)) return erro('Família inválida.', 400);
    const f = doc('prodfam/' + id); if (!f) return erro('Família não encontrada. Atualize a tela.', 404);
    if (f.juntadaEm) return erro('Esta família foi juntada a "' + (f.juntadaNome || '') + '" e não se renomeia.', 409);
    const nome = nomeOk(b.nome); if (!nome) return erro('Informe o nome novo (de 2 a 80 letras).', 400);
    if (nome === limpa(f.nome)) return erro('O nome novo é igual ao atual.', 400);
    const dup = cad().fs.find(x => x.id !== id && norm(x.nome) === norm(nome));
    if (dup) return erro('Já existe a família "' + dup.nome + '"' + (dup.juntadaEm ? ' (juntada)' : '') + '. Para unir as duas, use Juntar famílias.', 409);
    const ps = produtos([f.nome]);
    const itens = [{ p: 'prodfam/' + id, velho: f, data: Object.assign({}, f, { id, nome, renPor: conta.id, renEm: Date.now(), nomeAnt: limpa(f.nome) }) }].concat(prodItens(ps, nome));
    const r = gravar(conta, req, itens, 'PRODFAM_RENOMEADA', 'prodfam/' + id, { de: limpa(f.nome), para: nome, produtos: ps.length });
    if (!r.erro) { r.produtos = ps.length; r.msg = 'Família renomeada para "' + nome + '" em ' + ps.length + ' produto(s).'; }
    return r;
  }
  function rotaJuntar(conta, req, b) {
    if (!podeFam(conta)) return semPerm(conta, req, 'juntar');
    const did = String(b.destino || ''); if (!ID_OK.test(did)) return erro('Escolha a família que fica.', 400);
    const d = doc('prodfam/' + did); if (!d) return erro('Família que fica não encontrada. Atualize a tela.', 404);
    if (d.juntadaEm) return erro('A família que fica já foi juntada a outra.', 409);
    if (d.ativo === false) return erro('A família que fica está inativa: reative-a antes.', 409);
    const ids = [...new Set((Array.isArray(b.origens) ? b.origens : []).map(String))].filter(x => x !== did);
    if (!ids.length || ids.length > 100 || ids.some(x => !ID_OK.test(x))) return erro('Escolha as famílias que serão juntadas na que fica.', 400);
    const os = ids.map(x => doc('prodfam/' + x));
    if (os.some(o => !o)) return erro('Família não encontrada. Atualize a tela.', 404);
    const ja = os.find(o => o.juntadaEm); if (ja) return erro('A família "' + ja.nome + '" já foi juntada a "' + (ja.juntadaNome || '') + '".', 409);
    const ts = Date.now(), epi = typeof b.epi === 'boolean' ? b.epi : d.epi === true;
    const ps = produtos(os.map(o => o.nome));
    const itens = [{ p: 'prodfam/' + did, velho: d, data: Object.assign({}, d, { id: did, epi }) }]
      .concat(os.map((o, i) => ({ p: 'prodfam/' + ids[i], velho: o, data: Object.assign({}, o, { id: ids[i], ativo: false, juntadaEm: did, juntadaNome: limpa(d.nome), juntadaPor: conta.id, juntadaTs: ts }) })))
      .concat(prodItens(ps, limpa(d.nome)));
    const r = gravar(conta, req, itens, 'PRODFAM_JUNTADAS', 'prodfam/' + did, { destino: limpa(d.nome), origens: os.map(o => limpa(o.nome)), produtos: ps.length, epi });
    if (!r.erro) { r.produtos = ps.length; r.msg = os.length + ' família(s) juntada(s) em "' + limpa(d.nome) + '": ' + ps.length + ' produto(s) mudaram de família.'; }
    return r;
  }
  function rotaMigrar(conta, req, b) {
    if (!podeFam(conta)) return semPerm(conta, req, 'migrar');
    const gs = Array.isArray(b.grupos) ? b.grupos : [];
    if (!gs.length || gs.length > 3000) return erro('Nenhuma família para criar.', 400);
    const C = cad(), novas = new Map(), ligar = [], criadas = [], ligadas = [], ts = Date.now();
    for (const g of gs) {
      const nome = nomeOk(g && g.nome); if (!nome) return erro('Nome de família inválido: "' + String((g && g.nome) || '').slice(0, 40) + '" (de 2 a 80 letras).', 400);
      const vs = (Array.isArray(g.variantes) ? g.variantes : []).map(limpa).filter(Boolean);
      const ks = new Set(vs.map(norm));
      if (ks.size > 1) return erro('Na criação a partir dos produtos, cada família só junta variações do mesmo nome (maiúsculas, acento, espaços): ' + vs.join(', ') + '. Nomes diferentes: crie separado e use Juntar famílias depois.', 400);
      const k = norm(nome);
      let f = C.m.get(k) || novas.get(k);
      if (!f) {
        let id = 'pf_' + hash(k); for (let i = 2; doc('prodfam/' + id) || [...novas.values()].some(x => x.id === id); i++) id = 'pf_' + hash(k) + '_' + i;
        f = { id, nome, desc: String((g && g.desc) || '').slice(0, 300), ativo: true, epi: !!(g && g.epi === true), crPor: conta.id, crEm: ts, mig156: true };
        novas.set(k, f); criadas.push(nome);
      } else if (!novas.has(k)) ligadas.push(f.nome);
      ligar.push({ vs: [...new Set(vs.concat([nome]))], nome: f.nome });
    }
    const itens = [...novas.values()].map(f => ({ p: 'prodfam/' + f.id, data: f })), vistos = new Set();
    let n = 0;
    for (const l of ligar) { const ps = produtos(l.vs).filter(o => !vistos.has(o.c + '/' + o.p.id)); ps.forEach(o => vistos.add(o.c + '/' + o.p.id)); const its = prodItens(ps, l.nome); n += ps.length; itens.push(...its); }
    if (!itens.length) return { ok: true, docs: [], criadas: [], ligadas, produtos: n, msg: 'Nada a mudar: as famílias já estão no cadastro.' };
    const r = gravar(conta, req, itens, 'PRODFAM_MIGRACAO', 'prodfam', { criadas, ligadas, produtos: n });
    if (!r.erro) { r.criadas = criadas; r.ligadas = ligadas; r.produtos = n; r.msg = criadas.length + ' família(s) criada(s); ' + n + ' produto(s) ligados ao cadastro.'; }
    return r;
  }
  async function rota(p, m, req, res, conta) {
    if (m !== 'POST' || !p.startsWith('/api/prodfam/')) return false;
    const { lerJson, json } = X;
    const R = async fn => { const b = await lerJson(req), r = fn(b && typeof b === 'object' ? b : {}); if (r.erro) return json(res, r.st || 403, { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : 'not_granted', erro: r.erro }); return json(res, 200, r); };
    if (p === '/api/prodfam/renomear') { await R(b => rotaRenomear(conta, req, b)); return true; }
    if (p === '/api/prodfam/juntar') { await R(b => rotaJuntar(conta, req, b)); return true; }
    if (p === '/api/prodfam/migrar') { await R(b => rotaMigrar(conta, req, b)); return true; }
    return false;
  }
  return { antes, antesExcluir, rota, ehFamEpi, nomeEpi, norm, restrito };
};

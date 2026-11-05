'use strict';
/* v152 (relatorios/feito_v152.md): compras — quem aprova, lembrete de aprovação, SC recusada reenviada, tipo da SC.
   1. "Quem aprova" (quem): o mesmo cálculo do navegador (new_v152sc.js › v152Quem), a partir das regras reais do servidor:
      - solicitação de compra "Aguardando aprovação": o aprovador escolhido (aprovUid) e, como alternativa, os aprovadores de
        material (cfg.matFluxo.aprov + matriz "Compras" com substitutos); sem nenhum, os aprovadores das alçadas
        (todosAprovadores); sem nenhum, o dono ou o Administrador. Quem pediu (solUid) nunca entra.
      - pedido de compra acima da alçada, sem aprovação: nível pelo total (N1/N2/N3, alcNiv); os aprovadores do nível
        (matriz com substitutos) e, como alternativa, os dos níveis acima (quemAprova); sem nenhum, o dono ou o
        Administrador (como a rota /api/aprovar). No N3 são duas pessoas: quem já deu a primeira aprovação (aprovParc) sai da
        lista e aparece como "já aprovou". Quem lançou (crBy) nunca entra.
   2. POST /api/aprov/lembrete {col:'sc'|'ped', id}: quem criou/enviou, quem grava a tela, o Administrador ou o dono pedem a
      aprovação. O servidor manda uma mensagem na conversa "Central de Gestão" do chat de cada aprovador responsável e, com o
      SMTP configurado, um e-mail (nº, obra, necessidade, valor do pedido só para quem vê valores, link direto). Um lembrete por
      documento a cada 2 horas (LEMBRETE_APROV_HORAS); grava lembAprov {em, por, para, emails} e uma linha no histórico do
      documento; auditoria APROV_LEMBRETE (recusa: APROV_LEMBRETE_NEGADO). GET /api/aprov/quem?col=&id= devolve o cálculo.
      O campo lembAprov só muda por essa rota.
   3. SC recusada "Corrigir e reenviar": a SC nova nasce com origemId (a recusada, ainda sem reenvio e sem outra SC com o mesmo
      origemId) e, gravada a nova, o servidor marca a recusada com reenviadaId/reenviadaNum. origemId não muda depois;
      reenviadaId só pelo servidor (ou igual ao que ele gravou). Reenviar a mesma recusada duas vezes é recusado (409).
   4. Tipo da SC (tipo): 'obra' exige obra (projId); 'repos' (reposição de estoque) exige um almoxarifado (almoxId) e não tem
      obra; 'adm' (administrativa) exige a categoria do plano de contas (categoria) e não tem obra. SC sem tipo (antes da
      v152, do diário de obra e da fábrica) segue como antes.
   5. camposProprio (perfis.json, regraFina): o perfil com "campos" limitados numa coleção cria e altera os PRÓPRIOS registros
      nas situações listadas (Almoxarife: sc → rascunho). */
const crypto = require('node:crypto');

module.exports = function (X) {
  const { q, db, json, lerJson, avisarDoc, auditar, salvar, ehDono, perfilEm, perfilDe, cfgEmp, col, doc, erro, nomeConta, gravaCol, PERM, EMAIL, APP_URL,
    aprovadoresDe, quemAprova, todosAprovadores, nivelDe, pedTotal, alcadas, antesDaAlcada, leModulo, igual } = X;
  const HORAS = Math.max(0.01, +process.env.LEMBRETE_APROV_HORAS || 2), JANELA = HORAS * 3600e3;
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const lista = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
  const uniq = a => [...new Set(a.filter(Boolean))];
  const NIV = ['', 'N1 · gestor da área', 'N2 · diretor', 'N3 · duas pessoas'];
  const brData = d => /^\d{4}-\d{2}-\d{2}/.test(String(d || '')) ? String(d).slice(8, 10) + '/' + String(d).slice(5, 7) + '/' + String(d).slice(0, 4) : '';
  const brHora = t => new Date(t).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const brDT = t => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const moeda = v => (+v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  /* ---------- 1. quem aprova ---------- */
  const aprovMat = () => uniq(lista((cfgEmp().matFluxo || {}).aprov).concat(aprovadoresDe('compras')));
  function pendente(c, r) {
    if (!r) return false;
    if (c === 'sc') return r.status === 'aprovacao';
    if (c === 'ped') { const A = alcadas(); return A.ped > 0 && !(r.aprov && r.aprov.ok) && !['cancelado', 'recebido'].includes(r.status) && pedTotal(r) > A.ped && !antesDaAlcada(A.padrao, 'ped', r); }
    return false;
  }
  function quem(c, r) {
    if (!pendente(c, r)) return { pend: false };
    if (c === 'sc') {
      const fora = [r.solUid].filter(Boolean), tira = l => uniq(l).filter(u => !fora.includes(u));
      let pri, alt = [];
      if (r.aprovUid) { pri = tira([r.aprovUid]); alt = tira(aprovMat()).filter(u => !pri.includes(u)); }
      else pri = tira(aprovMat());
      if (!pri.length) { pri = alt; alt = []; }
      if (!pri.length) pri = tira(todosAprovadores());
      return { pend: true, col: c, principais: pri, alternativos: alt, fallback: !pri.length, desde: +r.aprovPedidoEm || +r.cr || 0 };
    }
    const v = pedTotal(r), nv = nivelDe(v), par = r.aprovParc && r.aprovParc.por ? r.aprovParc : null;
    const fora = [r.crBy, par && par.por].filter(Boolean), tira = l => uniq(l).filter(u => !fora.includes(u));
    let pri = tira(aprovadoresDe('n' + nv)), alt = tira(quemAprova(nv)).filter(u => !pri.includes(u));
    if (!pri.length) { pri = alt; alt = []; }
    return { pend: true, col: c, nivel: nv, nivelNome: NIV[nv], dois: nv === 3, ja: par ? [{ por: par.por, em: +par.em || 0 }] : [], principais: pri, alternativos: alt, fallback: !pri.length,
      desde: Math.max(+r.cr || 0, +(r.aprovReaberta && r.aprovReaberta.em) || 0) };
  }
  /* fallback: os donos e as contas com o perfil Administrador */
  function donosAdmins() {
    const out = [];
    for (const c of q.contas.all()) { if (!c.ativo) continue; if (c.nivel === 'owner' || perfilEm(c, ['admin'])) out.push(c.id); }
    return out;
  }
  const veValor = ct => { if (!ct) return false; if (ct.nivel === 'owner') return true; const pr = PERM.perfis[perfilDe(ct)]; if (!pr) return false; if (pr.w === '*') return true; return pr.valNao !== true && leModulo(ct, 'ped'); };

  /* ---------- chat: conversa "Central de Gestão" (igual ao aceite do fornecedor, v150) ---------- */
  function avisarChat(u, texto, ag) {
    if (!u || !ID_OK.test(u)) return;
    try {
      const cid = 'av_' + u, cp = 'cm/sistema/c/' + cid;
      if (!q.docGet.get(cp)) { const cv = { id: cid, tipo: 'dm', membros: [u], ts: ag, sistema: true }; q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(cv), ag); avisarDoc('set', cp, cv, ag); }
      const mid = 'm' + ag.toString(36) + crypto.randomBytes(4).toString('hex'), mp = 'cm/sistema/m/' + mid;
      const msg = { id: mid, k: 'msg', conv: 'sistema/' + cid, txt: '🔔 ' + texto, ts: ag, men: [], sistema: true };
      q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(msg), ag); avisarDoc('set', mp, msg, ag);
    } catch (e) { console.error('[v152] chat:', e.message); }
  }

  /* ---------- 2. lembrete ---------- */
  function podePedir(conta, c, r) {
    if (ehDono(conta) || perfilEm(conta, ['admin']) || gravaCol(conta, c)) return true;
    return [r.crBy, c === 'sc' ? r.solUid : ''].filter(Boolean).includes(conta.id);
  }
  function resumo(c, r, comValor) {
    const pj = r.projId ? doc('proj/' + r.projId) : null, obra = pj ? [pj.codigo, pj.nome].filter(Boolean).join(' · ') : '';
    if (c === 'sc') {
      const tipo = r.tipo === 'repos' ? 'reposição de estoque' + (r.almoxId && doc('almox/' + r.almoxId) ? ' (' + doc('almox/' + r.almoxId).nome + ')' : '') : r.tipo === 'adm' ? 'administrativa' + (r.categoria ? ' (' + r.categoria + ')' : '') : r.tipo === 'rh' ? 'solicitação de RH' + (r.categoria ? ' (' + r.categoria + ')' : '') : r.tipo === 'frota' ? 'solicitação da frota' + (r.veicId && doc('veic/' + r.veicId) ? ' (veículo ' + (doc('veic/' + r.veicId).placa || '') + ')' : '') : ''; /* v158 */
      return ['Solicitação de compra nº ' + (r.numero || ''), obra ? 'obra ' + obra : tipo, (Array.isArray(r.itens) ? r.itens.length : 0) + ' item(ns)', r.necessidade ? 'necessidade ' + brData(r.necessidade) : ''].filter(Boolean).join(' · ');
    }
    const f = r.parcId ? doc('parc/' + r.parcId) : null;
    return ['Pedido de compra nº ' + (r.numero || ''), f ? (f.fantasia || f.nome || '') : '', obra ? 'obra ' + obra : '', comValor ? moeda(pedTotal(r)) : '', r.necessidade ? 'necessidade ' + brData(r.necessidade) : ''].filter(Boolean).join(' · ');
  }
  const link = c => APP_URL + '/#' + (c === 'sc' ? 'sc' : 'aprov');
  function rotaLembrete(conta, req, b) {
    const c = String(b.col || ''), id = String(b.id || ''), p = c + '/' + id;
    if (!['sc', 'ped'].includes(c) || !ID_OK.test(id)) return erro('Documento inválido.', 400);
    const r = doc(p); if (!r) return erro('Documento não encontrado.', 404);
    if (X.podeVer && !X.podeVer(conta, p, r)) { auditar(conta, req, 'APROV_LEMBRETE_NEGADO', p, null, null); return erro('Sem acesso a este documento.', 403); } /* v158: quem não vê o documento (SC de outra pessoa para quem acompanha só as próprias) não pede a aprovação dele */
    const qa = quem(c, Object.assign({}, r, { id }));
    if (!qa.pend) return erro('Este documento não está aguardando aprovação.', 409);
    if (!podePedir(conta, c, r)) { auditar(conta, req, 'APROV_LEMBRETE_NEGADO', p, null, null); return erro('Pedir aprovação é de quem criou ou enviou o documento, de quem grava esta tela ou do Administrador.'); }
    const ag = Date.now(), l = r.lembAprov;
    if (l && ag - (+l.em || 0) < JANELA) return Object.assign(erro('Já foi pedido às ' + brHora(l.em) + ' por ' + nomeConta(l.por) + '. O próximo lembrete pode ser enviado a partir das ' + brHora(+l.em + JANELA) + '.', 429), { lemb: l });
    let para = qa.fallback ? donosAdmins() : qa.principais;
    para = uniq(para).filter(u => u !== conta.id && (() => { const ct = q.contaPorId.get(u); return ct && ct.ativo; })());
    if (!para.length) return erro('Não há aprovador para avisar (você é o único aprovador possível).', 409);
    const quemPede = nomeConta(conta.id), conf = EMAIL.configurado(), emailOk = e => /^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(String(e || '')), out = [];
    for (const u of para) {
      const ct = q.contaPorId.get(u), vv = c === 'ped' && veValor(ct), rs = resumo(c, r, vv);
      const espera = qa.desde ? ' Aguardando desde ' + brDT(qa.desde) + '.' : '';
      const nivel = c === 'ped' ? ' ' + qa.nivelNome + (qa.dois && qa.ja.length ? ' (já aprovou: ' + nomeConta(qa.ja[0].por) + ')' : '') + '.' : '';
      avisarChat(u, quemPede + ' pede a sua aprovação: ' + rs + '.' + nivel + espera + ' Abra: ' + link(c), ag);
      const env = conf && emailOk(ct.email);
      if (env) {
        const m = EMAIL.modelo('Aprovação pendente: ' + (c === 'sc' ? 'solicitação de compra nº ' : 'pedido de compra nº ') + (r.numero || ''),
          [quemPede + ' pede a sua aprovação.', rs + '.', (nivel.trim() ? nivel.trim() : '') + espera].filter(x => x && x.trim()), 'Abrir ' + (c === 'sc' ? 'as solicitações de compra' : 'as aprovações'), link(c), 'Lembrete enviado pela Central de Gestão a pedido de ' + quemPede + '.');
        EMAIL.enviar({ para: ct.email, assunto: 'Aprovação pendente · ' + rs.split(' · ')[0] + ' · Central de Gestão', texto: m.texto, html: m.html })
          .catch(e => auditar(conta, req, 'APROV_LEMBRETE_FALHA', p, null, { para: ct.email, erro: String((e && e.message) || e).slice(0, 200) }));
      }
      out.push({ id: u, nome: nomeConta(u), email: !!env, valor: !!vv });
    }
    const n = JSON.parse(JSON.stringify(r));
    n.lembAprov = { em: ag, por: conta.id, para: out.map(x => x.id), emails: out.filter(x => x.email).length };
    n.lembHist = (Array.isArray(r.lembHist) ? r.lembHist : []).concat([n.lembAprov]).slice(-20);
    n.hist = (Array.isArray(r.hist) ? r.hist : []).concat([{ t: ag, by: conta.id, ch: [['lembAprov', '—', 'pedido a ' + out.map(x => x.nome).join(', ') + (out.some(x => x.email) ? ' (chat e e-mail)' : ' (chat)')]] }]).slice(-20);
    salvar(p, n, conta, req, 'APROV_LEMBRETE', r);
    return { ok: true, data: n, para: out, smtp: conf, quem: qa, proximo: ag + JANELA };
  }

  /* ---------- 3 e 4. regras da SC e proteção do lembrete (antesGravar, sc/<id> e ped/<id>) ---------- */
  const TIPOS = ['obra', 'repos', 'adm', 'rh', 'frota']; /* v158: RH (EPI, uniforme, treinamento, exames) e Frota (peças, pneus, oficina) */
  function antes(conta, c, id, velho, novo, ctx) {
    const v = velho || {};
    /* lembrete: só pela rota */
    for (const k of ['lembAprov', 'lembHist']) { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; }
    if (c !== 'sc') return null;
    /* origem (reenvio da recusada) */
    if (velho) { if (v.origemId !== undefined) novo.origemId = v.origemId; else delete novo.origemId; }
    else if (novo.origemId) {
      const o = doc('sc/' + String(novo.origemId));
      if (!o || o.status !== 'recusada') return erro('A solicitação de origem não está recusada: só a recusada é corrigida e reenviada.', 409);
      const outra = col('sc').find(s => s.origemId === novo.origemId && s.id !== id);
      if ((o.reenviadaId && o.reenviadaId !== id) || outra) return erro('Esta solicitação recusada já foi reenviada (SC nº ' + ((outra && outra.numero) || o.reenviadaNum || '') + ').', 409);
      if (!(ehDono(conta) || perfilEm(conta, ['admin']) || gravaCol(conta, 'sc') || [o.solUid, o.crBy].includes(conta.id))) return erro('Só quem pediu, quem grava Solicitações ou o Administrador reenvia a solicitação recusada.');
      ctx.v152 = { origem: String(novo.origemId), nova: id };
    }
    if (!igual(v.reenviadaId, novo.reenviadaId)) {
      const alvo = novo.reenviadaId ? doc('sc/' + String(novo.reenviadaId)) : null;
      if (!(velho && !v.reenviadaId && alvo && alvo.origemId === id && v.status === 'recusada')) return erro('A ligação "reenviada como" é gravada pelo servidor.', 409);
      novo.reenviadaNum = alvo.numero || '';
    }
    /* tipo */
    if (novo.tipo !== undefined && novo.tipo !== '' && !TIPOS.includes(novo.tipo)) return erro('Tipo de solicitação inválido.', 400);
    if (novo.status !== 'cancelada' && (!velho || !igual(v.tipo, novo.tipo) || !igual(v.projId, novo.projId) || !igual(v.almoxId, novo.almoxId) || !igual(v.categoria, novo.categoria) || !igual(v.veicId, novo.veicId))) {
      if (novo.tipo === 'obra' && !novo.projId) return erro('Solicitação de obra: escolha a obra (ou use o tipo Reposição de estoque ou Administrativa).', 400);
      if (novo.tipo === 'repos') { if (novo.projId) return erro('Reposição de estoque não tem obra.', 400); if (!novo.almoxId || !doc('almox/' + String(novo.almoxId))) return erro('Reposição de estoque: escolha o almoxarifado de destino.', 400); }
      if (novo.tipo === 'rh' || novo.tipo === 'frota') { if (novo.projId) return erro('Solicitação ' + (novo.tipo === 'rh' ? 'de RH' : 'da frota') + ' não tem obra.', 400); if (novo.veicId && (novo.tipo !== 'frota' || !doc('veic/' + String(novo.veicId)))) return erro(novo.tipo === 'frota' ? 'Veículo da solicitação não encontrado.' : 'Só a solicitação da frota é ligada a um veículo.', 400); } /* v158 */
      if (novo.tipo === 'adm') { if (novo.projId) return erro('Solicitação administrativa não tem obra.', 400); if (!String(novo.categoria || '').trim()) return erro('Solicitação administrativa: escolha a categoria (plano de contas).', 400); }
    }
    return null;
  }
  /* depois de gravada a SC nova: a recusada ganha a ligação */
  function depois(conta, req, x) {
    if (!x || !x.origem) return;
    const p = 'sc/' + x.origem, o = doc(p), nv = doc('sc/' + x.nova); if (!o || !nv || o.reenviadaId) return;
    const n = Object.assign(JSON.parse(JSON.stringify(o)), { reenviadaId: x.nova, reenviadaNum: nv.numero || '', reenviadaEm: Date.now(), reenviadaPor: conta.id });
    n.hist = (Array.isArray(o.hist) ? o.hist : []).concat([{ t: n.reenviadaEm, by: conta.id, ch: [['reenviadaId', '—', 'reenviada como SC nº ' + (nv.numero || '')]] }]).slice(-20);
    salvar(p, n, conta, req, 'SC_REENVIADA', o);
  }
  /* camposProprio: o próprio registro, nas situações listadas, fica livre dos "campos" (cria só nessas situações) */
  function proprio(conta, d, c0, velho, novo, m) {
    const l = d && d.camposProprio && Array.isArray(d.camposProprio[c0]) ? d.camposProprio[c0] : null; if (!l || m === 'DELETE') return false;
    if (!velho) return l.includes(String((novo || {}).status || ''));
    return velho.crBy === conta.id && l.includes(String(velho.status || ''));
  }

  async function rota(p, m, req, res, conta) {
    if (m === 'POST' && p === '/api/aprov/lembrete') {
      const b = await lerJson(req), r = rotaLembrete(conta, req, b || {});
      json(res, r.erro ? (r.st || 403) : 200, r.erro ? { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : r.st === 429 ? 'rate_limited' : 'not_granted', erro: r.erro, lemb: r.lemb } : r); return true;
    }
    if (m === 'GET' && p === '/api/aprov/quem') {
      const u = new URL(req.url, 'http://x'), c = u.searchParams.get('col') || '', id = u.searchParams.get('id') || '';
      if (!['sc', 'ped'].includes(c) || !ID_OK.test(id)) { json(res, 400, { code: 'invalid_argument', erro: 'Documento inválido.' }); return true; }
      const r = doc(c + '/' + id); if (!r) { json(res, 404, { code: 'not_found', erro: 'Documento não encontrado.' }); return true; }
      if (!X.podeVer(conta, c + '/' + id, r)) { json(res, 403, { code: 'not_granted', erro: 'Sem acesso.' }); return true; }
      const qa = quem(c, Object.assign({}, r, { id }));
      if (qa.pend && qa.fallback) qa.donosAdmins = donosAdmins();
      json(res, 200, Object.assign(qa, { lemb: r.lembAprov || null, janelaMs: JANELA })); return true;
    }
    return false;
  }
  return { quem, antes, depois, proprio, rota, rotaLembrete, JANELA };
};

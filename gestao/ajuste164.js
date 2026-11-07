'use strict';
/* v164 (relatorios/feito_v164.md): aviso de SC recebida, lote e validade, entrega do pedido (obra / veículo próprio),
   material na obra, romaneio só de transporte, devolução de obra e transferência de guarda. Ligado em regras.js por
   v164/ed_v164.py. Coleções novas: rec164 (recebimento na obra e romaneio de retirada), mob164 (movimento da obra:
   transferência entre obras, consumo declarado, devolução nova), gua164 (transferência de guarda de ferramentas),
   pend164 (pendências: falta/avaria do fornecedor, acessório faltando, divergência, item não encontrado).
   1. SC recebida: quando um recebimento é gravado no pedido de compra (ped.recebs, pelo almoxarifado ou na obra) ou a nota
      liga o pedido como recebido, o servidor avisa quem pediu a SC (chat "Central de Gestão" e e-mail, se configurado) e
      guarda o aviso na própria SC (sc.rec164: um por recebimento, sem repetir). "Recebi / retirei" (POST /api/sc164/retirar)
      pela pessoa ou pelo almoxarife. Lembrete depois de 3 dias sem retirada (POST /api/sc164/lembretes e a cada hora).
   2. Lote: produto com lote:true. Movimento com lotes:[{lote,qtd,val,fab}] (entrada: obrigatório, validade calculada com
      diasValLote; saída/transferência/ajuste: lote escolhido, FEFO quando falta; lote vencido só em perda/descarte). Saldo
      antigo sem lote = lote "SEM-LOTE" (nenhuma quantidade muda). POST /api/lote164/identificar troca SEM-LOTE por lote.
   3. Pedido: ped.entrega164 (almox | obra | retira). Recebimento na obra: POST /api/rec164/obra (encarregado ou responsável
      pela obra, Administrador): entrada + saída de consumo direto na obra numa transação, pendência de falta/avaria,
      aviso ao comprador e à SC. Retirada com veículo próprio: POST /api/rec164/retirada (romaneio de retirada).
   6. Romaneio novo: item de ferramenta só ligado a um envio (fmov) — POST/PUT recusado sem envioId.
   7. Obra encerrada/concluída: recusada com saldo de material ou de ferramentas na obra, salvo liberação do Administrador
      com justificativa (proj.encerra164, auditada).
   8. Transferência de guarda: POST /api/gua164/transferir confere que as ferramentas estão mesmo com quem entrega. */
const crypto = require('node:crypto');
module.exports = function (X) {
  const { q, db, col, erro, ehDono, perfilEm, papelConta, cfgEmp, lerJson, json, avisarDoc } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const doc = p => { const d = X.doc(p); if (d && typeof d === 'object' && !d.id) d.id = String(p).split('/').pop(); return d; }; /* o id do caminho (o documento gravado pode não ter o campo id) */
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const r2 = v => Math.round((+v || 0) * 100) / 100;
  const r4 = v => Math.round((+v || 0) * 10000) / 10000;
  const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const maisDias = (d, n) => new Date(Date.parse(String(d).slice(0, 10) + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const br = d => dataOk(String(d || '').slice(0, 10)) ? String(d).slice(8, 10) + '/' + String(d).slice(5, 7) + '/' + String(d).slice(0, 4) : '';
  const admin = conta => ehDono(conta) || perfilEm(conta, ['admin']);
  const uniq = a => [...new Set(a.filter(Boolean))];
  const fq = v => (Math.round((+v || 0) * 1000) / 1000).toLocaleString('pt-BR');
  const C153 = () => X.C153();

  const nomeConta = id => { try { return X.nomeConta(id); } catch (e) { return id || ''; } };
  const ativa = u => { const c = u && q.contaPorId.get(u); return !!(c && c.ativo); };
  const nomeProj = id => { const p = id ? doc('proj/' + String(id)) : null; return p ? [p.codigo, p.nome].filter(Boolean).join(' · ') : ''; };
  const nomeAlm = id => { const a = id ? doc('almox/' + String(id)) : null; return a ? String(a.nome || '') : ''; };
  const stPorCampo = (c, campo) => db.prepare("SELECT id, data FROM docs WHERE parent='" + c + "' AND json_extract(data,'$." + campo + "')=?");
  const lista = (st, v) => st.all(String(v)).map(r => { try { return Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { return null; } }).filter(Boolean);
  const stPedSc = stPorCampo('ped', 'scId');
  /* gravação do próprio servidor (avisos e campos que só ele mantém) */
  function gravaSis(p, data) { const s = p.split('/'), ts = Date.now(); q.docPut.run(p, s.slice(0, -1).join('/'), s[s.length - 1], JSON.stringify(data), ts); avisarDoc('set', p, data, ts); return ts; }
  /* conversa "Central de Gestão" de cada pessoa (mesmo formato de aceite.js) */
  function avisarChat(uids, texto) {
    const ag = Date.now(); let n = 0;
    for (const u of uniq(uids).filter(x => ID_OK.test(x) && x !== 'sistema')) {
      try {
        const cid = 'av_' + u, cp = 'cm/sistema/c/' + cid;
        if (!q.docGet.get(cp)) { const cv = { id: cid, tipo: 'dm', membros: [u], ts: ag, sistema: true }; q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(cv), ag); avisarDoc('set', cp, cv, ag); }
        const mid = 'm' + ag.toString(36) + crypto.randomBytes(4).toString('hex'), mp = 'cm/sistema/m/' + mid;
        const msg = { id: mid, k: 'msg', conv: 'sistema/' + cid, txt: '🔔 ' + texto, ts: ag, men: [], sistema: true, v164: 1 };
        q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(msg), ag); avisarDoc('set', mp, msg, ag); n++;
      } catch (e) { console.error('[v164] chat:', e.message); }
    }
    return n;
  }
  function avisarEmail(uids, assunto, texto) {
    const E = X.EMAIL; if (!E || typeof E.configurado !== 'function' || !E.configurado()) return 0;
    let n = 0;
    for (const u of uniq(uids)) {
      const c = q.contaPorId.get(u); if (!c || !c.ativo || !/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(String(c.email || ''))) continue;
      try { const m = E.modelo(assunto, [texto], 'Abrir a Central de Gestão', X.APP_URL || ''); Promise.resolve(E.enviar({ para: c.email, assunto: assunto + ' · Central de Gestão', texto: m.texto, html: m.html })).catch(e => console.error('[v164] e-mail:', e && e.message)); n++; } catch (e) { console.error('[v164] e-mail:', e.message); }
    }
    return n;
  }
  const almoxarifesDe = almId => { try { return C153().quem(almId); } catch (e) { return []; } };
  const usuarios = () => col('usr').filter(u => u && u.uid && u.ativo !== false && ativa(u.uid));
  const papelU = u => { try { return X.papelDe(u.perfil); } catch (e) { return u.perfil; } };
  const comPapel = (...ps) => usuarios().filter(u => ps.includes(papelU(u))).map(u => u.uid);

  /* grava vários documentos numa transação, passando pelas regras (antesGravar) e pelo depois */
  let ROTA = false;
  function gravarLote(conta, req, itens, metodoAud, resumo) {
    const prep = []; ROTA = true;
    try {
      for (const x of itens) {
        const velho = x.velho !== undefined ? x.velho : doc(x.p);
        if (x.del) { prep.push({ x, velho, v: {} }); continue; }
        if (x.sis) { prep.push({ x, velho, v: { data: x.data } }); continue; } /* campo calculado pelo próprio servidor (recebimento, retirada, pendência) */
        const v = X.antesGravar(conta, x.p, velho, x.data, req);
        if (v && v.reauth) return erro('Confirme a senha e tente de novo.', 409);
        if (v && v.erro) return erro((x.p.startsWith('mov/') ? 'Estoque: ' : '') + v.erro, v.st);
        prep.push({ x, velho, v: v || { data: x.data } });
      }
    } finally { ROTA = false; }
    const ts = Date.now();
    db.exec('BEGIN');
    try { for (const { x, v } of prep) { const s = x.p.split('/'); if (x.del) q.docDel.run(x.p); else q.docPut.run(x.p, s.slice(0, -1).join('/'), s[s.length - 1], JSON.stringify(v.data || x.data), ts); } db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } return erro('Falha ao gravar. Nada foi gravado; tente de novo.', 500); }
    for (const { x, velho, v } of prep) { avisarDoc(x.del ? 'del' : 'set', x.p, x.del ? null : (v.data || x.data), ts); try { X.depois(conta, req, x.del ? 'DELETE' : 'PUT', x.p, velho || null, x.del ? null : (v.data || x.data), v); } catch (e) { } }
    auditar(conta, req, metodoAud, itens[0] ? itens[0].p : '', null, resumo || null);
    return { ok: true, docs: prep.filter(o => !o.x.del).map(o => { const s = o.x.p.split('/'); return { col: s[0], id: s[1], data: o.v.data || o.x.data }; }), dels: prep.filter(o => o.x.del).map(o => { const s = o.x.p.split('/'); return { col: s[0], id: s[1] }; }) };
  }

  /* =================================================================== 1. SC recebida */
  const solDe = sc => String((sc && (sc.solUid || sc.crBy)) || '');
  const SC_SIS = ['rec164', 'ret164', 'lem164'];
  /* linhas compradas da SC (todos os pedidos não cancelados) e quantas chegaram por inteiro */
  function progresso(scId) {
    let total = 0, done = 0; const falta = [];
    for (const p of lista(stPedSc, scId)) {
      if (p.status === 'cancelado') continue;
      const its = Array.isArray(p.itens) ? p.itens : [], recs = Array.isArray(p.recebs) ? p.recebs : [];
      its.forEach((i, k) => {
        if (!(+i.qtd > 0)) return; total++;
        const rq = recs.reduce((s, r) => s + (Array.isArray(r.itens) ? r.itens.filter(x => +x.k === k).reduce((a, x) => a + (+x.qtd || 0), 0) : 0), 0);
        if ((p.status === 'recebido' && !recs.length) || p.saldoEnc || rq >= (+i.qtd) - 1e-9) done++; else falta.push({ desc: String(i.desc || ''), qtd: r4((+i.qtd) - rq), un: String(i.un || 'UN') });
      });
    }
    return { total, done, falta };
  }
  function pratDe(itens) { return uniq(itens.map(i => { const p = i.prodId ? doc('prod/' + String(i.prodId)) : null; return p && p.prateleira ? String(p.prateleira) : ''; })); }
  /* um recebimento novo → aviso (uma vez por SC + recebimento) */
  function avisarRecebimento(sc, p, rec, origem) {
    if (!sc || sc.status === 'cancelada') return null;
    const key = String(rec.id || ''); if (!key) return null;
    const ja = Array.isArray(sc.rec164) ? sc.rec164 : [];
    if (ja.some(x => x.id === key)) return null;
    const its = (Array.isArray(rec.itens) ? rec.itens : []).map(x => { const i = (p.itens || [])[+x.k] || {}; return { desc: String(i.desc || x.desc || ''), qtd: r4(+x.qtd || 0), un: String(i.un || 'UN'), prodId: String(i.prodId || '') }; }).filter(x => x.qtd > 0);
    const pr = progresso(sc.id), obra = origem === 'obra';
    let almId = ''; try { almId = rec.almoxId || C153().almoxPed(p) || ''; } catch (e) { }
    const prat = obra ? [] : pratDe(its);
    const o = { id: key, pedId: p.id, pedNum: String(p.numero || ''), em: Date.now(), data: String(rec.data || hoje()), origem: obra ? 'obra' : 'almox', almoxId: obra ? '' : almId, projId: String(p.projId || sc.projId || ''), prat, itens: its.map(x => ({ desc: x.desc, qtd: x.qtd, un: x.un })), total: pr.total, done: pr.done, falta: pr.falta.slice(0, 30), ret: obra ? { em: Date.now(), auto: true } : null };
    const nova = Object.assign({}, sc, { rec164: ja.concat([o]) });
    gravaSis('sc/' + sc.id, nova);
    const u = solDe(sc), onde = obra ? 'entregue na obra ' + (nomeProj(o.projId) || '') : 'no almoxarifado ' + (nomeAlm(almId) || '(sem almoxarifado definido)');
    const cont = pr.total ? pr.done + ' de ' + pr.total + ' itens' + (pr.total - pr.done > 0 ? '; faltam ' + (pr.total - pr.done) : '; todos os itens chegaram') : its.length + ' item(ns)';
    const chegou = its.slice(0, 8).map(x => x.desc + ' (' + fq(x.qtd) + ' ' + x.un + ')').join(', ') + (its.length > 8 ? ' e mais ' + (its.length - 8) : '');
    const fal = pr.falta.length ? ' Ainda falta: ' + pr.falta.slice(0, 6).map(x => x.desc + ' (' + fq(x.qtd) + ' ' + x.un + ')').join(', ') + (pr.falta.length > 6 ? ' e mais ' + (pr.falta.length - 6) : '') + '. Você recebe outro aviso quando o restante chegar.' : '';
    const retire = obra ? ' O material já está na obra.' : ' Retire no almoxarifado ' + (nomeAlm(almId) || '') + (prat.length ? ' (prateleira ' + prat.join(', ') + ')' : '') + ' e confirme em "Recebi / retirei".';
    const txt = 'Sua SC nº ' + (sc.numero || '') + ' foi recebida ' + onde + ': ' + cont + '. Chegou: ' + chegou + '.' + fal + retire;
    if (u) { avisarChat([u], txt); avisarEmail([u], 'SC nº ' + (sc.numero || '') + ' recebida', txt); }
    auditar(null, null, 'SC_RECEBIDA_AVISO', 'sc/' + sc.id, null, { rec: key, ped: p.numero || '', origem: o.origem, para: u, faltam: pr.total - pr.done });
    return o;
  }
  function depoisPed(velho, novo) {
    if (!novo || !novo.scId) return;
    const sc = doc('sc/' + String(novo.scId)); if (!sc) return;
    const ant = new Set((Array.isArray((velho || {}).recebs) ? velho.recebs : []).map(r => r.id));
    const novos = (Array.isArray(novo.recebs) ? novo.recebs : []).filter(r => r && r.id && !ant.has(r.id));
    let cur = sc;
    for (const r of novos) { const o = avisarRecebimento(cur, novo, r, r.obra164 ? 'obra' : 'almox'); if (o) cur = doc('sc/' + sc.id) || cur; }
    /* nota lançada direto (sem recebimento): o pedido vira recebido */
    if (!novos.length && novo.status === 'recebido' && (velho || {}).status !== 'recebido' && !(novo.recebs || []).length && novo.notaId)
      avisarRecebimento(cur, novo, { id: 'nf_' + novo.notaId, data: hoje(), itens: (novo.itens || []).map((i, k) => ({ k, qtd: +i.qtd || 0 })) }, 'almox');
  }
  const pendentes = sc => (Array.isArray(sc.rec164) ? sc.rec164 : []).filter(r => !r.ret);
  function podeRetirarPor(conta, sc) {
    if (admin(conta)) return true;
    if (solDe(sc) === conta.id) return true;
    const pap = papelConta(conta);
    if (pap === 'almoxarife' || pap === 'almoxfab') return true;
    return pendentes(sc).some(r => r.almoxId && almoxarifesDe(r.almoxId).includes(conta.id));
  }
  function rotaRetirar(conta, req, b) {
    const id = String(b.scId || ''); if (!ID_OK.test(id)) return erro('SC inválida.', 400);
    const sc = doc('sc/' + id); if (!sc) return erro('SC não encontrada.', 404);
    const pend = pendentes(sc); if (!pend.length) return erro('Esta SC não tem material aguardando retirada.', 409);
    if (!podeRetirarPor(conta, sc)) return erro('Só quem pediu a SC ou o almoxarife registram a retirada.');
    const porUid = solDe(sc) === conta.id ? conta.id : String(b.porUid || solDe(sc) || ''), em = Date.now();
    const porNome = String(b.porNome || '').trim().slice(0, 120) || nomeConta(porUid);
    const ret = { em, porUid, porNome, regPor: conta.id, emNome: nomeConta(conta.id), obs: String(b.obs || '').slice(0, 300), recIds: pend.map(r => r.id), almoxarife: conta.id !== solDe(sc) };
    const novo = Object.assign({}, sc, { rec164: sc.rec164.map(r => r.ret ? r : Object.assign({}, r, { ret: { em, porUid, porNome, regPor: conta.id } })), ret164: (Array.isArray(sc.ret164) ? sc.ret164 : []).concat([ret]) });
    gravaSis('sc/' + id, novo);
    auditar(conta, req, 'SC_RETIRADA', 'sc/' + id, null, { por: porNome, registrou: conta.id, recebimentos: ret.recIds });
    if (conta.id !== solDe(sc) && solDe(sc)) avisarChat([solDe(sc)], 'O almoxarife ' + nomeConta(conta.id) + ' registrou a retirada do material da sua SC nº ' + (sc.numero || '') + ' por ' + porNome + '.');
    return { ok: true, msg: 'Retirada registrada.', sc: novo };
  }
  /* lembrete: 3 dias sem retirada → quem pediu e o almoxarife responsável (uma vez por recebimento) */
  function lembrar(dias) {
    const lim = Date.now() - (dias == null ? 3 : dias) * 864e5; let n = 0;
    for (const r of db.prepare("SELECT id, data FROM docs WHERE parent='sc' AND data LIKE '%\"rec164\"%'").all()) {
      let sc; try { sc = Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { continue; }
      if (sc.status === 'cancelada') continue;
      const atr = pendentes(sc).filter(x => +x.em <= lim && !x.lem);
      if (!atr.length) continue;
      const u = solDe(sc), alm = uniq(atr.map(x => x.almoxId)), dsc = 'nº ' + (sc.numero || '');
      avisarChat([u], 'Lembrete: o material da sua SC ' + dsc + ' está no almoxarifado ' + alm.map(nomeAlm).join(', ') + ' desde ' + br(new Date(Math.min(...atr.map(x => +x.em)) - 3 * 3600e3).toISOString()) + '. Retire e confirme em "Recebi / retirei".');
      const al = uniq([].concat(...alm.map(almoxarifesDe))).filter(x => x !== u);
      if (al.length) avisarChat(al, 'A SC ' + dsc + ' (' + nomeConta(u) + ') está recebida há mais de 3 dias e ninguém retirou o material no almoxarifado ' + alm.map(nomeAlm).join(', ') + '. Avise a pessoa ou registre a retirada.');
      const em = Date.now();
      gravaSis('sc/' + sc.id, Object.assign({}, sc, { rec164: sc.rec164.map(x => atr.some(a => a.id === x.id) ? Object.assign({}, x, { lem: em }) : x), lem164: em }));
      n++;
    }
    return n;
  }
  if (process.env.NODE_ENV !== 'test') setInterval(() => { try { lembrar(); } catch (e) { console.error('[v164] lembrete:', e.message); } }, 3600e3).unref();


  /* =================================================================== 2. lote e validade */
  const L = require('./lote164.js');
  try { db.exec("CREATE INDEX IF NOT EXISTS ix164_mov_prod ON docs(json_extract(data,'$.prodId')) WHERE parent='mov'"); } catch (e) { console.error('[v164] índice:', e.message); }
  const stMovProd = db.prepare("SELECT id, data FROM docs WHERE parent='mov' AND json_extract(data,'$.prodId')=?");
  const cmpMov = (a, b) => String(a.data || '').localeCompare(String(b.data || '')) || (+a.cr || +a.ts || 0) - (+b.cr || +b.ts || 0);
  function saldosLote(pid, fora) { const ms = lista(stMovProd, pid).filter(m => !fora || m.id !== fora).sort(cmpMov); return L.calc(ms, doc('prod/' + pid), id => doc('mov/' + id)); }
  const ehLote = p => !!(p && p.lote === true);
  const SEM_OK = ['recProv', 'devObraId', 'devObra', 'devolObra', 'higId', 'higienizado', 'mob164', 'quar164', 'gua164', 'devFor', 'impLote', 'balanco', 'invajId', 'epiId'];
  const temV = v => !(v === undefined || v === null || v === '' || v === false);
  const normLotes = ls => ls.map(x => ({ lote: String((x && x.lote) || '').trim().slice(0, 60), qtd: r4(x && x.qtd), val: dataOk(x && x.val) ? x.val : '', fab: dataOk(x && x.fab) ? x.fab : '' }));
  function antesMov(conta, id, velho, novo) {
    const pid = String(novo.prodId || ''), prod = pid ? doc('prod/' + pid) : null;
    if (velho) { if (velho.lotes !== undefined) novo.lotes = velho.lotes; else delete novo.lotes; return null; } /* os lotes de um movimento gravado não mudam (para identificar o SEM-LOTE: /api/lote164/identificar) */
    if (!ehLote(prod)) { delete novo.lotes; return null; }
    const t = String(novo.tipo || ''), q = +novo.qtd || 0, nome = String(prod.nome || pid);
    if (temV(novo.estornoDe)) { const o = doc('mov/' + String(novo.estornoDe)); if (o && Array.isArray(o.lotes) && o.lotes.length) novo.lotes = o.tipo === 'ajuste' ? o.lotes.map(x => Object.assign({}, x, { qtd: -(+x.qtd || 0) })) : o.lotes; else delete novo.lotes; return null; }
    if (novo.ex === true) return null;
    let ls = Array.isArray(novo.lotes) && novo.lotes.length ? normLotes(novo.lotes.slice(0, 50)) : null;
    const soma = a => r4(a.reduce((s, x) => s + x.qtd, 0));
    if (t === 'entrada') {
      if (!ls) { if (SEM_OK.some(k => temV(novo[k]))) { novo.lotes = [{ lote: L.SEM, qtd: r4(Math.abs(q)) }]; return null; } return erro('Produto com controle de lote (' + nome + '): informe o lote e a validade da entrada.', 400); }
      for (const x of ls) {
        if (!x.lote) return erro('Informe o número do lote (' + nome + ').', 400);
        if (!(x.qtd > 0)) return erro('Quantidade do lote ' + x.lote + ' inválida.', 400);
        if (!x.val) x.val = L.valCalc(prod, x.fab, novo.data);
        if (!x.val && x.lote !== L.SEM) return erro('Informe a validade do lote ' + x.lote + ' (' + nome + ') ou os dias de validade do lote no cadastro do produto.', 400);
      }
      if (Math.abs(soma(ls) - Math.abs(q)) > 0.001) return erro('A soma dos lotes (' + fq(soma(ls)) + ') não confere com a quantidade da entrada (' + fq(Math.abs(q)) + ').', 400);
      if (new Set(ls.map(x => x.lote)).size !== ls.length) return erro('O mesmo lote aparece duas vezes na entrada.', 400);
      novo.lotes = ls; return null;
    }
    if (t === 'saida' || t === 'transf' || (t === 'ajuste' && !ls && q < 0)) {
      const sd = saldosLote(pid, id), alm = String(novo.almoxId || prod.almoxId || ''), h = hoje();
      const perda = (t === 'saida' && ['perda', 'descarte'].includes(String(novo.motivo || ''))) || temV(novo.quar164) || temV(novo.perda164);
      if (t === 'saida' && temV(novo.rec164) && ls) { novo.lotes = ls; return null; } /* consumo direto na obra: os mesmos lotes da entrada do recebimento */
      if (!ls) { const f = L.fefo(sd, alm, Math.abs(q), h, false); ls = f.alloc; if (f.falta > 1e-9) ls.push({ lote: L.SEM, qtd: f.falta, val: '' }); novo.lotes = ls.map(x => ({ lote: x.lote, qtd: x.qtd, val: x.val || '' })); novo.fefo164 = 1; return null; }
      for (const x of ls) {
        const o = sd.get(alm + '|' + x.lote);
        if (x.lote !== L.SEM && (!o || o.qtd < x.qtd - 1e-6)) return erro('O lote ' + x.lote + ' de ' + nome + ' não tem ' + fq(x.qtd) + ' no almoxarifado (saldo do lote: ' + fq(o ? o.qtd : 0) + ').', 409);
        if (o && o.val && o.val < h && !perda) return erro('O lote ' + x.lote + ' de ' + nome + ' venceu em ' + br(o.val) + '. Lote vencido só sai como perda ou descarte, com o motivo.', 409);
        x.val = o ? o.val || '' : ''; if (o && o.fab) x.fab = o.fab;
      }
      if (t !== 'ajuste' && Math.abs(soma(ls) - Math.abs(q)) > 0.001) return erro('A soma dos lotes (' + fq(soma(ls)) + ') não confere com a quantidade (' + fq(Math.abs(q)) + ').', 400);
      novo.lotes = ls; return null;
    }
    if (t === 'ajuste' && ls) {
      if (Math.abs(soma(ls) - q) > 0.001) return erro('A soma dos lotes do ajuste (' + fq(soma(ls)) + ') não confere com a diferença (' + fq(q) + ').', 400);
      const sd = saldosLote(pid, id), alm = String(novo.almoxId || prod.almoxId || '');
      for (const x of ls) { if (x.qtd < 0) { const o = sd.get(alm + '|' + x.lote); if (!o || o.qtd < -x.qtd - 1e-6) return erro('O lote ' + x.lote + ' não tem ' + fq(-x.qtd) + ' para baixar (saldo ' + fq(o ? o.qtd : 0) + ').', 409); if (!x.val) x.val = o.val || ''; } else if (!x.val && x.lote !== L.SEM) { const o = sd.get(alm + '|' + x.lote); x.val = (o && o.val) || L.valCalc(prod, x.fab, novo.data); if (!x.val) return erro('Informe a validade do lote ' + x.lote + '.', 400); } }
      novo.lotes = ls; return null;
    }
    return null;
  }
  /* identificar o SEM-LOTE (no inventário): ajuste de quantidade zero que troca SEM-LOTE pelo lote informado */
  function rotaIdentificar(conta, req, b) {
    if (!(admin(conta) || X.gravaCol(conta, 'mov'))) return erro('Seu perfil não movimenta o estoque.');
    const pid = String(b.prodId || ''), prod = ID_OK.test(pid) ? doc('prod/' + pid) : null; if (!ehLote(prod)) return erro('Produto sem controle de lote.', 400);
    const alm = String(b.almoxId || ''), ls = normLotes(Array.isArray(b.lotes) ? b.lotes.slice(0, 30) : []).filter(x => x.qtd > 0);
    if (!ls.length) return erro('Informe o lote, a validade e a quantidade.', 400);
    const sd = saldosLote(pid), sem = sd.get(alm + '|' + L.SEM), tot = r4(ls.reduce((s, x) => s + x.qtd, 0));
    if (!sem || sem.qtd < tot - 1e-6) return erro('O saldo SEM-LOTE deste almoxarifado é ' + fq(sem ? sem.qtd : 0) + '.', 409);
    for (const x of ls) { if (!x.lote || x.lote === L.SEM) return erro('Informe o número do lote.', 400); if (!x.val) x.val = L.valCalc(prod, x.fab, hoje()); if (!x.val) return erro('Informe a validade do lote ' + x.lote + '.', 400); }
    const mid = 'lt' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const mov = { id: mid, data: hoje(), prodId: pid, tipo: 'ajuste', qtd: 0, custoUnit: 0, projId: '', almoxId: alm, obs: 'Lote identificado no inventário (SEM-LOTE → ' + ls.map(x => x.lote).join(', ') + ')', lote164: 'identificar', lotes: [{ lote: L.SEM, qtd: -tot, val: '' }].concat(ls), crBy: conta.id, cr: Date.now() };
    const x = gravarLote(conta, req, [{ p: 'mov/' + mid, data: mov }], 'LOTE_IDENTIFICADO', { prodId: pid, almoxId: alm, lotes: ls.map(x => x.lote + ':' + x.qtd) });
    return x;
  }


  /* =================================================================== 3. entrega do pedido e recebimento na obra */
  const ENTREGA = ['almox', 'obra', 'retira'];
  const novoId = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  /* quem recebe na obra: Administrador/dono, o responsável pela obra (proj.respObra) ou o encarregado alocado na obra
     (colaborador ligado ao usuário com o projeto atual = a obra) */
  function podeObra(conta, projId) {
    if (admin(conta)) return true;
    const p = projId ? doc('proj/' + String(projId)) : null; if (!p) return false;
    if (p.respObra && p.respObra === conta.id) return true;
    if (papelConta(conta) !== 'encarregado') return false;
    return col('func').some(f => f.usrId === conta.id && f.status !== 'desligado' && String(f.projId || '') === String(projId));
  }
  const compradorDe = p => uniq([p.crBy, (cfgEmp().matFluxo || {}).comprador].filter(u => u && ativa(u)));
  const recQ = (p, k) => (Array.isArray(p.recebs) ? p.recebs : []).reduce((s, r) => s + (Array.isArray(r.itens) ? r.itens.filter(x => +x.k === k).reduce((a, x) => a + (+x.qtd || 0), 0) : 0), 0);
  const saldoIt = (p, k) => { const it = (p.itens || [])[k]; if (!it) return 0; if (p.status === 'recebido' && !(p.recebs || []).length) return 0; return Math.max(0, r4((+it.qtd || 0) - recQ(p, k))); };
  const itBruto = i => (+i.qtd || 0) * (+i.vUnit || 0), itDesc = i => r2(itBruto(i) * Math.min(100, Math.max(0, +i.pDesc || 0)) / 100);
  const itLiq = i => r2(itBruto(i) - itDesc(i) + r2((itBruto(i) - itDesc(i)) * (+i.pIpi || 0) / 100) + (+i.vSt || 0));
  /* custo unitário do item do pedido: líquido do desconto do item, + IPI e ST, com o frete e o desconto do pedido rateados pelo valor */
  function custoUnit(p, k) { const its = p.itens || [], i = its[k]; if (!i || !(+i.qtd > 0)) return 0; const tot = its.reduce((s, x) => s + itLiq(x), 0), l = itLiq(i), ac = (+p.frete || 0) - (+p.descGeral || 0); return r4((l + (tot > 0 ? ac * l / tot : 0)) / (+i.qtd)); }
  function anexo(a) { if (!a || typeof a !== 'object') return null; const id = String(a.id || ''); if (!ID_OK.test(id)) return null; return { id, nome: String(a.nome || '').slice(0, 160), ct: String(a.ct || '').slice(0, 80) }; }
  function assinatura(a) { if (!a || typeof a !== 'object') return null; const nome = String(a.nome || '').trim().slice(0, 120); const img = typeof a.img === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(a.img) && a.img.length < 400000 ? a.img : ''; if (nome.length < 3) return null; return { nome, img, em: Date.now() }; }
  function antesPed(conta, id, velho, novo) {
    const v = velho || {};
    if (!ROTA) for (const k of ['retirada164', 'pend164', 'vsai164']) { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; } /* só pelas rotas */
    if (novo.entrega164 !== undefined && !ENTREGA.includes(novo.entrega164)) return erro('Entrega do pedido inválida.', 400);
    if (novo.entrega164 === 'obra' && !novo.projId) return erro('Entrega direto na obra: escolha a obra (projeto) do pedido.', 400);
    if (novo.entrega164 === 'retira') { if (!novo.veic164 || !doc('veic/' + String(novo.veic164))) return erro('Retirada com veículo próprio: escolha o veículo.', 400); if (!novo.mot164 || !doc('func/' + String(novo.mot164))) return erro('Retirada com veículo próprio: escolha o motorista.', 400); if (!dataOk(novo.retData164)) return erro('Retirada com veículo próprio: informe a data da retirada.', 400); }
    /* recebimento na obra só pela rota (/api/rec164/obra) */
    const antigos = new Set((Array.isArray(v.recebs) ? v.recebs : []).map(r => r.id));
    if ((Array.isArray(novo.recebs) ? novo.recebs : []).some(r => r && r.obra164 && !antigos.has(r.id)) && !ROTA) return erro('O recebimento na obra é registrado em Obras › Recebimentos pendentes desta obra.', 409);
    if (velho && (v.entrega164 === 'obra' || v.entrega164 === 'retira') && !ROTA) { const novos = (Array.isArray(novo.recebs) ? novo.recebs : []).filter(r => r && !antigos.has(r.id)); if (novos.length) return erro('Este pedido é entregue na obra: o recebimento é feito pelo encarregado ou pelo responsável pela obra (Obras › Recebimentos pendentes desta obra).', 409); }
    return null;
  }
  /* veículo próprio: a saída de frota ligada ao pedido (vsai) */
  function depoisPedFrota(novo) {
    if (!novo || novo.entrega164 !== 'retira' || !novo.veic164) return;
    const vid = 'ped164_' + novo.id, v = doc('vsai/' + vid);
    if (v && v.retornoEm) return;
    const f = doc('parc/' + String(novo.parcId || '')) || {};
    const n = Object.assign({}, v || {}, { id: vid, veicId: String(novo.veic164), funcId: String(novo.mot164 || ''), projId: String(novo.projId || ''), destino: 'Retirada do pedido de compra nº ' + (novo.numero || '') + (f.nome ? ' em ' + f.nome : ''), saidaEm: String(novo.retData164 || hoje()), hora: (v && v.hora) || '', kmSaida: (v && v.kmSaida) || '', retornoEm: '', kmRetorno: '', obs: 'Criada pelo pedido de compra nº ' + (novo.numero || '') + ' (v164)', pedId164: novo.id });
    gravaSis('vsai/' + vid, n);
    if (novo.vsai164 !== vid) { const cur = doc('ped/' + novo.id); if (cur) gravaSis('ped/' + novo.id, Object.assign({}, cur, { vsai164: vid })); }
  }
  /* passo 1 da retirada com veículo próprio: o motorista confirma no fornecedor o que retirou, com a foto da nota */
  function rotaRetirada(conta, req, b) {
    const pid = String(b.pedId || ''), p = ID_OK.test(pid) ? doc('ped/' + pid) : null; if (!p) return erro('Pedido não encontrado.', 404);
    if (p.entrega164 !== 'retira') return erro('Este pedido não é de retirada com veículo próprio.', 409);
    const mot = p.mot164 ? doc('func/' + p.mot164) : null, eMot = !!(mot && mot.usrId === conta.id);
    if (!(admin(conta) || eMot || ['comprador', 'compras', 'almoxarife', 'almoxfab'].includes(papelConta(conta)))) return erro('Quem confirma a retirada é o motorista do pedido (ou o comprador ou o almoxarife).');
    if (p.retirada164 && !p.retirada164.cancelada) return erro('A retirada deste pedido já foi confirmada.', 409);
    const its = []; for (const x of Array.isArray(b.itens) ? b.itens.slice(0, 300) : []) { const k = +x.k, q = r4(+x.qtd || 0); if (!Number.isInteger(k) || !(p.itens || [])[k] || q < 0) return erro('Item inválido.', 400); if (q > saldoIt(p, k) + 1e-6) return erro('Item ' + (k + 1) + ': retirado mais que o saldo do pedido.', 400); if (q > 0) its.push({ k, qtd: q }); }
    if (!its.length) return erro('Informe o que foi retirado.', 400);
    const nf = anexo(b.notaFoto); if (!nf) return erro('Tire a foto da nota fiscal na retirada.', 400);
    const rid = novoId('rt'), r = { id: rid, tipo: 'retirada', pedId: pid, pedNum: String(p.numero || ''), projId: String(p.projId || ''), parcId: String(p.parcId || ''), data: dataOk(b.data) ? b.data : hoje(), em: Date.now(), por: conta.id, porNome: nomeConta(conta.id), motorista: mot ? String(mot.nome || '') : '', motoristaId: p.mot164 || '', veicId: p.veic164 || '', itens: its.map(x => Object.assign({}, x, { desc: String(p.itens[x.k].desc || ''), un: String(p.itens[x.k].un || 'UN') })), anexos: { nota: nf }, st: 'transito' };
    const np = Object.assign({}, p, { retirada164: { id: rid, em: r.em, por: conta.id, itens: its } });
    const x = gravarLote(conta, req, [{ p: 'rec164/' + rid, data: r }, { p: 'ped/' + pid, data: np, sis: true }], 'PED_RETIRADA_164', { ped: p.numero || '', itens: its.length });
    if (x.erro) return x;
    const enc = uniq([(doc('proj/' + String(p.projId || '')) || {}).respObra].concat(col('func').filter(f => f.status !== 'desligado' && f.usrId && String(f.projId || '') === String(p.projId || '')).map(f => f.usrId)));
    avisarChat(enc.filter(u => u !== conta.id), 'O material do pedido de compra nº ' + (p.numero || '') + ' foi retirado no fornecedor' + (r.motorista ? ' pelo motorista ' + r.motorista : '') + ' e está a caminho da obra ' + nomeProj(p.projId) + '. Confira e assine em Obras › Recebimentos pendentes desta obra.');
    x.msg = 'Retirada confirmada.'; return x;
  }
  /* passo final: recebimento na obra (encarregado ou responsável): conferência item a item, fotos, assinatura, lote; estoque
     entra e sai como consumo direto da obra (custo do pedido no projeto/etapa); nota em rascunho ligada (3-way);
     falta/avaria vira pendência com o fornecedor e avisa o comprador */
  function rotaRecObra(conta, req, b) {
    const pid = String(b.pedId || ''), p = ID_OK.test(pid) ? doc('ped/' + pid) : null; if (!p) return erro('Pedido não encontrado.', 404);
    if (p.entrega164 !== 'obra' && p.entrega164 !== 'retira') return erro('Este pedido é entregue no almoxarifado: o recebimento é pelo almoxarife.', 409);
    if (['cancelado', 'recebido'].includes(p.status)) return erro('Este pedido não tem saldo a receber.', 409);
    if (!p.projId || !doc('proj/' + String(p.projId))) return erro('O pedido não tem a obra.', 400);
    if (!podeObra(conta, p.projId)) return erro('Quem recebe na obra é o encarregado alocado na obra ou o responsável pela obra (ou o Administrador).');
    if (p.entrega164 === 'retira' && !(p.retirada164 && p.retirada164.id)) return erro('Retirada com veículo próprio: primeiro o motorista confirma o que retirou no fornecedor (romaneio de retirada).', 409);
    const as = assinatura(b.assin); if (!as) return erro('Assinatura: informe o nome de quem recebeu (e assine no quadro).', 400);
    const nf = anexo(b.anexos && b.anexos.nota), fm = anexo(b.anexos && b.anexos.material);
    if (!nf) return erro('Anexe a foto ou o arquivo da nota fiscal (ou do canhoto).', 400);
    const data = dataOk(b.data) ? b.data : hoje(), rid = novoId('ro'), its = [], movs = [];
    const sc = p.scId ? doc('sc/' + String(p.scId)) : null, etapaId = String(p.etapaId || (sc && sc.etapaId) || '');
    for (const x of Array.isArray(b.itens) ? b.itens.slice(0, 300) : []) {
      const k = +x.k, i = (p.itens || [])[k]; if (!Number.isInteger(k) || !i) return erro('Item inválido.', 400);
      const q = r4(+x.qtd || 0), av = r4(+x.avaria || 0), sd = saldoIt(p, k);
      if (q < 0 || av < 0) return erro('Quantidade negativa no item ' + (k + 1) + '.', 400);
      if (q + av > sd + 1e-6) return erro('Item ' + (k + 1) + ' (' + (i.desc || '') + '): recebido + avaria (' + fq(q + av) + ') passa do saldo do pedido (' + fq(sd) + ').', 400);
      const fl = x.falta === undefined || x.falta === '' ? r4(Math.max(0, sd - q - av)) : Math.min(r4(+x.falta || 0), r4(Math.max(0, sd - q - av)));
      const fa = anexo(x.fotoAvaria); if (av > 0 && !fa) return erro('Avaria no item ' + (k + 1) + ': tire a foto.', 400);
      if (!(q > 0) && !(av > 0) && !(fl > 0)) continue;
      its.push({ k, desc: String(i.desc || ''), un: String(i.un || 'UN'), prodId: String(i.prodId || ''), pedido: +i.qtd || 0, saldo: sd, qtd: q, falta: fl, avaria: av, fotoAvaria: fa, lotes: Array.isArray(x.lotes) ? x.lotes.slice(0, 20) : null });
    }
    if (!its.some(x => x.qtd > 0 || x.avaria > 0)) return erro('Informe a quantidade recebida (ou a avaria) de pelo menos um item.', 400);
    /* nota em rascunho ligada ao pedido e ao recebimento (a mesma regra do recebimento no almoxarifado) */
    const nid = novoId('nf'), bruto = its.reduce((s, x) => s + x.qtd * (+p.itens[x.k].vUnit || 0), 0), pb = (p.itens || []).reduce((s, i) => s + itBruto(i), 0) || 1;
    let desc = 0, ipi = 0, st = 0;
    const nitens = its.filter(x => x.qtd > 0).map(x => { const i = p.itens[x.k], f = (+i.qtd || 0) > 0 ? x.qtd / (+i.qtd) : 0, pr = i.prodId ? doc('prod/' + String(i.prodId)) || {} : {}; desc += itDesc(i) * f; ipi += r2((itBruto(i) - itDesc(i)) * (+i.pIpi || 0) / 100) * f; st += (+i.vSt || 0) * f; return { desc: String(i.desc || ''), prodId: String(i.prodId || ''), ncm: String(i.ncm || pr.ncm || ''), cfop: '1102', un: String(i.un || 'UN'), qtd: x.qtd, vUnit: +i.vUnit || 0, pedK: x.k, obra164: true }; });
    const fr = bruto / pb, venc = maisDias(data, 30);
    const nota = { id: nid, tipo: 'entrada', numero: '', serie: '1', natOp: 'Compra para consumo na obra', emissao: data, parcId: String(p.parcId || ''), projId: String(p.projId || ''), chave: '', itens: nitens, frete: r2((+p.frete || 0) * fr), desconto: r2(desc + (+p.descGeral || 0) * fr), outras: r2(st), ipi: r2(ipi), aliqIcms: 0, aliqPis: 0, aliqCofins: 0, categoria: 'Compra de mercadorias e insumos', parcelas: 1, venc1: venc, intervalo: 30, contaId: '', comum: false, status: 'rascunho', protocolo: '', rIss: 0, rIrrf: 0, rPis: 0, rCofins: 0, rCsll: 0, rInss: 0, pedId: pid, recebId: rid, obra164: { projId: String(p.projId), recId: rid }, crBy: conta.id, cr: Date.now() };
    for (const x of its) {
      if (!(x.qtd > 0) || !x.prodId || !doc('prod/' + x.prodId)) continue;
      const cu = custoUnit(p, x.k), base = { data, prodId: x.prodId, qtd: x.qtd, custoUnit: cu, almoxId: '', prateleira: '', rec164: rid, pedId: pid, crBy: conta.id, cr: Date.now() };
      const ls = x.lotes && x.lotes.length ? x.lotes : undefined;
      const e = Object.assign({ id: novoId('re'), tipo: 'entrada', projId: '', obs: 'Recebido na obra ' + nomeProj(p.projId) + ' · pedido nº ' + (p.numero || '') }, base, ls ? { lotes: ls } : {});
      movs.push({ p: 'mov/' + e.id, data: e });
      movs.push({ p: 'mov/' + novoId('rs'), data: Object.assign({ tipo: 'saida', projId: String(p.projId), etapaId, consumoDireto164: true, obs: 'Consumo direto na obra ' + nomeProj(p.projId) + ' · pedido nº ' + (p.numero || '') }, base, ls ? { lotes: ls } : {}, { id: undefined }) });
    }
    movs.forEach(m => { if (!m.data.id) m.data.id = m.p.split('/')[1]; });
    const rec = { id: rid, data, por: conta.id, em: Date.now(), conferente: as.nome, itens: its.filter(x => x.qtd > 0).map(x => ({ k: x.k, qtd: x.qtd })), notaId: nid, obra164: true, recObraId: rid };
    const recebs = (Array.isArray(p.recebs) ? p.recebs : []).concat([rec]);
    const comp = (p.itens || []).every((i, k) => !(+i.qtd > 0) || recebs.reduce((s, r) => s + (r.itens || []).filter(y => +y.k === k).reduce((a, y) => a + (+y.qtd || 0), 0), 0) >= (+i.qtd) - 1e-9);
    let pend = null;
    const ruins = its.filter(x => x.falta > 0 || x.avaria > 0);
    if (ruins.length) pend = { id: novoId('pf'), tipo: 'fornecedor', origem: 'rec164', recId: rid, pedId: pid, pedNum: String(p.numero || ''), parcId: String(p.parcId || ''), projId: String(p.projId), itens: ruins.map(x => ({ k: x.k, desc: x.desc, un: x.un, falta: x.falta, avaria: x.avaria, fotoAvaria: x.fotoAvaria })), st: 'aberta', em: Date.now(), por: conta.id };
    const np = Object.assign({}, p, { recebs, notaId: nid, notaIds: (p.notaIds || []).concat([nid]), recParcial: !comp, pend164: pend ? (p.pend164 || []).concat([pend.id]) : p.pend164 });
    if (comp && !X.pedPend(np)) np.status = 'recebido'; else if (np.status === 'aberto') np.status = 'enviado';
    const r164 = { id: rid, tipo: 'obra', pedId: pid, pedNum: String(p.numero || ''), projId: String(p.projId), parcId: String(p.parcId || ''), data, em: Date.now(), por: conta.id, porNome: nomeConta(conta.id), itens: its, anexos: { nota: nf, material: fm }, assin: as, retiradaId: p.retirada164 ? p.retirada164.id : '', pendId: pend ? pend.id : '', notaId: nid, etapaId };
    const docs = [{ p: 'notas/' + nid, data: nota }].concat(movs, [{ p: 'rec164/' + rid, data: r164 }], pend ? [{ p: 'pend164/' + pend.id, data: pend }] : [], [{ p: 'ped/' + pid, data: np, sis: true }]);
    if (p.retirada164 && p.retirada164.id) { const rt = doc('rec164/' + p.retirada164.id); if (rt) docs.push({ p: 'rec164/' + rt.id, data: Object.assign({}, rt, { st: 'entregue', entregueEm: Date.now(), recObraId: rid }) }); }
    const x = gravarLote(conta, req, docs, 'REC_OBRA_164', { ped: p.numero || '', obra: p.projId, itens: its.length, falta: ruins.length });
    if (x.erro) return x;
    if (pend) avisarChat(compradorDe(p).filter(u => u !== conta.id), 'Recebimento na obra ' + nomeProj(p.projId) + ' do pedido de compra nº ' + (p.numero || '') + ' com ' + ruins.map(y => y.desc + ': ' + (y.falta > 0 ? 'faltou ' + fq(y.falta) + ' ' + y.un : '') + (y.falta > 0 && y.avaria > 0 ? ', ' : '') + (y.avaria > 0 ? 'avaria ' + fq(y.avaria) + ' ' + y.un : '')).join('; ') + '. A pendência com o fornecedor ficou no pedido.');
    x.msg = 'Recebimento na obra registrado.' + (pend ? ' Falta/avaria: o comprador foi avisado.' : '');
    return x;
  }
  /* pedidos a receber nas obras da pessoa (o encarregado não lê pedidos de compra: a rota devolve só o necessário) */
  function rotaPendentes(conta) {
    const out = [];
    for (const r of db.prepare("SELECT id, data FROM docs WHERE parent='ped' AND json_extract(data,'$.entrega164') IN ('obra','retira')").all()) {
      let p; try { p = Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { continue; }
      if (['cancelado', 'recebido'].includes(p.status) || !p.projId || !podeObra(conta, p.projId)) continue;
      const f = doc('parc/' + String(p.parcId || '')) || {}, v = p.veic164 ? doc('veic/' + p.veic164) : null, mo = p.mot164 ? doc('func/' + p.mot164) : null;
      out.push({ id: p.id, numero: p.numero || '', data: p.data || '', previsao: p.previsao || '', projId: p.projId, parcId: p.parcId || '', parcNome: String(f.nome || f.fantasia || ''), entrega164: p.entrega164, veic164: p.veic164 || '', veicNome: v ? [v.placa, v.modelo].filter(Boolean).join(' · ') : '', mot164: p.mot164 || '', motNome: mo ? String(mo.nome || '') : '', retirada164: p.retirada164 || null, frete: +p.frete || 0, descGeral: +p.descGeral || 0, scId: p.scId || '', etapaId: p.etapaId || '', itens: (p.itens || []).map(i => ({ desc: String(i.desc || ''), un: String(i.un || 'UN'), qtd: +i.qtd || 0, prodId: String(i.prodId || '') })), saldos: (p.itens || []).map((i, k) => saldoIt(p, k)) });
    }
    const roms = [];
    for (const r of db.prepare("SELECT id, data FROM docs WHERE parent='rom' AND json_extract(data,'$.status')='transito' AND json_extract(data,'$.destTipo')='obra'").all()) {
      let x; try { x = Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { continue; }
      if (!x.projId || !podeObra(conta, x.projId)) continue;
      roms.push({ id: x.id, numero: x.numero || '', data: x.data || '', projId: x.projId, v164: x.v164 || 0, almoxId: x.almoxId || '', itens: (x.itens || []).map(i => { const m = i.fmovId ? doc('fmov/' + i.fmovId) : null, f = m ? doc('ferr/' + String(m.ferrId)) || {} : null; return { origem: i.origem, desc: String(i.desc || ''), un: String(i.un || ''), qtd: +i.qtd || 0, prodId: i.prodId || '', fmovId: i.fmovId || '', guarda: m ? String((doc('func/' + String(m.funcId)) || {}).nome || '') : '', acess: f && Array.isArray(f.acess164) ? f.acess164.map(a => ({ id: a.id, desc: a.desc, qtd: a.qtd })) : [] }; }) });
    }
    return { ok: true, peds: out, roms };
  }
  /* pendência com o fornecedor resolvida (comprador) */
  function rotaPendOk(conta, req, b) {
    const id = String(b.id || ''), pd = ID_OK.test(id) ? doc('pend164/' + id) : null; if (!pd) return erro('Pendência não encontrada.', 404);
    if (!(admin(conta) || ['comprador', 'compras', 'almoxarife', 'almoxfab'].includes(papelConta(conta)) || podeObra(conta, pd.projId))) return erro('Seu perfil não resolve esta pendência.');
    if (pd.st !== 'aberta') return erro('Esta pendência já foi resolvida.', 409);
    const como = String(b.como || '').trim().slice(0, 300); if (como.length < 3) return erro('Diga como foi resolvida (reposição, crédito, devolução…).', 400);
    return gravarLote(conta, req, [{ p: 'pend164/' + id, data: Object.assign({}, pd, { st: 'resolvida', okEm: Date.now(), okPor: conta.id, como }) }], 'PEND_164_RESOLVIDA', { id, como });
  }


  /* =================================================================== 4. material na obra (razão por obra) */
  const O = require('./obra164.js');
  try { db.exec("CREATE INDEX IF NOT EXISTS ix164_mov_proj ON docs(json_extract(data,'$.projId')) WHERE parent='mov'"); } catch (e) { console.error('[v164] índice:', e.message); }
  const stMovProj = db.prepare("SELECT id, data FROM docs WHERE parent='mov' AND json_extract(data,'$.projId')=?");
  const stDevProj = stPorCampo('devobra', 'projId'), stMobProj = stPorCampo('mob164', 'projId');
  function razaoSrv(projId, comCusto) {
    const movs = lista(stMovProj, projId), devs = lista(stDevProj, projId), mobs = lista(stMobProj, projId);
    let custo = m => +m.custoUnit || 0;
    if (comCusto) { const cs = new Map(); for (const pid of uniq(movs.map(m => m.prodId))) { const c = O.custos(lista(stMovProd, pid)); c.forEach((v, k) => cs.set(k, v)); } custo = m => cs.has(m.id) ? cs.get(m.id) : (+m.custoUnit || 0); }
    return O.razao(projId, movs, devs, mobs, custo, id => doc('mov/' + id));
  }
  const veRazao = (conta, projId) => admin(conta) || podeObra(conta, projId) || ['projetos', 'almoxarife', 'almoxfab', 'comprador', 'compras', 'diretoria', 'financeiro'].includes(papelConta(conta));
  const mexeObra = (conta, projId) => admin(conta) || podeObra(conta, projId) || ['almoxarife', 'almoxfab', 'projetos'].includes(papelConta(conta));
  /* devolução de sobras ao almoxarifado a partir do saldo da obra: pelo custo do envio, com motivo, estado e foto */
  function rotaDevol(conta, req, b) {
    const projId = String(b.projId || ''), pj = ID_OK.test(projId) ? doc('proj/' + projId) : null; if (!pj) return erro('Obra não encontrada.', 404);
    if (!mexeObra(conta, projId)) return erro('Seu perfil não devolve o material desta obra.');
    const alm = String(b.almoxId || ''); if (!alm || !doc('almox/' + alm)) return erro('Escolha o almoxarifado que recebe.', 400);
    const rz = new Map(razaoSrv(projId, true).map(o => [o.prodId, o])), its = [], MOTS = ['sobra', 'errado', 'troca', 'avariado'], ESTS = ['novo', 'usado', 'avariado'];
    for (const x of Array.isArray(b.itens) ? b.itens.slice(0, 300) : []) {
      const pid = String(x.prodId || ''), q = r4(+x.qtd || 0), o = rz.get(pid); if (!(q > 0)) continue;
      if (!o || q > o.saldo + 1e-6) return erro(((doc('prod/' + pid) || {}).nome || 'Item') + ': a obra só tem ' + fq(o ? Math.max(0, o.saldo) : 0) + ' (Material na obra).', 409);
      const est = ESTS.includes(x.estado) ? x.estado : 'novo', foto = anexo(x.foto); if (est === 'avariado' && !foto) return erro('Item avariado precisa da foto (' + ((doc('prod/' + pid) || {}).nome || '') + ').', 400);
      const pr = doc('prod/' + pid) || {}; its.push({ prodId: pid, desc: String(pr.nome || ''), cod: String(pr.sku || ''), un: String(pr.un || ''), qtd: q, cu164: o.cu, motivo: MOTS.includes(x.motivo) ? x.motivo : 'sobra', estado: est, foto });
    }
    if (!its.length) return erro('Informe a quantidade de pelo menos um item.', 400);
    const id = novoId('dv'), num = String(Math.max(0, ...col('devobra').map(d => parseInt(d.numero, 10) || 0)) + 1);
    const d = { id, numero: num, data: dataOk(b.data) ? b.data : hoje(), projId, almoxId: alm, resp: String(b.resp || nomeConta(conta.id)).slice(0, 120), transp: String(b.transp || '').slice(0, 120), obs: String(b.obs || '').slice(0, 300), status: 'enviado', v164: 1, porUid: conta.id, romRet164: String(b.romRet || ''), itens: its, crBy: conta.id, cr: Date.now() };
    if (b.soMontar) return { d };
    const x = gravarLote(conta, req, [{ p: 'devobra/' + id, data: d }], 'OBRA_DEVOL_164', { obra: projId, numero: num, itens: its.length });
    if (x.erro) return x;
    try { avisarChat(C153().quem(alm).filter(u => u !== conta.id), 'A obra ' + nomeProj(projId) + ' devolveu material (devolução nº ' + num + ') para o ' + nomeAlm(alm) + '. Confira às cegas na chegada.'); } catch (e) { }
    x.msg = 'Devolução nº ' + num + ' registrada. O almoxarife confere às cegas na chegada.'; return x;
  }
  /* movimento da obra: transferência entre obras (o custo sai de uma e entra na outra), consumo declarado pelo responsável,
     descarte/perda na obra (o custo fica na obra) e devolução ao fornecedor (pendência no pedido/fornecedor) */
  function rotaMobObra(conta, req, b) {
    const t = String(b.tipo || ''), projId = String(b.projId || ''); if (!['transf', 'consumo', 'descarte', 'devforn'].includes(t)) return erro('Tipo inválido.', 400);
    const pj = ID_OK.test(projId) ? doc('proj/' + projId) : null; if (!pj) return erro('Obra não encontrada.', 404);
    if (!mexeObra(conta, projId)) return erro('Seu perfil não movimenta o material desta obra.');
    if (t === 'consumo' && !(admin(conta) || podeObra(conta, projId))) return erro('O consumo é declarado pelo responsável pela obra ou pelo encarregado da obra.');
    const para = String(b.para || ''); if (t === 'transf') { if (!para || para === projId || !doc('proj/' + para)) return erro('Escolha a obra de destino (outra obra).', 400); }
    const rz = new Map(razaoSrv(projId, true).map(o => [o.prodId, o])), its = [];
    for (const x of Array.isArray(b.itens) ? b.itens.slice(0, 300) : []) {
      const pid = String(x.prodId || ''), q = r4(+x.qtd || 0), o = rz.get(pid); if (!(q > 0)) continue;
      if (!o || q > o.saldo + 1e-6) return erro((doc('prod/' + pid) || {}).nome + ': a obra só tem ' + fq(o ? Math.max(0, o.saldo) : 0) + ' (Material na obra).', 409);
      const it = { prodId: pid, qtd: q, cu: o.cu, desc: String((doc('prod/' + pid) || {}).nome || ''), motivo: String(x.motivo || '').slice(0, 200), foto: anexo(x.foto) };
      if (t === 'descarte' && (it.motivo.length < 3 || !it.foto)) return erro('Descarte/perda na obra: informe o motivo e tire a foto (' + it.desc + ').', 400);
      its.push(it);
    }
    if (!its.length) return erro('Informe a quantidade de pelo menos um item.', 400);
    let decl = null; if (t === 'consumo') { decl = { nome: String((b.declaracao && b.declaracao.nome) || nomeConta(conta.id)).slice(0, 120), texto: String((b.declaracao && b.declaracao.texto) || '').trim().slice(0, 500), porUid: conta.id, em: Date.now() }; if (decl.texto.length < 5) return erro('Declare o consumo (o que foi usado na obra).', 400); }
    const id = novoId('mo'), data = dataOk(b.data) ? b.data : hoje(), resp = String(b.resp || '').slice(0, 120);
    const mob = { id, tipo: t, projId, para: t === 'transf' ? para : '', data, em: Date.now(), por: conta.id, porNome: nomeConta(conta.id), itens: its, resp, decl, obs: String(b.obs || '').slice(0, 300), pedId: String(b.pedId || ''), parcId: String(b.parcId || '') };
    const docs = [{ p: 'mob164/' + id, data: mob }];
    if (t === 'transf') for (const it of its) {
      const prod = doc('prod/' + it.prodId) || {}, ls = ehLote(prod) ? [{ lote: L.SEM, qtd: it.qtd, val: '' }] : undefined, base = { data, prodId: it.prodId, qtd: it.qtd, custoUnit: it.cu, almoxId: '', prateleira: '', mob164: id, crBy: conta.id, cr: Date.now() };
      docs.push({ p: 'mov/' + novoId('me'), data: Object.assign({ tipo: 'entrada', projId, devObra: true, obs: 'Transferência para a obra ' + nomeProj(para) }, base, ls ? { lotes: ls } : {}) }); /* devObra: o custo sai desta obra */
      docs.push({ p: 'mov/' + novoId('ms'), data: Object.assign({ tipo: 'saida', projId: para, obs: 'Transferência da obra ' + nomeProj(projId) }, base, ls ? { lotes: ls } : {}) });
    }
    docs.forEach(d => { if (!d.data.id) d.data.id = d.p.split('/')[1]; });
    if (t === 'devforn') { const pid = novoId('pf'); docs.push({ p: 'pend164/' + pid, data: { id: pid, tipo: 'devforn', origem: 'mob164', mobId: id, pedId: mob.pedId, parcId: mob.parcId, projId, itens: its.map(i => ({ prodId: i.prodId, desc: i.desc, qtd: i.qtd, motivo: i.motivo })), st: 'aberta', lembrete: 'Emitir a nota fiscal de devolução ao fornecedor (Fiscal).', em: Date.now(), por: conta.id } }); mob.pendId = pid; }
    const x = gravarLote(conta, req, docs, 'OBRA_MOV_164', { tipo: t, obra: projId, para: mob.para, itens: its.map(i => i.prodId + ':' + i.qtd) });
    if (x.erro) return x;
    if (t === 'devforn') avisarChat(uniq(comPapel('comprador', 'compras', 'fiscal')).filter(u => u !== conta.id), 'Devolução ao fornecedor a partir da obra ' + nomeProj(projId) + ': ' + its.map(i => i.desc + ' ' + fq(i.qtd)).join(', ') + '. Falta emitir a nota fiscal de devolução.');
    x.msg = t === 'transf' ? 'Transferido para ' + nomeProj(para) + '.' : t === 'consumo' ? 'Consumo declarado.' : t === 'descarte' ? 'Descarte registrado (o custo fica na obra).' : 'Devolução ao fornecedor registrada (pendência criada).';
    return x;
  }

  /* =================================================================== 6. romaneio só de transporte; recebimento e retorno */
  function antesRom(conta, id, velho, novo) {
    const v = velho || {};
    if (!ROTA) for (const k of ['recObra164', 'retConf164']) { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; }
    if (!velho && novo.v164 === undefined) novo.v164 = 1; /* romaneio novo: regra nova */
    const ant = new Set((Array.isArray(v.itens) ? v.itens : []).filter(i => i && i.origem === 'ferr').map(i => String(i.ferrId || '')));
    const novos = (Array.isArray(novo.itens) ? novo.itens : []).filter(i => i && i.origem === 'ferr' && !ant.has(String(i.ferrId || '')));
    if (novos.some(i => !(i.fmovId || i.envioId))) return erro('Ferramenta só entra no romaneio por um Envio de ferramentas (responsável pela guarda, ficha de entrega e acessórios). Use "Criar envio de ferramenta" no romaneio.', 409);
    return null;
  }
  function depoisRomFrota(r) {
    if (!r || !r.v164 || r.transpModo !== 'proprio' || !r.veicId || !['transito', 'entregue', 'divergencia'].includes(r.status)) return;
    const vid = 'rom164_' + r.id, v = doc('vsai/' + vid); if (v) return;
    gravaSis('vsai/' + vid, { id: vid, veicId: String(r.veicId), funcId: String(r.motoristaId || ''), projId: String(r.projId || ''), destino: 'Romaneio nº ' + (r.numero || '') + (r.destTipo === 'obra' && r.projId ? ' · obra ' + nomeProj(r.projId) : r.destAlmoxId ? ' · ' + nomeAlm(r.destAlmoxId) : ''), saidaEm: String(r.despachadoEm || hoje()), hora: '', kmSaida: '', retornoEm: '', kmRetorno: '', obs: 'Criada pelo romaneio nº ' + (r.numero || '') + ' (v164)', romId164: r.id });
    const cur = doc('rom/' + r.id); if (cur && cur.vsai164 !== vid) gravaSis('rom/' + r.id, Object.assign({}, cur, { vsai164: vid }));
  }
  /* recebimento do romaneio na obra: material conferido (falta vira pendência e sai do saldo da obra), ferramentas com a
     assinatura do responsável pela guarda e a checagem dos acessórios */
  function rotaRecRom(conta, req, b) {
    const rid = String(b.romId || ''), r = ID_OK.test(rid) ? doc('rom/' + rid) : null; if (!r) return erro('Romaneio não encontrado.', 404);
    if (r.destTipo !== 'obra' || !r.projId) return erro('Este romaneio não vai para uma obra.', 409);
    if (r.status !== 'transito') return erro('O romaneio não está em trânsito.', 409);
    if (!podeObra(conta, r.projId)) return erro('Quem recebe na obra é o encarregado alocado na obra ou o responsável pela obra.');
    const as = assinatura(b.assin); if (!as) return erro('Assinatura de quem recebeu: informe o nome (e assine).', 400);
    const data = dataOk(b.data) ? b.data : hoje(), q = new Map((Array.isArray(b.itens) ? b.itens : []).map(x => [+x.k, x])), fr = new Map((Array.isArray(b.ferr) ? b.ferr : []).map(x => [+x.k, x]));
    const docs = [], falta = [], ruinsF = []; let div = 0;
    const its = (r.itens || []).map((i, k) => {
      if (i.origem === 'env' || i.origem === 'ferr') {
        const x = fr.get(k) || {}, m = i.fmovId ? doc('fmov/' + i.fmovId) : null;
        if (m && !m.retornoEm) {
          const ag = assinatura(x.assin); if (!ag && !x.naoChegou) return { erro: 'Ferramenta ' + (i.desc || '') + ': o responsável pela guarda assina a ficha de entrega.' };
          const f = doc('ferr/' + String(m.ferrId)) || {}, acs = (Array.isArray(f.acess164) ? f.acess164 : []).map(a => { const y = (Array.isArray(x.acess) ? x.acess : []).find(z => z && z.id === a.id) || {}; return { id: a.id, desc: a.desc, qtd: a.qtd, st: ['ok', 'falta', 'dano'].includes(y.st) ? y.st : 'ok' }; });
          const ruins = acs.filter(a => a.st !== 'ok'); const nm = Object.assign({}, m, { st164: x.naoChegou ? 'naochegou' : 'entregue', recObra164: { em: Date.now(), por: conta.id, data, assin: ag, acess: acs, estado: String(x.estado || '') } });
          if (ruins.length) { nm.pend164 = (m.pend164 || []).concat(ruins.map(a => ({ id: novoId('pa'), tipo: 'acessorio', acId: a.id, desc: a.desc, st: a.st, em: Date.now(), por: conta.id, ok: false, fase: 'entrega' }))); ruinsF.push((f.nome || '') + ': ' + ruins.map(a => a.desc + ' ' + (a.st === 'falta' ? 'faltando' : 'danificado')).join(', ')); div++; }
          if (x.naoChegou) { div++; ruinsF.push((f.nome || i.desc || '') + ': não chegou'); nm.pend164 = (nm.pend164 || m.pend164 || []).concat([{ id: novoId('pa'), tipo: 'naochegou', desc: f.nome || i.desc || '', st: 'falta', em: Date.now(), por: conta.id, ok: false, fase: 'entrega' }]); }
          docs.push({ p: 'fmov/' + m.id, data: nm, sis: true });
        }
        return Object.assign({}, i, { qtdRec: x.naoChegou ? 0 : 1 });
      }
      const x = q.get(k) || {}, qr = x.qtd === undefined || x.qtd === '' ? +i.qtd || 0 : r4(+x.qtd || 0);
      if (qr < 0) return { erro: 'Quantidade inválida.' };
      if (Math.abs(qr - (+i.qtd || 0)) > 1e-9 || x.obs) div++;
      if (i.origem === 'sep' && i.prodId && qr < (+i.qtd || 0) - 1e-9) falta.push({ prodId: i.prodId, desc: i.desc || '', un: i.un || '', qtd: r4((+i.qtd || 0) - qr), sepId: i.sepId || '' });
      return Object.assign({}, i, { qtdRec: qr, obsRec: String(x.obs || '').slice(0, 200) });
    });
    const e = its.find(x => x && x.erro); if (e) return erro(e.erro, 400);
    const nr = Object.assign({}, r, { itens: its, status: div ? 'divergencia' : 'entregue', entregueEm: data, recebidoPor: as.nome, recObra164: { em: Date.now(), por: conta.id, assin: as } });
    docs.push({ p: 'rom/' + rid, data: nr, sis: true });
    for (const s of uniq((r.sepIds || []).map(String))) { const sp = doc('sep/' + s); if (sp) docs.push({ p: 'sep/' + s, data: Object.assign({}, sp, { transito164: false, recObra164: Date.now() }), sis: true }); }
    if (falta.length) {
      const mid = novoId('mo'), pid = novoId('pf');
      docs.push({ p: 'mob164/' + mid, data: { id: mid, tipo: 'faltarom', projId: String(r.projId), romId: rid, data, em: Date.now(), por: conta.id, itens: falta.map(f => ({ prodId: f.prodId, qtd: f.qtd, desc: f.desc })) } });
      docs.push({ p: 'pend164/' + pid, data: { id: pid, tipo: 'romaneio', origem: 'rom', romId: rid, romNum: String(r.numero || ''), projId: String(r.projId), itens: falta, st: 'aberta', em: Date.now(), por: conta.id } });
    }
    const x = gravarLote(conta, req, docs, 'ROM_RECEBIDO_OBRA_164', { rom: r.numero || '', div, falta: falta.length });
    if (x.erro) return x;
    if (falta.length || ruinsF.length) { let al = []; try { al = C153().quem(r.almoxId); } catch (e2) { } avisarChat(al.filter(u => u !== conta.id), 'Romaneio nº ' + (r.numero || '') + ' recebido na obra ' + nomeProj(r.projId) + ' com pendência: ' + falta.map(f => f.desc + ' faltou ' + fq(f.qtd) + ' ' + f.un).concat(ruinsF).join('; ') + '.'); }
    x.msg = div ? 'Romaneio recebido com ' + div + ' pendência(s); o almoxarife foi avisado.' : 'Romaneio recebido.'; return x;
  }
  /* romaneio de retorno (obra → almoxarifado): devolução de sobras (pelo saldo da obra) e retorno de ferramentas (estado e
     acessórios); o almoxarife confirma na chegada (entrada do material pela conferência às cegas e fecha as ferramentas) */
  function rotaRomRetorno(conta, req, b) {
    const projId = String(b.projId || ''), pj = ID_OK.test(projId) ? doc('proj/' + projId) : null; if (!pj) return erro('Obra não encontrada.', 404);
    if (!mexeObra(conta, projId)) return erro('Seu perfil não monta o retorno desta obra.');
    const alm = String(b.almoxId || ''); if (!alm || !doc('almox/' + alm)) return erro('Escolha o almoxarifado de destino.', 400);
    const rid = novoId('rr'), docs = [], itens = [];
    if (Array.isArray(b.dev) && b.dev.length) {
      const m = rotaDevol(conta, req, { projId, almoxId: alm, data: b.data, resp: b.resp, transp: b.transp, obs: b.obs, itens: b.dev, romRet: rid, soMontar: true });
      if (m.erro) return m; docs.push({ p: 'devobra/' + m.d.id, data: m.d }); itens.push(...m.d.itens.map(i => ({ origem: 'dev', devId: m.d.id, prodId: i.prodId, desc: i.desc, un: i.un, qtd: i.qtd, cod: i.cod || '' })));
    }
    const ESTS = ['Em funcionamento e limpo', 'Em funcionamento e sujo', 'Com defeito', 'Danificado', 'Perdido'];
    for (const x of Array.isArray(b.ferr) ? b.ferr.slice(0, 200) : []) {
      const m = ID_OK.test(String(x.fmovId || '')) ? doc('fmov/' + x.fmovId) : null; if (!m || m.retornoEm || String(m.projId || '') !== projId) return erro('Ferramenta que não está nesta obra.', 400);
      if (m.ret164 && m.ret164.romId) return erro('A ferramenta já está em outro romaneio de retorno.', 409);
      const f = doc('ferr/' + String(m.ferrId)) || {}, est = ESTS.includes(x.estado) ? x.estado : 'Em funcionamento e limpo';
      const acs = (Array.isArray(f.acess164) ? f.acess164 : []).map(a => { const y = (Array.isArray(x.acess) ? x.acess : []).find(z => z && z.id === a.id) || {}; return { id: a.id, desc: a.desc, qtd: a.qtd, st: ['ok', 'falta', 'dano'].includes(y.st) ? y.st : 'ok' }; });
      docs.push({ p: 'fmov/' + m.id, data: Object.assign({}, m, { ret164: { romId: rid, estado: est, acess: acs, em: Date.now(), por: conta.id } }), sis: true });
      itens.push({ origem: 'fret', fmovId: m.id, ferrId: m.ferrId, desc: String(f.nome || ''), cod: String(f.codigo || ''), un: 'UN', qtd: 1, estado: est, acess: acs });
    }
    if (!itens.length) return erro('Inclua material ou ferramentas no retorno.', 400);
    const num = String(Math.max(0, ...col('rom').map(r => parseInt(r.numero, 10) || 0)) + 1);
    const rom = { id: rid, numero: num, data: dataOk(b.data) ? b.data : hoje(), tipo164: 'retorno', v164: 1, almoxId: '', projId, destTipo: 'almox', destAlmoxId: alm, destNome: nomeAlm(alm), transpModo: b.veicId ? 'proprio' : 'retira', veicId: String(b.veicId || ''), motoristaId: String(b.motoristaId || ''), recebedor: '', sepIds: [], itens, status: 'transito', despachadoEm: hoje(), despachadoPor: conta.id, obs: 'Romaneio de retorno da obra ' + nomeProj(projId) + (b.obs ? ' · ' + String(b.obs).slice(0, 200) : ''), crBy: conta.id, cr: Date.now() };
    docs.push({ p: 'rom/' + rid, data: rom, sis: true });
    const x = gravarLote(conta, req, docs, 'ROM_RETORNO_164', { obra: projId, numero: num, itens: itens.length });
    if (x.erro) return x;
    try { avisarChat(C153().quem(alm).filter(u => u !== conta.id), 'Romaneio de retorno nº ' + num + ' da obra ' + nomeProj(projId) + ' a caminho do ' + nomeAlm(alm) + ' (' + itens.length + ' item(ns)). Confirme na chegada.'); } catch (e) { }
    x.msg = 'Romaneio de retorno nº ' + num + ' registrado.'; return x;
  }


  /* =================================================================== 7.6 encerramento da obra */
  const FECHA = ['concluido', 'concluida', 'encerrada', 'encerrado'];
  const stFmovProj = stPorCampo('fmov', 'projId');
  function saldoObra(projId) {
    const mat = razaoSrv(projId, false).filter(o => o.saldo > 1e-6).map(o => ({ prodId: o.prodId, nome: String((doc('prod/' + o.prodId) || {}).nome || ''), saldo: o.saldo }));
    const fer = lista(stFmovProj, projId).filter(m => !m.retornoEm).map(m => ({ fmovId: m.id, ferrId: m.ferrId, nome: String((doc('ferr/' + String(m.ferrId)) || {}).nome || '') }));
    return { mat, fer };
  }
  function antesProj(conta, req, id, velho, novo) {
    const v = velho || {};
    if (!admin(conta)) { if (v.encerra164 !== undefined) novo.encerra164 = v.encerra164; else delete novo.encerra164; }
    if (!velho || !FECHA.includes(String(novo.status || '')) || FECHA.includes(String(v.status || ''))) return null;
    const sd = saldoObra(id); if (!sd.mat.length && !sd.fer.length) return null;
    const lib = novo.encerra164 && typeof novo.encerra164 === 'object' ? novo.encerra164 : null;
    if (lib && admin(conta) && String(lib.just || '').trim().length >= 10 && !(v.encerra164 && v.encerra164.em)) {
      novo.encerra164 = { just: String(lib.just).trim().slice(0, 500), por: conta.id, em: Date.now(), mat: sd.mat.length, fer: sd.fer.length };
      auditar(conta, req, 'OBRA_ENCERRADA_COM_SALDO_164', 'proj/' + id, null, { justificativa: novo.encerra164.just, material: sd.mat.map(x => x.nome + ':' + x.saldo), ferramentas: sd.fer.map(x => x.nome) });
      return null;
    }
    auditar(conta, req, 'OBRA_ENCERRAMENTO_RECUSADO_164', 'proj/' + id, null, { material: sd.mat.length, ferramentas: sd.fer.length });
    return erro('A obra ainda tem ' + (sd.mat.length ? sd.mat.length + ' item(ns) de material' : '') + (sd.mat.length && sd.fer.length ? ' e ' : '') + (sd.fer.length ? sd.fer.length + ' ferramenta(s)' : '') + ' no saldo (Obras › Material na obra): ' + sd.mat.slice(0, 5).map(x => x.nome + ' ' + fq(x.saldo)).concat(sd.fer.slice(0, 5).map(x => x.nome)).join(', ') + '. Devolva, transfira ou declare o consumo antes de encerrar' + (admin(conta) ? ', ou libere com a justificativa.' : '. Só o Administrador libera com justificativa.'), 409);
  }

  /* =================================================================== 8. transferência de guarda das ferramentas na obra */
  const EST_G = ['Em funcionamento e limpo', 'Em funcionamento e sujo', 'Avariado', 'Não encontrado'];
  function rotaGuarda(conta, req, b) {
    const projId = String(b.projId || ''), pj = ID_OK.test(projId) ? doc('proj/' + projId) : null; if (!pj) return erro('Obra não encontrada.', 404);
    const pap = papelConta(conta), almx = ['almoxarife', 'almoxfab'].includes(pap), resp = !!(pj.respObra && pj.respObra === conta.id);
    if (!(admin(conta) || almx || podeObra(conta, projId))) return erro('A transferência de guarda é feita pelo almoxarife, pelo responsável pela obra, pelo encarregado da obra ou pelo Administrador.');
    const de = String(b.de || ''), para = String(b.para || ''), fDe = ID_OK.test(de) ? doc('func/' + de) : null, fPara = ID_OK.test(para) ? doc('func/' + para) : null;
    if (!fDe) return erro('Escolha quem entrega a guarda.', 400);
    if (!fPara || fPara.status === 'desligado') return erro('Escolha quem recebe a guarda (colaborador ativo).', 400);
    if (de === para) return erro('Quem recebe é a mesma pessoa que entrega.', 400);
    const paraProj = String(b.paraProj || '') || projId; if (paraProj !== projId && !doc('proj/' + paraProj)) return erro('Obra de destino não encontrada.', 400);
    const ausente = !!b.ausente, data = dataOk(b.data) ? b.data : hoje();
    const asPara = assinatura(b.assinPara); if (!asPara) return erro('Quem recebe a guarda assina (nome e assinatura).', 400);
    const asDe = assinatura(b.assinDe);
    let test = null, fotos = [];
    if (ausente) {
      if (!(admin(conta) || almx || resp)) return erro('Sem a presença do responsável anterior, a transferência é feita pelo responsável pela obra ou pelo almoxarife.');
      test = String(b.testemunha || '').trim().slice(0, 120); if (test.length < 3) return erro('Sem a presença do responsável anterior: informe a testemunha.', 400);
      fotos = (Array.isArray(b.fotos) ? b.fotos : []).map(anexo).filter(Boolean).slice(0, 10); if (!fotos.length) return erro('Sem a presença do responsável anterior: tire as fotos das ferramentas.', 400);
    } else if (!asDe) return erro('Quem entrega a guarda assina (nome e assinatura). Se a pessoa não está, marque "sem a presença do responsável anterior".', 400);
    const gid = novoId('gu'), docs = [], its = [], pend = [];
    for (const x of Array.isArray(b.itens) ? b.itens.slice(0, 300) : []) {
      const m = ID_OK.test(String(x.fmovId || '')) ? doc('fmov/' + x.fmovId) : null;
      if (!m || m.retornoEm) return erro('Ferramenta que não está em obra (movimentação encerrada).', 409);
      if (String(m.projId || '') !== projId) return erro('A ferramenta ' + ((doc('ferr/' + String(m.ferrId)) || {}).nome || '') + ' não está nesta obra.', 409);
      if (m.ret164 && m.ret164.romId) return erro('A ferramenta ' + ((doc('ferr/' + String(m.ferrId)) || {}).nome || '') + ' já está num romaneio de retorno.', 409);
      if (String(m.funcId || '') !== de) return erro('A ferramenta ' + ((doc('ferr/' + String(m.ferrId)) || {}).nome || '') + ' não está sob a guarda de ' + (fDe.nome || '') + ' (está com ' + ((doc('func/' + String(m.funcId)) || {}).nome || 'outra pessoa') + ').', 409);
      const f = doc('ferr/' + String(m.ferrId)) || {}, est = EST_G.includes(x.estado) ? x.estado : EST_G[0];
      const acs = (Array.isArray(f.acess164) ? f.acess164 : []).map(a => { const y = (Array.isArray(x.acess) ? x.acess : []).find(z => z && z.id === a.id) || {}; return { id: a.id, desc: a.desc, qtd: a.qtd, st: ['ok', 'falta', 'dano'].includes(y.st) ? y.st : 'ok' }; });
      const fica = est === 'Avariado' || est === 'Não encontrado';
      const it = { fmovId: m.id, ferrId: String(m.ferrId), desc: String(f.nome || ''), cod: String(f.codigo || ''), estado: est, acess: acs, st: fica ? 'pendente' : 'transferido' };
      if (fica) {
        pend.push(it);
        docs.push({ p: 'fmov/' + m.id, data: Object.assign({}, m, { pend164: (m.pend164 || []).concat([{ id: novoId('pa'), tipo: 'guarda', st: est === 'Avariado' ? 'dano' : 'naoencontrado', desc: f.nome || '', guaId: gid, em: Date.now(), por: conta.id, ok: false }]) }), sis: true });
      } else {
        const nid = novoId('fg');
        docs.push({ p: 'fmov/' + m.id, data: Object.assign({}, m, { retornoEm: data, estadoRetorno: est, guarda164: { id: gid, para, paraProj }, obs: [m.obs, 'Guarda transferida para ' + (fPara.nome || '') + (paraProj !== projId ? ' na obra ' + nomeProj(paraProj) : '')].filter(Boolean).join(' · ') }), sis: true });
        docs.push({ p: 'fmov/' + nid, data: { id: nid, ferrId: String(m.ferrId), projId: paraProj, funcId: para, saidaEm: data, previsto: m.previsto || '', estadoSaida: est, retornoEm: '', estadoRetorno: '', obs: 'Guarda recebida de ' + (fDe.nome || '') + (paraProj !== projId ? ' (veio da obra ' + nomeProj(projId) + ')' : ''), gua164: gid, acessSai164: acs, st164: 'entregue', crBy: conta.id, cr: Date.now() }, sis: true });
        it.novoFmovId = nid;
      }
      its.push(it);
    }
    if (!its.length) return erro('Escolha as ferramentas.', 400);
    const g = { id: gid, projId, paraProj, de, deNome: String(fDe.nome || ''), para, paraNome: String(fPara.nome || ''), data, em: Date.now(), por: conta.id, porNome: nomeConta(conta.id), ausente, testemunha: test, fotos, assinDe: ausente ? null : asDe, assinPara: asPara, itens: its };
    docs.unshift({ p: 'gua164/' + gid, data: g });
    const x = gravarLote(conta, req, docs, 'GUARDA_TRANSFERIDA_164', { obra: projId, paraObra: paraProj, de: fDe.nome || de, para: fPara.nome || para, ausente, transferidas: its.length - pend.length, pendentes: pend.length });
    if (x.erro) return x;
    if (pend.length) { const al = uniq([].concat(...uniq(pend.map(i => (doc('ferr/' + i.ferrId) || {}).almoxId)).map(almoxarifesDe))).filter(u => u !== conta.id); avisarChat(al.length ? al : comPapel('almoxarife'), 'Transferência de guarda na obra ' + nomeProj(projId) + ' (' + (fDe.nome || '') + ' → ' + (fPara.nome || '') + '): ' + pend.map(i => i.desc + ' ' + (i.estado === 'Avariado' ? 'avariada' : 'não encontrada')).join(', ') + '. Continua com ' + (fDe.nome || '') + ' como pendência.'); }
    x.gua = g; x.msg = (its.length - pend.length) + ' ferramenta(s) transferida(s)' + (pend.length ? '; ' + pend.length + ' ficam com ' + (fDe.nome || '') + ' como pendência' : '') + '.'; return x;
  }
  /* RH: desligamento, afastamento ou mudança de obra de quem tem ferramentas sob guarda → aviso ao RH e ao almoxarife */
  const stFmovFunc = stPorCampo('fmov', 'funcId');
  function guardaDe(funcId) { return lista(stFmovFunc, funcId).filter(m => !m.retornoEm); }
  function avisoRhGuarda(funcId, motivo) {
    const ls = guardaDe(funcId); if (!ls.length) return 0; const f = doc('func/' + funcId) || {};
    const txt = (f.nome || 'Colaborador') + ' (' + motivo + ') tem ' + ls.length + ' ferramenta(s) sob guarda: ' + ls.slice(0, 10).map(m => ((doc('ferr/' + String(m.ferrId)) || {}).nome || '') + ' (obra ' + nomeProj(m.projId) + ')').join(', ') + '. Transfira a guarda ou registre a devolução.';
    return avisarChat(uniq(comPapel('rh', 'rhcompras').concat(comPapel('almoxarife'))), txt);
  }
  function depoisRh(c0, antes_, depois_, id) {
    if (!depois_) return;
    if (c0 === 'func') { const a = antes_ || {}; if (depois_.status === 'desligado' && a.status !== 'desligado') avisoRhGuarda(id, 'desligado'); else if (depois_.status === 'afastado' && a.status !== 'afastado') avisoRhGuarda(id, 'afastado'); else if (antes_ && String(a.projId || '') !== String(depois_.projId || '')) avisoRhGuarda(id, 'mudou de obra: ' + (nomeProj(depois_.projId) || 'sem obra')); }
    if ((c0 === 'desl' || c0 === 'afast') && !antes_ && depois_.funcId) avisoRhGuarda(String(depois_.funcId), c0 === 'desl' ? 'desligamento registrado' : 'afastamento registrado');
  }

  /* =================================================================== antes / depois / rotas */
  function antes(conta, c0, id, velho, novo, req) {
    if (!novo) return null;
    if (c0 === 'sc') { for (const k of SC_SIS) { if (velho && velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; } return null; }
    /* defeito do romaneio (v164): o Almoxarife lê o veículo com o mínimo (leMin) e não grava a frota; a saída de frota do
       romaneio/pedido (vsai) é criada pelo próprio servidor (gravaSis), não pela gravação comum */
    if ((c0 === 'veic' || c0 === 'vsai') && !admin(conta) && !X.gravaCol(conta, c0)) return erro('Seu perfil não altera a frota (veículos e saídas). A saída do veículo do romaneio é criada pelo próprio romaneio.');
    if (c0 === 'mov') return antesMov(conta, id, velho, novo);
    if (c0 === 'ped') return antesPed(conta, id, velho, novo);
    if (c0 === 'rom') return antesRom(conta, id, velho, novo);
    if (c0 === 'proj') return antesProj(conta, req, id, velho, novo);
    if (c0 === 'gua164') return ROTA ? null : erro('A transferência de guarda é registrada em Obras › Material na obra › Ferramentas na obra.', 409);
    if (c0 === 'mob164') return ROTA ? null : erro('O movimento da obra é registrado em Obras › Material na obra.', 409);
    if (c0 === 'pend164' && !ROTA && !velho && novo.tipo === 'devforn' && (admin(conta) || ['almoxarife', 'almoxfab'].includes(papelConta(conta)))) return null; /* v164: quarentena → devolução ao fornecedor */
    if (c0 === 'rec164' || c0 === 'pend164') return ROTA ? null : erro('Este registro é gravado pelas telas de recebimento na obra e de pendências.', 409);
    return null;
  }
  function antesExcluir(conta, c0, id, velho) { if ((c0 === 'rec164' || c0 === 'pend164' || c0 === 'mob164' || c0 === 'gua164') && !ehDono(conta)) return erro('Recebimento na obra e pendência não se excluem (ficam no histórico).', 409); return null; }
  function depois(conta, req, metodo, p, antes_, depois_) {
    const s = p.split('/'); if (s.length !== 2) return;
    if ((s[0] === 'func' || s[0] === 'desl' || s[0] === 'afast') && metodo !== 'DELETE') { try { depoisRh(s[0], antes_, depois_, s[1]); } catch (e) { console.error('[v164] rh:', e.message); } }
    if (s[0] === 'rom' && metodo !== 'DELETE' && depois_) { try { depoisRomFrota(Object.assign({}, depois_, { id: s[1] })); } catch (e) { console.error('[v164] frota:', e.message); } }
    if (s[0] === 'ped' && metodo !== 'DELETE') { depoisPed(antes_, depois_ ? Object.assign({}, depois_, { id: s[1] }) : depois_); try { depoisPedFrota(depois_ ? Object.assign({}, depois_, { id: s[1] }) : null); } catch (e) { console.error('[v164] frota:', e.message); } }
  }
  async function rota(p, m, req, res, conta) {
    if (!p.startsWith('/api/sc164/') && !p.startsWith('/api/rom164/') && !p.startsWith('/api/lote164/') && !p.startsWith('/api/rec164/') && !p.startsWith('/api/obra164/') && !p.startsWith('/api/gua164/')) return false;
    const R = r => json(res, r.erro ? (r.st || 403) : 200, r.erro ? { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : 'not_granted', erro: r.erro } : r);
    if (m === 'POST' && p === '/api/sc164/retirar') { R(rotaRetirar(conta, req, await lerJson(req))); return true; }
    if (m === 'POST' && p === '/api/lote164/identificar') { R(rotaIdentificar(conta, req, await lerJson(req))); return true; }
    if (m === 'GET' && p === '/api/lote164/saldos') { const u = new URL(req.url, 'http://x'), pid = String(u.searchParams.get('prod') || ''); if (!ID_OK.test(pid)) { R(erro('Produto inválido.', 400)); return true; } R({ ok: true, lotes: [...saldosLote(pid).values()].map(o => ({ alm: o.alm, lote: o.lote, qtd: o.qtd, val: o.val, fab: o.fab })) }); return true; }
    if (m === 'GET' && p === '/api/obra164/razao') { const u = new URL(req.url, 'http://x'), pid = String(u.searchParams.get('projId') || ''); if (!ID_OK.test(pid) || !doc('proj/' + pid)) { R(erro('Obra inválida.', 400)); return true; } if (!veRazao(conta, pid)) { R(erro('Seu perfil não vê o material desta obra.')); return true; } R({ ok: true, itens: razaoSrv(pid, true).map(o => Object.assign({}, o, { nome: String((doc('prod/' + o.prodId) || {}).nome || ''), un: String((doc('prod/' + o.prodId) || {}).un || '') })) }); return true; }
    if (m === 'POST' && p === '/api/rec164/romaneio') { R(rotaRecRom(conta, req, await lerJson(req))); return true; }
    if (m === 'POST' && p === '/api/rom164/retorno') { R(rotaRomRetorno(conta, req, await lerJson(req))); return true; }
    if (m === 'POST' && p === '/api/gua164/transferir') { R(rotaGuarda(conta, req, await lerJson(req))); return true; }
    if (m === 'GET' && p === '/api/obra164/saldo') { const u = new URL(req.url, 'http://x'), pid = String(u.searchParams.get('projId') || ''); if (!ID_OK.test(pid) || !doc('proj/' + pid)) { R(erro('Obra inválida.', 400)); return true; } if (!veRazao(conta, pid)) { R(erro('Seu perfil não vê o material desta obra.')); return true; } R(Object.assign({ ok: true }, saldoObra(pid))); return true; }
    if (m === 'POST' && p === '/api/obra164/devol') { R(rotaDevol(conta, req, await lerJson(req))); return true; }
    if (m === 'POST' && p === '/api/obra164/mov') { R(rotaMobObra(conta, req, await lerJson(req))); return true; }
    if (m === 'GET' && p === '/api/rec164/pendentes') { R(rotaPendentes(conta)); return true; }
    if (m === 'POST' && p === '/api/rec164/obra') { R(rotaRecObra(conta, req, await lerJson(req))); return true; }
    if (m === 'POST' && p === '/api/rec164/retirada') { R(rotaRetirada(conta, req, await lerJson(req))); return true; }
    if (m === 'POST' && p === '/api/rec164/pendok') { R(rotaPendOk(conta, req, await lerJson(req))); return true; }
    if (m === 'POST' && p === '/api/sc164/lembretes') { if (!admin(conta)) { R(erro('Só o Administrador.')); return true; } const b = await lerJson(req); R({ ok: true, n: lembrar(b && b.dias != null ? +b.dias : 3) }); return true; }
    json(res, 404, { code: 'not_found', erro: 'Rota não encontrada.' }); return true;
  }
  const COLS = new Set(['veic', 'vsai', 'sc', 'mov', 'ped', 'rom', 'proj', 'fmov', 'ferr', 'rec164', 'mob164', 'gua164', 'pend164']); /* depois: também func, desl e afast (aviso de ferramentas sob guarda) */
  return { COLS, saldoObra, antesRom, razaoSrv, podeObra, saldosLote, rotaPendentes, gravarLote, antes, antesExcluir, depois, rota, lembrar, progresso, avisarChat };
};

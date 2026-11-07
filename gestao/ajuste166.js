'use strict';
/* v166 (relatorios/feito_v166.md): "Terceiros e locações" no servidor. Ligado em regras.js por v166/ed_v166.py.
   Regras e contas em terc166.js (o MESMO arquivo vai embutido no navegador).
   Coleções novas (grupo "ter"; gravação só pelas rotas): ter166 (empresa terceira, id = fornecedor do cadastro), tdc166
   (documentos: empresa, obrigações do mês, trabalhador, trabalhador indicado pelo terceiro), loc166 (contrato de locação,
   com ou sem operador), leq166 (equipamento locado: retirada, guarda, devolução, notas conciliadas), tnl166 (nota do
   locador marcada como "não é da locação"). Tabela ter_link166 (link público do terceiro: hash do token, token cifrado).
   Quem faz o quê (o perfil precisa gravar "Terceiros e locações" e mais o módulo da área; o Administrador faz tudo):
     Compras/suprimentos (grava Compras): cadastro, contrato de locação, equipamentos, retirada, devolução, conciliação.
     RH e SST (grava RH, SST ou Documentos dos empreiteiros): conferem e aprovam/recusam os documentos.
     Engenharia/obra (grava Obras): guarda do equipamento na obra e transferência entre obras (horas pelo diário).
     Administrador: tudo e a liberação do pagamento bloqueado (justificativa obrigatória, auditoria, visível na conta).
   Bloqueio do pagamento (obrigatório, no servidor): baixa (pago), aprovação (/api/aprovar) e remessa de conta a pagar de
   terceiro sob contrato são recusadas enquanto terc166.bloqueio() tiver faltas e não houver a liberação do Administrador.
   Diário de obra: trabalhador terceiro não liberado não entra (liberação do SST/Administrador com justificativa: aptlib) e
   a linha de equipamento locado só aceita equipamento retirado para a obra. Link público /terceiro/<token> no padrão do
   aceite.js: validade TERCEIROS_LINK_DIAS (padrão 30), revogável, limite por IP e por link, sem acesso ao sistema,
   PDF/JPG/PNG até TERCEIROS_ARQ_MB (padrão 10 MB); cada envio fica "aguardando conferência" e na auditoria (link, IP, hora). */
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const C = require('./terc166.js');
module.exports = function (X) {
  const { db, q, col, erro, ehDono, perfilEm, gravaGrupo, cfgEmp, lerJson, json, avisarDoc, ipDe, SEG, APP_URL, DATA } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const doc = p => { const d = X.doc(p); if (d && typeof d === 'object' && !d.id) d.id = String(p).split('/').pop(); return d; };
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const SIS = new Set(['ter166', 'tdc166', 'loc166', 'leq166', 'tnl166']);
  const COLS = new Set([...SIS, 'lanc', 'rdo']);
  const agoraBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 16), hojeBr = () => agoraBr().slice(0, 10);
  const novoId = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const s = C.s, txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 300);
  const nomeConta = id => { try { return X.nomeConta(id); } catch (e) { return id || ''; } };
  const parcNome = id => { const p = id ? doc('parc/' + id) : null; return p ? String(p.nome || p.fantasia || '') : ''; };
  const projNome = id => { const p = id ? doc('proj/' + id) : null; return p ? [p.codigo, p.nome].filter(Boolean).join(' · ') : ''; };
  const sha = t => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
  const LINK_DIAS = () => Math.min(365, Math.max(1, Math.round(+process.env.TERCEIROS_LINK_DIAS || 30)));
  const ARQ_MAX = () => Math.min(25, Math.max(1, +process.env.TERCEIROS_ARQ_MB || 10)) * 1024 * 1024;

  /* ---------- papéis: pela coleção que o perfil grava dentro do módulo "ter" (Sistema › Perfis de acesso ajusta) ----------
     loc166 = contrato de locação (Compras/suprimentos: contrato, equipamento, retirada, devolução, conciliação da nota);
     leq166 = equipamento locado (engenharia/obra: guarda e transferência); ter166 = cadastro do terceiro e o link;
     tdc166 = documentos (registrar); aprovar/recusar também pede RH, SST ou Documentos dos empreiteiros. */
  const admin = conta => ehDono(conta) || perfilEm(conta, ['admin']);
  const temTer = conta => admin(conta) || gravaGrupo(conta, 'ter');
  const wc = (conta, c) => admin(conta) || (gravaGrupo(conta, 'ter') && X.gravaCol(conta, c));
  const papel = conta => ({ admin: admin(conta), compras: wc(conta, 'loc166'), obra: wc(conta, 'leq166'), cad: wc(conta, 'ter166'), reg: wc(conta, 'tdc166'), docs: admin(conta) || (wc(conta, 'tdc166') && gravaGrupo(conta, 'rh', 'sst', 'empdoc')), le: admin(conta) || X.leModulo(conta, 'ter166') });

  /* ---------- contexto do núcleo (lido do banco; cada coleção só quando a conta precisa dela) ---------- */
  function ctx() {
    const X6 = { cfg: cfgEmp(), hoje: hojeBr() }, M = { ter: 'ter166', tdc: 'tdc166', tdoc: 'tdoc', tterc: 'tterc', ctremp: 'ctremp', medemp: 'medemp', loc: 'loc166', leq: 'leq166', rdo: 'rdo', notas: 'notas', tnl: 'tnl166', integ: 'integ', proj: 'proj', lanc: 'lanc' };
    for (const [k, c] of Object.entries(M)) { let v = null; Object.defineProperty(X6, k, { enumerable: true, get: () => v || (v = col(c)) }); }
    return X6;
  }
  const cfg6 = () => C.cfgPad(cfgEmp().ter166);

  /* ---------- aviso pela conversa "Central de Gestão" (como v150/v164/v165) ---------- */
  function avisarChat(uids, texto) {
    const ag = Date.now(); let n = 0;
    for (const u of C.uniq(uids).filter(x => ID_OK.test(x) && x !== 'sistema')) {
      try {
        const cid = 'av_' + u, cp = 'cm/sistema/c/' + cid;
        if (!q.docGet.get(cp)) { const cv = { id: cid, tipo: 'dm', membros: [u], ts: ag, sistema: true }; q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(cv), ag); avisarDoc('set', cp, cv, ag); }
        const mid = 'm' + ag.toString(36) + crypto.randomBytes(4).toString('hex'), mp = 'cm/sistema/m/' + mid;
        const msg = { id: mid, k: 'msg', conv: 'sistema/' + cid, txt: '📋 ' + texto, ts: ag, men: [], sistema: true, v166: 1 };
        q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(msg), ag); avisarDoc('set', mp, msg, ag); n++;
      } catch (e) { console.error('[v166] chat:', e.message); }
    }
    return n;
  }
  const usrsDe = pfs => col('usr').filter(u => u && u.uid && pfs.includes(u.perfil)).map(u => u.uid).slice(0, 30);
  const U_DOCS = ['rh', 'rhcompras', 'sstgestor', 'ssttec', 'sst'], U_COMP = ['comprador', 'compras', 'rhcompras', 'almoxarife'];

  /* ---------- gravação (transação) ---------- */
  let ROTA = false;
  function gravar(conta, req, docs, metodo, resumo) {
    const ts = Date.now(), prep = [];
    for (const x of docs) { if (!ID_OK.test(String(x.d.id || ''))) return erro('Identificador inválido.', 400); prep.push({ p: x.c + '/' + x.d.id, velho: doc(x.c + '/' + x.d.id), data: x.d }); }
    db.exec('BEGIN');
    try { for (const o of prep) { const s2 = o.p.split('/'); q.docPut.run(o.p, s2[0], s2[1], JSON.stringify(o.data), ts); } db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } return erro('Falha ao gravar. Nada foi gravado; tente de novo.', 500); }
    for (const o of prep) avisarDoc('set', o.p, o.data, ts);
    auditar(conta, req, metodo, prep[0] ? prep[0].p : '', null, resumo || null);
    return { ok: true, docs: prep.map(o => { const s2 = o.p.split('/'); return { col: s2[0], id: s2[1], data: o.data }; }) };
  }
  /* anexos enviados pela tela (/api/assets): a origem fica no documento; o ASO é dado de saúde (só RH/SST/Administrador abrem) */
  const stOrig = db.prepare('UPDATE arquivos SET origem=? WHERE id=? AND origem IS NULL'), stRestr = db.prepare('UPDATE arquivos SET restrito=1 WHERE id=?'), stArq = db.prepare('SELECT id, ct, tam, por FROM arquivos WHERE id=?');
  function arqsOk(conta, lst, origem, saude) {
    const out = [];
    for (const a of (Array.isArray(lst) ? lst : []).slice(0, 10)) {
      const id = String((a && a.id) || '').replace(/[^A-Za-z0-9_-]/g, ''); if (!id) continue;
      const r = stArq.get(id); if (!r) return { erro: 'Anexo não encontrado (envie o arquivo de novo).' };
      if (conta && r.por && r.por !== conta.id && !admin(conta)) return { erro: 'Anexo de outra pessoa.' };
      if (!/^(application\/pdf|image\/(png|jpe?g))$/i.test(String(r.ct || ''))) return { erro: 'Envie PDF, JPG ou PNG.' };
      out.push({ id, nome: txt(a.nome || 'arquivo', 120), ct: r.ct, tam: r.tam });
    }
    return { arqs: out, fim: () => out.forEach(a => { try { stOrig.run(origem, a.id); if (saude) stRestr.run(a.id); } catch (e) { } }) };
  }

  /* =================================================================== documentos */
  const TIPOS_EMP = new Set(C.DOC_EMP.map(d => d[0])), TIPOS_MES = new Set(C.OBRIG.map(d => d[0])), TIPOS_TRAB = new Set(C.DOC_TRAB.map(d => d[0]));
  /* confere os dados de um documento (vale para a tela e para o link); devolve {erro} ou o registro */
  function montaDoc(X6, parcId, b, linkCtr) {
    const esc = String(b.escopo || ''), tipo = String(b.tipo || ''), d = { parcId, escopo: esc, tipo, emissao: C.dataOk(b.emissao) ? b.emissao : '', validade: C.dataOk(b.validade) ? b.validade : '', obs: txt(b.obs, 300) };
    if (esc === 'emp') { if (!TIPOS_EMP.has(tipo)) return { erro: 'Tipo de documento inválido.' }; if (C.temVal(tipo) && !d.validade) return { erro: 'Informe a validade do documento.' }; if (tipo === 'outro') d.nomeOutro = txt(b.nomeOutro, 80) || 'Outro documento'; }
    else if (esc === 'mes') {
      if (!TIPOS_MES.has(tipo)) return { erro: 'Obrigação inválida.' };
      const ctrCol = b.ctrCol === 'loc166' ? 'loc166' : 'ctremp', ctr = C.ctrDe(X6, ctrCol, String(b.ctrId || ''));
      if (!ctr || ctr.parcId !== parcId) return { erro: 'Contrato não encontrado para este terceiro.', st: 403, outro: true };
      if (linkCtr && linkCtr !== ctr.id) return { erro: 'Este link é de outro contrato.', st: 403, outro: true };
      const mes = String(b.mes || ''); if (!/^\d{4}-\d{2}$/.test(mes)) return { erro: 'Informe o mês.' };
      const h = C.ym(X6.hoje); if (mes > C.maisMeses(h, 1) || mes < C.maisMeses(h, -24)) return { erro: 'Mês fora do período aceito.' };
      Object.assign(d, { ctrCol, ctrId: ctr.id, mes }); delete d.validade;
    } else if (esc === 'trab') {
      if (!TIPOS_TRAB.has(tipo)) return { erro: 'Documento do trabalhador inválido.' };
      const t = X6.tterc.find(x => x.id === String(b.tercId || ''));
      if (!t || t.parcId !== parcId) return { erro: 'Trabalhador não encontrado para este terceiro.', st: 403, outro: true };
      d.tercId = t.id; d.tercNome = txt(t.nome, 120);
      if (tipo === 'nr') { const mm = String(b.nr || '').trim().match(/^NR\s*-?\s*(\d{1,2})$/i); if (!mm) return { erro: 'Informe a NR do certificado (ex.: NR-35).' }; d.nr = C.nrCurto('NR-' + mm[1]); }
      if (tipo === 'cnh') { const cat = String(b.cnhCat || '').toUpperCase().replace(/[^A-E]/g, ''); if (!cat) return { erro: 'Informe a categoria da CNH.' }; d.cnhCat = cat.slice(0, 5); }
      if (tipo === 'registro') { d.regTipo = b.regTipo === 'esocial' ? 'esocial' : 'ctps'; delete d.validade; }
      else if (!d.validade) return { erro: 'Informe a validade.' };
    } else if (esc === 'trabnovo') {
      const nome = txt(b.nome, 120), cpf = C.s(b.cpf).replace(/\D/g, '');
      if (nome.length < 3) return { erro: 'Informe o nome do trabalhador.' }; if (cpf.length !== 11) return { erro: 'CPF com 11 dígitos.' };
      if (X6.tterc.some(t => t.parcId === parcId && C.s(t.cpf).replace(/\D/g, '') === cpf)) return { erro: 'Este trabalhador já está cadastrado.' };
      const projId = String(b.projId || ''); if (projId && !doc('proj/' + projId)) return { erro: 'Obra inválida.' };
      d.novo = { nome, cpf, funcao: txt(b.funcao, 80), projId }; d.tipo = 'novo'; delete d.validade;
    } else return { erro: 'Escopo inválido.' };
    if (d.validade && d.emissao && d.validade < d.emissao) return { erro: 'A validade não pode ser antes da emissão.' };
    return { d };
  }
  function rotaDocNovo(conta, req, b) {
    const P = papel(conta); if (!P.reg) return erro('Seu perfil não registra documentos de terceiros.');
    const X6 = ctx(), parcId = String(b.parcId || ''); if (!doc('parc/' + parcId)) return erro('Fornecedor não encontrado.', 404);
    const m = montaDoc(X6, parcId, b); if (m.erro) return erro(m.erro, m.st || 400);
    const id = novoId('td'), saude = m.d.escopo === 'trab' && m.d.tipo === 'aso', A2 = arqsOk(conta, b.arqs, 'tdc166/' + id, saude); if (A2.erro) return erro(A2.erro, 400);
    if (!A2.arqs.length) return erro('Anexe o arquivo do documento.', 400);
    const ag = Date.now(), aprova = !!b.aprovar && P.docs;
    const d = Object.assign(m.d, { id, arqs: A2.arqs, st: aprova ? 'aprovado' : 'aguardando', origem: 'interno', enviadoEm: ag, enviadoPor: conta.id }, aprova ? { revPor: conta.id, revEm: ag } : {});
    const docs = [{ c: 'tdc166', d }]; if (aprova) { const t = efeitoAprov(X6, d); if (t && t.erro) return erro(t.erro, 409); if (t) docs.push(t); }
    const g = gravar(conta, req, docs, aprova ? 'TERC_DOC_APROVADO' : 'TERC_DOC_ENVIADO', { escopo: d.escopo, tipo: d.tipo, parcId, tercId: d.tercId || '', mes: d.mes || '' }); if (g.erro) return g;
    A2.fim(); return Object.assign(g, { msg: aprova ? 'Documento registrado e aprovado.' : 'Documento registrado: aguardando conferência do RH/SST.' });
  }
  /* aprovar um documento do trabalhador atualiza o cadastro (as mesmas validades que a SST já usa) */
  function efeitoAprov(X6, d) {
    if (d.escopo === 'trabnovo') {
      const id = novoId('tt'), n = d.novo || {};
      d.tercCriado = id;
      return { c: 'tterc', d: { id, parcId: d.parcId, projId: n.projId || '', nome: n.nome, cpf: n.cpf, funcao: n.funcao || '', ativo: true, asoVal: '', integVal: '', epiVal: '', obs: 'Indicado pelo terceiro pelo link (v166)', origem166: 'link' } };
    }
    if (d.escopo !== 'trab') return null;
    const t0 = X6.tterc.find(x => x.id === d.tercId); if (!t0) return { erro: 'Trabalhador não encontrado.' };
    const t = Object.assign({}, t0), mais = (k, v) => { if (C.dataOk(v) && (!t[k] || String(v) > String(t[k]))) t[k] = v; };
    if (d.tipo === 'registro') { t.registro166 = d.regTipo === 'esocial' ? 'eSocial' : 'CTPS digital'; t.registro166Doc = d.id; }
    if (d.tipo === 'aso') mais('asoVal', d.validade);
    if (d.tipo === 'integ') mais('integVal', d.validade);
    if (d.tipo === 'epi') mais('epiVal', d.validade);
    if (d.tipo === 'nr') mais(C.nrKey(d.nr), d.validade);
    if (d.tipo === 'cnh') { if (!t.cnhVal166 || String(d.validade) >= String(t.cnhVal166)) { t.cnhVal166 = d.validade; t.cnhCat166 = d.cnhCat; } }
    const an = Array.isArray(t.anexos) ? t.anexos.slice() : []; (d.arqs || []).forEach(a => { if (!an.some(x => x && x.id === a.id)) an.push({ id: a.id, nome: C.nomeTrab(d.tipo, d.nr) + ' · ' + a.nome }); }); t.anexos = an.slice(-60);
    return { c: 'tterc', d: t };
  }
  function rotaDecidir(conta, req, b) {
    if (!papel(conta).docs) { auditar(conta, req, 'TERC_DOC_DECISAO_NEGADA', 'tdc166/' + String(b.id || '').slice(0, 80), null, null); return erro('Só o RH, a Segurança do trabalho ou o Administrador aprovam ou recusam documentos de terceiros.'); }
    const X6 = ctx(), d0 = ID_OK.test(String(b.id || '')) ? X6.tdc.find(x => x.id === b.id) : null; if (!d0) return erro('Documento não encontrado.', 404);
    if (d0.st !== 'aguardando') return erro('Este documento já foi conferido.', 409);
    const ag = Date.now(), d = Object.assign({}, d0, { revPor: conta.id, revEm: ag });
    if (b.aprovar) {
      if (C.dataOk(b.validade)) d.validade = b.validade; /* a conferência pode corrigir a validade lida no documento */
      if (d.escopo === 'emp' && C.temVal(d.tipo) && !C.dataOk(d.validade)) return erro('Informe a validade do documento.', 400);
      if (d.escopo === 'trab' && d.tipo !== 'registro' && !C.dataOk(d.validade)) return erro('Informe a validade.', 400);
      d.st = 'aprovado'; delete d.motivo;
    } else { const mo = txt(b.motivo, 500); if (mo.length < 5) return erro('Escreva o motivo da recusa (o terceiro vê esse texto).', 400); d.st = 'recusado'; d.motivo = mo; }
    const docs = [{ c: 'tdc166', d }]; if (d.st === 'aprovado') { const t = efeitoAprov(X6, d); if (t && t.erro) return erro(t.erro, 409); if (t) docs.push(t); }
    const g = gravar(conta, req, docs, d.st === 'aprovado' ? 'TERC_DOC_APROVADO' : 'TERC_DOC_RECUSADO', { escopo: d.escopo, tipo: d.tipo, parcId: d.parcId, motivo: d.motivo || '' }); if (g.erro) return g;
    return Object.assign(g, { msg: d.st === 'aprovado' ? 'Documento aprovado.' : 'Documento recusado. O terceiro vê o motivo no link.' });
  }

  /* =================================================================== cadastro da empresa terceira */
  function rotaEmp(conta, req, b) {
    const P = papel(conta); if (!P.cad) return erro('Seu perfil não altera o cadastro de terceiros.');
    const parcId = String(b.parcId || ''), p = ID_OK.test(parcId) ? doc('parc/' + parcId) : null; if (!p) return erro('Escolha o fornecedor do cadastro (Clientes e fornecedores).', 400);
    const v = doc('ter166/' + parcId) || { id: parcId, parcId, em: Date.now(), por: conta.id };
    const ex = {}; if (b.exig && typeof b.exig === 'object') C.DOC_EMP.forEach(d => { if (typeof b.exig[d[0]] === 'boolean' && d[0] !== 'outro') ex[d[0]] = b.exig[d[0]]; });
    const n = Object.assign({}, v, { contato: txt(b.contato, 100), whats: String(b.whats || '').replace(/[^\d+]/g, '').slice(0, 16), email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email || '').trim()) ? String(b.email).trim().slice(0, 120) : '', exig: ex, servico: txt(b.servico, 160), obs: txt(b.obs, 500), ativo: b.ativo !== false, edPor: conta.id, edEm: Date.now() });
    return Object.assign(gravar(conta, req, [{ c: 'ter166', d: n }], 'TERC_CADASTRO', { parcId, ativo: n.ativo }), { msg: 'Cadastro do terceiro salvo.' });
  }
  /* o que a tela da empresa terceira mostra (para quem não lê o cadastro de trabalhadores da SST, o servidor devolve o resumo) */
  function modeloEmp(X6, parcId, tudo) {
    const t = X6.ter.find(x => x.id === parcId) || null, ctrs = X6.ctremp.filter(c => c.parcId === parcId).map(c => ({ col: 'ctremp', id: c.id, numero: c.numero || '', projId: c.projId || '', obra: projNome(c.projId), status: c.status || '', tipo: 'serv' }))
      .concat(X6.loc.filter(l => l.parcId === parcId).map(l => ({ col: 'loc166', id: l.id, numero: l.numero || '', projId: l.projId || '', obra: projNome(l.projId), status: l.st || '', tipo: l.tipo === 'com' ? 'loccom' : 'locsem' })));
    const c6 = C.C6(X6), mes = C.maisMeses(C.ym(X6.hoje), -c6.defas);
    const meses = ctrs.filter(k => k.tipo !== 'locsem' && !['encerrado', 'cancelado', 'concluido'].includes(k.status)).map(k => ({ ctrCol: k.col, ctrId: k.id, nome: (k.tipo === 'serv' ? 'Contrato ' : 'Locação ') + k.numero + (k.obra ? ' · ' + k.obra : ''), mes, itens: C.mesItens(X6, k.col, k.id, parcId, mes).map(i => ({ k: i.k, nome: i.nome, exig: i.exig, st: i.st, motivo: i.motivo })) }));
    const trabs = C.tercsDe(X6, parcId).filter(w => w.ativo !== false).map(w => { const stt = C.trabStatus(X6, w, w.projId || ''); const op = C.ehOperador(c6, w.funcao);
      const req = C.uniq((((X6.cfg || {}).matrizTrein || {})[w.funcao || ''] || []).concat(C.nrsDaFuncao(c6, w.funcao)).map(C.nrCurto));
      return { id: w.id, nome: w.nome, cpf: C.mascCpf(w.cpf), funcao: w.funcao || '', projId: w.projId || '', obra: projNome(w.projId), lib: stt.lib, motivos: stt.motivos, operador: op, nrs: req,
        val: tudo ? { aso: w.asoVal || '', integ: w.integVal || '', epi: w.epiVal || '', cnh: w.cnhVal166 || '', cnhCat: w.cnhCat166 || '', registro: w.registro166 || '', nr: Object.fromEntries(req.map(n => [n, w[C.nrKey(n)] || ''])) } : null }; });
    return { parcId, nome: parcNome(parcId), ter: t, docs: C.empDocs(X6, parcId).map(d => ({ k: d.k, nome: d.nome, exig: d.exig, st: d.st, validade: d.validade, dias: d.dias, pend: d.pend ? { id: d.pend.id, st: d.pend.st, motivo: d.pend.motivo || '' } : null, apId: d.ap ? d.ap.id : '', arqs: d.ap && Array.isArray(d.ap.arqs) ? d.ap.arqs : [] })),
      faltas: C.empFaltas(X6, parcId), ctrs, meses, trabs, mes };
  }

  /* lista das empresas terceiras (cadastro, contratos de empreiteiro vigentes e locações) com a situação de cada uma */
  function lista(X6) {
    const ps = C.uniq(X6.ter.map(t => t.parcId || t.id).concat(X6.ctremp.filter(c => c.status === 'vigente').map(c => c.parcId)).concat(X6.loc.map(l => l.parcId)));
    const nomes = {}, projs = {};
    const emps = ps.map(p => { nomes[p] = parcNome(p); const t = X6.ter.find(x => x.id === p) || null, ts = C.tercsDe(X6, p).filter(w => w.ativo !== false);
      return { parcId: p, nome: nomes[p], ativo: !t || t.ativo !== false, cad: !!t, servico: t ? t.servico || '' : '', nCtr: X6.ctremp.filter(c => c.parcId === p && c.status === 'vigente').length, nLoc: X6.loc.filter(l => l.parcId === p && l.st !== 'encerrado').length,
        faltas: C.empFaltas(X6, p), aguard: X6.tdc.filter(d => d.parcId === p && d.st === 'aguardando').length, trabs: ts.length, naoLib: ts.filter(w => !C.trabStatus(X6, w, w.projId || '').lib).length }; }).sort((a, b) => a.nome.localeCompare(b.nome));
    X6.loc.forEach(l => { projs[l.projId] = projNome(l.projId); }); X6.leq.forEach(e => { projs[e.projId] = projNome(e.projId); (e.guardaHist || []).forEach(g => { if (g && g.para) projs[g.para.projId] = projNome(g.para.projId); }); });
    return { ok: true, emps, nomes, projs };
  }

  /* =================================================================== link público */
  try { db.exec('CREATE TABLE IF NOT EXISTS ter_link166(hash TEXT PRIMARY KEY, parc TEXT, ctr TEXT, tok TEXT, criado INTEGER, expira INTEGER, por TEXT, revogado INTEGER, revPor TEXT, n INTEGER DEFAULT 0, ult INTEGER); CREATE INDEX IF NOT EXISTS ter_link166_parc ON ter_link166(parc);'); } catch (e) { console.error('[v166] tabela:', e.message); }
  const envLink = new Map();
  function rotaLink(conta, req, b) {
    const P = papel(conta); if (!(P.cad || P.reg)) { auditar(conta, req, 'TERC_LINK_NEGADO', 'ter166/' + String(b.parcId || '').slice(0, 80), null, null); return erro('Seu perfil não gera o link de documentos do terceiro.'); }
    const parcId = String(b.parcId || ''); if (!ID_OK.test(parcId) || !doc('parc/' + parcId)) return erro('Fornecedor não encontrado.', 404);
    const ctr = String(b.ctrId || ''); if (ctr) { const X6 = ctx(); const k = X6.ctremp.find(c => c.id === ctr) || X6.loc.find(l => l.id === ctr); if (!k || k.parcId !== parcId) return erro('Contrato de outro terceiro.', 400); }
    const ag = Date.now();
    if (!b.novo) { const ex = db.prepare('SELECT * FROM ter_link166 WHERE parc=? AND coalesce(ctr,\'\')=? AND revogado IS NULL AND expira>? ORDER BY criado DESC LIMIT 1').get(parcId, ctr, ag + 864e5); if (ex) { const t = SEG.decifrarSegredo(ex.tok); if (t && sha(t) === ex.hash) return { ok: true, url: APP_URL + '/terceiro/' + t, expira: ex.expira, id: ex.hash.slice(0, 12) }; } }
    const env = (envLink.get(conta.id) || []).filter(t => ag - t < 3600e3); if (env.length >= 60) return erro('Muitos links gerados na última hora. Tente mais tarde.', 429); env.push(ag); envLink.set(conta.id, env);
    db.prepare('UPDATE ter_link166 SET revogado=?, revPor=? WHERE parc=? AND coalesce(ctr,\'\')=? AND revogado IS NULL').run(ag, conta.id, parcId, ctr);
    const tok = crypto.randomBytes(24).toString('base64url'), exp = ag + LINK_DIAS() * 864e5;
    db.prepare('INSERT INTO ter_link166(hash,parc,ctr,tok,criado,expira,por) VALUES(?,?,?,?,?,?,?)').run(sha(tok), parcId, ctr, SEG.cifrarSegredo(tok), ag, exp, conta.id);
    auditar(conta, req, 'TERC_LINK', 'ter166/' + parcId, null, { link: sha(tok).slice(0, 12), ctr, expira: exp });
    return { ok: true, url: APP_URL + '/terceiro/' + tok, expira: exp, id: sha(tok).slice(0, 12) };
  }
  function rotaLinks(conta, u) {
    if (!papel(conta).le) return erro('Sem acesso.');
    const parcId = String(u.searchParams.get('parcId') || '');
    return { ok: true, dias: LINK_DIAS(), links: db.prepare('SELECT hash, ctr, criado, expira, por, revogado, n, ult FROM ter_link166 WHERE parc=? ORDER BY criado DESC LIMIT 30').all(parcId).map(r => ({ id: r.hash.slice(0, 12), ctr: r.ctr || '', criado: r.criado, expira: r.expira, por: nomeConta(r.por), revogado: r.revogado || null, envios: r.n || 0, ult: r.ult || null, ativo: !r.revogado && r.expira > Date.now() })) };
  }
  function rotaRevogar(conta, req, b) {
    const P = papel(conta); if (!(P.cad || P.reg)) return erro('Seu perfil não revoga links de terceiros.');
    const id = String(b.id || '').replace(/[^0-9a-f]/g, ''); if (id.length !== 12) return erro('Link inválido.', 400);
    const r = db.prepare('SELECT hash, parc FROM ter_link166 WHERE substr(hash,1,12)=? AND revogado IS NULL').get(id); if (!r) return erro('Link não encontrado ou já revogado.', 404);
    db.prepare('UPDATE ter_link166 SET revogado=?, revPor=? WHERE hash=?').run(Date.now(), conta.id, r.hash);
    auditar(conta, req, 'TERC_LINK_REVOGADO', 'ter166/' + r.parc, null, { link: id });
    return { ok: true, msg: 'Link revogado: quem tiver o endereço não consegue mais enviar.' };
  }
  /* limite por IP (janela de 1 h) e atraso nas tentativas erradas, como o aceite.js */
  const lim = new Map();
  setInterval(() => { const ag = Date.now(); for (const [k, v] of lim) if (ag - v.ini > 3600e3) lim.delete(k); }, 600e3).unref();
  const conta1 = (k, max) => { const ag = Date.now(); let l = lim.get(k); if (!l || ag - l.ini > 3600e3) { l = { n: 0, ini: ag }; lim.set(k, l); } l.n++; return l.n > max; };
  const bloqIp = ip => { const l = lim.get('x:' + ip); return !!l && Date.now() - l.ini <= 3600e3 && l.n >= 30; };
  const errou = async (res, ip, st, msg) => { conta1('x:' + ip, 1e9); await new Promise(r => setTimeout(r, 400)); json(res, st, { erro: msg }); return true; };
  function tipoArquivo(b) {
    if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    return '';
  }
  /* o que a página pública mostra: só o que falta deste terceiro (nada de valores, contas ou dados de outros) */
  function publico(X6, reg) {
    const m = modeloEmp(X6, reg.parc, false), e = cfgEmp();
    const tdcP = X6.tdc.filter(d => d.parcId === reg.parc && d.origem === 'link').sort((a, b) => (+b.enviadoEm || 0) - (+a.enviadoEm || 0)).slice(0, 40)
      .map(d => ({ escopo: d.escopo, tipo: d.tipo, nome: d.escopo === 'emp' ? C.nomeDoc(d.tipo) : d.escopo === 'mes' ? C.nomeObrig(d.tipo) + ' ' + C.brYm(d.mes) : d.escopo === 'trab' ? C.nomeTrab(d.tipo, d.nr) : 'Novo trabalhador: ' + ((d.novo || {}).nome || ''), st: d.st, motivo: d.motivo || '', em: d.enviadoEm }));
    const ctrs = reg.ctr ? m.meses.filter(x => x.ctrId === reg.ctr) : m.meses;
    return { empresa: String(e.fantasia || e.razao || 'Empresa'), terceiro: m.nome, expira: reg.expira, arqMb: Math.round(ARQ_MAX() / 1048576),
      docs: m.docs.filter(d => d.exig || d.k === 'outro').map(d => ({ k: d.k, nome: d.nome, exig: d.exig, st: d.pend ? (d.pend.st === 'aguardando' ? 'aguardando' : d.pend.st) : d.st, motivo: d.pend && d.pend.st === 'recusado' ? d.pend.motivo : '', validade: d.validade, temVal: C.temVal(d.k) })),
      meses: ctrs, trabs: m.trabs.map(w => ({ id: w.id, nome: w.nome, cpf: w.cpf, funcao: w.funcao, obra: w.obra, lib: w.lib, motivos: w.motivos, operador: w.operador, nrs: w.nrs })),
      obras: C.uniq(m.ctrs.map(k => k.projId)).map(id => ({ id, nome: projNome(id) })), envios: tdcP, tipos: { emp: C.DOC_EMP.map(d => [d[0], d[1], d[2]]), mes: C.OBRIG, trab: C.DOC_TRAB.map(d => [d[0], d[1], d[2]]) } };
  }
  const PAG_CSS = '.sec{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:12px 0}.sec h2{font-size:16px;margin:0 0 8px}.it{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding:8px 0}.it:first-of-type{border-top:0}.it .n{flex:1 1 220px}.pl{display:inline-block;border-radius:999px;padding:2px 8px;font-size:12px;border:1px solid var(--line)}.pl.ok{color:#047857;border-color:#047857}.pl.neg{color:#b91c1c;border-color:#b91c1c}.pl.warn{color:#b45309;border-color:#b45309}.frm{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;width:100%;margin-top:6px}.frm label{font-size:12px;margin:0}.frm input,.frm select{width:100%;box-sizing:border-box}.err{color:#b91c1c}.okm{color:#047857}.mut{color:var(--mut);font-size:12px}button.sm{padding:6px 10px;font-size:13px;min-height:36px}';
  const PAG_JS = "(function(){var t=location.pathname.split('/').pop(),c=document.getElementById('c'),D=null;function h(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[x];});}" +
    "function br(d){return /^\\d{4}-\\d{2}-\\d{2}/.test(d||'')?d.slice(8,10)+'/'+d.slice(5,7)+'/'+d.slice(0,4):'';}function bym(m){return /^\\d{4}-\\d{2}$/.test(m||'')?m.slice(5,7)+'/'+m.slice(0,4):'';}" +
    "var ST={ok:['Em dia','ok'],vence:['Vence em breve','warn'],vencido:['Vencido','neg'],falta:['Pendente','neg'],aguardando:['Aguardando conferência','warn'],recusado:['Recusado','neg'],aprovado:['Aprovado','ok'],entregue:['Aguardando conferência','warn'],pendente:['Pendente','neg']};function pl(k){var o=ST[k]||[k,''];return '<span class=\"pl '+o[1]+'\">'+h(o[0])+'</span>';}" +
    "function fim(x){c.innerHTML='<p style=\"font-size:17px\">'+h(x)+'</p>';}" +
    "function frm(meta,val){var id='f'+Math.random().toString(36).slice(2,8);return '<div class=\"frm\" data-m=\"'+h(JSON.stringify(meta))+'\" id=\"'+id+'\"><label>Arquivo (PDF, JPG ou PNG, até '+D.arqMb+' MB)<input type=\"file\" accept=\"application/pdf,image/jpeg,image/png\"></label><label>Emissão<input type=\"date\" data-k=\"emissao\"></label>'+(val?'<label>Validade<input type=\"date\" data-k=\"validade\"></label>':'')+(meta.tipo==='nr'?'':'')+(meta.tipo==='cnh'?'<label>Categoria<input data-k=\"cnhCat\" maxlength=\"5\" placeholder=\"Ex.: D\"></label>':'')+(meta.tipo==='registro'?'<label>Tipo<select data-k=\"regTipo\"><option value=\"ctps\">CTPS digital</option><option value=\"esocial\">eSocial</option></select></label>':'')+'<button type=\"button\" class=\"sm pri\" data-env=\"'+id+'\">Enviar</button><span class=\"mg\"></span></div>';}" +
    "function tela(j){D=j;var o='<p class=\"sub\">'+h(j.empresa)+'</p><h1>Documentos de '+h(j.terceiro)+'</h1><p class=\"sub\">Envie aqui os documentos pedidos. Cada envio fica aguardando a conferência da nossa equipe; o resultado aparece nesta página. Link válido até '+h(new Date(j.expira).toLocaleDateString('pt-BR'))+'.</p>';" +
    "o+='<div class=\"sec\"><h2>Documentos da empresa</h2>'+j.docs.map(function(d){return '<div class=\"it\"><div class=\"n\"><b>'+h(d.nome)+'</b> '+pl(d.st)+(d.validade?' <span class=\"mut\">válido até '+br(d.validade)+'</span>':'')+(d.motivo?'<div class=\"err\">Recusado: '+h(d.motivo)+'</div>':'')+'</div>'+(d.st==='ok'?'<details style=\"width:100%\"><summary class=\"mut\">Enviar nova versão</summary>'+frm({escopo:'emp',tipo:d.k},d.temVal)+'</details>':frm({escopo:'emp',tipo:d.k},d.temVal))+'</div>';}).join('')+'</div>';" +
    "j.meses.forEach(function(m){o+='<div class=\"sec\"><h2>'+h(m.nome)+' · obrigações de '+bym(m.mes)+'</h2>'+m.itens.filter(function(i){return i.exig;}).map(function(i){return '<div class=\"it\"><div class=\"n\"><b>'+h(i.nome)+'</b> '+pl(i.st)+(i.motivo?'<div class=\"err\">Recusado: '+h(i.motivo)+'</div>':'')+'</div>'+(i.st==='aprovado'?'':frm({escopo:'mes',tipo:i.k,ctrCol:m.ctrCol,ctrId:m.ctrId,mes:m.mes},false))+'</div>';}).join('')+'</div>';});" +
    "o+='<div class=\"sec\"><h2>Trabalhadores</h2>'+(j.trabs.length?j.trabs.map(function(w){var ds=[['registro','Registro (CTPS digital ou eSocial)',0],['aso','ASO',1],['integ','Integração de SST',1],['epi','Ficha de EPI',1]].concat(w.nrs.map(function(n){return ['nr','Certificado '+n,1,n];})).concat(w.operador?[['cnh','CNH',1]]:[]);" +
    "return '<div class=\"it\" style=\"display:block\"><div><b>'+h(w.nome)+'</b> <span class=\"mut\">'+h(w.cpf)+' · '+h(w.funcao)+(w.obra?' · '+h(w.obra):'')+'</span> '+(w.lib?'<span class=\"pl ok\">Liberado</span>':'<span class=\"pl neg\">Não liberado</span>')+(w.motivos.length?'<div class=\"mut\">Falta: '+h(w.motivos.join(', '))+'</div>':'')+'</div><details><summary>Enviar documento</summary>'+ds.map(function(d){return '<div style=\"margin:6px 0\"><b>'+h(d[1])+'</b>'+frm({escopo:'trab',tipo:d[0],tercId:w.id,nr:d[3]||''},!!d[2])+'</div>';}).join('')+'</details></div>';}).join(''):'<p class=\"mut\">Nenhum trabalhador cadastrado.</p>')+" +
    "'<details style=\"margin-top:8px\"><summary>Indicar um novo trabalhador</summary><div class=\"frm\" id=\"novo\"><label>Nome<input data-k=\"nome\" maxlength=\"120\"></label><label>CPF<input data-k=\"cpf\" inputmode=\"numeric\" maxlength=\"14\"></label><label>Função<input data-k=\"funcao\" maxlength=\"80\"></label>'+(j.obras.length?'<label>Obra<select data-k=\"projId\"><option value=\"\">—</option>'+j.obras.map(function(x){return '<option value=\"'+h(x.id)+'\">'+h(x.nome)+'</option>';}).join('')+'</select></label>':'')+'<button type=\"button\" class=\"sm pri\" id=\"novoEnv\">Indicar</button><span class=\"mg\"></span></div><p class=\"mut\">Depois da conferência, envie os documentos dele por esta página.</p></details></div>';" +
    "if(j.envios.length)o+='<div class=\"sec\"><h2>Seus envios</h2>'+j.envios.map(function(e){return '<div class=\"it\"><div class=\"n\">'+h(e.nome)+' <span class=\"mut\">'+h(new Date(e.em).toLocaleString('pt-BR'))+'</span></div>'+pl(e.st)+(e.motivo?'<div class=\"err\" style=\"width:100%\">'+h(e.motivo)+'</div>':'')+'</div>';}).join('')+'</div>';" +
    "o+='<p class=\"mut\">Ao enviar, registramos a data, a hora e o endereço de internet (IP) de onde veio o arquivo, só como comprovação do envio. Este link não dá acesso a nenhum outro dado da empresa.</p>';c.innerHTML=o;}" +
    "function env(box){var m=JSON.parse(box.getAttribute('data-m')),f=box.querySelector('input[type=file]'),msg=box.querySelector('.mg');msg.className='mg';msg.textContent='';[].forEach.call(box.querySelectorAll('[data-k]'),function(x){m[x.getAttribute('data-k')]=x.value;});" +
    "if(!f.files.length){msg.className='mg err';msg.textContent='Escolha o arquivo.';return;}var a=f.files[0];if(a.size>D.arqMb*1048576){msg.className='mg err';msg.textContent='Arquivo maior que '+D.arqMb+' MB.';return;}m.nomeArq=a.name;" +
    "var b=box.querySelector('button');b.disabled=true;msg.textContent='Enviando…';fetch('/api/pub/terc/'+t+'/enviar?m='+encodeURIComponent(JSON.stringify(m)),{method:'POST',headers:{'content-type':a.type||'application/octet-stream'},body:a}).then(function(r){return r.json();}).then(function(j){b.disabled=false;if(j.ok){msg.className='mg okm';msg.textContent='Enviado: aguardando conferência.';f.value='';}else{msg.className='mg err';msg.textContent=j.erro||'Não foi possível enviar.';}},function(){b.disabled=false;msg.className='mg err';msg.textContent='Sem conexão. Tente de novo.';});}" +
    "c.addEventListener('click',function(ev){var x=ev.target;if(x.getAttribute&&x.getAttribute('data-env'))env(document.getElementById(x.getAttribute('data-env')));if(x.id==='novoEnv'){var bx=document.getElementById('novo'),o={escopo:'trabnovo'},msg=bx.querySelector('.mg');[].forEach.call(bx.querySelectorAll('[data-k]'),function(y){o[y.getAttribute('data-k')]=y.value;});x.disabled=true;" +
    "fetch('/api/pub/terc/'+t+'/novo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(o)}).then(function(r){return r.json();}).then(function(j){x.disabled=false;msg.className='mg '+(j.ok?'okm':'err');msg.textContent=j.ok?'Indicação enviada: aguardando conferência.':(j.erro||'Não foi possível enviar.');},function(){x.disabled=false;msg.className='mg err';msg.textContent='Sem conexão.';});}});" +
    "fetch('/api/pub/terc/'+t).then(function(r){return r.json();}).then(function(j){if(j.situacao==='aberto')tela(j);else if(j.situacao==='expirado')fim('Este link expirou ou foi revogado. Peça um novo a quem enviou.');else fim(j.erro||'Link não encontrado. Confira o endereço recebido.');},function(){fim('Não foi possível abrir agora. Tente mais tarde.');});})();";
  const avLink = new Map();
  async function publica(p, m, req, res) {
    const pa = p.match(/^\/terceiro\/([A-Za-z0-9_-]{32,64})$/), aa = p.match(/^\/api\/pub\/terc\/([A-Za-z0-9_-]{32,64})(\/enviar|\/novo)?$/);
    if (!pa && !aa) return false;
    const ip = ipDe(req);
    if (pa) { if (m !== 'GET') { json(res, 405, { erro: 'Método não permitido.' }); return true; } X.html(res, 200, X.pag('Documentos do terceiro', '<style>' + PAG_CSS + '</style><div class="card" style="max-width:920px;margin:24px auto"><div id="c"><p class="sub">Carregando…</p></div></div><script>' + PAG_JS + '</script>'), { 'x-robots-tag': 'noindex', 'referrer-policy': 'same-origin', 'cache-control': 'no-store' }); return true; }
    if (bloqIp(ip)) { json(res, 429, { erro: 'Muitas tentativas. Tente mais tarde.' }); return true; }
    const acao = aa[2] || '';
    if (conta1('t:' + ip, m === 'GET' ? 120 : 40)) { json(res, 429, { erro: 'Muitas tentativas. Tente mais tarde.' }); return true; }
    const reg = db.prepare('SELECT * FROM ter_link166 WHERE hash=?').get(sha(aa[1]));
    if (!reg) return errou(res, ip, 404, 'Link não encontrado. Confira o endereço recebido.');
    const vivo = !reg.revogado && reg.expira > Date.now();
    if (m === 'GET' && !acao) { if (!vivo) { json(res, 200, { situacao: 'expirado' }); return true; } json(res, 200, Object.assign({ situacao: 'aberto' }, publico(ctx(), reg))); return true; }
    if (m !== 'POST' || !acao) { json(res, 405, { erro: 'Método não permitido.' }); return true; }
    if (!vivo) { json(res, 410, { erro: 'Este link expirou ou foi revogado. Peça um novo a quem enviou.' }); return true; }
    if ((reg.n || 0) >= 500) { json(res, 429, { erro: 'Limite de envios deste link. Peça um novo link.' }); return true; }
    const linkId = reg.hash.slice(0, 12), X6 = ctx();
    let meta, buf = null;
    try {
      if (acao === '/novo') meta = JSON.parse((await X.lerCorpo(req, 20000)).toString('utf8') || '{}');
      else { meta = JSON.parse(new URL(req.url, 'http://x').searchParams.get('m') || '{}'); buf = await X.lerCorpo(req, ARQ_MAX()); }
    } catch (e) { const g = e && e.st === 413; json(res, g ? 413 : 400, { erro: g ? 'Arquivo grande demais (até ' + Math.round(ARQ_MAX() / 1048576) + ' MB).' : 'Dados inválidos.' }); return true; }
    if (!meta || typeof meta !== 'object') { json(res, 400, { erro: 'Dados inválidos.' }); return true; }
    if (acao === '/novo') meta.escopo = 'trabnovo'; else if (meta.escopo === 'trabnovo') { json(res, 400, { erro: 'Dados inválidos.' }); return true; }
    const mm = montaDoc(X6, reg.parc, meta, reg.ctr || '');
    if (mm.erro) { if (mm.outro) auditar(null, req, 'TERC_LINK_OUTRO_TERCEIRO', 'ter166/' + reg.parc, null, { link: linkId, escopo: String(meta.escopo || '').slice(0, 20) }); if (mm.outro) return errou(res, ip, 403, mm.erro); json(res, 400, { erro: mm.erro }); return true; }
    const id = novoId('td'), ag = Date.now(), d = Object.assign(mm.d, { id, st: 'aguardando', origem: 'link', linkId, ip: String(ip || '').slice(0, 64), enviadoEm: ag, enviadoPor: 'terceiro', arqs: [] });
    if (buf) {
      if (!buf.length) { json(res, 400, { erro: 'Arquivo vazio.' }); return true; }
      const ct = tipoArquivo(buf); if (!ct) { json(res, 415, { erro: 'Envie PDF, JPG ou PNG.' }); return true; }
      const bid = crypto.randomBytes(16).toString('hex');
      try { fs.writeFileSync(path.join(DATA, 'blobs', bid), buf); q.arqNovo.run(bid, ct, buf.length, null, ag); db.prepare('UPDATE arquivos SET origem=?' + (d.escopo === 'trab' && d.tipo === 'aso' ? ', restrito=1' : '') + ' WHERE id=?').run('tdc166/' + id, bid); }
      catch (e) { json(res, 500, { erro: 'Falha ao guardar o arquivo. Tente de novo.' }); return true; }
      d.arqs = [{ id: bid, nome: txt(meta.nomeArq || 'arquivo', 120), ct, tam: buf.length }];
    }
    const ts = Date.now(); q.docPut.run('tdc166/' + id, 'tdc166', id, JSON.stringify(d), ts); avisarDoc('set', 'tdc166/' + id, d, ts);
    db.prepare('UPDATE ter_link166 SET n=coalesce(n,0)+1, ult=? WHERE hash=?').run(ag, reg.hash);
    auditar(null, req, 'TERC_LINK_UPLOAD', 'tdc166/' + id, null, { link: linkId, ip: String(ip || '').slice(0, 64), em: ag, parcId: reg.parc, escopo: d.escopo, tipo: d.tipo, tam: buf ? buf.length : 0 });
    if (!(avLink.get(reg.hash) > ag - 3600e3)) { avLink.set(reg.hash, ag); avisarChat(usrsDe(U_DOCS).concat([reg.por]), parcNome(reg.parc) + ' enviou documento pelo link (' + (d.escopo === 'trabnovo' ? 'novo trabalhador' : d.escopo === 'emp' ? C.nomeDoc(d.tipo) : d.escopo === 'mes' ? C.nomeObrig(d.tipo) + ' ' + C.brYm(d.mes) : C.nomeTrab(d.tipo, d.nr)) + '). Confira em Terceiros e locações › Conferência de documentos.'); }
    json(res, 200, { ok: true }); return true;
  }

  /* =================================================================== locação */
  const num = C.num, dt = v => C.dataOk(v) ? v : '';
  function rotaLoc(conta, req, b) {
    if (!papel(conta).compras) return erro('Contrato de locação é com Compras/suprimentos (ou o Administrador).');
    const parcId = String(b.parcId || ''); if (!doc('parc/' + parcId)) return erro('Escolha o locador (fornecedor do cadastro).', 400);
    const projId = String(b.projId || ''); if (!doc('proj/' + projId)) return erro('Escolha a obra.', 400);
    const ini = dt(b.ini), fim = dt(b.fim); if (!ini) return erro('Informe o início do período.', 400); if (fim && fim < ini) return erro('O fim do período é antes do início.', 400);
    const X6 = ctx(), id = ID_OK.test(String(b.id || '')) ? String(b.id) : '', v = id ? X6.loc.find(x => x.id === id) : null;
    if (id && !v) return erro('Locação não encontrada.', 404);
    const ops = (Array.isArray(b.operadores) ? b.operadores : []).map(String).filter(x => { const t = X6.tterc.find(w => w.id === x); return t && t.parcId === parcId; }).slice(0, 20);
    const tipo = b.tipo === 'com' ? 'com' : 'sem'; if (tipo === 'com' && !ops.length && b.operadores && b.operadores.length) return erro('O operador tem de ser trabalhador deste locador.', 400);
    const n = Object.assign({}, v || { id: novoId('lc'), numero: 'LOC-' + String(X6.loc.length + 1).padStart(4, '0'), por: conta.id, em: Date.now(), st: 'vigente' }, { parcId, tipo, projId, ini, fim, operadores: tipo === 'com' ? ops : [], opNomes: tipo === 'com' ? ops.map(x => txt((X6.tterc.find(w => w.id === x) || {}).nome, 120)) : [], obs: txt(b.obs, 500), edPor: conta.id, edEm: Date.now() });
    if (b.encerrar) { if (X6.leq.some(e => e.locId === n.id && e.st === 'retirado')) return erro('Há equipamento desta locação ainda na obra: registre a devolução antes de encerrar.', 409); n.st = 'encerrado'; n.encEm = Date.now(); }
    const docs = [{ c: 'loc166', d: n }]; if (!doc('ter166/' + parcId)) docs.push({ c: 'ter166', d: { id: parcId, parcId, ativo: true, em: Date.now(), por: conta.id, exig: {} } });
    return Object.assign(gravar(conta, req, docs, v ? 'TERC_LOCACAO_ALTERADA' : 'TERC_LOCACAO', { parcId, tipo, projId, st: n.st }), { msg: v ? 'Locação salva.' : 'Locação ' + n.numero + ' criada.', id: n.id });
  }
  function rotaEq(conta, req, b) {
    if (!papel(conta).compras) return erro('Equipamento locado é cadastrado por Compras/suprimentos (ou o Administrador).');
    const X6 = ctx(), lc = X6.loc.find(x => x.id === String(b.locId || '')); if (!lc) return erro('Locação não encontrada.', 404);
    if (lc.st === 'encerrado') return erro('Locação encerrada.', 409);
    const id = ID_OK.test(String(b.id || '')) ? String(b.id) : '', v = id ? X6.leq.find(x => x.id === id) : null; if (id && !v) return erro('Equipamento não encontrado.', 404);
    const desc = txt(b.desc, 160); if (desc.length < 3) return erro('Descreva o equipamento.', 400);
    const ini = dt(b.ini) || lc.ini, fim = dt(b.fim) || lc.fim || ''; if (fim && fim < ini) return erro('O fim do período é antes do início.', 400);
    const vals = { vDia: Math.max(0, num(b.vDia)), vSem: Math.max(0, num(b.vSem)), vMes: Math.max(0, num(b.vMes)) }; if (!(vals.vDia || vals.vSem || vals.vMes)) return erro('Informe o valor por dia, semana ou mês.', 400);
    const n = Object.assign({}, v || { id: novoId('le'), st: 'aguardando', por: conta.id, em: Date.now(), guardaHist: [], notas166: [] }, { locId: lc.id, parcId: lc.parcId, projId: v && v.st !== 'aguardando' ? v.projId : (String(b.projId || '') && doc('proj/' + b.projId) ? String(b.projId) : lc.projId), tipo: txt(b.tipo, 60), desc, serie: txt(b.serie, 60), patr: txt(b.patr, 60), ini, fim },
      vals, { franqH: Math.max(0, num(b.franqH)), vHoraExc: Math.max(0, num(b.vHoraExc)), manutPor: b.manutPor === 'empresa' ? 'empresa' : 'locador', edPor: conta.id, edEm: Date.now() });
    if (v && v.fim !== n.fim) n.av166 = Object.assign({}, v.av166 || {}, { fim: '', atraso: '' }); /* renovou o período: os alertas valem de novo */
    return Object.assign(gravar(conta, req, [{ c: 'leq166', d: n }], v ? 'TERC_EQUIP_ALTERADO' : 'TERC_EQUIP', { locId: lc.id, desc, fim }), { msg: 'Equipamento salvo.', id: n.id });
  }
  function vistoria(b, c6) { const o = {}; c6.vist.forEach(i => { const v = b && b[i]; if (v === 'ok' || v === 'nok') o[i] = v; }); return o; }
  function fotos(conta, lst, origem) { const A2 = arqsOk(conta, (Array.isArray(lst) ? lst : []).map(f => ({ id: f && f.id, nome: (f && f.nome) || 'foto' })), origem, false); return A2; }
  function rotaRetirada(conta, req, b) {
    if (!papel(conta).compras) return erro('A retirada é registrada por Compras/suprimentos (ou o Administrador).');
    const X6 = ctx(), e = X6.leq.find(x => x.id === String(b.id || '')); if (!e) return erro('Equipamento não encontrado.', 404);
    if (e.st !== 'aguardando') return erro('A retirada deste equipamento já foi registrada.', 409);
    const c6 = C.C6(X6), vist = vistoria(b.vist, c6); if (Object.keys(vist).length < c6.vist.length) return erro('Marque todos os itens da vistoria (OK ou Problema).', 400);
    if (Object.values(vist).includes('nok') && txt(b.vistObs, 500).length < 5) return erro('Descreva o problema encontrado na vistoria.', 400);
    const F = fotos(conta, b.fotos, 'leq166/' + e.id); if (F.erro) return erro(F.erro, 400); if (!F.arqs.length) return erro('Tire ao menos uma foto do equipamento na retirada.', 400);
    const resp = txt(b.resp, 100); if (resp.length < 3) return erro('Informe o responsável pela retirada.', 400);
    const data = dt(b.data) || hojeBr();
    const n = Object.assign({}, e, { st: 'retirado', ret: { data, hora: /^\d{2}:\d{2}$/.test(String(b.hora || '')) ? b.hora : '', vist, vistObs: txt(b.vistObs, 500), fotos: F.arqs, hor: Math.max(0, num(b.hor)), resp, por: conta.id, em: Date.now() },
      guarda: { resp: txt(b.guardaResp, 100) || resp, respUid: String(b.guardaUid || '').slice(0, 60), local: txt(b.local, 120), projId: e.projId, desde: data, por: conta.id } });
    const g = gravar(conta, req, [{ c: 'leq166', d: n }], 'TERC_EQUIP_RETIRADA', { id: e.id, hor: n.ret.hor, fotos: F.arqs.length }); if (g.erro) return g; F.fim();
    return Object.assign(g, { msg: 'Retirada registrada: o equipamento está na obra.' });
  }
  function rotaGuarda(conta, req, b) {
    const X6 = ctx(), e = X6.leq.find(x => x.id === String(b.id || '')); if (!e) return erro('Equipamento não encontrado.', 404);
    const P = papel(conta); if (!(P.compras || P.obra)) return erro('A guarda é registrada pela engenharia/obra ou por Compras (ou o Administrador).');
    if (e.st !== 'retirado') return erro('Só equipamento que está na obra muda de guarda.', 409);
    const resp = txt(b.resp, 100); if (resp.length < 3) return erro('Informe quem fica responsável pela guarda.', 400);
    const projId = String(b.projId || e.projId), muda = projId !== e.projId; if (!doc('proj/' + projId)) return erro('Obra inválida.', 400);
    if (muda && txt(b.motivo, 300).length < 5) return erro('Informe o motivo da transferência entre obras.', 400);
    const de = e.guarda || {}, para = { resp, respUid: String(b.respUid || '').slice(0, 60), local: txt(b.local, 120), projId, desde: dt(b.data) || hojeBr(), por: conta.id };
    const n = Object.assign({}, e, { projId, guarda: para, guardaHist: (Array.isArray(e.guardaHist) ? e.guardaHist : []).concat([{ de: { resp: de.resp || '', local: de.local || '', projId: de.projId || e.projId }, para: { resp, local: para.local, projId }, data: para.desde, motivo: txt(b.motivo, 300), recebe: txt(b.recebe, 100) || resp, por: conta.id, em: Date.now() }]).slice(-100) });
    const g = gravar(conta, req, [{ c: 'leq166', d: n }], muda ? 'TERC_EQUIP_TRANSFERIDO' : 'TERC_EQUIP_GUARDA', { id: e.id, de: de.projId || e.projId, para: projId }); if (g.erro) return g;
    return Object.assign(g, { msg: muda ? 'Equipamento transferido para ' + projNome(projId) + '.' : 'Guarda atualizada.' });
  }
  function rotaDevolucao(conta, req, b) {
    if (!papel(conta).compras) return erro('A devolução é registrada por Compras/suprimentos (ou o Administrador).');
    const X6 = ctx(), e = X6.leq.find(x => x.id === String(b.id || '')); if (!e) return erro('Equipamento não encontrado.', 404);
    if (e.st !== 'retirado') return erro(e.st === 'devolvido' ? 'A devolução já foi registrada.' : 'Registre a retirada antes da devolução.', 409);
    const c6 = C.C6(X6), vist = vistoria(b.vist, c6); if (Object.keys(vist).length < c6.vist.length) return erro('Marque todos os itens da vistoria (OK ou Problema).', 400);
    const av = (Array.isArray(b.avarias) ? b.avarias : []).filter(a => a && txt(a.desc, 300)).slice(0, 20);
    const F = fotos(conta, b.fotos, 'leq166/' + e.id); if (F.erro) return erro(F.erro, 400); if (!F.arqs.length) return erro('Tire ao menos uma foto do equipamento na devolução.', 400);
    const FA = fotos(conta, av.map(a => a.foto).filter(Boolean), 'leq166/' + e.id); if (FA.erro) return erro(FA.erro, 400);
    if (av.some(a => !(a.foto && a.foto.id))) return erro('Cada avaria precisa de foto.', 400);
    const data = dt(b.data) || hojeBr(), ini = C.dataOk(e.ret && e.ret.data) ? e.ret.data : e.ini; if (data < ini) return erro('A devolução não pode ser antes da retirada.', 400);
    const hor = Math.max(0, num(b.hor)); if (e.ret && num(e.ret.hor) > 0 && hor > 0 && hor < num(e.ret.hor)) return erro('O horímetro da devolução é menor que o da retirada (' + e.ret.hor + ').', 400);
    const n = Object.assign({}, e, { st: 'devolvido', dev: { data, hora: /^\d{2}:\d{2}$/.test(String(b.hora || '')) ? b.hora : '', vist, avarias: av.map(a => ({ desc: txt(a.desc, 300), foto: { id: String(a.foto.id), nome: 'avaria' } })), fotos: F.arqs, hor, por: conta.id, em: Date.now() } });
    n.dev.horas = C.horasEq(X6, n, '', '');
    const g = gravar(conta, req, [{ c: 'leq166', d: n }], 'TERC_EQUIP_DEVOLUCAO', { id: e.id, avarias: av.length, hor }); if (g.erro) return g; F.fim(); FA.fim();
    if (av.length) avisarChat(usrsDe(U_COMP).concat([e.por]), 'Devolução com avaria: ' + e.desc + ' (' + parcNome(e.parcId) + '), ' + av.length + ' avaria(s) registrada(s) com foto. Confira a cobrança na nota do locador.');
    const pv = C.previsto(X6, n, '', ''); return Object.assign(g, { msg: 'Devolução registrada: ' + pv.dias + ' dia(s), ' + pv.horas + ' h de uso.', previsto: pv });
  }
  /* conciliação: a nota do locador com o contrato, o equipamento e a obra; mostra o previsto ao lado do valor da nota */
  function rotaNota(conta, req, b) {
    if (!(papel(conta).compras || (temTer(conta) && X.gravaCol(conta, 'notas')))) return erro('Quem concilia a nota do locador é Compras ou o Fiscal (ou o Administrador).');
    const X6 = ctx(), n = X6.notas.find(x => x.id === String(b.notaId || '')); if (!n) return erro('Nota não encontrada.', 404);
    if (b.naoLoc) {
      const mo = txt(b.motivo, 300); if (mo.length < 5) return erro('Explique por que esta nota não é da locação.', 400);
      if (C.eqsDaNota(X6, n.id).length) return erro('A nota já está conciliada com equipamento locado.', 409);
      return Object.assign(gravar(conta, req, [{ c: 'tnl166', d: { id: n.id, notaId: n.id, parcId: n.parcId || '', motivo: mo, por: conta.id, em: Date.now() } }], 'TERC_NOTA_NAO_LOCACAO', { notaId: n.id, motivo: mo }), { msg: 'Nota marcada como não sendo da locação.' });
    }
    const ids = (Array.isArray(b.eqIds) ? b.eqIds : []).map(String), es = X6.leq.filter(e => ids.includes(e.id)); if (!es.length || es.length !== ids.length) return erro('Escolha os equipamentos da nota.', 400);
    if (es.some(e => e.parcId !== n.parcId)) return erro('Equipamento de outro locador: a nota é de ' + parcNome(n.parcId) + '.', 400);
    if (es.some(e => e.st === 'aguardando')) return erro('Equipamento ainda não retirado não entra na nota.', 409);
    const vNota = C.notaValor(n), docs = [], rs = [];
    let totPrev = 0;
    for (const e of es) {
      if ((e.notas166 || []).some(x => x.notaId === n.id)) return erro('A nota já está conciliada com ' + e.desc + '.', 409);
      const per = (b.per && b.per[e.id]) || {}, ult = (e.notas166 || []).map(x => x.ate).filter(C.dataOk).sort().pop();
      const de = C.dataOk(per.de) ? per.de : ult ? C.maisDias(ult, 1) : '', ate = C.dataOk(per.ate) ? per.ate : (C.dataOk(n.emissao) && e.st !== 'devolvido' ? n.emissao : '');
      const pv = C.previsto(X6, e, de, ate); totPrev += pv.total; rs.push({ e, pv });
    }
    const tol = C.C6(X6).tolPct, dif = C.r2(vNota - totPrev), pct = totPrev > 0 ? Math.abs(dif) / totPrev * 100 : (vNota > 0 ? 100 : 0);
    if (pct > tol + 1e-9 && txt(b.just, 500).length < 10) return { erro: 'O valor da nota (R$ ' + vNota.toFixed(2) + ') difere do previsto (R$ ' + C.r2(totPrev).toFixed(2) + ') em ' + pct.toFixed(1) + '%. Escreva a justificativa da diferença (ao menos 10 caracteres).', st: 409, previsto: C.r2(totPrev), valorNota: vNota, dif };
    for (const { e, pv } of rs) { const parte = totPrev > 0 ? C.r2(vNota * pv.total / totPrev) : C.r2(vNota / rs.length);
      docs.push({ c: 'leq166', d: Object.assign({}, e, { notas166: (e.notas166 || []).concat([{ notaId: n.id, numero: n.numero || '', valor: parte, previsto: pv.total, dias: pv.dias, horas: pv.horas, excedentes: pv.excedentes, de: pv.de, ate: pv.ate, projId: e.projId, dif: C.r2(parte - pv.total), just: txt(b.just, 500), por: conta.id, em: Date.now() }]) }) }); }
    const g = gravar(conta, req, docs, 'TERC_NOTA_CONCILIADA', { notaId: n.id, valor: vNota, previsto: C.r2(totPrev), dif, eqs: ids }); if (g.erro) return g;
    return Object.assign(g, { msg: 'Nota conciliada: valor R$ ' + vNota.toFixed(2) + ' × previsto R$ ' + C.r2(totPrev).toFixed(2) + '.', previsto: C.r2(totPrev), valorNota: vNota, dif });
  }
  function rotaPrevisto(conta, u) {
    if (!papel(conta).le && !X.gravaCol(conta, 'notas')) return erro('Sem acesso.');
    const X6 = ctx(), n = X6.notas.find(x => x.id === String(u.searchParams.get('notaId') || '')), ids = String(u.searchParams.get('eqIds') || '').split(',').filter(Boolean);
    const es = X6.leq.filter(e => ids.includes(e.id)), ate = n && C.dataOk(n.emissao) ? n.emissao : '';
    const L = es.map(e => { const ult = (e.notas166 || []).map(x => x.ate).filter(C.dataOk).sort().pop(); return Object.assign({ id: e.id, desc: e.desc }, C.previsto(X6, e, ult ? C.maisDias(ult, 1) : '', e.st === 'devolvido' ? '' : ate)); });
    return { ok: true, valorNota: n ? C.notaValor(n) : 0, previsto: C.r2(L.reduce((t, x) => t + x.total, 0)), itens: L, tolPct: C.C6(X6).tolPct, candidatas: X6.leq.filter(e => n && e.parcId === n.parcId && e.st !== 'aguardando').map(e => ({ id: e.id, desc: e.desc, obra: projNome(e.projId), st: e.st })) };
  }

  /* =================================================================== bloqueio do pagamento */
  const TXT_BLOQ = 'Bloqueado por documentação';
  function bloqueioLanc(l, X6) { try { return C.bloqueio(X6 || ctx(), l); } catch (e) { console.error('[v166] bloqueio:', e.message); return { sob: false, bloq: false, faltas: [] }; } }
  function msgBloq(b, acao) { return TXT_BLOQ + ': ' + acao + ' recusado pelo servidor. Falta: ' + b.faltas.slice(0, 8).join('; ') + (b.faltas.length > 8 ? ' e mais ' + (b.faltas.length - 8) : '') + '. Regularize em Terceiros e locações ou peça a liberação ao Administrador (com justificativa).'; }
  /* /api/aprovar e remessa: devolve o erro ou null */
  function trava(conta, req, l, acao) {
    if (!l || l.tipo !== 'pagar' || l.pago) return null;
    const b = bloqueioLanc(l); if (!b.bloq) return null;
    auditar(conta, req, 'TERC_PAGAMENTO_BLOQUEADO', 'lanc/' + l.id, null, { acao, faltas: b.faltas.slice(0, 20) });
    return erro(msgBloq(b, acao), 409);
  }
  function travaTxt(l) { if (!l || l.tipo !== 'pagar' || l.pago) return ''; const b = bloqueioLanc(l); return b.bloq ? TXT_BLOQ + ' (' + b.faltas.slice(0, 3).join('; ') + ')' : ''; }
  function rotaLiberar(conta, req, b) {
    if (!admin(conta)) { auditar(conta, req, 'TERC_LIBERACAO_NEGADA', 'lanc/' + String(b.lancId || '').slice(0, 80), null, null); return erro('Só o Administrador libera o pagamento bloqueado por documentação.'); }
    const id = String(b.lancId || ''), l = ID_OK.test(id) ? doc('lanc/' + id) : null; if (!l) return erro('Conta não encontrada.', 404);
    if (l.pago) return erro('Conta já paga.', 409);
    const bl = bloqueioLanc(l); if (!bl.sob) return erro('Esta conta não é de terceiro sob contrato.', 400); if (!bl.faltas.length) return erro('Esta conta não está bloqueada.', 409);
    const just = txt(b.just, 1000); if (just.length < 15) return erro('Escreva a justificativa da liberação (ao menos 15 caracteres).', 400);
    const lib = { srv: 1, por: conta.id, nome: nomeConta(conta.id), em: Date.now(), ip: String(ipDe(req) || '').slice(0, 64), just, faltas: bl.faltas.slice(0, 40) };
    const n = Object.assign({}, l, { lib166: lib, hist: (Array.isArray(l.hist) ? l.hist : []).concat([{ t: lib.em, by: conta.id, ch: [['lib166', '', 'Pagamento liberado pelo Administrador apesar da documentação pendente: ' + just.slice(0, 200)]] }]).slice(-30) });
    const g = gravar(conta, req, [{ c: 'lanc', d: n }], 'TERC_PAGAMENTO_LIBERADO', { lanc: id, just, faltas: bl.faltas.slice(0, 20) }); if (g.erro) return g;
    return Object.assign(g, { msg: 'Pagamento liberado pelo Administrador (registrado na auditoria e na conta).' });
  }
  function rotaBloqueios(conta, u) {
    if (!(papel(conta).le || gravaGrupo(conta, 'fin') || X.leModulo(conta, 'lanc'))) return erro('Sem acesso.');
    const X6 = ctx(), id = String(u.searchParams.get('lanc') || ''), out = {};
    const L = id ? X6.lanc.filter(l => l.id === id) : X6.lanc.filter(l => l.tipo === 'pagar' && !l.pago && l.status !== 'cancelado');
    for (const l of L) { const b = bloqueioLanc(l, X6); if (b.sob && (b.faltas.length || b.lib)) out[l.id] = { bloq: b.bloq, faltas: b.faltas, ref: b.alvo.ref, parc: parcNome(b.alvo.parcId), lib: b.lib ? { nome: b.lib.nome, em: b.lib.em, just: b.lib.just } : null }; }
    return { ok: true, bloq: out };
  }

  /* =================================================================== gravação comum (PUT) */
  function antes(conta, c0, id, velho, novo, req) {
    if (!novo) return null;
    if (SIS.has(c0)) return ROTA ? null : erro('Os registros de Terceiros e locações são gravados pelas telas do módulo (o servidor confere quem faz cada passo).', 409);
    if (c0 === 'lanc') {
      const v = velho || {}; if (v.lib166 !== undefined) novo.lib166 = v.lib166; else delete novo.lib166; /* a liberação só pela rota do Administrador */
      if (novo.pago && !v.pago && novo.tipo === 'pagar') { const b = bloqueioLanc(Object.assign({}, novo, { id })); if (b.bloq) { auditar(conta, req, 'TERC_PAGAMENTO_BLOQUEADO', 'lanc/' + id, null, { acao: 'baixa', faltas: b.faltas.slice(0, 20) }); return erro(msgBloq(b, 'pagamento (baixa)'), 409); } }
      return null;
    }
    if (c0 === 'rdo') return antesRdo(conta, velho, novo);
    return null;
  }
  /* diário: trabalhador terceiro não liberado não entra (só com a liberação do SST/Administrador, aptlib); equipamento locado só se retirado para a obra */
  function antesRdo(conta, velho, novo) {
    const X6 = ctx(), c6 = C.C6(X6), pid = String(novo.projId || ''), data = C.dataOk(novo.data) ? novo.data : hojeBr();
    const mudou = !velho || velho.data !== novo.data || String(velho.projId || '') !== pid;
    if (c6.bloqDiario) {
      const ja = new Set(); if (!mudou) (Array.isArray(velho.efetivo) ? velho.efetivo : []).forEach(x => { if (x && x.tercId) ja.add(String(x.tercId)); });
      const bloq = [], vis = new Set();
      for (const x of (Array.isArray(novo.efetivo) ? novo.efetivo : [])) {
        const tid = x && x.tercId ? String(x.tercId) : ''; if (!tid || vis.has(tid) || ja.has(tid)) continue; vis.add(tid);
        const t = X6.tterc.find(w => w.id === tid); if (!t) continue; /* fora do cadastro: vale a conferência antiga (resumo de aptidão) */ const st = C.trabStatus(X6, t, pid); if (st.lib) continue;
        const lib = col('aptlib').find(l => l && l.srv && !l.revogadaEm && String(l.tercId || '') === tid && (!l.projId || l.projId === pid) && String(l.de || '') <= data && data <= String(l.ate || ''));
        if (lib) continue;
        bloq.push((t ? t.nome : 'trabalhador ' + tid) + ' (' + st.motivos.slice(0, 4).join(', ') + ')');
      }
      if (bloq.length) return erro('Diário recusado pelo servidor: trabalhador terceiro não liberado para esta obra: ' + bloq.slice(0, 6).join('; ') + '. Regularize os documentos (Terceiros e locações) ou peça a liberação do SST ou do Administrador, com justificativa (CIPA e SST › Liberações de aptidão).', 409);
    }
    const vv = new Set(); if (!mudou) (Array.isArray(velho.equip) ? velho.equip : []).forEach(x => { if (x && x.leqId) vv.add(x.leqId + '|' + x.horas); });
    for (const x of (Array.isArray(novo.equip) ? novo.equip : [])) {
      if (!x || !x.leqId || vv.has(x.leqId + '|' + x.horas)) continue;
      const e = X6.leq.find(q2 => q2.id === String(x.leqId)); if (!e) return erro('Diário recusado: equipamento locado não encontrado.', 409);
      const naObra = e.projId === pid || (e.guardaHist || []).some(g => g && g.para && g.para.projId === pid && String(g.data || '') <= data);
      const ini = e.ret && e.ret.data, fim = e.st === 'devolvido' && e.dev ? e.dev.data : '9999-12-31';
      if (!naObra || e.st === 'aguardando' || !ini || data < ini || data > fim) return erro('Diário recusado: o equipamento locado ' + e.desc + ' não estava retirado para esta obra nesse dia.', 409);
      if (C.num(x.horas) < 0 || C.num(x.horas) > 24) return erro('Diário recusado: horas do equipamento entre 0 e 24.', 409);
    }
    return null;
  }
  function antesExcluir(conta, c0) { if (SIS.has(c0) && !ehDono(conta)) return erro('Os registros de Terceiros e locações não se excluem: ficam no histórico.', 409); return null; }

  /* =================================================================== avisos (a cada hora) */
  function lembretes() {
    const X6 = ctx(), c6 = C.C6(X6), av = Object.assign({}, doc('cfg/ter166av') || {}), hoje = X6.hoje; let n = 0;
    const marca = k => { if (av[k]) return false; av[k] = Date.now(); return true; };
    const parcs = C.uniq(X6.ter.filter(t => t.ativo !== false).map(t => t.parcId || t.id).concat(X6.ctremp.filter(x => x.status === 'vigente').map(x => x.parcId)).concat(X6.loc.filter(x => x.st !== 'encerrado').map(x => x.parcId)));
    for (const p of parcs) for (const d of C.empDocs(X6, p)) {
      if (!d.exig || !d.ap || !C.dataOk(d.validade)) continue;
      const dd = d.dias, lim = c6.avisoDias.find(x => dd <= x && dd >= 0 && (c6.avisoDias.filter(y => y < x).every(y => dd > y)));
      const k = dd < 0 ? 'venc|' + p + '|' + d.k + '|' + d.validade : lim != null ? 'av' + lim + '|' + p + '|' + d.k + '|' + d.validade : ''; if (!k || !marca(k)) continue;
      avisarChat(usrsDe(U_DOCS).concat(usrsDe(U_COMP)), parcNome(p) + ': ' + d.nome + (dd < 0 ? ' venceu em ' + C.br(d.validade) + ' (pagamentos do terceiro ficam bloqueados)' : dd === 0 ? ' vence hoje' : ' vence em ' + dd + ' dia(s) (' + C.br(d.validade) + ')') + '. Peça o documento novo pelo link do terceiro.'); n++;
    }
    for (const e of X6.leq) {
      const a = C.eqAlerta(X6, e); if (!a) continue; const k = 'loc|' + a.k + '|' + e.id + '|' + e.fim + (a.k === 'atraso' ? '|' + hoje : ''); if (!marca(k)) continue;
      avisarChat(usrsDe(U_COMP).concat([e.por, e.guarda && e.guarda.respUid]), e.desc + ' (' + parcNome(e.parcId) + ', ' + projNome(e.projId) + '): ' + a.txt); n++;
    }
    const ks = Object.keys(av); if (ks.length > 3000) ks.sort((a, b) => av[a] - av[b]).slice(0, ks.length - 3000).forEach(k => delete av[k]);
    av.id = 'ter166av'; const ts = Date.now(); q.docPut.run('cfg/ter166av', 'cfg', 'ter166av', JSON.stringify(av), ts);
    return n;
  }
  if (process.env.NODE_ENV !== 'test' || process.env.V166_LEMBRETES === '1') { const t = setInterval(() => { try { lembretes(); } catch (e) { console.error('[v166] lembretes:', e.message); } }, 3600e3); if (t.unref) t.unref(); }
  function rotaCfg(conta, req, b) {
    if (!admin(conta)) return erro('Só o Administrador altera as regras de Terceiros e locações.');
    const atual = cfgEmp(), n = C.cfgPad(b.ter166 || {}), novo = Object.assign({}, atual, { id: 'empresa', ter166: n });
    const ts = Date.now(); q.docPut.run('cfg/empresa', 'cfg', 'empresa', JSON.stringify(novo), ts); avisarDoc('set', 'cfg/empresa', novo, ts);
    auditar(conta, req, 'TERC_CFG_166', 'cfg/empresa', { ter166: atual.ter166 || null }, { ter166: n });
    return { ok: true, msg: 'Regras salvas.', docs: [{ col: 'cfg', id: 'empresa', data: novo }] };
  }

  /* =================================================================== rotas */
  const R = (res, r) => json(res, r.erro ? (r.st || 403) : 200, r.erro ? Object.assign({ code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : r.st === 429 ? 'rate_limited' : 'not_granted', erro: r.erro }, r.previsto !== undefined ? { previsto: r.previsto, valorNota: r.valorNota, dif: r.dif } : {}) : r);
  async function rota(p, m, req, res, conta) {
    if (!p.startsWith('/api/ter166/')) return false;
    const u = new URL(req.url, 'http://x'), b = m === 'POST' ? await lerJson(req).catch(() => ({})) : {};
    const P = (k, fn) => { if (p === '/api/ter166/' + k) { ROTA = true; let r; try { r = fn(); } finally { ROTA = false; } R(res, r); return true; } return false; };
    if (m === 'GET') {
      if (P('painel', () => papel(conta).le ? Object.assign({ ok: true, nomes: {} }, (() => { const X6 = ctx(), pn = C.painel(X6); const ns = {}; C.uniq([].concat(pn.docsVenc.map(x => x.parcId), pn.porObra.flatMap(o => o.eqs.map(e => e.parcId)), pn.naoLib.map(x => x.parcId), pn.obrPend.map(x => x.parcId), pn.bloq.map(x => x.parcId), pn.devAtr.map(x => x.parcId), pn.devPrev.map(x => x.parcId))).forEach(id => { ns[id] = parcNome(id); }); const ps = {}; C.uniq([].concat(pn.porObra.map(o => o.projId), pn.naoLib.map(x => x.projId), pn.devAtr.map(x => x.projId), pn.devPrev.map(x => x.projId), pn.obrPend.map(x => x.projId))).forEach(id => { ps[id] = projNome(id); }); return Object.assign(pn, { parcs: ns, projs: ps }); })()) : erro('Sem acesso a Terceiros e locações.'))) return true;
      if (P('emp', () => { if (!papel(conta).le) return erro('Sem acesso a Terceiros e locações.'); const id = String(u.searchParams.get('parcId') || ''); if (!doc('parc/' + id)) return erro('Fornecedor não encontrado.', 404); return Object.assign({ ok: true }, modeloEmp(ctx(), id, papel(conta).docs)); })) return true;
      if (P('trabs', () => { if (!papel(conta).le && !gravaGrupo(conta, 'proj')) return erro('Sem acesso.'); const X6 = ctx(), pid = String(u.searchParams.get('projId') || ''); const pc = String(u.searchParams.get('parcId') || ''); return { ok: true, trabs: X6.tterc.filter(t => t.ativo !== false && (!pc || t.parcId === pc) && (!pid || !t.projId || t.projId === pid)).map(t => { const st = C.trabStatus(X6, t, pid); return { id: t.id, nome: t.nome, cpf: C.mascCpf(t.cpf), funcao: t.funcao || '', parcId: t.parcId, parc: parcNome(t.parcId), lib: st.lib, motivos: st.motivos }; }) }; })) return true;
      if (P('links', () => rotaLinks(conta, u))) return true;
      if (P('lista', () => papel(conta).le ? lista(ctx()) : erro('Sem acesso a Terceiros e locações.'))) return true;
      if (P('bloqueios', () => rotaBloqueios(conta, u))) return true;
      if (P('previsto', () => rotaPrevisto(conta, u))) return true;
    }
    if (m === 'POST') {
      if (P('emp', () => rotaEmp(conta, req, b))) return true;
      if (P('doc', () => rotaDocNovo(conta, req, b))) return true;
      if (P('doc/decidir', () => rotaDecidir(conta, req, b))) return true;
      if (P('link', () => rotaLink(conta, req, b))) return true;
      if (P('link/revogar', () => rotaRevogar(conta, req, b))) return true;
      if (P('loc', () => rotaLoc(conta, req, b))) return true;
      if (P('eq', () => rotaEq(conta, req, b))) return true;
      if (P('eq/retirada', () => rotaRetirada(conta, req, b))) return true;
      if (P('eq/guarda', () => rotaGuarda(conta, req, b))) return true;
      if (P('eq/devolucao', () => rotaDevolucao(conta, req, b))) return true;
      if (P('nota', () => rotaNota(conta, req, b))) return true;
      if (P('liberar', () => rotaLiberar(conta, req, b))) return true;
      if (P('cfg', () => rotaCfg(conta, req, b))) return true;
      if (P('lembretes', () => admin(conta) ? { ok: true, n: lembretes() } : erro('Só o Administrador.'))) return true;
    }
    json(res, 404, { code: 'not_found', erro: 'Rota não encontrada.' }); return true;
  }
  return { COLS, antes, antesExcluir, rota, publica, trava, travaTxt, lembretes, bloqueioLanc, ctx };
};

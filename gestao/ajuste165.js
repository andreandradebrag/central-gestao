'use strict';
/* v165 (relatorios/feito_v165.md): frota — reserva com aprovação, saída e retorno em telas separadas, cidade/base e responsável
   da frota por cidade, autorização do condutor, relatório da Sem Parar (rede CTF), recibo lido pela IA, conferências,
   correção do hodômetro, custo por obra e fatura do mês. Ligado em regras.js e server.js por v165/ed_v165.py.
   As regras e as contas estão em frota165.js (o MESMO arquivo vai embutido no navegador).
   Coleções novas: vres165 (reservas), vaut165 (autorização do condutor; id = colaborador), vav165 (avarias), vimp165 (lotes
   importados), vfat165 (fatura do mês). Campos novos em veic (cidade, tipoAut, combustivel, tanque), vsai (v165, resId,
   comb165, ck165, fotos165, retPrev165, combRet165, ckR165, fotosR165, atraso165) e vabas (imp165, rec165, st165,
   alertas165, itens165, hodCorr165, hodHist165, fat165).
   Rotas: /api/frota165/* (a lista está em rota()). A gravação comum (PUT) dessas coleções é recusada: só pelas rotas.
   Escopo por cidade (aprovar e alterar): o responsável da cidade só gere os veículos da cidade dele; Administrador e
   Administrador de frota, todos. */
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const C = require('./frota165.js');
module.exports = function (X) {
  const { q, db, col, erro, ehDono, perfilEm, cfgEmp, lerJson, json, avisarDoc } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const doc = p => { const d = X.doc(p); if (d && typeof d === 'object' && !d.id) d.id = String(p).split('/').pop(); return d; };
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const agoraBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 16);
  const uniq = a => [...new Set(a.filter(Boolean))];
  const novoId = p => p + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const admin = conta => ehDono(conta) || perfilEm(conta, ['admin']);
  const nomeConta = id => { try { return X.nomeConta(id); } catch (e) { return id || ''; } };
  const cfg = () => C.cfgPad((cfgEmp() || {}).frota165);
  const SIS = new Set(['vres165', 'vaut165', 'vav165', 'vimp165', 'vfat165']);
  /* contexto do núcleo (frota165.js), lido do banco a cada pedido */
  function ctx(extra) {
    const ag = agoraBr();
    return Object.assign({ veic: col('veic'), vsai: col('vsai'), vres: col('vres165'), vaut: col('vaut165'), vav: col('vav165'), vabas: col('vabas'), vman: col('vman'), func: col('func'), afast: col('afast'), cfg: cfg(), mig: doc('cfg/frota165mig'), hoje: ag.slice(0, 10), agora: ag }, extra || {});
  }
  function quemDe(conta, todas, Xc) {
    const fs_ = (Xc ? Xc.func : col('func')).filter(f => f.usrId === conta.id && f.status !== 'desligado');
    const ft = admin(conta) || perfilEm(conta, ['frotaadm']);
    return { uid: conta.id, funcId: fs_[0] ? fs_[0].id : '', admin: admin(conta), frotaTodos: ft, frotaW: admin(conta) || X.gravaCol(conta, 'vsai'), todas: !!todas, nome: nomeConta(conta.id) };
  }
  const usrDoFunc = (Xc, funcId) => { const f = (Xc.func || []).find(x => x.id === funcId); return f && f.usrId ? f.usrId : ''; };
  /* aviso pela conversa "Central de Gestão" (o mesmo formato da v164; o sino do chat e a notificação do navegador) */
  function avisarChat(uids, texto) {
    const ag = Date.now(); let n = 0;
    for (const u of uniq(uids).filter(x => ID_OK.test(x) && x !== 'sistema')) {
      try {
        const cid = 'av_' + u, cp = 'cm/sistema/c/' + cid;
        if (!q.docGet.get(cp)) { const cv = { id: cid, tipo: 'dm', membros: [u], ts: ag, sistema: true }; q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(cv), ag); avisarDoc('set', cp, cv, ag); }
        const mid = 'm' + ag.toString(36) + crypto.randomBytes(4).toString('hex'), mp = 'cm/sistema/m/' + mid;
        const msg = { id: mid, k: 'msg', conv: 'sistema/' + cid, txt: '🚗 ' + texto, ts: ag, men: [], sistema: true, v165: 1 };
        q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(msg), ag); avisarDoc('set', mp, msg, ag); n++;
      } catch (e) { console.error('[v165] chat:', e.message); }
    }
    return n;
  }
  function gravaSis(p, data) { const s = p.split('/'), ts = Date.now(); q.docPut.run(p, s.slice(0, -1).join('/'), s[s.length - 1], JSON.stringify(data), ts); avisarDoc('set', p, data, ts); return ts; }
  /* grava numa transação: coleções da v165 e a saída (vsai) direto (as regras estão no núcleo e já foram conferidas);
     abastecimento, manutenção e conta a pagar passam pelas regras de sempre (antesGravar) */
  let ROTA = false;
  function gravar(conta, req, docs, metodoAud, resumo) {
    const prep = []; ROTA = true;
    try {
      for (const x of docs) {
        const p = x.c + '/' + x.d.id; if (!ID_OK.test(String(x.d.id))) return erro('Identificador inválido.', 400);
        const velho = doc(p), data = Object.assign({}, x.d);
        if (SIS.has(x.c) || x.c === 'vsai') { prep.push({ p, velho, data }); continue; }
        if (velho && x.c === 'vabas') data.corrMotivo = data.corrMotivo || 'Frota (v165): ' + metodoAud.toLowerCase().replace(/_/g, ' ');
        const v = X.antesGravar(conta, p, velho, data, req);
        if (v && v.reauth) return erro('Confirme a senha e tente de novo.', 409);
        if (v && v.erro) return erro(v.erro, v.st);
        prep.push({ p, velho, data: (v && v.data) || data, v });
      }
    } finally { ROTA = false; }
    const ts = Date.now();
    db.exec('BEGIN');
    try { for (const o of prep) { const s = o.p.split('/'); q.docPut.run(o.p, s[0], s[1], JSON.stringify(o.data), ts); } db.exec('COMMIT'); }
    catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } return erro('Falha ao gravar. Nada foi gravado; tente de novo.', 500); }
    for (const o of prep) { avisarDoc('set', o.p, o.data, ts); try { X.depois(conta, req, 'PUT', o.p, o.velho || null, o.data, o.v || { data: o.data }); } catch (e) { } }
    auditar(conta, req, metodoAud, prep[0] ? prep[0].p : '', null, resumo || null);
    return { ok: true, docs: prep.map(o => { const s = o.p.split('/'); return { col: s[0], id: s[1], data: o.data }; }) };
  }
  const vNome = (Xc, id) => { const v = (Xc.veic || []).find(x => x.id === id); return v ? v.placa + (v.modelo ? ' · ' + v.modelo : '') : '—'; };
  const fNome = (Xc, id) => { const f = (Xc.func || []).find(x => x.id === id); return f ? String(f.nome || '') : '—'; };
  const pNome = id => { const p = id ? doc('proj/' + String(id)) : null; return p ? [p.codigo, p.nome].filter(Boolean).join(' · ') : ''; };

  /* =================================================================== migração (uma vez) */
  function migrar() {
    if (doc('cfg/frota165mig')) return null;
    const Xc = ctx(), ini = C.maisDias(Xc.hoje, -90), vaut = new Set(Xc.vaut.map(a => a.funcId || a.id)); let n = 0, total = 0;
    for (const f of Xc.func) {
      if (f.status === 'desligado' || !C.temCnh(f) || vaut.has(f.id)) continue; total++;
      if (!Xc.vsai.some(x => x.funcId === f.id && String(x.saidaEm || '') >= ini)) continue;
      const tipos = C.tiposMig(Xc.cfg, f.cnhCat);
      gravaSis('vaut165/' + f.id, { id: f.id, funcId: f.id, st: 'ativa', migracao: true, validade: C.maisDias(Xc.hoje, 30), tipos: tipos.length ? tipos : ['leve'], autPor: 'migracao', autEm: Xc.agora, cursos: {}, hist: [{ em: Xc.agora, por: 'sistema', o: 'Autorizado (migração): saída nos últimos 90 dias' }] }); n++;
    }
    const m = { id: 'frota165mig', em: Xc.agora, migrados: n, condutores: total };
    gravaSis('cfg/frota165mig', m);
    auditar({ id: 'sistema', nivel: 'owner' }, null, 'FROTA_MIGRACAO_165', 'cfg/frota165mig', null, m);
    return m;
  }
  try { migrar(); } catch (e) { console.error('[v165] migração:', e.message); }

  /* =================================================================== rotas */
  const R = (res, r) => json(res, r.erro ? (r.st || 403) : 200, r.erro ? { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : 'not_granted', erro: r.erro } : r);
  const E = (r, st) => r && r.erro ? Object.assign({}, r, { st: st || r.st || 409 }) : r;
  function rotaMeu(conta, u) {
    const Xc = ctx(), quem = quemDe(conta, u.searchParams.get('todas') === '1', Xc), m = C.modelo(Xc, quem);
    m.projs = col('proj').filter(p => !['concluido', 'concluida', 'encerrado', 'encerrada', 'cancelado'].includes(String(p.status || ''))).map(p => ({ id: p.id, nome: [p.codigo, p.nome].filter(Boolean).join(' · ') })).slice(0, 500);
    m.nomes = {}; uniq([].concat(m.resGerir.map(r => r.funcId), m.saiGerir.map(x => x.funcId))).forEach(id => { m.nomes[id] = fNome(Xc, id); });
    m.usrNomes = {}; Object.values(m.cfg.resp || {}).forEach(r => [r.uid, r.sub].filter(Boolean).forEach(id => { m.usrNomes[id] = nomeConta(id); }));
    return Object.assign({ ok: true }, m);
  }
  function rotaReserva(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc), r = C.reservar(Xc, quem, b, novoId('rs'));
    if (r.erro) return E(r, 409);
    const g = gravar(conta, req, r.docs, 'FROTA_RESERVA', { veic: r.res.veicId || 'qualquer', cidade: r.res.cidade, ini: r.res.ini, fim: r.res.fim }); if (g.erro) return g;
    avisarChat(r.avisar.filter(x => x !== conta.id), 'Reserva de veículo para aprovar: ' + fNome(Xc, r.res.funcId) + ', ' + (r.res.veicId ? vNome(Xc, r.res.veicId) : 'qualquer veículo disponível em ' + r.res.cidade) + ', de ' + C.brDt(r.res.ini) + ' a ' + C.brDt(r.res.fim) + ' (' + r.res.destino + '). Aprove em Frota › Reservas.');
    return Object.assign(g, { msg: 'Reserva enviada para aprovação do responsável pela frota de ' + r.res.cidade + '.', res: r.res });
  }
  function rotaDecidir(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, true, Xc), id = String(b.id || ''), rs = ID_OK.test(id) ? Xc.vres.find(x => x.id === id) : null;
    const r = C.decidir(Xc, quem, rs, b); if (r.erro) { if (rs && /responsável/.test(r.erro)) auditar(conta, req, 'FROTA_RESERVA_NEGADA', 'vres165/' + id, null, { cidade: rs.cidade }); return E(r, /responsável/.test(r.erro) ? 403 : 409); }
    const g = gravar(conta, req, r.docs, r.res.st === 'aprovada' ? 'FROTA_RESERVA_APROVADA' : 'FROTA_RESERVA_RECUSADA', { veic: r.res.veicId, motivo: r.res.motRec || '' }); if (g.erro) return g;
    const u = r.res.uid || usrDoFunc(Xc, r.res.funcId);
    if (u && u !== conta.id) avisarChat([u], r.res.st === 'aprovada' ? 'Sua reserva foi aprovada: ' + vNome(Xc, r.res.veicId) + ' de ' + C.brDt(r.res.ini) + ' a ' + C.brDt(r.res.fim) + (r.res.trocou ? ' (o responsável trocou o veículo)' : '') + '. Na hora, registre a saída em Frota › Saída do veículo.' : 'Sua reserva de ' + C.brDt(r.res.ini) + ' foi recusada: ' + r.res.motRec);
    return Object.assign(g, { msg: r.res.st === 'aprovada' ? 'Reserva aprovada.' : 'Reserva recusada.' });
  }
  function rotaCancelar(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, true, Xc), rs = Xc.vres.find(x => x.id === String(b.id || ''));
    if (!rs) return erro('Reserva não encontrada.', 404);
    if (!['pendente', 'aprovada'].includes(rs.st)) return erro('Esta reserva não pode mais ser cancelada.', 409);
    if (!(rs.funcId === quem.funcId || C.podeAprovar(Xc.cfg, quem, rs.cidade))) return erro('Só quem pediu ou o responsável pela frota da cidade cancela a reserva.');
    return gravar(conta, req, [{ c: 'vres165', d: Object.assign({}, rs, { st: 'cancelada', canPor: conta.id, canEm: Xc.agora }) }], 'FROTA_RESERVA_CANCELADA', null);
  }
  function rotaSaida(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc), r = C.saida(Xc, quem, b, novoId('sv'), true);
    if (r.erro) { if (/bloqueada/.test(r.erro)) auditar(conta, req, 'FROTA_SAIDA_BLOQUEADA', 'vsai/', null, { veic: b.resId ? '' : b.veicId, motivo: r.erro.slice(0, 200) }); return E(r, 409); }
    const g = gravar(conta, req, r.docs, 'FROTA_SAIDA', { veic: r.saida.veicId, km: r.saida.kmSaida, avarias: r.docs.filter(d => d.c === 'vav165').length }); if (g.erro) return g;
    if (r.avisar.length) avisarChat(r.avisar.filter(x => x !== conta.id), 'Avaria registrada antes da saída de ' + vNome(Xc, r.saida.veicId) + ' por ' + fNome(Xc, r.saida.funcId) + ' (fica para o uso anterior). Veja em Frota › Painel da frota da cidade.');
    return Object.assign(g, { msg: 'Saída registrada: ' + vNome(Xc, r.saida.veicId) + ' em uso por ' + fNome(Xc, r.saida.funcId) + '.', saida: r.saida });
  }
  function rotaRetorno(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc), id = String(b.vsaiId || ''), sd = ID_OK.test(id) ? Xc.vsai.find(x => x.id === id) : null;
    const r = C.retorno(Xc, quem, sd, b, true); if (r.erro) { if (/Só o condutor/.test(r.erro)) auditar(conta, req, 'FROTA_RETORNO_NEGADO', 'vsai/' + id, null, null); return E(r, /Só o condutor/.test(r.erro) ? 403 : 409); }
    const g = gravar(conta, req, r.docs, 'FROTA_RETORNO', { veic: sd.veicId, km: r.saida.kmRetorno, rodados: r.saida.kmRetorno - (+sd.kmSaida || 0), comb: r.saida.combRet165, atraso: r.atraso, avarias: r.avarias.length }); if (g.erro) return g;
    const resp = r.avisar.filter(x => x !== conta.id), vn = vNome(Xc, sd.veicId);
    if (r.baixo) avisarChat(resp, 'Combustível baixo: ' + vn + ' voltou com ' + C.combNome(r.saida.combRet165) + ' do tanque (' + fNome(Xc, sd.funcId) + '). Abasteça antes da próxima saída.');
    if (r.avarias.length) avisarChat(resp, 'Avaria nova em ' + vn + ' no retorno de ' + fNome(Xc, sd.funcId) + ': ' + r.avarias.map(a => a.desc + (a.grave ? ' (grave)' : '')).join('; ') + '. Abra a manutenção em Frota › Painel da frota da cidade (um toque).');
    if (r.atraso > 15) avisarChat(resp, 'Retorno atrasado: ' + vn + ' voltou ' + Math.round(r.atraso / 60 * 10) / 10 + ' h depois do previsto (' + fNome(Xc, sd.funcId) + ').');
    return Object.assign(g, { msg: 'Retorno registrado: ' + (r.saida.kmRetorno - (+sd.kmSaida || 0)) + ' km rodados.' + (r.baixo ? ' Combustível baixo: o responsável pela frota foi avisado.' : ''), saida: r.saida, baixo: r.baixo });
  }
  function podeGerirVeic(Xc, quem, vid) { const v = Xc.veic.find(x => x.id === vid); return !!v && C.podeAprovar(Xc.cfg, quem, C.cidadeDe(v)); }
  function rotaManut(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, true, Xc), av = Xc.vav.find(x => x.id === String(b.avId || ''));
    if (!av) return erro('Avaria não encontrada.', 404);
    if (!podeGerirVeic(Xc, quem, av.veicId)) return erro('Só o responsável pela frota da cidade do veículo (ou o Administrador) abre a manutenção.');
    if (av.vmanId && doc('vman/' + av.vmanId)) return erro('Esta avaria já tem manutenção aberta.', 409);
    const mid = novoId('vm'), sd = Xc.vsai.find(x => x.id === av.vsaiId);
    const m = { id: mid, veicId: av.veicId, data: Xc.hoje, km: sd ? (+sd.kmRetorno || +sd.kmSaida || '') : '', tipo: 'Correção de defeito', status: 'agendada', desc: 'Avaria' + (av.grave ? ' grave' : '') + ': ' + av.desc + (sd ? ' (saída de ' + C.br(sd.saidaEm) + ', ' + fNome(Xc, sd.funcId) + ')' : ''), parcId: '', proxKm: '', proxData: '', obs: 'Aberta pela avaria (v165). O custo entra pela nota (v163).', vsaiId: av.vsaiId || '', origem: 'avaria165', av165: av.id };
    return gravar(conta, req, [{ c: 'vman', d: m }, { c: 'vav165', d: Object.assign({}, av, { vmanId: mid, st: 'manutencao' }) }], 'FROTA_AVARIA_MANUTENCAO', { avaria: av.id });
  }
  function rotaAvResolver(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, true, Xc), av = Xc.vav.find(x => x.id === String(b.avId || ''));
    if (!av) return erro('Avaria não encontrada.', 404);
    if (!podeGerirVeic(Xc, quem, av.veicId)) return erro('Só o responsável pela frota da cidade do veículo (ou o Administrador) resolve a avaria.');
    if (String(b.como || '').trim().length < 3) return erro('Diga como foi resolvida.', 400);
    return gravar(conta, req, [{ c: 'vav165', d: Object.assign({}, av, { st: 'resolvida', como: String(b.como).trim().slice(0, 300), okPor: conta.id, okEm: Xc.agora }) }], 'FROTA_AVARIA_RESOLVIDA', null);
  }
  function rotaAutorizar(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, true, Xc), f = Xc.func.find(x => x.id === String(b.funcId || ''));
    if (!f) return erro('Colaborador não encontrado.', 404);
    const cid = String(b.cidade || '');
    if (!(quem.admin || quem.frotaTodos || (cid && C.cidadesDe(Xc.cfg, quem.uid).includes(cid)))) return erro('Só o Administrador, o Administrador de frota ou o responsável pela frota da cidade (com a autorização restrita à cidade dele) autoriza condutores.');
    const ant = Xc.vaut.find(a => a.funcId === f.id || a.id === f.id);
    const a = { id: f.id, funcId: f.id, st: 'ativa', migracao: false, validade: String(b.validade || C.maisDias(Xc.hoje, 30 * (+Xc.cfg.autMeses || 12))).slice(0, 10), tipos: (Array.isArray(b.tipos) ? b.tipos : []).map(String).slice(0, 6),
      veics: (Array.isArray(b.veics) ? b.veics : []).map(String).filter(id => Xc.veic.some(v => v.id === id)).slice(0, 50), cidade: Xc.cfg.cidades.includes(cid) ? cid : '', dirigeFuncao: !!b.dirigeFuncao, ear: !!b.ear,
      toxVal: C.dataOk(b.toxVal) ? b.toxVal : '', cursos: {}, termo: b.termo && b.termo.id ? { id: String(b.termo.id).slice(0, 80), nome: String(b.termo.nome || 'termo.pdf').slice(0, 120), em: Xc.agora } : (ant && ant.termo) || null,
      autPor: conta.id, autPorNome: nomeConta(conta.id), autEm: Xc.agora, hist: ((ant && ant.hist) || []).concat([{ em: Xc.agora, por: conta.id, o: ant ? 'Autorização renovada/alterada' : 'Autorizado' }]).slice(-40) };
    Object.keys(C.CURSOS).forEach(k => { const d = b.cursos && b.cursos[k]; if (C.dataOk(d)) a.cursos[k] = d; });
    const e = C.autValida(Xc, f, a); if (e) return erro(e, 400);
    if (!a.termo) return erro('Anexe o termo de responsabilidade do condutor assinado (PDF).', 400);
    return gravar(conta, req, [{ c: 'vaut165', d: a }], 'FROTA_CONDUTOR_AUTORIZADO', { funcId: f.id, tipos: a.tipos, validade: a.validade, cidade: a.cidade });
  }
  function rotaRevogar(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, true, Xc), a = Xc.vaut.find(x => x.funcId === String(b.funcId || '') || x.id === String(b.funcId || ''));
    if (!a) return erro('Autorização não encontrada.', 404);
    if (!(quem.admin || quem.frotaTodos || (a.cidade && C.cidadesDe(Xc.cfg, quem.uid).includes(a.cidade)))) return erro('Só o Administrador, o Administrador de frota ou o responsável pela frota da cidade revoga.');
    if (String(b.motivo || '').trim().length < 3) return erro('Informe o motivo.', 400);
    return gravar(conta, req, [{ c: 'vaut165', d: Object.assign({}, a, { st: 'revogada', motivo: String(b.motivo).trim().slice(0, 200), revPor: conta.id, revEm: Xc.agora, hist: (a.hist || []).concat([{ em: Xc.agora, por: conta.id, o: 'Revogada: ' + String(b.motivo).trim().slice(0, 200) }]).slice(-40) }) }], 'FROTA_CONDUTOR_REVOGADO', { funcId: a.funcId });
  }
  const podeImportar = (Xc, quem) => quem.admin || quem.frotaTodos || C.cidadesDe(Xc.cfg, quem.uid).length > 0;
  /* importarAbastecimentos(linhas, origem): a fronteira para uma futura API ou entrega automática da Sem Parar/CTF */
  function importarAbastecimentos(conta, req, linhas, origem, opc) {
    opc = opc || {};
    const Xc = ctx(), quem = quemDe(conta, false, Xc);
    if (!podeImportar(Xc, quem)) return erro('Importam o relatório: o Administrador, o Administrador de frota e o responsável pela frota da cidade (só os veículos da cidade dele).');
    const ls = (Array.isArray(linhas) ? linhas : []).slice(0, 5000).filter(l => l && typeof l === 'object').map(l => Object.assign({}, l, { aut: C.digitos(l.aut), autCupom: C.digitos(l.autCupom), placa: C.placaN(l.placa), cpf: C.digitos(l.cpf), data: C.dataOk(l.data) ? l.data : '' })).filter(l => l.aut && l.data);
    if (!ls.length) return erro('Nenhuma linha válida no relatório.', 400);
    const lote = novoId('ld'), r = C.importar(Xc, quem, ls, origem || 'arquivo', { lote });
    const prev = r.prev.map(p => Object.assign({}, p));
    if (!opc.confirmar) return { ok: true, prev, resumo: r.resumo };
    if (!r.docs.length) return erro('Nada a gravar: todas as linhas estão fora da sua cidade ou sem veículo cadastrado.', 409);
    const lt = { id: lote, em: Xc.agora, por: conta.id, origem: String(origem || 'arquivo').slice(0, 40), arquivo: String(opc.arquivo || '').slice(0, 120), resumo: r.resumo, ids: r.docs.map(d => d.d.id).slice(0, 5000) };
    const g = gravar(conta, req, r.docs.concat([{ c: 'vimp165', d: lt }]), 'FROTA_IMPORTA_SEMPARAR', r.resumo); if (g.erro) return g;
    const porCid = new Map(); prev.filter(p => p.alertas.length && p.st !== 'fora').forEach(p => porCid.set(p.cidade, (porCid.get(p.cidade) || 0) + 1));
    porCid.forEach((n, cid) => avisarChat(C.respDe(Xc.cfg, cid).filter(x => x !== conta.id), 'Relatório da Sem Parar importado: ' + n + ' abastecimento(s) de ' + (cid || 'sem cidade') + ' com alerta. Veja em Frota › Painel da frota da cidade.'));
    return { ok: true, prev, resumo: r.resumo, lote, docs: g.docs };
  }
  /* recibo (cupom do POS da CTF) lido pela IA */
  const PROMPT = 'A imagem (ou o PDF) é um cupom de abastecimento impresso pela maquininha (POS) da rede CTF, pago com cartão de frota. Leia o cupom e extraia os dados.\n\n' +
    'Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois e sem markdown, exatamente neste formato:\n' +
    '{"placa":"ABC1D23","km":0,"comb":"tipo do combustível como escrito","volume":0,"valor":0,"aut":"número depois de AUT:","nsu":"número depois de NSU:","cnpj_posto":"CNPJ do posto","data":"AAAA-MM-DD","hora":"HH:MM","posto":"nome do posto","duvidas":["o que não ficou claro"]}\n\n' +
    'Regras: números em JSON com ponto decimal (51.7), sem separador de milhar nem "R$". "volume" é o VOLUME em litros e "valor" o VALOR em reais. "km" é o número depois de KM: (sem zeros à esquerda). ' +
    'A data do cupom vem como dd/mm/aa: converta para AAAA-MM-DD (20aa). Não invente: o que não estiver legível fica null e vai para "duvidas". Não copie CPF, nome do motorista nem o número do cartão.';
  async function rotaRecibo(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc), arqId = String(b.arqId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const sd = b.vsaiId ? Xc.vsai.find(x => x.id === String(b.vsaiId)) : null;
    if (!(C.gestor(Xc, quem) || (sd && sd.funcId && sd.funcId === quem.funcId))) return erro('A foto do recibo é do condutor, na própria saída (ou do responsável pela frota).');
    const a = arqId ? q.arqGet.get(arqId) : null;
    if (!a || (a.por !== conta.id && conta.nivel !== 'owner')) return erro('Arquivo não encontrado. Tire a foto de novo.', 404);
    if ((+a.tam || 0) > 10 * 1024 * 1024) return erro('A foto passa de 10 MB.', 413);
    let buf; try { buf = fs.readFileSync(path.join(X.DATA, 'blobs', arqId)); } catch (e) { return erro('Arquivo não encontrado.', 404); }
    const mt = buf.slice(0, 4).toString('latin1') === '%PDF' ? 'application/pdf' : buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf.slice(1, 4).toString('latin1') === 'PNG' ? 'image/png' : buf.slice(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : '';
    if (!mt) return erro('Envie a foto do cupom (JPG, PNG, WebP) ou um PDF.', 400);
    const auditCorpo = { input: PROMPT, modelTier: 'complex', funcao: 'recibo-abastecimento' };
    if (typeof X.ia !== 'function') return erro('A IA não está configurada no servidor.', 503);
    let r;
    try { r = mt === 'application/pdf' ? await X.ia({ input: PROMPT }, { docs: [buf.toString('base64')], tier: 'complex' }) : await X.ia({ input: PROMPT, images: [{ type: mt, data: buf.toString('base64') }] }, { tier: 'complex' }); }
    catch (e) { try { X.auditarIa(conta, req, auditCorpo, false, e.msg || e.message); } catch (z) { } auditar(conta, req, 'FROTA_RECIBO_IA', 'arq/' + arqId, null, { ok: false });
      return erro(e.st === 503 ? 'A IA não está configurada no servidor. Digite os dados do cupom.' : e.st === 429 ? 'A IA está com muitos pedidos agora. Tente de novo em alguns minutos ou digite os dados.' : (e.msg || 'Falha na IA. Digite os dados do cupom.'), e.st || 502); }
    let j = null; const t = String((r && r.text) || ''); try { j = JSON.parse(t); } catch (e) { const i = t.indexOf('{'), k = t.lastIndexOf('}'); if (i >= 0 && k > i) try { j = JSON.parse(t.slice(i, k + 1)); } catch (z) { } }
    if (!j || typeof j !== 'object') { try { X.auditarIa(conta, req, auditCorpo, false, 'resposta fora do formato'); } catch (z) { } auditar(conta, req, 'FROTA_RECIBO_IA', 'arq/' + arqId, null, { ok: false }); return erro('A IA não leu o cupom. Digite os dados.', 502); }
    const dd = String(j.data || ''), m = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(dd);
    const dados = { placa: C.placaN(j.placa), km: C.num(j.km), comb: String(j.comb || '').slice(0, 40), litros: C.num(j.volume ?? j.litros), valor: C.num(j.valor), aut: C.digitos(j.aut).slice(0, 20), nsu: C.digitos(j.nsu).slice(0, 20), cnpj: C.digitos(j.cnpj_posto ?? j.cnpj).slice(0, 14),
      data: C.dataOk(dd) ? dd : m ? (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[2] + '-' + m[1] : '', hora: /^\d{2}:\d{2}/.test(String(j.hora || '')) ? String(j.hora).slice(0, 5) : '', posto: String(j.posto || '').slice(0, 120), duvidas: (Array.isArray(j.duvidas) ? j.duvidas : []).map(x => String(x).slice(0, 200)).slice(0, 10), ia: true };
    try { X.auditarIa(conta, req, auditCorpo, true); } catch (z) { } auditar(conta, req, 'FROTA_RECIBO_IA', 'arq/' + arqId, null, { ok: true, placa: dados.placa, aut: dados.aut });
    return { ok: true, dados };
  }
  function rotaReciboSalvar(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc), sd = b.vsaiId ? Xc.vsai.find(x => x.id === String(b.vsaiId)) : null;
    const vid = sd ? sd.veicId : String(b.veicId || ''), v = Xc.veic.find(x => x.id === vid);
    if (!v) return erro('Escolha o veículo.', 400);
    if (!(podeGerirVeic(Xc, quem, vid) || quem.frotaW || (sd && sd.funcId && sd.funcId === quem.funcId))) return erro('O recibo é registrado pelo condutor, na própria saída (ou pelo responsável pela frota).');
    const d = b.dados || {}; if (!(C.num(d.litros ?? d.volume) > 0) || !(C.num(d.valor) > 0)) return erro('Informe litros e valor do cupom.', 400);
    if (!(b.foto && b.foto.id)) return erro('Tire a foto do cupom.', 400);
    const a = C.reciboDoc(Xc, quem, { veicId: vid, vsaiId: sd ? sd.id : '', funcId: sd ? sd.funcId : quem.funcId, projId: sd ? sd.projId : '', cidade: C.cidadeDe(v), dados: d, foto: b.foto }, novoId('rc'));
    const g = gravar(conta, req, [{ c: 'vabas', d: a }], 'FROTA_RECIBO', { veic: vid, aut: a.rec165.aut }); if (g.erro) return g;
    return Object.assign(g, { msg: 'Abastecimento provisório registrado (aguardando o relatório da Sem Parar).' });
  }
  function rotaHod(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc), a = Xc.vabas.find(x => x.id === String(b.id || ''));
    const r = C.corrigirHod(Xc, quem, a, b.km, b.motivo); if (r.erro) return E(r, /Só o/.test(r.erro) ? 403 : 400);
    return gravar(conta, req, r.docs, 'FROTA_HODOMETRO_CORRIGIDO', { abas: a.id, de: C.kmAbas(a), para: r.abas.km, motivo: r.abas.hodCorr165.motivo });
  }
  const podeFatura = (Xc, quem, conta) => quem.admin || quem.frotaTodos || X.gravaCol(conta, 'lanc') || C.cidadesDe(Xc.cfg, quem.uid).length > 0;
  function rotaFaturaVer(conta, u) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc);
    if (!podeFatura(Xc, quem, conta)) return erro('Seu perfil não vê a fatura da Sem Parar.');
    const mes = /^\d{4}-\d{2}$/.test(String(u.searchParams.get('mes') || '')) ? u.searchParams.get('mes') : Xc.hoje.slice(0, 7);
    const esc = quem.admin || quem.frotaTodos || X.gravaCol(conta, 'lanc') ? null : C.escopo(Xc.cfg, quem, false);
    const f = C.fatura(Xc, mes, esc), fat = doc('vfat165/fat_' + mes);
    f.porObra = f.porObra.map(o => Object.assign(o, { nome: o.projId ? pNome(o.projId) : 'Frota (sem obra)' })); f.porVeic = f.porVeic.map(o => Object.assign(o, { nome: vNome(Xc, o.veicId) }));
    return { ok: true, fat: f, lancada: fat || null, podeLancar: !!(quem.admin || X.gravaCol(conta, 'lanc')) };
  }
  function rotaFatura(conta, req, b) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc);
    if (!(quem.admin || X.gravaCol(conta, 'lanc'))) return erro('Quem lança a fatura no contas a pagar é o Financeiro (ou o Administrador).');
    const mes = String(b.mes || ''); if (!/^\d{4}-\d{2}$/.test(mes)) return erro('Informe o mês.', 400);
    const ex = doc('vfat165/fat_' + mes); if (ex && ex.lancId && doc('lanc/' + ex.lancId)) return erro('A fatura de ' + mes.slice(5) + '/' + mes.slice(0, 4) + ' já foi lançada.', 409);
    const f = C.fatura(Xc, mes, null), valor = Math.round((C.num(b.valor) || 0) * 100) / 100;
    if (!(valor > 0)) return erro('Informe o valor da fatura da Sem Parar.', 400);
    if (!f.n) return erro('Nenhum abastecimento importado neste mês. Importe o relatório antes.', 409);
    const dif = Math.round((valor - f.total) * 100) / 100;
    if (Math.abs(dif) > 0.05 && String(b.motivoDif || '').trim().length < 3) return erro('A fatura (' + valor.toFixed(2) + ') difere do importado (' + f.total.toFixed(2) + ') em ' + dif.toFixed(2) + '. Confira ou informe o motivo da diferença.', 409);
    if (!C.dataOk(b.venc)) return erro('Informe o vencimento da fatura.', 400);
    const lid = novoId('lf'), rat = f.rateio.filter(x => x.pct > 0);
    const l = { id: lid, tipo: 'pagar', status: 'aberto', estoqueValor: 0, desc: 'Fatura Sem Parar · combustível ' + mes.slice(5) + '/' + mes.slice(0, 4) + ' (' + f.n + ' abastecimentos)', valor, venc: b.venc, comp: mes, categoria: 'Veículos e frota', parcId: String(b.parcId || '').slice(0, 64),
      projId: rat.length === 1 && f.geral < 0.01 ? rat[0].projId : '', rateioProj: rat.length >= 2 ? rat.map(x => ({ projId: x.projId, pct: x.pct })) : [], comum: false, pago: '', valorPago: null, fat165: 'fat_' + mes, anexos: b.arq && b.arq.id ? [{ id: String(b.arq.id), nome: String(b.arq.nome || 'fatura.pdf').slice(0, 120) }] : [] };
    const fat = { id: 'fat_' + mes, mes, valor, total: f.total, dif, motivoDif: String(b.motivoDif || '').slice(0, 300), lancId: lid, rateio: f.rateio, porCidade: f.porCidade, porVeic: f.porVeic, geral: f.geral, n: f.n, por: conta.id, em: Xc.agora, arq: l.anexos[0] || null };
    const g = gravar(conta, req, [{ c: 'lanc', d: l }, { c: 'vfat165', d: fat }], 'FROTA_FATURA_SEMPARAR', { mes, valor, total: f.total, dif }); if (g.erro) return g;
    for (const id of f.ids) { const a = doc('vabas/' + id); if (a && !a.fat165) gravaSis('vabas/' + id, Object.assign({}, a, { fat165: fat.id })); }
    return Object.assign(g, { msg: 'Fatura lançada em contas a pagar (uma conta, com o rateio por obra).', fat, lancId: lid });
  }
  function rotaPainel(conta, u) {
    const Xc = ctx(), quem = quemDe(conta, u.searchParams.get('todas') === '1', Xc);
    if (!(C.gestor(Xc, quem))) return erro('O painel da frota é do responsável pela frota da cidade, do Administrador de frota e de quem cuida da frota.');
    const esc = C.escopo(Xc.cfg, quem, true), P = C.painel(Xc, esc);
    const v = x => x ? { id: x.id, placa: x.placa, modelo: x.modelo || '', cidade: C.cidadeDe(x) } : null, f = x => x ? { id: x.id, nome: x.nome || '' } : null;
    const sdm = x => ({ id: x.id, veicId: x.veicId, funcId: x.funcId, nome: fNome(Xc, x.funcId), saidaEm: x.saidaEm, hora: x.hora, retPrev165: x.retPrev165 || '', retornoEm: x.retornoEm || '', horaRet: x.horaRet || '', combRet165: x.combRet165 || '', destino: x.destino || '' });
    return { ok: true, esc: esc ? [...esc] : null, cidades: Xc.cfg.cidades, minhas: C.cidadesDe(Xc.cfg, quem.uid), veics: Xc.veic.filter(x => P.vs.includes(x)).map(v),
      disp: P.disp.map(x => v(x.v)), uso: P.uso.map(x => ({ v: v(x.v), s: sdm(x.st.s) })), manut: P.manut.map(x => v(x.v)), grave: P.grave.map(x => ({ v: v(x.v), txt: x.st.txt })),
      atrasados: P.atrasados.map(x => ({ s: sdm(x.s), min: x.min })), combBaixo: P.combBaixo.map(x => sdm(x.s)), avarias: P.avarias.map(a => Object.assign({}, a, { nome: fNome(Xc, a.atribFunc) })), resPend: P.resPend.map(r => Object.assign({}, r, { nome: fNome(Xc, r.funcId) })),
      venc: P.venc.map(x => ({ v: v(x.v), t: x.t, d: x.d })), cnh: P.cnh.map(x => ({ f: f(x.f), d: x.d })), bloq: P.bloq.map(x => ({ f: f(x.f), txt: x.st.txt, motivos: x.st.motivos })), autVenc: P.autVenc.map(x => ({ f: f(x.f), d: x.d })),
      abasAl: P.abasAl.slice(0, 100).map(a => ({ id: a.id, veicId: a.veicId, data: a.data, km: a.km, litros: a.litros, alertas: a.alertas165, st165: a.st165 || '' })), kml: P.kml.map(x => ({ v: v(x.v), ult: x.ult, media: x.media })), desligEmUso: P.desligEmUso.map(x => ({ s: sdm(x.s), f: f(x.f) })) };
  }
  function rotaCfg(conta, req, b) {
    if (!(admin(conta) || perfilEm(conta, ['frotaadm']))) return erro('Só o Administrador e o Administrador de frota alteram as configurações da frota.');
    const c = C.cfgPad(b.frota165), atual = cfgEmp() || {};
    const n = { cidades: c.cidades, resp: {}, saidaDireta: !!c.saidaDireta, fotosObrig: !!c.fotosObrig, frac8: !!c.frac8, checklist: c.checklist.map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 30), exigeRecibo: !!c.exigeRecibo };
    c.cidades.forEach(cid => { const r = (c.resp || {})[cid] || {}; n.resp[cid] = { uid: ID_OK.test(String(r.uid || '')) ? String(r.uid) : '', sub: ID_OK.test(String(r.sub || '')) ? String(r.sub) : '' }; });
    ['diasAviso', 'autMeses', 'quedaKmlPct', 'kmMax', 'kmMin', 'tolKm', 'precoPct', 'tolMatchDias'].forEach(k => { const v = +c[k]; if (isFinite(v) && v >= 0) n[k] = v; });
    if (c.reqTipo && typeof c.reqTipo === 'object') { n.reqTipo = {}; C.TIPOS.forEach(([t]) => { const r = c.reqTipo[t] || {}; n.reqTipo[t] = { cat: /^[A-E]$/.test(String(r.cat || '')) ? String(r.cat) : 'B', cursos: (Array.isArray(r.cursos) ? r.cursos : []).filter(k => C.CURSOS[k]) }; }); }
    const novo = Object.assign({}, atual, { id: 'empresa', frota165: n });
    gravaSis('cfg/empresa', novo);
    auditar(conta, req, 'FROTA_CFG_165', 'cfg/empresa', { frota165: atual.frota165 || null }, { frota165: n });
    return { ok: true, docs: [{ col: 'cfg', id: 'empresa', data: novo }] };
  }
  function rotaQr(conta, u, res) {
    const Xc = ctx(), quem = quemDe(conta, false, Xc), vid = String(u.searchParams.get('veicId') || ''), v = Xc.veic.find(x => x.id === vid);
    if (!v) { json(res, 404, { code: 'not_found', erro: 'Veículo não encontrado.' }); return; }
    if (!(C.gestor(Xc, quem) || quem.funcId)) { json(res, 403, { code: 'not_granted', erro: 'Sem acesso.' }); return; }
    let svg = ''; try { svg = require('./qr.js').svg((X.APP_URL || '') + '/#v165sai/' + v.id, 220); } catch (e) { json(res, 500, { code: 'internal', erro: 'Falha ao gerar o QR.' }); return; }
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'private, max-age=3600' }); res.end(svg);
  }
  /* atraso: avisa o condutor e o responsável uma vez por saída */
  function lembretes() {
    const Xc = ctx(); let n = 0;
    for (const x of Xc.vsai) {
      if (x.retornoEm || !x.v165 || !x.retPrev165 || x.retPrev165 >= Xc.agora || x.atrAvis165) continue;
      const u = usrDoFunc(Xc, x.funcId) || x.condUid, resp = C.respDe(Xc.cfg, x.cidade || '');
      avisarChat(uniq([u]), 'Retorno atrasado: o veículo ' + vNome(Xc, x.veicId) + ' devia ter voltado em ' + C.brDt(x.retPrev165) + '. Registre o retorno em Frota › Retorno do veículo (ou avise o responsável pela frota).');
      avisarChat(resp.filter(r => r !== u), 'Retorno atrasado: ' + vNome(Xc, x.veicId) + ' com ' + fNome(Xc, x.funcId) + ', previsto para ' + C.brDt(x.retPrev165) + '.');
      const cur = doc('vsai/' + x.id); if (cur) gravaSis('vsai/' + x.id, Object.assign({}, cur, { atrAvis165: Xc.agora })); n++;
    }
    return n;
  }
  if (process.env.NODE_ENV !== 'test' || process.env.V165_LEMBRETES === '1') { const t = setInterval(() => { try { lembretes(); } catch (e) { console.error('[v165] lembretes:', e.message); } }, 3600e3); if (t.unref) t.unref(); }

  async function rota(p, m, req, res, conta) {
    if (!p.startsWith('/api/frota165/')) return false;
    const u = new URL(req.url, 'http://x'), b = m === 'POST' ? await lerJson(req).catch(() => ({})) : {};
    const P = (k, fn) => { if (p === '/api/frota165/' + k) { R(res, fn()); return true; } return false; };
    if (m === 'GET') {
      if (P('meu', () => rotaMeu(conta, u))) return true;
      if (P('painel', () => rotaPainel(conta, u))) return true;
      if (P('fatura', () => rotaFaturaVer(conta, u))) return true;
      if (p === '/api/frota165/qr') { rotaQr(conta, u, res); return true; }
    }
    if (m === 'POST') {
      if (P('reserva', () => rotaReserva(conta, req, b))) return true;
      if (P('reserva/decidir', () => rotaDecidir(conta, req, b))) return true;
      if (P('reserva/cancelar', () => rotaCancelar(conta, req, b))) return true;
      if (P('saida', () => rotaSaida(conta, req, b))) return true;
      if (P('retorno', () => rotaRetorno(conta, req, b))) return true;
      if (P('manut', () => rotaManut(conta, req, b))) return true;
      if (P('avaria/resolver', () => rotaAvResolver(conta, req, b))) return true;
      if (P('autorizar', () => rotaAutorizar(conta, req, b))) return true;
      if (P('revogar', () => rotaRevogar(conta, req, b))) return true;
      if (P('importar', () => importarAbastecimentos(conta, req, b.linhas, b.origem, { confirmar: !!b.confirmar, arquivo: b.arquivo }))) return true;
      if (p === '/api/frota165/recibo') { R(res, await rotaRecibo(conta, req, b)); return true; }
      if (P('recibo/salvar', () => rotaReciboSalvar(conta, req, b))) return true;
      if (P('hodometro', () => rotaHod(conta, req, b))) return true;
      if (P('fatura', () => rotaFatura(conta, req, b))) return true;
      if (P('cfg', () => rotaCfg(conta, req, b))) return true;
      if (P('lembretes', () => admin(conta) ? { ok: true, n: lembretes() } : erro('Só o Administrador.'))) return true;
      if (P('migrar', () => admin(conta) ? { ok: true, mig: migrar() } : erro('Só o Administrador.'))) return true;
    }
    json(res, 404, { code: 'not_found', erro: 'Rota não encontrada.' }); return true;
  }

  /* =================================================================== gravação comum (PUT) */
  const VABAS_SIS = ['imp165', 'rec165', 'st165', 'alertas165', 'itens165', 'hodCorr165', 'hodHist165', 'fat165'];
  const VSAI_SIS = ['v165', 'resId', 'condUid', 'comb165', 'ck165', 'fotos165', 'retPrev165', 'combRet165', 'ckR165', 'fotosR165', 'atraso165', 'atrAvis165', 'retPor', 'regPor'];
  function foraDoEscopo(conta, vid, Xc) {
    const quem = quemDe(conta, false, Xc); if (quem.admin || quem.frotaTodos) return '';
    const cs = C.cidadesDe(Xc.cfg, conta.id); if (!cs.length) return '';
    const v = Xc.veic.find(x => x.id === vid); const c = C.cidadeDe(v);
    return v && cs.includes(c) ? '' : 'Você é responsável pela frota de ' + cs.join(', ') + ': só gere os veículos dessa(s) cidade(s)' + (v ? ' (este é de ' + (c || 'cidade não definida') + ').' : '.');
  }
  function antes(conta, c0, id, velho, novo) {
    if (!novo) return null;
    if (SIS.has(c0)) return ROTA ? null : erro('Este registro da frota é gravado pelas telas de reserva, saída, retorno, condutores, importação e fatura.', 409);
    if (c0 === 'cfg' && id === 'empresa' && !admin(conta)) { const v = velho || {}; if (v.frota165 !== undefined) novo.frota165 = v.frota165; else delete novo.frota165; return null; }
    if (ROTA) return null;
    if (c0 === 'veic') {
      const Xc = { veic: col('veic'), func: col('func'), cfg: cfg() };
      const e = (velho ? foraDoEscopo(conta, id, Xc) : '') || (() => { const cs = admin(conta) || perfilEm(conta, ['frotaadm']) ? [] : C.cidadesDe(Xc.cfg, conta.id); return cs.length && !cs.includes(C.cidadeDe(novo)) ? 'Você é responsável pela frota de ' + cs.join(', ') + ': o veículo tem de ser dessa(s) cidade(s).' : ''; })();
      if (e) return erro(e);
      return null;
    }
    if (c0 === 'vsai' || c0 === 'vabas' || c0 === 'vman') {
      const Xc = { veic: col('veic'), func: col('func'), cfg: cfg() };
      const e = foraDoEscopo(conta, String(novo.veicId || (velho && velho.veicId) || ''), Xc) || (velho && velho.veicId && velho.veicId !== novo.veicId ? foraDoEscopo(conta, velho.veicId, Xc) : '');
      if (e) return erro(e);
      if (c0 === 'vabas' && velho) VABAS_SIS.forEach(k => { if (velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; });
      if (c0 === 'vabas' && !velho) VABAS_SIS.forEach(k => { delete novo[k]; });
      if (c0 === 'vsai') {
        if (velho) VSAI_SIS.forEach(k => { if (velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; });
        else {
          VSAI_SIS.forEach(k => { delete novo[k]; });
          if (!admin(conta) && !/^(rom|ped)164_/.test(id)) { /* saída nova pela gravação comum: as mesmas travas da tela de saída */
            const Xf = ctx(), f = Xf.func.find(x => x.id === novo.funcId), v = Xf.veic.find(x => x.id === novo.veicId);
            const m = f ? C.podeDirigir(Xf, f, v) : 'Escolha o condutor.'; if (m) return erro('Saída bloqueada: ' + m, 409);
            const st = C.veicSit(Xf, v); if (st.k === 'manut' || st.k === 'grave') return erro('Saída bloqueada: ' + st.txt.toLowerCase() + '.', 409);
          }
        }
      }
    }
    return null;
  }
  function antesExcluir(conta, c0) { if (SIS.has(c0) && !ehDono(conta)) return erro('Os registros da frota da v165 (reservas, autorizações, avarias, importações, faturas) não se excluem: ficam no histórico.', 409); return null; }
  /* RH: desligamento revoga a autorização; com veículo em uso, avisa o responsável da cidade */
  function depois(conta, req, metodo, p, antes_, depois_) {
    const s = p.split('/'); if (s.length !== 2 || metodo === 'DELETE' || !depois_) return;
    let fid = '';
    if (s[0] === 'func' && depois_.status === 'desligado' && (!antes_ || antes_.status !== 'desligado')) fid = s[1];
    if (s[0] === 'desl' && !antes_ && depois_.funcId) fid = String(depois_.funcId);
    if (!fid) return;
    try {
      const a = doc('vaut165/' + fid), ag = agoraBr();
      if (a && a.st !== 'revogada') gravaSis('vaut165/' + fid, Object.assign({}, a, { st: 'revogada', motivo: 'Desligamento', revPor: 'sistema', revEm: ag, hist: (a.hist || []).concat([{ em: ag, por: 'sistema', o: 'Revogada: desligamento' }]).slice(-40) }));
      const Xc = ctx(), abertas = Xc.vsai.filter(x => x.funcId === fid && !x.retornoEm);
      for (const x of abertas) avisarChat(C.respDe(Xc.cfg, x.cidade || C.cidadeDe(Xc.veic.find(v => v.id === x.veicId))), 'Atenção: ' + fNome(Xc, fid) + ' foi desligado(a) e ainda está com o veículo ' + vNome(Xc, x.veicId) + ' (saída de ' + C.br(x.saidaEm) + '). Recolha o veículo e registre o retorno.');
      if (a) auditar(conta, req, 'FROTA_AUTORIZACAO_REVOGADA', 'vaut165/' + fid, null, { motivo: 'desligamento', emUso: abertas.length });
    } catch (e) { console.error('[v165] desligamento:', e.message); }
  }
  const COLS = new Set(['veic', 'vsai', 'vabas', 'vman', 'cfg', 'vres165', 'vaut165', 'vav165', 'vimp165', 'vfat165']);
  return { COLS, antes, antesExcluir, depois, rota, importarAbastecimentos, migrar, lembretes, ctx, quemDe };
};

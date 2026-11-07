/* v167 (relatorios/feito_v167.md): modo Campo — uso sem internet no celular (app instalável).
   1. Pacote para uso sem internet: GET /api/campo167/obras (as obras que a pessoa pode escolher) e
      GET /api/campo167/pacote?obras=a,b — só o que as telas do Campo precisam, só das obras da pessoa e só o que o perfil
      dela pode usar: pedidos e romaneios a receber na obra, colaboradores da obra (nome, função, CPF mascarado e o
      almoxarifado de EPI; nada de folha, salário ou documentos do RH), EPI com saldo nesses almoxarifados, saldo de
      material da obra, ferramentas sob guarda, números do diário e os veículos e condutores que a pessoa usa.
   2. Envio sem duplicar: cada registro feito sem internet chega com o cabeçalho x-cg-cid (identificador gerado no
      aparelho) e x-cg-uid (quem fez). A primeira resposta de sucesso fica guardada (tabela campo167); o mesmo cid de novo
      recebe a mesma resposta e nada é gravado outra vez. Registro feito por outra pessoa no mesmo aparelho não é enviado
      com a sessão de quem está agora (409 outra_conta). As rotas de sempre validam tudo de novo (permissão, saldo, regras):
      o que veio do aparelho não vale mais do que o que vem da tela com internet.
   3. Diário de obra enviado pelo Campo: diário que já existe, ou outro diário da mesma obra no mesmo dia, é conflito
      (mostrado à pessoa, nada é sobrescrito); número repetido recebe o próximo número livre. */
'use strict';
module.exports = function (X) {
  const { db, col, doc, json, ehDono, perfilEm, papelConta } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const erro = (m, st) => ({ erro: m, st: st || 403 });
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/, CID_OK = /^[A-Za-z0-9_-]{8,80}(\.[A-Za-z0-9_.-]{1,40})?$/;
  const admin = c => ehDono(c) || perfilEm(c, ['admin']);
  const s = v => String(v == null ? '' : v);
  const N = v => s(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const r4 = v => Math.round((+v || 0) * 10000) / 10000;
  const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const maisDias = (d, n) => new Date(Date.parse(String(d).slice(0, 10) + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const br = d => /^\d{4}-\d{2}-\d{2}/.test(s(d)) ? s(d).slice(8, 10) + '/' + s(d).slice(5, 7) + '/' + s(d).slice(0, 4) : '';
  const cpfM = v => { const d = s(v).replace(/\D/g, ''); return d.length === 11 ? '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9) : ''; };
  const FECHADA = ['concluido', 'concluida', 'encerrado', 'encerrada', 'cancelado', 'cancelada'];
  const ativa = p => p && !FECHADA.includes(s(p.status));
  const nomeProj = p => [p.codigo, p.nome].filter(Boolean).join(' · ');
  const MAX_OBRAS = 10, MAX_PAC = 8 * 1048576;
  const VE_TODAS = ['projetos', 'almoxarife', 'almoxfab', 'rh', 'rhcompras', 'sst', 'sstgestor', 'ssttec', 'comprador', 'compras', 'frotaadm', 'diretoria'];
  const VE_MAT = ['projetos', 'almoxarife', 'almoxfab', 'comprador', 'compras', 'diretoria', 'financeiro'];
  const lista = (sql, v) => db.prepare(sql).all(s(v)).map(r => { try { return Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { return null; } }).filter(Boolean);
  const F165 = require('./frota165.js');

  /* ------------------------------------------------------------ tabela do envio sem duplicar */
  db.exec('CREATE TABLE IF NOT EXISTS campo167 (chave TEXT PRIMARY KEY, conta TEXT, rota TEXT, st INTEGER, resp TEXT, em INTEGER)');
  const qGet = db.prepare('SELECT * FROM campo167 WHERE chave=?'), qIns = db.prepare('INSERT INTO campo167(chave,conta,rota,st,resp,em) VALUES(?,?,?,0,NULL,?)');
  const qFim = db.prepare('UPDATE campo167 SET st=?, resp=? WHERE chave=?'), qDel = db.prepare('DELETE FROM campo167 WHERE chave=?');
  const ROTAS = new Set(['/api/assets', '/api/rec164/obra', '/api/rec164/romaneio', '/api/rec164/retirada', '/api/gua164/transferir', '/api/epi163/entregas', '/api/epi/assinar', '/api/frota165/reserva', '/api/frota165/saida', '/api/frota165/retorno']);
  function rotaDoCampo(p, m, u) {
    if (m === 'POST' && ROTAS.has(p)) return p;
    if (p === '/api/db/doc' && (m === 'PUT' || m === 'PATCH')) { const dp = s(u.searchParams.get('path')); if (/^rdo\/[\w-]{1,80}$/.test(dp)) return m + ' ' + dp; }
    return '';
  }
  /* resposta guardada: o necessário para o aparelho continuar (ids e mensagem), no máximo 64 KB */
  function enxuga(j) {
    const t = JSON.stringify(j || {}); if (t.length <= 65536) return t;
    const o = { ok: !!(j && j.ok), msg: j && j.msg, enxuto: true };
    if (j && j.saida && j.saida.id) o.saida = { id: j.saida.id }; if (j && j.res && j.res.id) o.res = { id: j.res.id }; if (j && j.id) o.id = j.id;
    if (j && Array.isArray(j.docs)) o.docs = j.docs.slice(0, 200).map(d => ({ col: d.col, id: d.id }));
    return JSON.stringify(o);
  }
  let limpo = 0;
  /* chamado pelo server.js logo depois do login e das travas de segurança (END.antes), antes de qualquer rota */
  async function antes(req, res, conta, p, m, u) {
    const cid = s(req.headers['x-cg-cid']); if (!cid) return false;
    const rota = rotaDoCampo(p, m, u || new URL(req.url, 'http://x')); if (!rota) return false;
    if (!CID_OK.test(cid)) { json(res, 400, { code: 'invalid_argument', erro: 'Identificador do registro inválido.' }); return true; }
    const quem = s(req.headers['x-cg-uid']);
    if (quem && quem !== conta.id) { json(res, 409, { code: 'outra_conta', erro: 'Este registro foi feito neste aparelho por outra pessoa: ele só é enviado quando ela entrar.' }); return true; }
    const chave = conta.id + ':' + cid, ag = Date.now();
    if (ag - limpo > 3600e3) { limpo = ag; try { db.prepare('DELETE FROM campo167 WHERE em<?').run(ag - 90 * 864e5); } catch (e) { } }
    const r0 = qGet.get(chave);
    if (r0 && r0.st >= 200 && r0.st < 300) {
      if (r0.rota !== rota) { json(res, 409, { code: 'conflict', erro: 'Identificador do registro já usado em outra ação.' }); return true; }
      let j = {}; try { j = JSON.parse(r0.resp || '{}'); } catch (e) { }
      auditar(conta, req, 'CAMPO_REPETIDO_167', p, null, { cid, rota, em: r0.em });
      json(res, 200, Object.assign(j, { repetido: true }), { 'x-cg-repetido': '1' }); return true;
    }
    if (r0 && r0.st === 0 && ag - r0.em < 120000) { json(res, 409, { code: 'em_andamento', erro: 'Este registro já está sendo enviado. Aguarde.' }); return true; }
    if (r0) qDel.run(chave);
    try { qIns.run(chave, conta.id, rota, ag); } catch (e) { json(res, 409, { code: 'em_andamento', erro: 'Este registro já está sendo enviado. Aguarde.' }); return true; }
    /* guarda a resposta de sucesso (o json() de sempre pode comprimir em gzip) */
    let st = 200, enc = ''; const wh = res.writeHead, en = res.end;
    res.writeHead = function (code) { st = code; const h = arguments[arguments.length - 1]; if (h && typeof h === 'object' && h['content-encoding']) enc = s(h['content-encoding']); return wh.apply(this, arguments); };
    res.end = function (chunk) {
      try {
        if (st >= 200 && st < 300) {
          let b = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
          if (/gzip/.test(enc || s(res.getHeader('content-encoding')))) b = require('node:zlib').gunzipSync(b);
          let j = {}; try { j = JSON.parse(b.toString('utf8') || '{}'); } catch (e) { j = { ok: true }; }
          qFim.run(st, enxuga(j), chave);
        } else qDel.run(chave);
      } catch (e) { try { qDel.run(chave); } catch (x) { } }
      return en.apply(this, arguments);
    };
    res.on('close', () => { try { const r = qGet.get(chave); if (r && r.st === 0) qDel.run(chave); } catch (e) { } });
    req.__campo167 = cid;
    return false;
  }

  /* ------------------------------------------------------------ diário enviado pelo Campo */
  function antesRdo(conta, id, velho, novo) {
    if (!novo) return null;
    if (velho) return erro('Este diário já existe no servidor (foi gravado ou alterado com internet). Nada foi sobrescrito: abra o diário no sistema e confira.', 409);
    const pj = s(novo.projId), dt = s(novo.data);
    const ls = lista("SELECT id, data FROM docs WHERE parent='rdo' AND json_extract(data,'$.projId')=?", pj).filter(r => r.id !== id);
    const dup = ls.find(r => s(r.data) === dt);
    if (dup) { const quem = dup.resp || (dup.crBy ? X.nomeConta(dup.crBy) : ''); return erro('Já existe o diário nº ' + (dup.numero || '') + ' desta obra em ' + br(dt) + (quem ? ' (preenchido por ' + quem + ')' : '') + '. Nada foi sobrescrito: complete o diário existente no sistema.', 409); }
    if (!(+novo.numero > 0) || ls.some(r => +r.numero === +novo.numero)) novo.numero = Math.max(0, ...ls.map(r => +r.numero || 0)) + 1;
    novo.campo167 = { em: Date.now() };
    return null;
  }

  /* ------------------------------------------------------------ obras da pessoa */
  function minhas(conta) {
    const ids = new Set();
    for (const p of col('proj')) if (ativa(p) && p.respObra && p.respObra === conta.id) ids.add(p.id);
    for (const f of col('func')) if (f && f.usrId === conta.id && f.status !== 'desligado' && f.projId) ids.add(s(f.projId));
    return ids;
  }
  function obrasPermitidas(conta) {
    const mi = minhas(conta), todas = admin(conta) || VE_TODAS.includes(papelConta(conta));
    return col('proj').filter(p => ativa(p) && (todas || mi.has(p.id))).map(p => ({ id: p.id, nome: nomeProj(p), minha: mi.has(p.id) }))
      .sort((a, b) => (b.minha - a.minha) || a.nome.localeCompare(b.nome)).slice(0, 400);
  }
  const podeW = (conta, p) => { try { return !!(X.pode(conta, p, 'w') && X.perfilPermite(conta, p, 'w') && X.gravacaoPermitida(conta, p)); } catch (e) { return false; } };

  /* ------------------------------------------------------------ pacote */
  function almEpi(f, als) {
    if (f.almoxEpi163 && als.some(a => a.id === f.almoxEpi163)) return f.almoxEpi163;
    const cid = c => { const l = als.filter(a => N(a.cidade) === N(c)); return (l.find(a => a.principal === true) || l[0] || {}).id || ''; };
    const lot = N(f.lotacao || f.lotacao163 || ''), sp = lot.includes('sao paulo') || (!lot && N(f.cidade) === 'sao paulo');
    const sP = cid('São Paulo'), tU = cid('Tuiuti');
    if (sp && sP) return sP; if (tU) return tU; return (als[0] || {}).id || '';
  }
  function pacote(conta, req, u) {
    const pedidas = s(u.searchParams.get('obras')).split(',').map(x => x.trim()).filter(Boolean);
    if (pedidas.length > MAX_OBRAS) return erro('Escolha no máximo ' + MAX_OBRAS + ' obras para usar sem internet.', 400);
    const perm = new Map(obrasPermitidas(conta).map(o => [o.id, o]));
    const fora = pedidas.filter(id => !ID_OK.test(id) || !perm.has(id));
    if (fora.length) return erro('Obra fora das suas obras: ' + fora.join(', ') + '.', 403);
    const C164 = X.C164(), C154 = X.C154(), C163 = X.C163(), C165 = X.C165();
    const pap = papelConta(conta), adm = admin(conta), almx = ['almoxarife', 'almoxfab'].includes(pap);
    const als = col('almox').filter(a => a && a.ativo !== false);
    const funcs = col('func');
    const podeEpi = !!(C163.podeEntregar(conta) && podeW(conta, 'epi/campo'));
    const pend = C164.rotaPendentes(conta);
    const almUsados = new Set();
    const obras = pedidas.map(pid => {
      const p = doc('proj/' + pid) || {};
      const rec = C164.podeObra(conta, pid), mat = adm || rec || VE_MAT.includes(pap), gua = adm || almx || rec, rdo = podeW(conta, 'rdo/campo');
      const fs = funcs.filter(f => f && f.status !== 'desligado' && s(f.projId) === pid).slice(0, 400);
      const fer = lista("SELECT id, data FROM docs WHERE parent='fmov' AND json_extract(data,'$.projId')=?", pid).filter(m => !m.retornoEm && !(m.ret164 && m.ret164.romId)).slice(0, 500);
      const comGuarda = new Set(fer.map(m => s(m.funcId)));
      const fsAll = fs.concat(funcs.filter(f => f && comGuarda.has(f.id) && !fs.includes(f)));
      const func = fsAll.map(f => { const a = almEpi(f, als); if (podeEpi && s(f.projId) === pid) almUsados.add(a); return { id: f.id, nome: s(f.nome), funcao: s(f.funcao || f.cargo), cpf: cpfM(f.cpf), almEpi: a, daObra: s(f.projId) === pid }; });
      const prods = new Map();
      const peds = rec || pend.peds.some(x => x.projId === pid) ? pend.peds.filter(x => x.projId === pid).map(x => {
        const mot = x.mot164 ? doc('func/' + x.mot164) : null, eMot = !!(mot && mot.usrId === conta.id);
        return Object.assign({}, x, { podeRet: adm || eMot || ['comprador', 'compras', 'almoxarife', 'almoxfab'].includes(pap), podeRec: rec,
          itens: x.itens.map((i, k) => { let pr = prods.get(i.prodId); if (pr === undefined) { pr = i.prodId ? doc('prod/' + i.prodId) : null; prods.set(i.prodId, pr); } return Object.assign({ k }, i, { lote: !!(pr && pr.lote === true) }); }) });
      }) : [];
      const roms = rec ? pend.roms.filter(x => x.projId === pid) : [];
      let matL = null;
      if (mat) matL = C164.razaoSrv(pid, true).slice(0, 1000).map(o => { const pr = doc('prod/' + o.prodId) || {}; return { prodId: o.prodId, nome: s(pr.nome), un: s(pr.un), env: r4(o.env + o.tin), dev: r4(o.dev + o.devPend + o.quar), tout: r4(o.tout), cons: r4(o.cons + o.desc + o.dforn), saldo: r4(o.saldo), cu: r4(o.cu) }; });
      const rdos = rdo ? lista("SELECT id, data FROM docs WHERE parent='rdo' AND json_extract(data,'$.projId')=?", pid) : [];
      const lim = maisDias(hoje(), -90);
      return { id: pid, nome: nomeProj(p), perm: { rec, rdo, mat, gua }, peds, roms, func,
        mat: matL, ferr: gua ? fer.map(m => { const f = doc('ferr/' + s(m.ferrId)) || {}; return { fmovId: m.id, ferrId: s(m.ferrId), nome: s(f.nome), cod: s(f.codigo), funcId: s(m.funcId), acess: Array.isArray(f.acess164) ? f.acess164.slice(0, 30).map(a => ({ id: a.id, desc: s(a.desc), qtd: +a.qtd || 0 })) : [] }; }) : [],
        rdo: rdo ? { prox: Math.max(0, ...rdos.map(r => +r.numero || 0)) + 1, datas: rdos.filter(r => s(r.data) >= lim).map(r => ({ data: s(r.data), numero: +r.numero || 0 })).slice(0, 120) } : null };
    });
    let epi = null;
    if (podeEpi) {
      const am = [...almUsados].filter(Boolean);
      const prods = col('prod').filter(C154.ehEpi).map(p => { const sd = {}; am.forEach(a => { const q = C154.saldo(p.id, a); if (q > 1e-9) sd[a] = q; }); return { id: p.id, nome: s(p.nome), un: s(p.un), ca: s(p.ca), caVal: s(p.caVal), tam: s(p.tam), saldos: sd }; }).filter(p => Object.keys(p.saldos).length).slice(0, 600);
      epi = { almox: als.filter(a => am.includes(a.id)).map(a => ({ id: a.id, nome: s(a.nome), cidade: s(a.cidade) })), prods };
    }
    let frota = null;
    try {
      const Xc = C165.ctx(), quem = C165.quemDe(conta, false, Xc), m = F165.modelo(Xc, quem);
      if (m.eu.funcId || m.eu.gestor) {
        const nomes = {}; (Xc.func || []).forEach(f => { nomes[f.id] = s(f.nome); });
        const saiMin = x => ({ id: x.id, veicId: x.veicId, funcId: x.funcId, funcNome: nomes[x.funcId] || '', saidaEm: x.saidaEm, hora: x.hora || '', kmSaida: +x.kmSaida || 0, retPrev165: x.retPrev165 || '', destino: s(x.destino), v165: !!x.v165, cidade: x.cidade || '' });
        frota = { cfg: m.cfg, eu: m.eu, veics: m.veics.slice(0, 300), minhaRes: m.minhaRes.filter(r => ['pendente', 'aprovada'].includes(r.st)).map(r => ({ id: r.id, veicId: r.veicId, cidade: r.cidade, ini: r.ini, fim: r.fim, projId: r.projId, destino: r.destino, motivo: r.motivo, st: r.st })),
          minhasSai: m.minhasSai.map(saiMin), saiGerir: m.eu.gestor ? m.saiGerir.slice(0, 100).map(saiMin) : [], cond: m.cond.slice(0, 300).map(c => ({ id: c.id, nome: c.nome, sit: c.sit })),
          fotos: F165.FOTOS, comb: F165.combOpts(Xc.cfg), projs: col('proj').filter(ativa).map(p => ({ id: p.id, nome: nomeProj(p) })).slice(0, 300), agora: m.agora };
      }
    } catch (e) { console.error('[v167] frota no pacote:', e.message); }
    if (!obras.length && !frota) return erro('Escolha pelo menos uma obra.', 400); /* sem obra, só quem usa veículo (motorista) */
    const pac = { ok: true, v: 167, em: Date.now(), hoje: hoje(), uid: conta.id, nome: X.nomeConta(conta.id), perm: { epi: podeEpi, frota: !!frota }, obras, epi, frota };
    const tam = JSON.stringify(pac).length;
    if (tam > MAX_PAC) return erro('Os dados dessas obras passam do limite para uso sem internet (' + Math.round(MAX_PAC / 1048576) + ' MB). Escolha menos obras.', 413);
    pac.tam = tam;
    auditar(conta, req, 'CAMPO_PACOTE_167', '/api/campo167/pacote', null, { obras: pedidas, tam });
    return pac;
  }

  async function rota(p, m, req, res, conta) {
    if (!p.startsWith('/api/campo167/')) return false;
    const u = new URL(req.url, 'http://x');
    const R = r => json(res, r.erro ? (r.st || 403) : 200, r.erro ? { code: r.st === 400 ? 'invalid_argument' : r.st === 413 ? 'too_large' : r.st === 409 ? 'conflict' : 'not_granted', erro: r.erro } : r);
    if (m === 'GET' && p === '/api/campo167/obras') { R({ ok: true, max: MAX_OBRAS, obras: obrasPermitidas(conta) }); return true; }
    if (m === 'GET' && p === '/api/campo167/pacote') { R(pacote(conta, req, u)); return true; }
    json(res, 404, { code: 'not_found', erro: 'Rota não encontrada.' }); return true;
  }
  return { antes, antesRdo, rota, obrasPermitidas, ROTAS };
};

'use strict';
/* v154 (relatorios/feito_v154.md): entrega de EPI pelo cadastro de produtos com baixa automática, devolução/troca e
   higienização de EPI, conferidas e gravadas pelo servidor.
   1. POST /api/epi/entrega {epi}: entrega nova com produto da família EPI. O servidor confere permissão (quem grava
      Controle de EPI: Almoxarife, RH, SST), o produto (família EPI ou marcado como EPI), o saldo do produto no almoxarifado
      (não deixa negativo) e grava a entrega e o movimento de saída (ligado ao colaborador e à obra dele: custo da obra pelo
      custo médio) numa transação só: ou os dois, ou nenhum.
   2. POST /api/epi/devolucao {id, data, cond, motivo, descMotivo, almoxDev, prodId, obs, troca:{epi}}: devolução em
      "condição de uso" (cria o registro de higienização; NÃO volta ao estoque) ou "descarte" (baixa definitiva, só na ficha);
      com troca, a nova entrega (e a baixa dela) entra na mesma transação.
   3. POST /api/epihig {acao: enviar|receber|higienizado|reprovado, ids, rom, prodIds, motivo, obs, data}: o fluxo da
      higienização (aguardando envio → em trânsito → em higienização → higienizado/retornado ou reprovado). Só "higienizado"
      cria a entrada no estoque (ajuste positivo no almoxarifado de higienização, marcado higienizado:true). Receber,
      higienizar e reprovar: responsável/substituto do almoxarifado de higienização (sem responsável: quem grava estoque),
      o Administrador ou o dono.
   4. POST /api/epi/migrar: unificação única do "estoque de EPI" com o cadastro de produtos (cfg.empresa.epi154Mig guarda o
      relatório; uma segunda chamada só devolve o relatório).
   5. Gravação comum (antes/antesExcluir): epihig não se grava nem se exclui (só o dono exclui); movimento ligado a EPI
      (epiId/higId/higienizado) só pelas rotas; entrega com baixa não muda produto, quantidade, almoxarifado nem os dados
      da devolução; entrega nova com baixa (movId) só pela rota.
   6. eventos(): aviso por e-mail ao responsável/substituto do almoxarifado de higienização (regras.js › eventosAviso). */
module.exports = function (X) {
  const { db, q, col, doc, erro, avisarDoc, auditar, depois, pode, perfilPermite, gravacaoPermitida, gravaCol, ehDono, perfilEm, cfgEmp, ipDe, C153 } = X;
  const antesGravar = (...a) => X.antesGravar(...a);
  let ROTA = false;
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const r4 = v => Math.round((+v || 0) * 10000) / 10000;
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const admin = conta => ehDono(conta) || perfilEm(conta, ['admin']);

  /* ---------- família EPI (igual ao navegador: new_v154.js › v154EhFamEpi) ---------- */
  const FAM_PAD = 'EPI';
  /* v156: família do cadastro (Cadastros › Famílias de produto) vale pela marca "É EPI" (fam156.js); texto ainda fora do
     cadastro continua pela regra antiga (nome de Configurações › EPI, "EPI"/"EPIs", "Equipamento de Proteção Individual") */
  const famLeg = () => String(cfgEmp().epiFamilia || '').trim() || FAM_PAD;
  const famCfg = () => { let n = ''; try { n = X.famEpiNome ? X.famEpiNome() : ''; } catch (e) { } return n || famLeg(); };
  const ehFam = f => { const k = norm(f); if (!k) return false; let r = null; try { r = X.famEpi ? X.famEpi(f) : null; } catch (e) { } if (r === true || r === false) return r; return k === norm(famLeg()) || /^epis?$/.test(k) || /^equipamentos? de protecao individual$/.test(k); };
  const ehEpi = p => !!p && (p.epi === true || ehFam(p.familia));
  /* almoxarifado de higienização: o configurado; senão o principal de Tuiuti; senão um de Tuiuti; senão o único ativo */
  function almHig() {
    const c = cfgEmp(), als = col('almox').filter(a => a && a.ativo !== false);
    if (c.epiHigAlmox && als.some(a => a.id === c.epiHigAlmox)) return c.epiHigAlmox;
    const tu = als.filter(a => norm(a.cidade) === 'tuiuti');
    const p = tu.find(a => a.principal === true) || tu[0]; if (p) return p.id;
    return als.length === 1 ? als[0].id : '';
  }
  /* saldo do produto no almoxarifado (navegador: almSaldosMap; sem almoxarifado: saldo total) */
  const stMov = db.prepare("SELECT data FROM docs WHERE parent='mov' AND json_extract(data,'$.prodId')=?");
  function saldo(pid, alm) {
    const p = doc('prod/' + pid) || {}; let qt = 0;
    for (const r of stMov.all(pid)) { let m; try { m = JSON.parse(r.data); } catch (e) { continue; } const n = +m.qtd || 0;
      if (m.tipo === 'transf') { if (alm === undefined) continue; if ((m.almoxId || '') === alm) qt -= n; if ((m.almoxDest || '') === alm) qt += n; continue; }
      if (alm !== undefined && (m.almoxId || p.almoxId || '') !== alm) continue;
      qt += m.tipo === 'saida' ? -n : n; }
    return r4(qt);
  }
  /* responsável e substituto do almoxarifado */
  const respDe = id => { const a = id ? doc('almox/' + id) : null; return a ? [a.respUid, a.substUid].filter(Boolean) : []; };
  function podeHig(conta, alm) {
    if (admin(conta)) return true; const r = respDe(alm);
    if (r.length) return r.includes(conta.id);
    return gravaCol(conta, 'mov');
  }
  const podeEpi = (conta, id) => { const p = 'epi/' + id; return pode(conta, p, 'w') && perfilPermite(conta, p, 'w') && gravacaoPermitida(conta, p); };
  const nomeConta = c => String((c && (c.nome || c.email)) || '');
  const nomeFunc = id => { const f = id ? doc('func/' + id) : null; return f ? f.nome || '' : ''; };

  /* grava o pacote [{p, velho, data|del}] numa transação, passando cada um pelas regras de sempre (antesGravar) */
  function gravar(conta, req, itens, metodoAud, resumo) {
    const prep = [];
    ROTA = true;
    try {
      for (const x of itens) {
        if (x.del) { prep.push({ x, v: {} }); continue; }
        const v = antesGravar(conta, x.p, x.velho || null, x.data, req);
        if (v && v.reauth) return erro('Confirme a senha e tente de novo.', 409);
        if (v && v.erro) return erro((x.p.startsWith('mov/') ? 'Estoque: ' : '') + v.erro, v.st);
        prep.push({ x, v: v || { data: x.data } });
      }
    } finally { ROTA = false; }
    const ts = Date.now();
    db.exec('BEGIN');
    try {
      for (const { x, v } of prep) { const s = x.p.split('/'); if (x.del) q.docDel.run(x.p); else q.docPut.run(x.p, s.slice(0, -1).join('/'), s[s.length - 1], JSON.stringify(v.data || x.data), ts); }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } return erro('Falha ao gravar. Nada foi gravado; tente de novo.', 500); }
    for (const { x, v } of prep) { avisarDoc(x.del ? 'del' : 'set', x.p, x.del ? null : (v.data || x.data), ts); try { depois(conta, req, x.del ? 'DELETE' : 'PUT', x.p, x.velho || null, x.del ? null : (v.data || x.data), v); } catch (e) { } }
    auditar(conta, req, metodoAud, itens[0] ? itens[0].p : '', null, resumo || null);
    return { ok: true, docs: prep.filter(o => !o.x.del).map(o => { const s = o.x.p.split('/'); return { col: s[0], id: s[1], data: o.v.data || o.x.data }; }) };
  }

  /* ---------- entrega (nova) com baixa: monta e confere ---------- */
  function montaEntrega(conta, e0, usados) {
    if (!e0 || typeof e0 !== 'object' || Array.isArray(e0)) return erro('Entrega inválida.', 400);
    const id = String(e0.id || ''); if (!ID_OK.test(id)) return erro('Entrega inválida.', 400);
    if (!podeEpi(conta, id)) return erro('Seu perfil não registra entrega de EPI.');
    if (doc('epi/' + id)) return erro('Esta entrega já existe. Atualize a tela.', 409);
    const f = doc('func/' + String(e0.funcId || '')); if (!f) return erro('Colaborador não encontrado.', 400);
    const pid = String(e0.prodId || ''), p = pid ? doc('prod/' + pid) : null;
    if (!p) return erro('Escolha o EPI no cadastro de produtos (família ' + famCfg() + ').', 400);
    if (!ehEpi(p)) return erro('O produto "' + (p.nome || '') + '" não é da família ' + famCfg() + '.', 400);
    const qt = r4(e0.qtd === '' || e0.qtd == null ? 1 : e0.qtd); if (!(qt > 0)) return erro('Quantidade inválida.', 400);
    const als = col('almox').filter(a => a && a.ativo !== false), alm = String(e0.almoxId || '');
    if (als.length && !als.some(a => a.id === alm)) return erro('Escolha o almoxarifado de onde sai o EPI.', 400);
    const ent = dataOk(e0.entrega) ? e0.entrega : hoje();
    if (e0.caVal && dataOk(e0.caVal) && e0.caVal < ent) return erro('O CA estava vencido na data da entrega. Confira a validade do CA.', 400);
    const k = pid + '|' + alm, ja = usados.get(k) || 0, sd = saldo(pid, als.length ? alm : undefined);
    if (sd - ja - qt < -1e-9) return erro('Sem saldo de ' + (p.nome || 'EPI') + (alm ? ' no almoxarifado ' + ((doc('almox/' + alm) || {}).nome || '') : '') + ': saldo ' + String(r4(sd - ja)).replace('.', ',') + ', pedido ' + String(qt).replace('.', ',') + '. Dê entrada no estoque ou escolha outro almoxarifado.', 409);
    usados.set(k, ja + qt);
    const movId = 'epimv_' + id;
    const epi = Object.assign({}, e0, { id, prodId: pid, qtd: qt, almoxId: alm, entrega: ent, item: String(e0.item || p.nome || ''), movId });
    ['devolucao', 'devCond', 'devDestino', 'higId', 'trocaId', 'devAlmox', 'assin'].forEach(c => delete epi[c]);
    if (!epi.ca && p.ca) epi.ca = p.ca; if (!epi.caVal && p.caVal) epi.caVal = p.caVal;
    const mov = { id: movId, data: ent, prodId: pid, tipo: 'saida', qtd: qt, custoUnit: 0, projId: f.projId || '', almoxId: alm, epiId: id, funcId: f.id || String(e0.funcId), obs: 'Entrega de EPI a ' + (f.nome || '') };
    return { itens: [{ p: 'epi/' + id, data: epi }, { p: 'mov/' + movId, data: mov }], resumo: { epi: id, prodId: pid, qtd: qt, almoxId: alm, func: e0.funcId } };
  }
  function rotaEntrega(conta, req, b) {
    const m = montaEntrega(conta, b && b.epi, new Map()); if (m.erro) return m;
    const r = gravar(conta, req, m.itens, 'EPI_ENTREGA', m.resumo); if (r.erro) return r;
    r.msg = 'Entrega registrada e baixa no estoque.'; return r;
  }

  /* ---------- devolução / troca ---------- */
  const COND = { uso: 'Em condição de uso', descarte: 'Descarte' };
  function rotaDevolucao(conta, req, b) {
    b = b && typeof b === 'object' ? b : {};
    const id = String(b.id || ''); if (!ID_OK.test(id)) return erro('Entrega inválida.', 400);
    if (!podeEpi(conta, id)) return erro('Seu perfil não registra devolução de EPI.');
    const e = doc('epi/' + id); if (!e) return erro('Entrega não encontrada.', 404);
    if (e.devolucao) return erro('Esta entrega já tem devolução registrada.', 409);
    const cond = String(b.cond || ''); if (!COND[cond]) return erro('Informe a condição do EPI devolvido (em condição de uso ou descarte).', 400);
    const data = dataOk(b.data) ? b.data : hoje(); if (e.entrega && data < e.entrega) return erro('A devolução não pode ser anterior à entrega.', 400);
    const motivo = String(b.motivo || '').slice(0, 120), desc = String(b.descMotivo || '').slice(0, 200), obs = String(b.obs || '').slice(0, 500);
    if (cond === 'descarte' && !desc.trim()) return erro('Informe o motivo do descarte (danificado, vencido, contaminado…).', 400);
    const als = col('almox').filter(a => a && a.ativo !== false), alm = String(b.almoxDev || e.almoxId || '');
    if (als.length && !als.some(a => a.id === alm)) return erro('Informe o almoxarifado onde o EPI foi devolvido.', 400);
    const ah = almHig(), ts = Date.now(), itens = [];
    let pid = e.prodId || '';
    if (!pid && b.prodId) { const p = doc('prod/' + String(b.prodId)); if (!p || !ehEpi(p)) return erro('Produto do cadastro inválido (precisa ser da família ' + famCfg() + ').', 400); pid = p.id || String(b.prodId); }
    const n = Object.assign({}, e, { devolucao: data, devCond: cond, devDestino: cond === 'uso' ? 'higien' : 'descarte', devMotivo: motivo, devDescMotivo: desc, devAlmox: alm, devPor: conta.id, devEm: ts,
      obs: [e.obs, 'Devolução em ' + data.split('-').reverse().join('/') + ': ' + (cond === 'uso' ? 'em condição de uso, enviada para higienização' : 'descarte (' + desc + ')') + (motivo ? ' · motivo: ' + motivo : '') + (obs ? ' · ' + obs : '')].filter(Boolean).join(' · ') });
    if (cond === 'uso') {
      const hid = 'hg_' + id; if (doc('epihig/' + hid)) return erro('Este EPI já está na higienização.', 409);
      const st = (!als.length || !ah || alm === ah) ? 'hig' : 'aguardando';
      n.higId = hid;
      itens.push({ p: 'epihig/' + hid, data: { id: hid, epiId: id, funcId: e.funcId || '', prodId: pid, item: e.item || '', tam: e.tam || '', ca: e.ca || '', caVal: e.caVal || '', qtd: +e.qtd || 1, devData: data, motivo, almoxDev: alm, almoxHig: ah, almoxAtual: alm, st, passos: [{ st, em: ts, por: conta.id, obs: 'Devolvido em condição de uso' }], cr: ts, crBy: conta.id } });
    }
    let tr = null;
    if (b.troca && b.troca.epi) {
      const t0 = Object.assign({}, b.troca.epi, { funcId: e.funcId, trocaDe: id, trocaMotivo: motivo });
      const m = montaEntrega(conta, t0, new Map()); if (m.erro) return erro('Nova entrega (troca): ' + m.erro, m.st);
      tr = m; n.trocaId = String(t0.id);
    }
    itens.unshift({ p: 'epi/' + id, velho: e, data: n });
    if (tr) itens.push(...tr.itens);
    const r = gravar(conta, req, itens, 'EPI_DEVOLUCAO', { epi: id, cond, motivo, desc, almoxDev: alm, almoxHig: cond === 'uso' ? ah : '', troca: tr ? n.trocaId : '' });
    if (r.erro) return r;
    r.msg = cond === 'uso' ? 'Devolução registrada: o EPI vai para a higienização.' : 'Devolução registrada: EPI descartado.'; return r;
  }

  /* ---------- higienização ---------- */
  const ST_NOME = { aguardando: 'Aguardando envio para higienização', transito: 'Em trânsito', hig: 'Em higienização', ok: 'Higienizado e retornado ao estoque', reprovado: 'Reprovado na higienização' };
  function rotaHig(conta, req, b) {
    b = b && typeof b === 'object' ? b : {};
    const acao = String(b.acao || ''), ids = Array.isArray(b.ids) ? b.ids.map(String).filter(x => ID_OK.test(x)) : [];
    if (!['enviar', 'receber', 'higienizado', 'reprovado'].includes(acao)) return erro('Ação inválida.', 400);
    if (!ids.length || ids.length > 500) return erro('Selecione os itens.', 400);
    const hs = ids.map(id => doc('epihig/' + id)); if (hs.some(h => !h)) return erro('Item de higienização não encontrado. Atualize a tela.', 404);
    const ts = Date.now(), data = dataOk(b.data) ? b.data : hoje(), obs = String(b.obs || '').slice(0, 300), itens = [];
    const passo = (h, st, extra) => Object.assign({}, h, extra || {}, { st, passos: (Array.isArray(h.passos) ? h.passos.slice(-49) : []).concat([{ st, em: ts, por: conta.id, data, obs: (extra && extra.motivoRep) || obs || '' }]) });
    if (acao === 'enviar') {
      const r0 = b.rom; if (!r0 || typeof r0 !== 'object' || !ID_OK.test(String(r0.id || ''))) return erro('Romaneio inválido.', 400);
      if (doc('rom/' + r0.id)) return erro('Romaneio já existe.', 409);
      const orig = String(hs[0].almoxAtual || '');
      for (const h of hs) { if (h.st !== 'aguardando') return erro('Só itens "' + ST_NOME.aguardando + '" são enviados (' + (h.item || '') + ': ' + (ST_NOME[h.st] || h.st) + ').', 409); if ((h.almoxAtual || '') !== orig) return erro('Envie juntos só itens do mesmo almoxarifado.', 400); }
      if (!(admin(conta) || podeEpi(conta, hs[0].epiId) || podeHig(conta, orig) || gravaCol(conta, 'mov'))) return erro('Seu perfil não envia EPI para higienização.');
      const dest = hs[0].almoxHig || almHig(); if (!dest || dest === orig) return erro('O almoxarifado de higienização não está definido (Configurações › EPI) ou é o próprio almoxarifado.', 400);
      const rom = Object.assign({}, r0, { almoxId: orig, destTipo: 'almox', destAlmoxId: dest, status: r0.status === 'conferido' ? 'conferido' : 'rascunho', epiHig: ids.slice(), sepIds: [],
        itens: hs.map(h => ({ origem: 'livre', desc: 'EPI para higienização: ' + (h.item || '') + (h.tam ? ' tam. ' + h.tam : '') + (h.ca ? ' · CA ' + h.ca : '') + ' · devolvido por ' + nomeFunc(h.funcId), un: 'UN', qtd: +h.qtd || 1, vol: '', peso: '', obs: '', higId: h.id })) });
      itens.push({ p: 'rom/' + rom.id, data: rom });
      hs.forEach(h => itens.push({ p: 'epihig/' + h.id, velho: h, data: passo(h, 'transito', { romId: rom.id, almoxHig: dest }) }));
    } else {
      const ah = hs[0].almoxHig || almHig();
      for (const h of hs) if ((h.almoxHig || ah) !== ah) return erro('Selecione itens de um mesmo almoxarifado de higienização.', 400);
      if (!podeHig(conta, ah)) return erro('Quem registra a higienização é o responsável ou o substituto do almoxarifado de higienização (ou um administrador).');
      for (const h of hs) {
        if (acao === 'receber') {
          if (!(h.st === 'transito' || (h.st === 'aguardando' && (h.almoxAtual || '') === ah))) return erro((h.item || 'Item') + ': só itens em trânsito são recebidos (' + (ST_NOME[h.st] || h.st) + ').', 409);
          itens.push({ p: 'epihig/' + h.id, velho: h, data: passo(h, 'hig', { almoxAtual: ah, recEm: ts, recPor: conta.id }) });
        } else if (acao === 'higienizado') {
          if (h.st !== 'hig') return erro((h.item || 'Item') + ': só itens "' + ST_NOME.hig + '" são marcados como higienizados (' + (ST_NOME[h.st] || h.st) + ').', 409);
          let pid = h.prodId || ''; if (!pid && b.prodIds && b.prodIds[h.id]) { const p = doc('prod/' + String(b.prodIds[h.id])); if (!p || !ehEpi(p)) return erro('Produto inválido para ' + (h.item || '') + '.', 400); pid = p.id || String(b.prodIds[h.id]); }
          if (!pid) return erro((h.item || 'Item') + ': escolha o produto do cadastro (família ' + famCfg() + ') para o EPI voltar ao estoque.', 400);
          const mid = 'hgmv_' + h.id; if (doc('mov/' + mid)) return erro('Este EPI já voltou ao estoque.', 409);
          itens.push({ p: 'epihig/' + h.id, velho: h, data: passo(h, 'ok', { prodId: pid, higEm: ts, higPor: conta.id, higData: data, higObs: obs, movId: mid }) });
          itens.push({ p: 'mov/' + mid, data: { id: mid, data, prodId: pid, tipo: 'ajuste', qtd: +h.qtd || 1, custoUnit: 0, projId: '', almoxId: ah, epiId: h.epiId, higId: h.id, higienizado: true, obs: 'EPI higienizado (usado), devolvido por ' + nomeFunc(h.funcId) + (obs ? ' · ' + obs : '') } });
        } else {
          if (h.st !== 'hig') return erro((h.item || 'Item') + ': só itens "' + ST_NOME.hig + '" são reprovados.', 409);
          const mot = String(b.motivo || '').trim(); if (mot.length < 3) return erro('Informe o motivo da reprovação (descarte).', 400);
          itens.push({ p: 'epihig/' + h.id, velho: h, data: passo(h, 'reprovado', { repEm: ts, repPor: conta.id, repData: data, motivoRep: mot.slice(0, 200) }) });
        }
      }
    }
    if (acao === 'receber') { /* o romaneio de transferência dos EPI fica entregue quando todos os itens dele chegaram */
      const rec = new Set(ids);
      for (const rid of new Set(hs.map(h => h.romId).filter(Boolean))) { const ro = doc('rom/' + rid); if (!ro || ['entregue', 'divergencia', 'cancelado'].includes(ro.status)) continue;
        const todos = (Array.isArray(ro.epiHig) ? ro.epiHig : []).every(x => rec.has(x) || ((doc('epihig/' + x) || {}).st !== 'transito'));
        if (todos) itens.push({ p: 'rom/' + rid, velho: ro, data: Object.assign({}, ro, { status: 'entregue', entregueEm: data, recebidoPor: nomeConta(conta), obs: [ro.obs, 'Chegada dos EPI confirmada na Higienização de EPI'].filter(Boolean).join(' · ') }) }); }
    }
    const r = gravar(conta, req, itens, 'EPI_HIG_' + acao.toUpperCase(), { ids, acao, rom: b.rom ? b.rom.id : '' });
    if (r.erro) return r;
    r.msg = { enviar: 'Romaneio de transferência criado para a higienização.', receber: 'Chegada registrada: itens em higienização.', higienizado: 'Higienizado: o EPI voltou ao estoque.', reprovado: 'Reprovado na higienização: EPI descartado.' }[acao];
    return r;
  }

  /* ---------- migração única ---------- */
  const hashId = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
  function plano(prods, epis, fam) {
    const ehF = f => { const k = norm(f); return !!k && (k === norm(fam) || /^epis?$/.test(k) || /^equipamentos? de protecao individual$/.test(k)); };
    const marcar = prods.filter(p => p.epi === true && !ehF(p.familia) && !String(p.familia || '').trim()).map(p => ({ id: p.id, nome: p.nome || '' }));
    const outra = prods.filter(p => p.epi === true && !ehF(p.familia) && String(p.familia || '').trim()).map(p => ({ id: p.id, nome: p.nome || '', familia: p.familia }));
    const nomes = new Set(prods.map(p => norm(p.nome))), criar = new Map();
    epis.slice().sort((a, b) => String(b.entrega || '').localeCompare(String(a.entrega || ''))).forEach(e => {
      if (e.prodId) return; const k = norm(e.item); if (!k || nomes.has(k) || criar.has(k)) return;
      criar.set(k, { id: 'epi154_' + hashId(k), nome: String(e.item).trim(), familia: fam, epi: true, ca: e.ca || '', caVal: e.caVal || '', un: 'UN', minimo: 0, preco: 0, ncm: '', migV154: true });
    });
    return { marcar, outra, criar: [...criar.values()] };
  }
  function rotaMigrar(conta, req) {
    if (!admin(conta)) return erro('Só um administrador ou o dono unifica o estoque de EPI.');
    const c = cfgEmp(); if (c.epi154Mig) return { ok: true, ja: true, rel: c.epi154Mig };
    const pl = plano(col('prod'), col('epi'), famCfg()), itens = [];
    pl.marcar.forEach(m => { const p = doc('prod/' + m.id); if (p) itens.push({ p: 'prod/' + m.id, velho: p, data: Object.assign({}, p, { familia: famCfg() }) }); });
    pl.criar.forEach(n => { if (!doc('prod/' + n.id)) itens.push({ p: 'prod/' + n.id, data: n }); });
    const rel = { em: Date.now(), por: conta.id, familia: famCfg(), marcados: pl.marcar.map(x => x.nome), outraFamilia: pl.outra.map(x => x.nome + ' (' + x.familia + ')'), criados: pl.criar.map(x => x.nome), saldo: 'Os saldos ficaram como estavam: o estoque de EPI já era o saldo do produto no cadastro. Os produtos criados começam com saldo zero (antes eram só o nome digitado na entrega).' };
    const cv = doc('cfg/empresa');
    itens.push({ p: 'cfg/empresa', velho: cv, data: Object.assign({}, cv || { id: 'empresa' }, { epi154Mig: rel }) });
    const r = gravar(conta, req, itens, 'EPI_MIGRACAO', { marcados: rel.marcados.length, criados: rel.criados.length }); if (r.erro) return r;
    r.rel = rel; return r;
  }

  /* ---------- gravação comum ---------- */
  const PROT_EPI = ['prodId', 'qtd', 'almoxId', 'movId', 'devolucao', 'devCond', 'devDestino', 'higId', 'trocaId', 'devAlmox'];
  const igualJ = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  function antes(conta, c0, id, velho, novo) {
    if (ROTA) return null;
    if (c0 === 'epihig') return erro('A higienização de EPI muda só pelos botões da tela Higienização de EPI (o servidor registra cada passo).', 409);
    if (c0 === 'mov') {
      if ((novo && (novo.epiId || novo.higId || novo.higienizado)) || (velho && (velho.epiId || velho.higId))) return erro('Movimento de estoque ligado a EPI (entrega, devolução ou higienização) só é gravado pela entrega de EPI e pela tela Higienização de EPI. EPI devolvido volta ao estoque só depois de marcado como Higienizado.', 409);
      return null;
    }
    if (c0 === 'epi') {
      if (!velho) { if (novo && (novo.movId || novo.higId || novo.devCond)) return erro('A entrega de EPI com baixa no estoque é registrada pela própria tela (Controle de EPI › Nova entrega), que grava a entrega e a baixa juntas.', 409); return null; }
      const v154 = velho.movId || velho.higId || velho.devCond;
      for (const k of PROT_EPI) if (!igualJ(velho[k], novo[k]) && (v154 || ['movId', 'higId', 'devCond', 'trocaId', 'devAlmox'].includes(k))) return erro('Produto, quantidade, almoxarifado e devolução de uma entrega de EPI com baixa no estoque não mudam por edição. Use Devolução (e uma nova entrega).', 409);
    }
    return null;
  }
  function antesExcluir(conta, c0, id, velho) {
    if (ROTA || !velho) return null;
    if (c0 === 'epihig' && !ehDono(conta)) return erro('Registro de higienização de EPI não se exclui.', 409);
    if (c0 === 'mov' && (velho.epiId || velho.higId) && !ehDono(conta)) return erro('Movimento de estoque de EPI não se exclui: registre a devolução.', 409);
    if (c0 === 'epi' && (velho.movId || velho.higId) && !admin(conta)) return erro('Entrega de EPI com baixa no estoque não se exclui: registre a devolução.', 409);
    return null;
  }
  function eventos() {
    const ev = [];
    for (const h of col('epihig')) {
      if (h.st !== 'aguardando' && h.st !== 'hig' && h.st !== 'transito') continue;
      const alm = h.st === 'aguardando' ? h.almoxAtual : h.almoxHig;
      const quem = C153 ? C153.quem(alm) : [];
      ev.push({ k: 'hig154:' + h.id + ':' + h.st, quem, tipo: h.st === 'aguardando' ? 'EPI devolvido para enviar à higienização' : h.st === 'transito' ? 'EPI a caminho da higienização' : 'EPI para higienizar',
        txt: (h.item || 'EPI') + (h.tam ? ' tam. ' + h.tam : '') + ' devolvido por ' + nomeFunc(h.funcId) + ' em ' + String(h.devData || '').split('-').reverse().join('/') + ': ' + (ST_NOME[h.st] || '') + '. Veja CIPA e SST › Higienização de EPI.' });
    }
    return ev;
  }
  /* GET /api/epi/estoque: quem registra EPI (RH e SST não leem o cadastro de produtos nem os almoxarifados) recebe só o que a
     entrega precisa: almoxarifados ativos e os produtos da família EPI com o saldo de cada almoxarifado. */
  function rotaEstoque(conta) {
    if (!podeEpi(conta, 'novo')) return erro('Seu perfil não registra entrega de EPI.');
    const als = col('almox').filter(a => a && a.ativo !== false).map(a => ({ id: a.id, nome: a.nome || '', cidade: a.cidade || '', uf: a.uf || '', principal: a.principal === true, respUid: a.respUid || '', substUid: a.substUid || '', ativo: true }));
    const prods = col('prod').filter(ehEpi).map(p => { const sd = {}; if (als.length) als.forEach(a => { const q = saldo(p.id, a.id); if (Math.abs(q) > 1e-9) sd[a.id] = q; }); else sd[''] = saldo(p.id);
      return { id: p.id, nome: p.nome || '', sku: p.sku || '', un: p.un || '', familia: p.familia || '', epi: p.epi === true, ca: p.ca || '', caVal: p.caVal || '', tam: p.tam || '', vidaEpi: p.vidaEpi || '', minimo: +p.minimo || 0, saldos: sd }; });
    return { ok: true, fam: famCfg(), almHig: almHig(), almox: als, prods };
  }
  async function rota(p, m, req, res, conta) {
    const { lerJson, json } = X;
    if (m === 'GET' && p === '/api/epi/estoque') { const r = rotaEstoque(conta); json(res, r.erro ? r.st || 403 : 200, r.erro ? { code: 'not_granted', erro: r.erro } : r); return true; }
    const R = async fn => { const b = await lerJson(req), r = fn(b || {}); if (r.erro) return json(res, r.st || 403, { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : 'not_granted', erro: r.erro }); return json(res, 200, r); };
    if (m !== 'POST') return false;
    if (p === '/api/epi/entrega') { await R(b => rotaEntrega(conta, req, b)); return true; }
    if (p === '/api/epi/devolucao') { await R(b => rotaDevolucao(conta, req, b)); return true; }
    if (p === '/api/epihig') { await R(b => rotaHig(conta, req, b)); return true; }
    if (p === '/api/epi/migrar') { await R(() => rotaMigrar(conta, req)); return true; }
    return false;
  }
  return { rota, antes, antesExcluir, eventos, saldo, almHig, ehEpi, plano };
};

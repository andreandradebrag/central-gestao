'use strict';
/* v163 (relatorios/feito_v163.md): manutenção sem contas a pagar (custo pela nota), aprovador de compras por obra e entrega
   de EPI integrada com o estoque, o romaneio de transferência e o recibo. Ligado em regras.js por v163/ed_v163.py.
   1. Manutenção de veículos (vman) e de equipamentos (fman): a gravação não cria nem muda conta a pagar (gerarLanc, lancId).
      O custo vem das notas fiscais de entrada ligadas (notas163: nota inteira ou linhas); o servidor confere cada nota
      (existe, é de entrada, não cancelada, não ligada duas vezes) e recalcula número, fornecedor e valor; o valor da
      manutenção é a soma das notas ligadas. Manutenção antiga com conta a pagar fica como está (campos financeiros
      intocados, sem nota). Conta a pagar nova "Manutenção · …" sem nota (o caminho antigo da tela) é recusada.
   2. Aprovador de compras (nível 1) por obra: proj.aprovC163 e o substituto proj.aprovS163. A SC da obra é aprovada por ele;
      com ele ausente (substituto ativo em Início › Matriz de aprovadores, cfg.aprovSubst), pelo substituto da obra (sem
      substituto da obra: o substituto do período). Quem pediu nunca aprova a própria (vale o substituto). O Administrador e o
      dono continuam aprovando. Sem aprovador na obra: a regra de sempre. /api/aprov/quem mostra a pessoa certa.
   3. EPI: só RH, Segurança do trabalho (gestor e técnico) e Administrador registram entrega (nova, em lote ou na troca).
      POST /api/epi163/entregas {epis:[…], rom}: cada EPI sai do almoxarifado do colaborador (entrega + baixa, como a v154)
      ou, sem saldo lá, vira um pedido de transferência (coleção epitr) com o romaneio de transferência (Tuiuti → São Paulo),
      tudo numa transação. POST /api/epi163/concluir {id}: com o romaneio recebido no destino, grava a entrega e a baixa.
      POST /api/epi163/cancelar {id}. GET /api/epi163/pend: pedidos de transferência com a situação do romaneio.
      CA vencido é recusado. epitr só muda por essas rotas.
   4. POST /api/man163/ligar {col, rec}: a nota ligada pela própria nota (Fiscal ou Comprador, que não gravam manutenção).
      Manutenção existente: muda só notas163 (e o fornecedor vazio); nova: manutenção concluída com a nota. */
module.exports = function (X) {
  const { col, doc, erro, auditar, ehDono, perfilEm, papelConta, cfgEmp, notaTotais, lerJson, json } = X;
  const C154 = () => X.C154();
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const r2 = v => Math.round((+v || 0) * 100) / 100;
  const r4 = v => Math.round((+v || 0) * 10000) / 10000;
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const admin = conta => ehDono(conta) || perfilEm(conta, ['admin']);
  const uniq = a => [...new Set(a.filter(Boolean))];
  let ROTA = false;

  /* ---------- 1. manutenção ---------- */
  const MAN = { vman: 'veicId', fman: 'ferrId' };
  const FIN = ['gerarLanc', 'lancId', 'venc', 'pago', 'contaId', 'comum'];
  const vt = i => (+i.qtd || 0) * (+i.vUnit || 0);
  function valorLink(n, l) {
    const t = notaTotais(n), its = Array.isArray(n.itens) ? n.itens : [];
    if (!Array.isArray(l)) return r2(t.vNF);
    const vp = its.reduce((s, i) => s + vt(i), 0), vl = l.reduce((s, k) => s + (its[k] ? vt(its[k]) : 0), 0);
    return vp > 0 ? r2(t.vNF * vl / vp) : 0;
  }
  const sobrepoe = (a, b) => !Array.isArray(a) || !Array.isArray(b) || a.some(k => b.includes(k));
  function antesMan(conta, c0, id, velho, novo) {
    if (!novo) return null;
    const v = velho || {};
    if (v.v163) novo.v163 = v.v163;
    if (v.lancId) { /* antes da v163, com conta a pagar: fica como está */
      for (const k of FIN.concat(['valor'])) { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; }
      if (Array.isArray(novo.notas163) && novo.notas163.length) return erro('Esta manutenção já tem conta a pagar (lançada antes da v163) e fica como está. Para ligar a nota fiscal, registre outra manutenção.', 409);
      delete novo.notas163; return null;
    }
    if (novo.gerarLanc === true || novo.gerarLanc === 'true' || novo.gerarLanc === 1) return erro('A manutenção não lança conta a pagar. O custo vem da nota fiscal (NFS-e da oficina ou compra de peças), lançada pelo Fiscal e ligada a esta manutenção.', 409);
    if (novo.lancId) return erro('A manutenção não se liga a conta a pagar: ligue a nota fiscal.', 409);
    FIN.forEach(k => delete novo[k]);
    if (!velho) novo.v163 = 1;
    const ls = novo.notas163;
    if (ls !== undefined && ls !== null) {
      if (!Array.isArray(ls) || ls.length > 30) return erro('Notas da manutenção inválidas.', 400);
      const out = [], aqui = [];
      for (const x of ls) {
        const nid = String((x && x.notaId) || ''); if (!ID_OK.test(nid)) return erro('Nota fiscal inválida.', 400);
        const n = doc('notas/' + nid);
        if (!n || n.tipo !== 'entrada' || n.status === 'cancelada') return erro('Nota fiscal não encontrada, de saída ou cancelada (' + ((x && x.num) || nid) + ').', 400);
        let l = null;
        if (Array.isArray(x.l)) {
          const its = Array.isArray(n.itens) ? n.itens : [];
          l = [...new Set(x.l.map(Number))].filter(k => Number.isInteger(k) && k >= 0 && k < its.length).sort((a, b) => a - b);
          if (!l.length) return erro('Escolha as linhas da nota nº ' + (n.numero || '') + ' (ou a nota inteira).', 400);
        }
        if (aqui.some(o => o.notaId === nid && sobrepoe(o.l, l))) return erro('A nota nº ' + (n.numero || '') + ' foi ligada duas vezes.', 400);
        for (const c of Object.keys(MAN)) for (const r of col(c)) {
          if (r.id === id && c === c0) continue;
          for (const o of Array.isArray(r.notas163) ? r.notas163 : []) if (o.notaId === nid && sobrepoe(o.l, l))
            return erro('A nota nº ' + (n.numero || '') + (Array.isArray(l) ? ' (essas linhas)' : '') + ' já está ligada a outra manutenção (' + (c === 'vman' ? 'veículo' : 'equipamento') + ', ' + String(r.data || r.abertura || '').split('-').reverse().join('/') + '). O custo seria contado duas vezes.', 409);
        }
        const p = n.parcId ? doc('parc/' + n.parcId) : null;
        const o = { notaId: nid, l, num: String(n.numero || ''), serie: String(n.serie || ''), modelo: n.modelo === 'nfse' ? 'nfse' : 'nfe', parcId: n.parcId || '', forn: p ? String(p.nome || p.fantasia || '') : '', emissao: n.emissao || '', projId: n.projId || '', valor: valorLink(n, l), em: +x.em || Date.now(), por: typeof x.por === 'string' && x.por ? x.por : conta.id };
        aqui.push(o); out.push(o);
      }
      novo.notas163 = out;
    }
    if (Array.isArray(novo.notas163) && novo.notas163.length) novo.valor = r2(novo.notas163.reduce((s, o) => s + (+o.valor || 0), 0));
    else if (novo.v163) novo.valor = '';
    return null;
  }
  /* pela nota (Ver nota › Ligar a veículo ou equipamento): quem lança a nota (Fiscal, Comprador) não grava manutenção; a rota
     grava só a ligação (manutenção existente: só notas163; nova: manutenção concluída com a nota) */
  const CAMPOS_NOVA = { vman: ['veicId', 'data', 'tipo', 'status', 'parcId', 'desc'], fman: ['ferrId', 'abertura', 'conclusao', 'tipo', 'parcId', 'desc'] };
  function rotaLigar(conta, req, b) {
    const c = String(b.col || ''); if (!MAN[c]) return erro('Tipo inválido.', 400);
    if (!(admin(conta) || X.gravaCol(conta, 'notas') || X.gravaCol(conta, c))) return erro('Seu perfil não liga notas a veículos ou equipamentos.');
    const r = b.rec && typeof b.rec === 'object' && !Array.isArray(b.rec) ? b.rec : null; if (!r || !ID_OK.test(String(r.id || ''))) return erro('Manutenção inválida.', 400);
    const id = String(r.id), k = MAN[c], velho = doc(c + '/' + id);
    if (!Array.isArray(r.notas163) || !r.notas163.length) return erro('Escolha a nota.', 400);
    let novo;
    if (velho) {
      if (String(r[k] || '') !== String(velho[k] || '')) return erro('A manutenção escolhida é de outro ' + (c === 'vman' ? 'veículo' : 'equipamento') + '.', 400);
      novo = Object.assign({}, velho, { notas163: r.notas163 }); if (!novo.parcId && r.parcId) novo.parcId = String(r.parcId);
    } else {
      const alvo = doc((c === 'vman' ? 'veic/' : 'ferr/') + String(r[k] || '')); if (!alvo) return erro(c === 'vman' ? 'Veículo não encontrado.' : 'Equipamento não encontrado.', 400);
      novo = { id }; for (const f of CAMPOS_NOVA[c]) if (r[f] !== undefined) novo[f] = typeof r[f] === 'string' ? r[f].slice(0, 300) : r[f];
      Object.assign(novo, c === 'vman' ? { km: '', proxKm: '', proxData: '', status: 'concluida', obs: '' } : { proxData: '', obs: '' }); novo.notas163 = r.notas163;
    }
    ROTA = true;
    let x; try { x = C154().gravar(conta, req, [{ p: c + '/' + id, velho: velho || null, data: novo }], 'MAN_NOTA_163', { col: c, id, notas: r.notas163.map(o => o && o.notaId).filter(Boolean) }); } finally { ROTA = false; }
    if (x.erro) return x; x.msg = 'Nota ligada à manutenção.'; return x;
  }
  function antesLanc(conta, velho, novo) {
    if (velho || !novo || novo.notaId) return null;
    if (novo.tipo === 'pagar' && /^Manutenção · /.test(String(novo.desc || ''))) return erro('Conta a pagar de manutenção não é criada pela tela de manutenção: o custo vem da nota fiscal da oficina ou da compra de peças.', 409);
    return null;
  }

  /* ---------- 2. aprovador de compras por obra ---------- */
  const substAtivos = () => { const h = hoje(); return (Array.isArray(cfgEmp().aprovSubst) ? cfgEmp().aprovSubst : []).filter(s => s && s.de && s.para && !s.cancelado && (!s.ini || String(s.ini) <= h) && (!s.fim || h <= String(s.fim))); };
  const ausente = u => !!u && substAtivos().some(s => s.de === u);
  /* null = a obra não tem aprovador (vale a regra de sempre) */
  function aprovObra(sc) {
    const p = sc && sc.projId ? doc('proj/' + String(sc.projId)) : null;
    if (!p || !p.aprovC163) return null;
    const a = String(p.aprovC163), s = p.aprovS163 ? String(p.aprovS163) : '', fora = [sc.solUid].filter(Boolean);
    const paras = substAtivos().filter(x => x.de === a).map(x => String(x.para));
    let pri, aus = ausente(a);
    if (aus) pri = s ? [s] : (paras.length ? paras : [a]); else pri = [a];
    pri = uniq(pri).filter(u => !fora.includes(u));
    if (!pri.length) pri = uniq(s ? [s] : paras).filter(u => !fora.includes(u));
    if (!pri.length) return null;
    return { pri, aprov: a, subst: s, aus };
  }
  function quemSc(sc) { const a = aprovObra(sc); return a ? a.pri : null; }
  /* chamado por P2N.regraScAprov no lugar de ehAprovMat: true/false */
  function podeAprovSc(conta, velho, novo, ehAprovMat) {
    const sc = Object.assign({}, velho || {}, novo || {}), a = aprovObra(sc);
    if (!a) return ehAprovMat(conta);
    if (admin(conta)) return true;
    return a.pri.includes(conta.id);
  }
  function msgSc(velho, novo) {
    const sc = Object.assign({}, velho || {}, novo || {}), a = aprovObra(sc); if (!a) return '';
    return 'Esta solicitação é da obra ' + ((doc('proj/' + sc.projId) || {}).codigo || '') + ': quem aprova é o aprovador de compras da obra' + (a.aus ? ' (ausente: aprova o substituto)' : '') + '. Envie para aprovação.';
  }

  /* ---------- 3. EPI ---------- */
  const podeEntregar = conta => admin(conta) || perfilEm(conta, ['rh', 'sst', 'ssttec']);
  const MSG_EPI = 'Entrega de EPI é registrada pelo RH ou pela Segurança do trabalho (gestor ou técnico). O almoxarife separa e transfere o material.';
  const caVencido = (p, data) => !!(p && p.caVal && dataOk(p.caVal) && p.caVal < (data || hoje()));
  const numRom = () => String(Math.max(0, ...col('rom').map(r => parseInt(r.numero, 10) || 0)) + 1);
  const almAtivo = id => { const a = id ? doc('almox/' + id) : null; return a && a.ativo !== false ? a : null; };
  function rotaEntregas(conta, req, b) {
    if (!podeEntregar(conta)) return erro(MSG_EPI);
    const epis = Array.isArray(b.epis) ? b.epis : [];
    if (!epis.length || epis.length > 30) return erro('Escolha de 1 a 30 EPI.', 400);
    const E = C154(), usados = new Map(), itens = [], trs = [], resumo = [];
    const romId = b.rom && ID_OK.test(String(b.rom.id || '')) ? String(b.rom.id) : '';
    let orig = '', dest = '', fid = '';
    for (const e0 of epis) {
      if (!e0 || typeof e0 !== 'object') return erro('EPI inválido.', 400);
      const p = doc('prod/' + String(e0.prodId || ''));
      if (p && caVencido(p, dataOk(e0.entrega) ? e0.entrega : hoje())) return erro('O CA de ' + (p.nome || 'EPI') + ' está vencido (' + String(p.caVal).split('-').reverse().join('/') + '). Entrega bloqueada: atualize o CA no cadastro do produto ou escolha outro EPI.', 409);
      if (fid && String(e0.funcId || '') !== fid) return erro('Na entrega em lote todos os EPI são do mesmo colaborador.', 400);
      fid = String(e0.funcId || '');
      if (e0.modo163 !== 'transf') {
        const e1 = Object.assign({}, e0); delete e1.modo163; delete e1.almoxOrig163;
        const m = E.montaEntrega(conta, e1, usados); if (m.erro) return m;
        itens.push(...m.itens); resumo.push({ epi: e1.id, modo: 'local', qtd: m.resumo.qtd });
        continue;
      }
      /* transferência */
      const id = String(e0.id || ''); if (!ID_OK.test(id)) return erro('EPI inválido.', 400);
      if (doc('epitr/' + id) || doc('epi/' + id)) return erro('Esta entrega já existe. Atualize a tela.', 409);
      const f = doc('func/' + fid); if (!f) return erro('Colaborador não encontrado.', 400);
      if (!p || !E.ehEpi(p)) return erro('Escolha o EPI no cadastro de produtos (família EPI).', 400);
      const qt = r4(e0.qtd === '' || e0.qtd == null ? 1 : e0.qtd); if (!(qt > 0)) return erro('Quantidade inválida.', 400);
      const o = String(e0.almoxOrig163 || ''), d = String(e0.almoxId || '');
      if (!almAtivo(o) || !almAtivo(d) || o === d) return erro('Transferência: escolha o almoxarifado de origem e o de destino (diferentes).', 400);
      if (orig && (o !== orig || d !== dest)) return erro('Numa entrega em lote, a transferência sai de um almoxarifado só para um destino só.', 400);
      orig = o; dest = d;
      const pid = String(e0.prodId), k = pid + '|' + o, ja = usados.get(k) || 0, sd = E.saldo(pid, o);
      if (sd - ja - qt < -1e-9) return erro('Sem saldo de ' + (p.nome || 'EPI') + ' no almoxarifado ' + ((doc('almox/' + o) || {}).nome || '') + ' para transferir (saldo ' + String(r4(sd - ja)).replace('.', ',') + ').', 409);
      usados.set(k, ja + qt);
      const tr = { id, funcId: fid, prodId: pid, item: String(e0.item || p.nome || ''), tam: String(e0.tam || p.tam || ''), ca: String(e0.ca || p.ca || ''), caVal: String(e0.caVal || p.caVal || ''), vida: e0.vida || p.vidaEpi || '', qtd: qt, almoxId: d, almoxOrig: o, obs: String(e0.obs || '').slice(0, 500), st: 'transf', romId, cr: Date.now(), crBy: conta.id };
      trs.push(tr); resumo.push({ epi: id, modo: 'transf', qtd: qt });
    }
    if (trs.length) {
      if (!romId) return erro('Romaneio inválido.', 400);
      if (doc('rom/' + romId)) return erro('Romaneio já existe.', 409);
      const f = doc('func/' + fid) || {}, ao = doc('almox/' + orig) || {}, ad = doc('almox/' + dest) || {};
      const rom = { id: romId, numero: numRom(), data: hoje(), almoxId: orig, destTipo: 'almox', destAlmoxId: dest, projId: '', parcId: '', destNome: ad.nome || '', cep: '', end: '', num: '', compl: '', bairro: '', cidade: ad.cidade || '', uf: ad.uf || '', recebedor: '', recebedorTel: '', respObraId: '', transpModo: 'proprio', veicId: '', motoristaId: '', transpId: '', placa: '', prevSaida: hoje(), prevChegada: hoje(), sepIds: [], status: 'rascunho',
        obs: 'Transferência de EPI para entrega a ' + (f.nome || 'colaborador') + ' (pedida por RH/SST). Ao receber em ' + (ad.nome || 'destino') + ', o RH ou a Segurança do trabalho registra a entrega e a baixa.',
        itens: trs.map(t => { const p = doc('prod/' + t.prodId) || {}; return { origem: 'prod', prodId: t.prodId, desc: t.item + (t.tam && !/tam\./i.test(t.item) ? ' · tam. ' + t.tam : ''), cod: p.sku || '', un: p.un || 'UN', qtd: t.qtd, vol: '', peso: '', obs: 'EPI de ' + (f.nome || ''), solic: f.nome || '' }; }),
        epiTr163: trs.map(t => t.id), avisar163: [conta.id] };
      if (!ao.id && !doc('almox/' + orig)) return erro('Almoxarifado de origem não encontrado.', 400);
      itens.push({ p: 'rom/' + romId, data: rom });
      trs.forEach(t => itens.push({ p: 'epitr/' + t.id, data: t }));
    }
    ROTA = true;
    let r; try { r = E.gravar(conta, req, itens, 'EPI_ENTREGA_163', { func: fid, itens: resumo, rom: trs.length ? romId : '' }); } finally { ROTA = false; }
    if (r.erro) return r;
    const nl = resumo.filter(x => x.modo === 'local').length;
    r.msg = (nl ? nl + ' EPI entregue(s) com baixa no estoque. ' : '') + (trs.length ? trs.length + ' EPI aguardando a transferência (romaneio nº ' + ((itens.find(x => x.p === 'rom/' + romId) || {}).data || {}).numero + ').' : '');
    return r;
  }
  const ROM_OK = ['entregue', 'divergencia'];
  function rotaConcluir(conta, req, b) {
    if (!podeEntregar(conta)) return erro(MSG_EPI);
    const id = String(b.id || ''); if (!ID_OK.test(id)) return erro('Pedido inválido.', 400);
    const t = doc('epitr/' + id); if (!t) return erro('Pedido de transferência não encontrado.', 404);
    if (t.st !== 'transf') return erro('Este pedido já foi ' + (t.st === 'entregue' ? 'entregue' : 'cancelado') + '.', 409);
    const ro = t.romId ? doc('rom/' + t.romId) : null;
    if (!ro) return erro('O romaneio desta transferência não foi encontrado.', 409);
    if (!ROM_OK.includes(ro.status)) return erro('O romaneio nº ' + (ro.numero || '') + ' ainda não foi recebido em ' + ((doc('almox/' + t.almoxId) || {}).nome || 'destino') + ' (situação: ' + ({ rascunho: 'em montagem', conferido: 'conferido', transito: 'em trânsito', cancelado: 'cancelado' }[ro.status] || ro.status) + '). A entrega fica aguardando.', 409);
    const p = doc('prod/' + t.prodId);
    const ent = dataOk(b.entrega) ? b.entrega : hoje();
    if (caVencido(p, ent)) return erro('O CA de ' + ((p && p.nome) || 'EPI') + ' venceu. Entrega bloqueada: atualize o CA no cadastro.', 409);
    const e0 = { id, funcId: t.funcId, prodId: t.prodId, item: t.item, tam: t.tam, ca: t.ca, caVal: t.caVal, vida: t.vida, troca: +t.vida > 0 ? new Date(Date.parse(ent + 'T12:00:00Z') + Math.round(+t.vida) * 864e5).toISOString().slice(0, 10) : '', qtd: t.qtd, almoxId: t.almoxId, entrega: ent, assinado: false, obs: [t.obs, 'Recebido pelo romaneio nº ' + (ro.numero || '')].filter(Boolean).join(' · '), trf163: { romId: t.romId, romNum: ro.numero || '', de: t.almoxOrig } };
    const E = C154(), m = E.montaEntrega(conta, e0, new Map()); if (m.erro) return m;
    const n = Object.assign({}, t, { st: 'entregue', epiId: id, concEm: Date.now(), concPor: conta.id });
    ROTA = true;
    let r; try { r = E.gravar(conta, req, m.itens.concat([{ p: 'epitr/' + id, velho: t, data: n }]), 'EPI_ENTREGA_163_TRANSF', { epi: id, rom: t.romId }); } finally { ROTA = false; }
    if (r.erro) return r;
    r.msg = 'Entrega registrada e baixa no estoque de ' + ((doc('almox/' + t.almoxId) || {}).nome || 'destino') + '.'; return r;
  }
  function rotaCancelar(conta, req, b) {
    if (!podeEntregar(conta)) return erro(MSG_EPI);
    const id = String(b.id || ''); if (!ID_OK.test(id)) return erro('Pedido inválido.', 400);
    const t = doc('epitr/' + id); if (!t) return erro('Pedido de transferência não encontrado.', 404);
    if (t.st !== 'transf') return erro('Este pedido não está aguardando transferência.', 409);
    const mot = String(b.motivo || '').trim(); if (mot.length < 3) return erro('Informe o motivo do cancelamento.', 400);
    const itens = [{ p: 'epitr/' + id, velho: t, data: Object.assign({}, t, { st: 'cancelada', cancEm: Date.now(), cancPor: conta.id, cancMotivo: mot.slice(0, 300) }) }];
    const ro = t.romId ? doc('rom/' + t.romId) : null;
    if (ro && ro.status === 'rascunho' && (Array.isArray(ro.epiTr163) ? ro.epiTr163 : []).every(x => x === id || ((doc('epitr/' + x) || {}).st !== 'transf')))
      itens.push({ p: 'rom/' + ro.id, velho: ro, data: Object.assign({}, ro, { status: 'cancelado', obs: [ro.obs, 'Cancelado: pedido de EPI cancelado (' + mot.slice(0, 120) + ')'].filter(Boolean).join(' · ') }) });
    ROTA = true;
    let r; try { r = C154().gravar(conta, req, itens, 'EPI_TRANSF_163_CANCELADA', { epi: id, motivo: mot.slice(0, 120) }); } finally { ROTA = false; }
    if (r.erro) return r; r.msg = 'Pedido de transferência cancelado.'; return r;
  }
  function rotaPend(conta) {
    if (!(podeEntregar(conta) || X.leSst(conta))) return erro('Sem acesso.');
    const out = col('epitr').filter(t => t.st === 'transf').map(t => { const ro = t.romId ? doc('rom/' + t.romId) : null; return { id: t.id, romId: t.romId || '', romNum: ro ? ro.numero || '' : '', romSt: ro ? ro.status || '' : 'sumiu', pronta: !!(ro && ROM_OK.includes(ro.status)) }; });
    return { ok: true, pend: out };
  }

  /* ---------- gravação comum ---------- */
  function antes(conta, c0, id, velho, novo) {
    if (c0 === 'vman' || c0 === 'fman') return antesMan(conta, c0, id, velho, novo);
    if (c0 === 'lanc') return antesLanc(conta, velho, novo);
    if (c0 === 'epitr') return ROTA ? null : erro('O pedido de transferência de EPI muda só pela tela Controle de EPI (entregar, cancelar).', 409);
    if (c0 === 'epi' && !velho && !ROTA && !podeEntregar(conta)) return erro(MSG_EPI);
    return null;
  }
  function antesExcluir(conta, c0, id, velho) {
    if (c0 === 'epitr' && velho && !ehDono(conta)) return erro('Pedido de transferência de EPI não se exclui: use Cancelar.', 409);
    return null;
  }
  async function rota(p, m, req, res, conta) {
    const R = async fn => { const b = await lerJson(req), r = fn(b && typeof b === 'object' ? b : {}); if (r.erro) return json(res, r.st || 403, { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : 'not_granted', erro: r.erro }); return json(res, 200, r); };
    if (m === 'GET' && p === '/api/epi163/pend') { const r = rotaPend(conta); json(res, r.erro ? 403 : 200, r.erro ? { code: 'not_granted', erro: r.erro } : r); return true; }
    if (m !== 'POST') return false;
    if (p === '/api/man163/ligar') { await R(b => rotaLigar(conta, req, b)); return true; }
    if (p === '/api/epi163/entregas') { await R(b => rotaEntregas(conta, req, b)); return true; }
    if (p === '/api/epi163/concluir') { await R(b => rotaConcluir(conta, req, b)); return true; }
    if (p === '/api/epi163/cancelar') { await R(b => rotaCancelar(conta, req, b)); return true; }
    /* rotas da v154: quem entrega e CA vencido (o resto continua no epi154.js) */
    if (p === '/api/epi/entrega' || p === '/api/epi/devolucao') {
      const b = await lerJson(req), body = b && typeof b === 'object' ? b : {};
      req.__corpo163 = body;
      const nova = p === '/api/epi/entrega' ? body.epi : (body.troca && body.troca.epi);
      if (nova && !podeEntregar(conta)) { auditar(conta, req, 'EPI_ENTREGA_NEGADA', p, null, null); json(res, 403, { code: 'not_granted', erro: MSG_EPI }); return true; }
      if (nova) { const pr = doc('prod/' + String(nova.prodId || '')); if (caVencido(pr, dataOk(nova.entrega) ? nova.entrega : hoje())) { json(res, 409, { code: 'conflict', erro: 'O CA de ' + (pr.nome || 'EPI') + ' está vencido. Entrega bloqueada: atualize o CA no cadastro do produto.' }); return true; } }
      return false;
    }
    return false;
  }
  return { antes, antesExcluir, rota, quemSc, aprovObra, podeAprovSc, msgSc, podeEntregar, valorLink };
};

'use strict';
/* v143 (relatorios/feito_v143_parte6.md): aprovação da medição ao cliente pelo Comercial.
   A obra prepara o boletim e envia para aprovação (aprovSt 'enviada'); o Comercial aprova (status 'aprovada', regra de
   sempre em regras.js › regraMedCli: quem grava Contratos ou a diretoria, e quem lançou não aprova) ou devolve com motivo
   (aprovSt 'devolvida'). A situação continua 'rascunho' até a aprovação, então o que conta como "medido" não muda.
   Este módulo roda logo depois de regraMedCli (regras.js) e:
     1. aprovação só de medição enviada (o dono pode aprovar direto, como já podia aprovar a própria);
     2. envio: só de rascunho, carimba envPor/envEm;
     3. devolução: só de medição enviada, por quem aprova (Contratos ou diretoria), nunca quem lançou ou enviou (o dono
        pode), com motivo de pelo menos 5 letras; carimba devPor/devEm/devMotivo;
     4. enquanto enviada, o conteúdo do boletim não muda (período, itens, valor, reajuste, observações, contrato, número);
     5. carimbos e histórico (fluxoHist) só o servidor escreve: o que vier do navegador é trocado pelo valor guardado.
   Ligação: em regras.js, `MEDF(conta, req, velho, novo)` logo depois de regraMedCli.
   v144 (relatorios/feito_v144_reabmed.md): Reabrir medição. Aprovada ou faturada só volta para rascunho pela rota
   POST /api/med/reabrir (rotaReabrir, abaixo), que desfaz o faturamento numa transação só. Pela gravação comum, voltar
   de aprovada/faturada é recusado; os carimbos da reabertura (reabPor, reabEm, reabMotivo) e a lista das NFS-e
   canceladas da medição (nfseAnt) também são do servidor. */
let REAB = null; /* registro que a rota POST /api/med/reabrir está gravando (a rota é síncrona: não se mistura) */
const reabrindo = novo => !!REAB && !!novo && REAB === novo;
module.exports = function ({ ehDono, ehDiretor, gravaGrupo, erro, ipDe, igual, acaoNeg }) {
  const PROT = ['envPor', 'envEm', 'devPor', 'devEm', 'devMotivo', 'fluxoHist', 'reabPor', 'reabEm', 'reabMotivo', 'nfseAnt'];
  const CONTEUDO = ['ini', 'fim', 'itens', 'valor', 'reajPct', 'obs', 'ctrId', 'numero'];
  const aprova = conta => ehDiretor(conta) || gravaGrupo(conta, 'ctr', 'dir');
  function regraMedFluxo(conta, req, velho, novo) {
    if (!novo) return null;
    if (reabrindo(novo)) return null; /* v144: montado pela própria rota de reabertura */
    const v = velho || {}, vs = v.status || 'rascunho', ns = novo.status || 'rascunho', va = v.aprovSt || '', agora = Date.now(), eu = conta && conta.id;
    /* v144: aprovada ou faturada não volta (nem faturada volta para aprovada) pela gravação comum */
    if (velho && ((vs === 'aprovada' && ns === 'rascunho') || (vs === 'faturada' && (ns === 'rascunho' || ns === 'aprovada'))))
      return erro('Medição ' + (vs === 'faturada' ? 'faturada' : 'aprovada') + ' só volta para rascunho pelo botão Reabrir medição, com o motivo (o servidor desfaz o faturamento junto).', 409);
    const hist = Array.isArray(v.fluxoHist) ? v.fluxoHist.slice(-49) : [];
    const pedido = novo.aprovSt || '', motivo = String(novo.devMotivo || '').trim();
    /* 5. o navegador não escreve carimbo nem histórico */
    PROT.forEach(k => { if (v[k] !== undefined) novo[k] = v[k]; else delete novo[k]; });
    novo.aprovSt = va || undefined; if (!novo.aprovSt) delete novo.aprovSt;
    const ip = req && ipDe ? ipDe(req) : '';
    /* 1. aprovação */
    if (ns === 'aprovada' && vs !== 'aprovada') {
      if (va !== 'enviada' && !ehDono(conta)) return erro('A medição precisa ser enviada para aprovação pela obra antes (Obras › Medições ao cliente › Enviar para aprovação).');
      if (!ehDono(conta) && eu && va === 'enviada' && eu === v.envPor) return erro('Quem enviou a medição para aprovação não a aprova. Peça a outra pessoa do Comercial.');
      if (acaoNeg && acaoNeg(conta, 'aprovar')) return erro('Seu perfil está sem a ação "Aprovar".');
      novo.aprovSt = 'aprovada'; hist.push({ ac: 'aprovada', por: eu, em: agora, ip }); novo.fluxoHist = hist; return null;
    }
    if (vs !== 'rascunho' || ns !== 'rascunho') return null; /* aprovada/faturada: segue o resto das regras */
    const autor = v.lancPor || v.crBy || '';
    /* 2. envio */
    if (pedido === 'enviada' && va !== 'enviada') {
      novo.aprovSt = 'enviada'; novo.envPor = eu; novo.envEm = agora; hist.push({ ac: 'enviada', por: eu, em: agora, ip }); novo.fluxoHist = hist; return null;
    }
    if (va === 'enviada') {
      /* 3. devolução */
      if (pedido === 'devolvida') {
        if (!aprova(conta)) return erro('Seu perfil não devolve medição ao cliente (quem aprova é quem grava em Contratos ou a diretoria).');
        if (!ehDono(conta) && eu && (eu === autor || eu === v.envPor)) return erro('Quem lançou ou enviou a medição não decide sobre ela. Peça a outra pessoa do Comercial.');
        if (acaoNeg && acaoNeg(conta, 'aprovar')) return erro('Seu perfil está sem a ação "Aprovar" (também vale para devolver).');
        if (motivo.length < 5) return erro('Informe o motivo da devolução (pelo menos 5 letras).', 400);
        for (const k of CONTEUDO) if (!igual(v[k], novo[k])) return erro('Na devolução o boletim não muda; a obra corrige depois.', 400);
        novo.aprovSt = 'devolvida'; novo.devPor = eu; novo.devEm = agora; novo.devMotivo = motivo.slice(0, 500);
        hist.push({ ac: 'devolvida', por: eu, em: agora, ip, motivo: motivo.slice(0, 500) }); novo.fluxoHist = hist; return null;
      }
      /* 4. enviada: o boletim fica parado até a decisão */
      for (const k of CONTEUDO) if (!igual(v[k], novo[k])) return erro('A medição está aguardando aprovação do Comercial e não pode ser alterada. Peça para devolverem.', 409);
      return null;
    }
    return null;
  }
  regraMedFluxo.reabrindo = reabrindo;
  return regraMedFluxo;
};

/* v144: POST /api/med/reabrir {id, motivo}. Quem aprova (quem grava Contratos ou a diretoria, com a ação "Aprovar" do
   perfil; o dono sempre) volta a medição aprovada ou faturada para rascunho (aprovSt 'reaberta'), com o motivo.
   Faturada: a NFS-e em rascunho é excluída e a conta a receber da retenção é cancelada (não excluída), na mesma
   transação. NFS-e já emitida bloqueia (cancele na prefeitura e registre o cancelamento no sistema; depois a NFS-e
   cancelada fica guardada em nfseAnt). Retenção com recebimento bloqueia. Cada documento passa pelas regras de sempre
   (permissão do módulo, competência fechada, ação "Cancelar e estornar"...) antes de gravar; nada é gravado se um falhar. */
module.exports.rotaReabrir = function (D) {
  const { doc, col, db, q, avisarDoc, depois, auditar, erro, ipDe, ehDono, ehDiretor, gravaGrupo, acaoNeg, pode, perfilPermite, gravacaoPermitida, excecaoGravacao, antesGravar, antesExcluir } = D;
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const aprova = conta => ehDono(conta) || ehDiretor(conta) || gravaGrupo(conta, 'ctr', 'dir');
  const QUEM_FAT = 'Reabrir uma medição faturada exclui o rascunho da NFS-e (módulo Notas) e cancela a conta a receber da retenção (Financeiro). Peça a quem emite as notas: Fiscal com acesso a Contratos ou um administrador.';
  const brl = v => (+v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dt = s => /^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(8, 10) + '/' + String(s).slice(5, 7) + '/' + String(s).slice(0, 4) : String(s || '');
  return function rotaReabrir(conta, req, b) {
    b = b && typeof b === 'object' ? b : {};
    const id = String(b.id || ''), p = 'med/' + id, motivo = String(b.motivo || '').trim().slice(0, 500);
    if (!ID_OK.test(id)) return erro('Medição inválida.', 400);
    const velho = doc(p); if (!velho) return erro('Medição não encontrada.', 404);
    const nega = (txt, st) => { auditar(conta, req, 'MEDICAO_REABRIR_RECUSADO', p, null, { erro: txt }); return erro(txt, st); };
    if (!aprova(conta)) return nega('Seu perfil não reabre medição ao cliente. Quem reabre é quem aprova: quem grava em Contratos (Comercial) ou a diretoria.');
    if (acaoNeg && acaoNeg(conta, 'aprovar')) return nega('Seu perfil está sem a ação "Aprovar" (também vale para reabrir a medição).');
    if (!pode(conta, p, 'w') || !perfilPermite(conta, p, 'w')) return nega('Seu perfil não permite alterar medições.');
    const vs = velho.status || 'rascunho';
    if (vs !== 'aprovada' && vs !== 'faturada') return nega(vs === 'rascunho' ? 'Esta medição já está em rascunho (não foi aprovada). Atualize a tela.' : 'Só medição aprovada ou faturada é reaberta.', 409);
    if (motivo.replace(/[^A-Za-zÀ-ÿ]/g, '').length < 5) return nega('Escreva o motivo da reabertura (pelo menos 5 letras).', 400);
    const agora = Date.now(), ip = req && ipDe ? ipDe(req) : '', plano = [], ev = { ac: 'reaberta', por: conta.id, em: agora, ip, motivo, de: vs };
    let nfseAnt = Array.isArray(velho.nfseAnt) ? velho.nfseAnt.slice(-20) : [];
    if (vs === 'faturada') {
      const nid = String(velho.nfseId || ''), n = nid ? doc('nfse/' + nid) : null;
      /* qualquer NFS-e desta medição ainda valendo na prefeitura bloqueia */
      const emit = (n && n.status !== 'rascunho' && n.status !== 'cancelada') ? n : col('nfse').find(x => x && String(x.medId || '') === id && x.status !== 'rascunho' && x.status !== 'cancelada');
      if (emit) return nega('A NFS-e ' + (emit.numOficial || emit.numero || '') + ' desta medição já foi emitida na prefeitura. Para reabrir: cancele a nota no sistema da prefeitura e registre o cancelamento aqui (Fiscal › NFS-e (serviços) › Cancelar; o pedido de cancelamento é aprovado por outra pessoa do Financeiro). Depois de cancelada, a medição pode ser reaberta.', 409);
      if (n && n.status === 'rascunho') {
        const lk = col('lanc').find(l => l && String(l.nfseId || '') === nid && l.status !== 'cancelado');
        if (lk) return nega('O rascunho da NFS-e tem uma conta a receber ligada (' + (lk.desc || lk.id) + ', ' + brl(lk.valor) + '). Cancele essa conta no Financeiro antes de reabrir.', 409);
        plano.push({ c: 'nfse', i: nid, p: 'nfse/' + nid, del: true, vx: n }); ev.nfse = { id: nid, num: n.numero || '', st: 'excluida' };
      } else if (n && n.status === 'cancelada') { if (!nfseAnt.includes(nid)) nfseAnt.push(nid); ev.nfse = { id: nid, num: n.numOficial || n.numero || '', st: 'cancelada' }; }
      const rid = String(velho.retLancId || ''), l = rid ? doc('lanc/' + rid) : null;
      if (l && l.status !== 'cancelado') {
        if (l.pago) return nega('A conta a receber da retenção (' + brl(l.valor) + ') já tem recebimento em ' + dt(l.pago) + '. Estorne o recebimento no Financeiro antes de reabrir a medição.', 409);
        const nl = Object.assign(JSON.parse(JSON.stringify(l)), { status: 'cancelado', cancel: { motivo: 'Medição nº ' + (velho.numero || '') + ' reaberta: ' + motivo, por: conta.id, em: agora, srv: 1 } });
        nl.obs = [l.obs, 'Cancelado em ' + dt(new Date(agora - 3 * 3600e3).toISOString()) + ' (medição reaberta): ' + motivo].filter(Boolean).join(' ').slice(0, 2000);
        plano.push({ c: 'lanc', i: rid, p: 'lanc/' + rid, data: nl, vx: l }); ev.ret = { id: rid, valor: +l.valor || 0, st: 'cancelada' };
      }
    }
    const novo = JSON.parse(JSON.stringify(velho));
    ['aprovPor', 'aprovEm', 'aprovIp', 'nfseId', 'retLancId', 'fatEm'].forEach(k => delete novo[k]);
    const hist = Array.isArray(velho.fluxoHist) ? velho.fluxoHist.slice(-49) : []; hist.push(ev);
    Object.assign(novo, { id, status: 'rascunho', aprovSt: 'reaberta', reabPor: conta.id, reabEm: agora, reabMotivo: motivo, fluxoHist: hist });
    if (nfseAnt.length) novo.nfseAnt = nfseAnt; else delete novo.nfseAnt;
    plano.push({ c: 'med', i: id, p, data: novo, vx: velho });
    const prep = [];
    REAB = novo;
    try {
      for (const x of plano) {
        const nome = x.c === 'nfse' ? 'NFS-e em rascunho' : x.c === 'lanc' ? 'Conta a receber da retenção' : 'Medição';
        if (x.c !== 'med') {
          if (!pode(conta, x.p, 'w') || !perfilPermite(conta, x.p, 'w') || (!gravacaoPermitida(conta, x.p) && !excecaoGravacao(conta, x.p, x.vx, x.del ? null : x.data, x.del ? 'DELETE' : 'PUT'))) return nega('Seu perfil não grava ' + (x.c === 'nfse' ? 'NFS-e' : 'contas a receber') + '. ' + QUEM_FAT);
        }
        const v = x.del ? antesExcluir(conta, x.p, x.vx, req) : antesGravar(conta, x.p, x.vx, x.data, req);
        if (v && v.reauth) return nega('Confirme a senha e reabra de novo.', 409);
        if (v && v.erro) return nega(nome + ': ' + v.erro, v.st);
        prep.push({ x, v: v || {} });
      }
    } finally { REAB = null; }
    const ts = Date.now();
    db.exec('BEGIN');
    try {
      for (const { x, v } of prep) { if (x.del) q.docDel.run(x.p); else q.docPut.run(x.p, x.c, x.i, JSON.stringify(v.data || x.data), ts); }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } return erro('Falha ao gravar a reabertura. Nada foi alterado; tente de novo.', 500); }
    for (const { x, v } of prep) { const d = x.del ? null : (v.data || x.data); avisarDoc(x.del ? 'del' : 'set', x.p, d, ts); try { depois(conta, req, x.del ? 'DELETE' : 'PUT', x.p, x.vx, d, v); } catch (e) { } }
    auditar(conta, req, 'MEDICAO_REABERTA', p, null, { numero: velho.numero || '', ctrId: velho.ctrId || '', de: vs, motivo, nfse: ev.nfse || null, retencao: ev.ret || null });
    const fe = [ev.nfse && ev.nfse.st === 'excluida' ? 'o rascunho da NFS-e foi excluído' : '', ev.ret ? 'a conta a receber da retenção foi cancelada' : ''].filter(Boolean);
    return { ok: true, msg: 'Medição reaberta: voltou para rascunho' + (fe.length ? '; ' + fe.join(' e ') : '') + '.', docs: prep.filter(o => !o.x.del).map(o => ({ col: o.x.c, id: o.x.i, data: o.v.data || o.x.data })), dels: prep.filter(o => o.x.del).map(o => ({ col: o.x.c, id: o.x.i })) };
  };
};
module.exports.reabrindo = reabrindo;

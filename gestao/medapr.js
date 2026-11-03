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
   Ligação: em regras.js, `MEDF(conta, req, velho, novo)` logo depois de regraMedCli. */
module.exports = function ({ ehDono, ehDiretor, gravaGrupo, erro, ipDe, igual, acaoNeg }) {
  const PROT = ['envPor', 'envEm', 'devPor', 'devEm', 'devMotivo', 'fluxoHist'];
  const CONTEUDO = ['ini', 'fim', 'itens', 'valor', 'reajPct', 'obs', 'ctrId', 'numero'];
  const aprova = conta => ehDiretor(conta) || gravaGrupo(conta, 'ctr', 'dir');
  return function regraMedFluxo(conta, req, velho, novo) {
    if (!novo) return null;
    const v = velho || {}, vs = v.status || 'rascunho', ns = novo.status || 'rascunho', va = v.aprovSt || '', agora = Date.now(), eu = conta && conta.id;
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
  };
};

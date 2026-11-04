'use strict';
/* v155 (relatorios/feito_v155.md): regras de quem faz o quê no Estoque, conferidas pelo servidor.
   1. Movimento de estoque NÃO se exclui (nem pelo Administrador nem pelo dono). Exceções: dados de exemplo (ex:true), que a
      limpeza de exemplos remove, e a entrada provisória do recebimento trocada pela definitiva dentro da rota de lançamento
      da nota (/api/nota/lancar, que já confere que é provisória daquele pedido). No lugar da exclusão: ESTORNO.
   2. Estorno = movimento novo com estornoDe=<original>, mesmo tipo, produto e almoxarifados, quantidade com o sinal trocado
      (a entrada estornada sai pelo mesmo custo; a saída estornada volta pelo custo em que saiu), motivo obrigatório (estMotivo);
      o servidor carimba quem e quando (estPor, estEm). Um movimento só se estorna uma vez; estorno não se estorna; movimento
      de EPI só pela devolução (epi154.js); movimento de nota fiscal só depois de a nota estar cancelada (o cancelamento da
      nota estorna o estoque). A data do estorno passa pela competência fechada como qualquer movimento (regras.js ›
      travaCompetencia). O original ganha estornoId/estornadoEm/estornadoPor/estornoMotivo (só esses campos mudam; ficam
      fora da "pegada" da competência fechada, para estornar hoje um movimento de mês fechado). Estorno e movimento estornado
      não se alteram depois.
   3. Entrada e saída MANUAIS (sem ligação com nota, separação, romaneio, EPI, higienização, inventário, devolução de obra,
      OS, recebimento, exemplo): motivo obrigatório de uma lista (motivo + motivoTxt quando "outro"). Ajuste manual fora do
      inventário (invaj) e transferência fora do romaneio são recusados. Movimentos antigos sem motivo continuam válidos; o dono
      (conta principal) pode gravar saldo de implantação pela API sem motivo (na tela o motivo é sempre pedido).
   4. Produto: o Almoxarife (perfis padrão almoxarife, almoxfab e o antigo "compras") não altera preço, NCM (só completa um
      NCM vazio), dados fiscais nem unidade tributável: o servidor mantém o valor guardado e recusa com a lista dos campos.
   5. Excluir produto: só Administrador ou dono, e só sem histórico (nenhum documento cita o produto: movimento, nota,
      pedido, SC, separação, romaneio, EPI, cotação, inventário, kit...). Inativar (prodinat + exclusão do ativo) e reativar
      continuam com quem grava o Estoque.
   Auditoria: ESTOQUE_ESTORNO, ESTOQUE_ENTRADA_MANUAL, ESTOQUE_BAIXA_MANUAL, MOV_EXCLUSAO_RECUSADA, PRODUTO_EXCLUIDO,
   PRODUTO_EXCLUSAO_RECUSADA, PRODUTO_FISCAL_RECUSADO (além do PUT/DELETE de sempre). */
module.exports = function (X) {
  const { db, doc, erro, ehDono, perfilEm, papelConta } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const acaoNeg = (c, k) => { try { return !!X.acaoNeg(c, k); } catch (e) { return false; } };
  const rotaNota = () => { try { return !!X.rotaNota(); } catch (e) { return false; } };
  const r4 = v => Math.round((+v || 0) * 10000) / 10000;
  const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const admin = c => ehDono(c) || perfilEm(c, ['admin']);

  /* ---------- movimentos ---------- */
  const LINK = ['notaId', 'sepId', 'romId', 'epiId', 'higId', 'higienizado', 'invajId', 'balanco', 'devObraId', 'devObra', 'osId', 'osfId', 'recProv', 'pedId', 'devFor', 'devolObra', 'devolucao', 'impLote', 'estornoDe'];
  const tem = v => !(v === undefined || v === null || v === '' || v === false);
  const automatico = m => m.ex === true || LINK.some(k => tem(m[k]));
  const MOT = {
    entrada: { doacao: 'Doação', devobra: 'Devolução de obra sem romaneio', sobra: 'Sobra de inventário', outro: 'Outro' },
    saida: { perda: 'Perda', consumo: 'Consumo interno', descarte: 'Descarte', outro: 'Outro' }
  };
  const EST_F = ['estornoId', 'estornadoEm', 'estornadoPor', 'estornoMotivo'];
  const CORE = ['prodId', 'tipo', 'qtd', 'custoUnit', 'almoxId', 'almoxDest', 'projId', 'data'];
  const META = new Set(['ts', 'cr', 'crBy', 'ed', 'edBy', 'hist', 'v', 'id']);
  const nv = v => (v === undefined || v === null || v === '' ? '' : typeof v === 'number' ? String(r4(v)) : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? String(r4(+v)) : typeof v === 'object' ? JSON.stringify(v) : String(v)));
  const igual = (a, b) => nv(a) === nv(b);
  const stEst = db.prepare("SELECT path FROM docs WHERE parent='mov' AND json_extract(data,'$.estornoDe')=?");
  const TIPO_N = { entrada: 'entrada', saida: 'saída', ajuste: 'ajuste', transf: 'transferência' };

  function regraEstorno(conta, req, id, novo) {
    const oid = String(novo.estornoDe || ''), o = oid ? doc('mov/' + oid) : null;
    if (!o) return erro('Movimento a estornar não encontrado. Atualize a tela.', 404);
    if (oid === id) return erro('Estorno inválido.', 400);
    if (tem(o.estornoDe)) return erro('Um estorno não pode ser estornado de novo.', 409);
    if (o.epiId || o.higId) return erro('Movimento de EPI (entrega, devolução ou higienização) não se estorna: registre a devolução em Controle de EPI.', 409);
    const ja = stEst.all(oid).map(r => r.path).filter(p => p !== 'mov/' + id);
    if (ja.length || (tem(o.estornoId) && o.estornoId !== id)) return erro('Este movimento já foi estornado (' + (ja[0] || 'mov/' + o.estornoId) + '). Cada movimento se estorna uma vez só.', 409);
    if (o.notaId) { const n = doc('notas/' + String(o.notaId)); if (!(n && n.status === 'cancelada')) return erro('Movimento de nota fiscal: para desfazer, cancele a nota (o cancelamento estorna o estoque dela).', 409); }
    if (String(novo.tipo || '') !== String(o.tipo || '') || String(novo.prodId || '') !== String(o.prodId || '') || String(novo.almoxId || '') !== String(o.almoxId || '') || String(novo.almoxDest || '') !== String(o.almoxDest || ''))
      return erro('O estorno repete o tipo, o produto e o almoxarifado do movimento original.', 400);
    if (Math.abs(r4(+novo.qtd || 0) + r4(+o.qtd || 0)) > 1e-6 || !(Math.abs(+o.qtd || 0) > 0)) return erro('O estorno lança a mesma quantidade com o sinal trocado (' + String(-(+o.qtd || 0)).replace('.', ',') + ').', 400);
    if (o.tipo === 'entrada' && Math.abs((+novo.custoUnit || 0) - (+o.custoUnit || 0)) > 1e-4) return erro('O estorno de uma entrada sai pelo mesmo custo da entrada.', 400);
    if (!(+novo.custoUnit >= 0)) novo.custoUnit = 0;
    const mot = String(novo.estMotivo || '').trim();
    if (mot.length < 3) return erro('Informe o motivo do estorno.', 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(novo.data || ''))) novo.data = hoje();
    if (String(novo.data) < String(o.data || '')) return erro('O estorno não pode ter data anterior à do movimento original (' + String(o.data || '').split('-').reverse().join('/') + ').', 400);
    if (acaoNeg(conta, 'cancelar')) return erro('Seu perfil não cancela nem estorna (a ação "Cancelar e estornar" está desligada em Sistema › Perfis de acesso).');
    novo.estMotivo = mot.slice(0, 500); novo.estPor = conta.id; novo.estEm = Date.now();
    EST_F.forEach(k => delete novo[k]);
    auditar(conta, req, 'ESTOQUE_ESTORNO', 'mov/' + id, null, { original: oid, tipo: o.tipo, prodId: o.prodId, qtd: o.qtd, almoxId: o.almoxId || '', motivo: novo.estMotivo, nota: o.notaId || '' });
    return null;
  }

  function antesMov(conta, req, id, velho, novo) {
    if (!velho) {
      EST_F.forEach(k => delete novo[k]);
      if (tem(novo.estornoDe)) return regraEstorno(conta, req, id, novo);
      if (automatico(novo) || ehDono(conta)) return null;
      const t = String(novo.tipo || '');
      if (t === 'ajuste') return erro('Ajuste de estoque fora do inventário não é aceito: use o botão Ajuste (proposta de ajuste; acima do limite por item, outra pessoa aprova em Estoque › Ajustes de inventário).', 409);
      if (t === 'transf') return erro('Transferência entre almoxarifados só por romaneio (Suprimentos › Romaneios › transferência).', 409);
      const L = MOT[t]; if (!L) return erro('Tipo de movimento inválido.', 400);
      const k = String(novo.motivo || '');
      if (!L[k]) return erro((t === 'entrada' ? 'Entrada manual (fora de nota, romaneio, devolução e higienização)' : 'Baixa manual (fora de separação, romaneio, EPI e fábrica)') + ' precisa do motivo: ' + Object.values(L).join(', ') + '.', 400);
      const tx = String(novo.motivoTxt || '').trim();
      if (k === 'outro' && tx.length < 3) return erro('Motivo "Outro": descreva o motivo.', 400);
      novo.motivoTxt = tx.slice(0, 300);
      if (!(+novo.qtd > 0)) return erro('Quantidade inválida.', 400);
      auditar(conta, req, t === 'entrada' ? 'ESTOQUE_ENTRADA_MANUAL' : 'ESTOQUE_BAIXA_MANUAL', 'mov/' + id, null, { prodId: novo.prodId || '', qtd: novo.qtd, almoxId: novo.almoxId || '', motivo: L[k] + (tx ? ': ' + tx : '') });
      return null;
    }
    /* alteração */
    const dif = Object.keys(Object.assign({}, velho, novo)).filter(k => !META.has(k) && !igual(velho[k], novo[k]));
    if (!dif.length) return null;
    if (tem(velho.estornoDe)) return erro('Estorno não se altera. Ele fica no histórico ligado ao movimento original.', 409);
    if (!tem(velho.estornoDe) && tem(novo.estornoDe)) return erro('Um movimento existente não vira estorno: use Estornar.', 409);
    if (tem(velho.estornoId)) {
      if (dif.some(k => EST_F.includes(k) || CORE.includes(k))) return erro('Movimento estornado não se altera.', 409);
      return null;
    }
    if (tem(novo.estornoId)) {
      const eid = String(novo.estornoId), e = doc('mov/' + eid);
      if (!e || String(e.estornoDe || '') !== id) return erro('Estorno não encontrado para este movimento. Use Estornar no Histórico do produto.', 409);
      if (dif.some(k => CORE.includes(k))) return erro('Ao marcar o estorno, o movimento original não muda.', 409);
      novo.estornadoEm = e.estEm || Date.now(); novo.estornadoPor = e.estPor || conta.id; novo.estornoMotivo = String(e.estMotivo || '').slice(0, 500);
      return null;
    }
    EST_F.forEach(k => { if (velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; });
    return null;
  }

  function excluirMov(conta, req, id, velho) {
    if (velho.ex === true) return null;
    if (rotaNota()) return null; /* /api/nota/lancar: só a entrada provisória do recebimento (conferida lá) */
    auditar(conta, req, 'MOV_EXCLUSAO_RECUSADA', 'mov/' + id, null, { tipo: velho.tipo, prodId: velho.prodId, qtd: velho.qtd });
    return erro('Movimento de estoque não se exclui (nem pelo Administrador). Use Estornar no Histórico do produto: o estorno lança o movimento contrário, com motivo, e os dois ficam registrados.', 409);
  }

  /* ---------- produto ---------- */
  const restrito = c => !ehDono(c) && ['almoxarife', 'compras'].includes(papelConta(c));
  const FISC = ['preco', 'custoPadrao', 'ncm', 'cest', 'cBenef', 'origem', 'tipoSped', 'pauta', 'fci', 'escala', 'cnpjFab', 'unTrib', 'qtdTrib', 'fatorTrib', 'eanTrib', 'detNfe'];
  const FISC_RE = /^(cfop|cst|csosn|aliq|icms|ipi|pis|cofins|mva|redBc|fcp)/i;
  const NOME = { preco: 'preço de venda', custoPadrao: 'custo padrão', ncm: 'NCM', cest: 'CEST', cBenef: 'benefício fiscal', origem: 'origem da mercadoria', tipoSped: 'tipo SPED', pauta: 'preço de pauta', fci: 'FCI', escala: 'produção em escala', cnpjFab: 'CNPJ do fabricante', unTrib: 'unidade tributável', qtdTrib: 'quantidade tributável', fatorTrib: 'fator de conversão', eanTrib: 'EAN tributável', detNfe: 'descrição na NF-e', variacoes: 'preço das variações' };
  const vazio0 = v => v === undefined || v === null || v === '' || v === 0 || v === '0' || v === false;
  const igualF = (a, b) => (vazio0(a) && vazio0(b)) || igual(a, b);
  const precosVar = p => JSON.stringify((Array.isArray(p.variacoes) ? p.variacoes : []).map(v => nv(v && v.preco)));
  function regraProd(conta, req, c0, id, velho, novo) {
    if (!velho || !restrito(conta) || novo._del === true) return null;
    const ks = [...new Set(FISC.concat(Object.keys(velho).concat(Object.keys(novo)).filter(k => FISC_RE.test(k))))];
    const mud = [];
    for (const k of ks) {
      if (!(k in novo)) { if (velho[k] !== undefined) novo[k] = velho[k]; continue; } /* não veio: mantém o guardado */
      if (igualF(velho[k], novo[k])) continue;
      if (k === 'ncm' && vazio0(velho.ncm)) continue; /* completar NCM vazio (pedido de compra) continua */
      mud.push(k);
    }
    if (precosVar(velho) !== precosVar(novo) && (Array.isArray(novo.variacoes) || Array.isArray(velho.variacoes))) mud.push('variacoes');
    if (!mud.length) return null;
    auditar(conta, req, 'PRODUTO_FISCAL_RECUSADO', c0 + '/' + id, null, { campos: mud });
    return erro('O Almoxarife não altera preço nem dados fiscais do produto (' + mud.map(k => NOME[k] || k).join(', ') + '). Nada foi gravado; o valor guardado continua. Peça ao Fiscal.', 409);
  }
  const FORA = ['prod', 'prodinat', 'lixo', 'cfg', 'usr', 'usrreq', 'perfc', 'implog', 'lgpdc', 'cm', 'chat'];
  const stVinc = db.prepare("SELECT path FROM docs WHERE data LIKE ? ESCAPE '\\' AND " + FORA.map(() => 'path NOT LIKE ?').join(' AND ') + ' LIMIT 500');
  const stComp = db.prepare("SELECT path FROM docs WHERE (parent='prod' OR parent='prodinat') AND path<>? AND path<>? AND data LIKE ? ESCAPE '\\' LIMIT 50");
  const NOMEC = { mov: 'movimentos de estoque', notas: 'notas fiscais', ped: 'pedidos de compra', sc: 'solicitações de compra', sep: 'separações', rom: 'romaneios', epi: 'entregas de EPI', cot: 'cotações', invaj: 'ajustes de inventário', devobra: 'devoluções de obra', psv: 'pedidos de venda', acordo: 'acordos de preço', prod: 'kits/produtos', epihig: 'higienização de EPI', os: 'ordens de serviço', osf: 'ordens da fábrica' };
  function vinculos(id) {
    const like = '%"' + String(id).replace(/[\\%_]/g, '\\$&') + '"%', m = {};
    for (const r of stVinc.all(like, ...FORA.map(c => c + '/%'))) { const c = String(r.path).split('/')[0]; m[c] = (m[c] || 0) + 1; }
    const k = stComp.all('prod/' + id, 'prodinat/' + id, like).length; if (k) m.prod = k;
    return Object.keys(m).map(c => ({ col: c, n: m[c] }));
  }
  function excluirProd(conta, req, c0, id, velho) {
    if (velho.ex === true) return null;
    if (doc((c0 === 'prod' ? 'prodinat/' : 'prod/') + id)) return null; /* inativar (vai para prodinat) ou reativar */
    const nome = String(velho.sku ? velho.sku + ' · ' : '') + String(velho.nome || '').slice(0, 160);
    if (!admin(conta)) { auditar(conta, req, 'PRODUTO_EXCLUSAO_RECUSADA', c0 + '/' + id, null, { produto: nome, motivo: 'perfil' }); return erro('Só o Administrador exclui produto. Use Inativar: o produto sai das listas e o histórico fica.'); }
    const v = vinculos(id);
    if (v.length) { auditar(conta, req, 'PRODUTO_EXCLUSAO_RECUSADA', c0 + '/' + id, null, { produto: nome, vinculos: v }); return erro('Este produto tem histórico (' + v.map(x => (NOMEC[x.col] || x.col) + ': ' + x.n).join(', ') + ') e não se exclui. Use Inativar.', 409); }
    auditar(conta, req, 'PRODUTO_EXCLUIDO', c0 + '/' + id, null, { produto: nome });
    return null;
  }

  function antes(conta, req, c0, id, velho, novo) {
    if (c0 === 'mov') return antesMov(conta, req, id, velho, novo);
    if (c0 === 'prod' || c0 === 'prodinat') {
      if (velho && novo && novo._del === true) return excluirProd(conta, req, c0, id, velho); /* importação do Omie: exclusão vira marca _del */
      return regraProd(conta, req, c0, id, velho, novo);
    }
    return null;
  }
  function antesExcluir(conta, req, c0, id, velho) {
    if (!velho) return null;
    if (c0 === 'mov') return excluirMov(conta, req, id, velho);
    if (c0 === 'prod' || c0 === 'prodinat') return excluirProd(conta, req, c0, id, velho);
    return null;
  }
  return { antes, antesExcluir, vinculos, automatico, MOT, EST_F, FISC };
};

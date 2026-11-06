'use strict';
/* v158 (relatorios/feito_v158.md): perfis padrão novos "Recursos humanos e compras" (rhcompras) e "Administrador de frota"
   (frotaadm), conferidos pelo servidor. Ligado por v158/ed_v158.py em regras.js (podeLer, redigir, antesGravar, antesExcluir),
   compras152.js (tipos de SC RH e Frota) e almox153.js (nome dos tipos). O resto dos dois perfis está no perfis.json (gerado
   pelo gen_perm.js a partir do sistema): módulos, "so", padFn (nível por função), leFora (cotações, pedidos, acordos de preço,
   notas, inventário e movimentos fora da leitura, mesmo como apoio da solicitação), scTipos, valCols e frotaTodos.
   As regras abaixo valem para o perfil padrão (e o ajuste dele em Perfis de acesso); um perfil personalizado segue a
   configuração dele.
   1. Solicitação de compra (os dois perfis): a pessoa vê, cria e altera só as PRÓPRIAS (criadas por ela ou em que ela é a
      solicitante). A SC de outra pessoa não é entregue (lista, documento, ao vivo, lixeira, "quem aprova") e a gravação ou a
      exclusão dela são recusadas (SC_ALHEIA_RECUSADA). A solicitante da SC nova é sempre a própria pessoa. A situação só vai
      para rascunho, aguardando aprovação, enviada/atendida (com a aprovação conferida em regras.js) ou cancelada; aprovar e
      recusar continuam com o aprovador (alçada normal).
   2. Administrador de frota:
      - não exclui veículo, saída, rota diária, abastecimento, manutenção, entrega com frete nem multa (só o Administrador):
        FROTA_EXCLUSAO_RECUSADA;
      - correção de abastecimento e de manutenção concluída pede o motivo (corrMotivo, 3 letras ou mais): sem ele, 400 e
        FROTA_CORRECAO_SEM_MOTIVO; com ele, o servidor acrescenta {em, por, motivo, campos: [{k, de, para}]} ao histórico
        correcoes do registro (até 50) e grava FROTA_CORRECAO. Concluir a manutenção agendada não é correção. O histórico só
        o servidor escreve (o que vier do navegador é trocado pelo guardado) e o campo corrMotivo não fica no registro;
      - colaboradores: recebe só nome, matrícula, função/cargo, obra, situação e a CNH (número, categoria, emissão e
        validade), com o CPF mascarado (mascCpf: ***.456.789-**). Nada de salário, documentos, ASO, endereço, contato ou folha.
   3. Estoque e produtos (os dois perfis): produto e movimento de estoque chegam sem custo, preço e valor (o Administrador de
      frota consulta saldo e local; o rhcompras escolhe o item da SC). */
const FROTA_COLS = new Set(['veic', 'vsai', 'vrota', 'vabas', 'vman', 'vfrete', 'multa']);
const CORR_COLS = new Set(['vabas', 'vman']);
const PERFIS_158 = new Set(['rhcompras', 'frotaadm']);
const SC_ST_OK = new Set(['rascunho', 'aprovacao', 'enviada', 'atendida', 'cancelada']);
const FUNC_MOT = ['id', 'nome', 'matricula', 'funcao', 'cargo', 'projId', 'status', 'ts', 'ex', 'cnhNum', 'cnhCat', 'cnhEmissao', 'cnhValidade'];
const CUSTO = { prod: /^(preco\w*|custo\w*|valor\w*|ult(Preco|Custo)\w*|pmc|cm)$/, prodinat: /^(preco\w*|custo\w*|valor\w*|ult(Preco|Custo)\w*|pmc|cm)$/, mov: /^(custo\w*|valor\w*|preco\w*|total\w*)$/ };
const IGNORA = new Set(['id', 'ts', 'cr', 'crBy', 'ed', 'edBy', 'hist', 'v', 'lancId', 'correcoes', 'corrMotivo', '_valOculto', '_restrito', 'notas163', 'v163']); /* v163: nota ligada à manutenção não é correção */
const NOME_COL = { veic: 'veículo', vsai: 'saída de veículo', vrota: 'viagem da rota diária', vabas: 'abastecimento', vman: 'manutenção', vfrete: 'entrega com frete', multa: 'multa' };

/* CPF mascarado (LGPD): mostra só os 6 do meio */
function mascCpf(c) { const d = String(c || '').replace(/\D/g, ''); if (!d) return ''; if (d.length !== 11) return '***'; return '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-**'; }
/* cópia sem os campos que batem com re (também dentro de listas e objetos, até 3 níveis) */
function tirar(o, re, nivel) {
  if (Array.isArray(o)) return o.map(x => tirar(x, re, nivel));
  if (!o || typeof o !== 'object') return o;
  const out = {}; for (const k of Object.keys(o)) { if (k !== 'id' && re.test(k)) continue; out[k] = nivel < 3 && o[k] && typeof o[k] === 'object' ? tirar(o[k], re, nivel + 1) : o[k]; }
  return out;
}
const curto = v => { if (v === undefined || v === null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > 120 ? s.slice(0, 117) + '...' : s; };

module.exports = function (X) {
  const { erro, ehDono, perfilDe, PERM, igual } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  /* o perfil padrão (ou o ajuste dele) da conta, quando é um dos dois perfis da v158 */
  function perfil158(conta) {
    if (!conta || ehDono(conta)) return '';
    const pf = perfilDe(conta), d = PERM.perfis && PERM.perfis[pf];
    if (!d || d.custom || d.w === '*' || !PERFIS_158.has(pf)) return '';
    return pf;
  }
  const proprio = (conta, s) => !!s && (s.crBy === conta.id || s.solUid === conta.id);

  /* ---------- 1. SC só as próprias ---------- */
  function scAlheia(conta, data) { return !!perfil158(conta) && !!data && typeof data === 'object' && !proprio(conta, data); }
  function antesSc(conta, req, id, velho, novo) {
    if (!perfil158(conta)) return null;
    const p = 'sc/' + id;
    if (velho && !proprio(conta, velho)) { auditar(conta, req, 'SC_ALHEIA_RECUSADA', p, null, { op: 'gravar' }); return erro('Seu perfil cria e acompanha só as próprias solicitações de compra.', 403); }
    if (!velho) { if (novo.solUid && novo.solUid !== conta.id) { auditar(conta, req, 'SC_ALHEIA_RECUSADA', p, null, { op: 'criar', solUid: novo.solUid }); return erro('Seu perfil cria solicitação de compra só em seu nome.', 403); } novo.solUid = conta.id; }
    else if (velho.solUid !== undefined && !igual(velho.solUid, novo.solUid)) novo.solUid = velho.solUid;
    const v = velho || {};
    if (!igual(v.status, novo.status) && !SC_ST_OK.has(String(novo.status || ''))) return erro('Seu perfil não muda a situação da solicitação para "' + String(novo.status || '') + '". Aprovar e recusar ficam com o aprovador; cotação e pedido, com o Comprador.', 403);
    return null;
  }
  function antesExcluirSc(conta, req, id, velho) {
    if (!perfil158(conta) || !velho) return null;
    if (!proprio(conta, velho)) { auditar(conta, req, 'SC_ALHEIA_RECUSADA', 'sc/' + id, null, { op: 'excluir' }); return erro('Seu perfil cria e acompanha só as próprias solicitações de compra.', 403); }
    return null;
  }

  /* ---------- 2. frota: sem exclusão; correção com motivo ---------- */
  function antesExcluirFrota(conta, req, c0, id, velho) {
    if (perfil158(conta) !== 'frotaadm' || !FROTA_COLS.has(c0) || !velho) return null;
    auditar(conta, req, 'FROTA_EXCLUSAO_RECUSADA', c0 + '/' + id, null, null);
    return erro('O Administrador de frota não exclui ' + (NOME_COL[c0] || 'registro da frota') + '. Corrija o registro' + (CORR_COLS.has(c0) ? ' (com o motivo da correção)' : '') + ' ou peça ao Administrador.', 403);
  }
  function mudou(velho, novo) { return [...new Set(Object.keys(velho || {}).concat(Object.keys(novo || {})))].filter(k => !IGNORA.has(k) && !(k === 'valor' && (velho || {}).v163) && !igual((velho || {})[k], (novo || {})[k])); } /* v163: o valor da manutenção nova vem das notas */
  function antesFrota(conta, req, c0, id, velho, novo) {
    if (!CORR_COLS.has(c0)) return null;
    const mot = String(novo.corrMotivo == null ? '' : novo.corrMotivo).trim(); delete novo.corrMotivo;
    /* histórico de correções: só o servidor escreve */
    if (velho && velho.correcoes !== undefined) novo.correcoes = velho.correcoes; else delete novo.correcoes;
    if (!velho) return null;
    const ks = mudou(velho, novo); if (!ks.length) return null;
    const pede = perfil158(conta) === 'frotaadm' && !(c0 === 'vman' && (velho.status || 'concluida') === 'agendada');
    if (pede && mot.length < 3) { auditar(conta, req, 'FROTA_CORRECAO_SEM_MOTIVO', c0 + '/' + id, null, { campos: ks }); return erro('Correção de ' + NOME_COL[c0] + ': informe o motivo da correção (fica no histórico do registro).', 400); }
    if (!pede && !mot) return null;
    const c = { em: Date.now(), por: conta.id, motivo: mot.slice(0, 500), campos: ks.slice(0, 30).map(k => ({ k, de: curto(velho[k]), para: curto(novo[k]) })) };
    novo.correcoes = (Array.isArray(velho.correcoes) ? velho.correcoes : []).concat([c]).slice(-50);
    auditar(conta, req, 'FROTA_CORRECAO', c0 + '/' + id, null, { motivo: c.motivo, campos: ks });
    return null;
  }

  /* ---------- 2 e 3. o que é entregue ---------- */
  function redigir(conta, p, data) {
    if (!data || typeof data !== 'object') return data;
    const pf = perfil158(conta); if (!pf) return data;
    const s = String(p || '').split('/');
    if (s.length === 2 && s[0] === 'lixo' && data.col && data.rec && (CUSTO[data.col] || (data.col === 'func' && pf === 'frotaadm'))) return Object.assign({}, data, { rec: redigir(conta, data.col + '/' + (data.rid || 'x'), data.rec) });
    if (s.length !== 2) return data;
    if (s[0] === 'func' && pf === 'frotaadm') { const o = {}; FUNC_MOT.forEach(k => { if (data[k] !== undefined) o[k] = data[k]; }); const m = mascCpf(data.cpf); if (m) o.mascCpf = m; o._restrito = true; o._min = true; return o; }
    if (CUSTO[s[0]]) return tirar(data, CUSTO[s[0]], 0);
    return data;
  }
  return { perfil158, scAlheia, antesSc, antesExcluirSc, antesExcluirFrota, antesFrota, redigir, mascCpf };
};
module.exports.mascCpf = mascCpf;
module.exports.FROTA_COLS = FROTA_COLS;

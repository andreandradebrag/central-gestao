'use strict';
/* v169 (relatorios/feito_v169.md): assistentes de IA por setor no chat interno (etapa 1). Ligado por v169/ed_v169.py em
   server.js (rotas /api/ia169/*, o limite de uso da IA por hora vale em /api/ia169/perguntar) e no Dockerfile.
   - 10 assistentes (diretoria, financeiro, fiscal, comercial, obras, suprimentos, pessoas, sst, frota, fabrica). Cada um vira
     um contato do chat (conversa cm/sistema/c/ia169_<assistente>_<conta>, só da própria pessoa) para quem pode usá-lo.
   - Configuração (Sistema › Assistentes de IA, só o Administrador): ativo, responsáveis, perfis e usuários que conversam,
     frequência do resumo, metas, limite de custo do mês (por assistente e geral). Guardada na tabela ia169_cfg; cada
     alteração vai para a auditoria (IA169_CFG, com os responsáveis de antes e de depois).
   - Resposta pelo servidor com uso de ferramentas (tool use da Anthropic). Cada ferramenta lê as coleções COMO a pessoa
     que perguntou: a mesma leitura da API (/api/db/col: podeVer + redigir, registro de leitura de saúde), então ninguém
     recebe o que o perfil não lê. CPF sai mascarado; salário e saúde só aparecem quando o perfil já os lê.
   - Ações propostas (tarefa, SC em rascunho, lembrete de cobrança, item de pauta) ficam como "proposta" e só rodam no
     "Confirmar" da pessoa, pelo caminho normal de gravação da API, com as permissões dela.
   - Resumo periódico (semanal na segunda 07:00 de Brasília por padrão, diário ou desligado) para cada responsável, com os
     dados lidos com as permissões DELE; pulado (e registrado) quando o limite de custo foi atingido.
   - Retorno "Útil / Não útil" de cada proposta e resumo (tabela ia169_fb), para a etapa 3.
   - Auditoria de cada chamada: IA_USO (auditarIa de sempre) e IA169_USO (quem, assistente, ferramentas, tamanhos, tokens,
     custo estimado; sem o conteúdo). */
const crypto = require('node:crypto');
const FR = require('./frota165.js');
module.exports = function (X) {
  const { db, q, json, lerJson, avisarDoc } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const nomeConta = id => { try { return X.nomeConta(id); } catch (e) { return id || ''; } };
  const doc = p => { const r = q.docGet.get(p); if (!r) return null; try { return JSON.parse(r.data); } catch (e) { return null; } };
  const colRaw = c => q.colGet.all(c).map(r => { try { return Object.assign(JSON.parse(r.data), { id: r.id }); } catch (e) { return null; } }).filter(Boolean);
  const admin = conta => !!conta && (conta.nivel === 'owner' || X.perfilEm(conta, ['admin']));
  const ID_OK = /^[\w\-.|~@+=]{1,120}$/;
  const env = (k, d) => { const v = process.env[k]; return v === undefined || v === '' ? d : v; };
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, n || 300);
  const txtL = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, n || 4000);
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const uniq = a => [...new Set((a || []).filter(Boolean))];
  const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(d + 'T12:00:00Z'));
  const agoraBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 16);
  const hojeBr = () => agoraBr().slice(0, 10);
  const maisDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const difDias = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
  const fmtBr = d => dataOk(d) ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';
  const mesAtual = () => hojeBr().slice(0, 7);
  const novoId = p => p + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const mascCpf = v => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 ? '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-**' : d ? '***' : ''; };

  /* ---------------- assistentes, perfis padrão e metas padrão ---------------- */
  const ASSIST = [
    ['diretoria', 'Assistente da Diretoria', ['diretoria', 'admin']],
    ['financeiro', 'Assistente Financeiro', ['financeiro']],
    ['fiscal', 'Assistente Fiscal', ['fiscal']],
    ['comercial', 'Assistente Comercial', ['comercial']],
    ['obras', 'Assistente de Obras', ['projetos', 'encarregado']],
    ['suprimentos', 'Assistente de Suprimentos', ['comprador', 'almoxarife', 'almoxfab', 'rhcompras']],
    ['pessoas', 'Assistente de Pessoas (RH/DP)', ['rh', 'rhcompras']],
    ['sst', 'Assistente de Segurança do Trabalho', ['sstgestor', 'ssttec']],
    ['frota', 'Assistente de Frota e Equipamentos', ['frotaadm']],
    ['fabrica', 'Assistente de Fábrica e Qualidade', ['fabrica', 'almoxfab']]
  ];
  const AID = new Set(ASSIST.map(a => a[0])), ANOME = Object.fromEntries(ASSIST.map(a => [a[0], a[1]]));
  const FERR_DE = {
    financeiro: ['contas_a_vencer', 'fluxo_previsto', 'inadimplencia', 'notas_pendentes', 'medicoes_a_faturar'],
    fiscal: ['notas_pendentes', 'medicoes_a_faturar', 'contas_a_vencer'],
    comercial: ['contratos_teto', 'medicoes_a_faturar', 'inadimplencia', 'obras_custo_vs_orcado'],
    obras: ['obras_custo_vs_orcado', 'horas_extras', 'sc_paradas', 'medicoes_a_faturar'],
    suprimentos: ['sc_paradas', 'precos_por_produto', 'estoque_minimo', 'validades'],
    pessoas: ['horas_extras', 'aso_nr_vencendo', 'quadro_pessoal', 'salarios_resumo', 'colaborador_busca', 'validades'],
    sst: ['aso_nr_vencendo', 'epi_trocas', 'validades', 'colaborador_busca'],
    frota: ['frota_consumo', 'abastecimentos_alerta', 'validades'],
    fabrica: ['producao_fabrica', 'nao_conformidades', 'estoque_minimo']
  };
  FERR_DE.diretoria = uniq([].concat(...Object.values(FERR_DE))); /* a Diretoria usa a união das ferramentas (limitada pelas permissões de quem pergunta) */
  const SEMPRE = ['reunioes_proximas', 'propor_acao'];
  /* tipos de ação que cada assistente pode propor */
  const ACOES_DE = a => ['tarefa', 'pauta'].concat(['suprimentos', 'obras', 'fabrica', 'frota', 'sst', 'diretoria'].includes(a) ? ['sc_rascunho'] : []).concat(['financeiro', 'comercial', 'fiscal', 'diretoria'].includes(a) ? ['cobranca'] : []);
  const M = (id, nome, valor, un, extra) => Object.assign({ id, nome, valor, un }, extra || {});
  const METAS_PAD = {
    diretoria: [M('margem_min', 'Margem mínima por obra', 25, '%'), M('inadimplencia_max', 'Inadimplência máxima', 5, '%'), M('sc_pedido_dias', 'Prazo máximo SC → pedido', 5, 'dias')],
    financeiro: [M('inadimplencia_max', 'Inadimplência máxima', 5, '%'), M('aviso_venc_dias', 'Avisar vencimentos com antecedência de', 7, 'dias'), M('pagar_vencido_max', 'Contas a pagar vencidas (máximo)', 0, 'R$')],
    fiscal: [M('notas_pend_max', 'Notas recebidas sem lançar (máximo)', 5, 'notas'), M('faturar_dias', 'Faturar medição aprovada em até', 5, 'dias')],
    comercial: [M('teto_alerta', 'Alerta de consumo do teto do contrato', 80, '%'), M('margem_min', 'Margem mínima por obra', 25, '%'), M('inadimplencia_max', 'Inadimplência máxima', 5, '%')],
    obras: [M('margem_min', 'Margem mínima por obra', 25, '%'), M('orcamento_alerta', 'Alerta de consumo do orçamento', 90, '%'), M('he_max_dia', 'Horas extras máximas por colaborador', 2, 'h/dia')],
    suprimentos: [M('sc_pedido_dias', 'Prazo máximo SC → pedido', 5, 'dias'), M('sc_parada_dias', 'SC parada há mais de', 3, 'dias')],
    pessoas: [M('he_max_dia', 'Horas extras máximas por colaborador', 2, 'h/dia'), M('aviso_aso_dias', 'Avisar ASO e NR a vencer com antecedência de', 30, 'dias')],
    sst: [M('aviso_aso_dias', 'Avisar ASO e NR a vencer com antecedência de', 30, 'dias'), M('epi_trocas_max', 'Trocas de EPI por colaborador no período (máximo)', 3, 'trocas')],
    frota: [M('kml_leve', 'Consumo esperado: leve (carro)', 10, 'km/l', { tipo: 'leve' }), M('kml_utilitario', 'Consumo esperado: utilitário / van', 8, 'km/l', { tipo: 'utilitario' }), M('kml_caminhao', 'Consumo esperado: caminhão', 3.5, 'km/l', { tipo: 'caminhao' }), M('kml_alerta', 'Alerta quando o consumo fica abaixo de', 75, '% do esperado')],
    fabrica: [M('osf_atrasadas_max', 'OS de fabricação atrasadas (máximo)', 0, 'OS'), M('nc_aberta_dias', 'Não conformidade aberta há mais de', 30, 'dias')]
  };
  const FREQS = ['semanal', 'diario', 'desligado'];
  const padAsst = id => ({ ativo: false, resp: [], perfis: (ASSIST.find(a => a[0] === id) || [0, 0, []])[2].slice(), usuarios: [], freq: 'semanal', dia: 1, hora: '07:00', metas: JSON.parse(JSON.stringify(METAS_PAD[id] || [])), limite: { un: 'R$', valor: 0 }, respCidades: id === 'frota' });
  const PAD_GLOBAL = { limite: { un: 'R$', valor: 0 }, histDias: 30, histMsgs: 10 };

  /* ---------------- tabelas ---------------- */
  db.exec(`CREATE TABLE IF NOT EXISTS ia169_cfg(k TEXT PRIMARY KEY, data TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS ia169_uso(mes TEXT, asst TEXT, n INTEGER, tin INTEGER, tout INTEGER, custo REAL, PRIMARY KEY(mes, asst));
CREATE TABLE IF NOT EXISTS ia169_hist(id INTEGER PRIMARY KEY AUTOINCREMENT, conta TEXT, asst TEXT, ts INTEGER, papel TEXT, texto TEXT);
CREATE INDEX IF NOT EXISTS ia169_hist_c ON ia169_hist(conta, asst, ts);
CREATE TABLE IF NOT EXISTS ia169_acao(id TEXT PRIMARY KEY, conta TEXT, asst TEXT, tipo TEXT, dados TEXT, st TEXT, cr INTEGER, em INTEGER, msg TEXT, res TEXT);
CREATE TABLE IF NOT EXISTS ia169_fb(conta TEXT, ref TEXT, asst TEXT, tipo TEXT, util INTEGER, ts INTEGER, PRIMARY KEY(conta, ref));
CREATE TABLE IF NOT EXISTS ia169_resumo(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, asst TEXT, para TEXT, periodo TEXT, st TEXT, motivo TEXT);
CREATE TABLE IF NOT EXISTS ia169_resumo_k(k TEXT PRIMARY KEY, ts INTEGER);`);
  const st = {
    cfgGet: db.prepare("SELECT data FROM ia169_cfg WHERE k='cfg'"),
    cfgPut: db.prepare("INSERT INTO ia169_cfg(k,data,ts) VALUES('cfg',?,?) ON CONFLICT(k) DO UPDATE SET data=excluded.data, ts=excluded.ts"),
    usoAdd: db.prepare('INSERT INTO ia169_uso(mes,asst,n,tin,tout,custo) VALUES(?,?,1,?,?,?) ON CONFLICT(mes,asst) DO UPDATE SET n=n+1, tin=tin+excluded.tin, tout=tout+excluded.tout, custo=custo+excluded.custo'),
    usoMes: db.prepare('SELECT * FROM ia169_uso WHERE mes=?'),
    histAdd: db.prepare('INSERT INTO ia169_hist(conta,asst,ts,papel,texto) VALUES(?,?,?,?,?)'),
    histDe: db.prepare('SELECT papel, texto, ts FROM ia169_hist WHERE conta=? AND asst=? AND ts>=? ORDER BY ts DESC, id DESC LIMIT ?'),
    histLimpa: db.prepare('DELETE FROM ia169_hist WHERE ts<?'),
    acaoAdd: db.prepare('INSERT INTO ia169_acao(id,conta,asst,tipo,dados,st,cr,em,msg,res) VALUES(?,?,?,?,?,?,?,?,?,?)'),
    acaoGet: db.prepare('SELECT * FROM ia169_acao WHERE id=?'),
    acaoSt: db.prepare('UPDATE ia169_acao SET st=?, em=?, res=? WHERE id=?'),
    acaoMsg: db.prepare('UPDATE ia169_acao SET msg=? WHERE id=?'),
    fbPut: db.prepare('INSERT INTO ia169_fb(conta,ref,asst,tipo,util,ts) VALUES(?,?,?,?,?,?) ON CONFLICT(conta,ref) DO UPDATE SET util=excluded.util, ts=excluded.ts'),
    fbCont: db.prepare('SELECT asst, tipo, SUM(util) AS util, SUM(1-util) AS nao FROM ia169_fb GROUP BY asst, tipo'),
    resLog: db.prepare('INSERT INTO ia169_resumo(ts,asst,para,periodo,st,motivo) VALUES(?,?,?,?,?,?)'),
    resUlt: db.prepare('SELECT * FROM ia169_resumo ORDER BY id DESC LIMIT 30'),
    resK: db.prepare('INSERT OR IGNORE INTO ia169_resumo_k(k,ts) VALUES(?,?)')
  };

  /* ---------------- configuração ---------------- */
  function cfg() {
    let s = {}; try { const r = st.cfgGet.get(); if (r) s = JSON.parse(r.data) || {}; } catch (e) { }
    const out = { global: Object.assign({}, PAD_GLOBAL, s.global || {}), asst: {} };
    out.global.limite = Object.assign({}, PAD_GLOBAL.limite, (s.global || {}).limite || {});
    for (const [id] of ASSIST) { const p = padAsst(id), g = (s.asst || {})[id] || {}; out.asst[id] = Object.assign(p, g); out.asst[id].limite = Object.assign({}, p.limite, g.limite || {}); if (!Array.isArray(out.asst[id].metas)) out.asst[id].metas = p.metas; }
    return out;
  }
  const contaOk = id => { const c = ID_OK.test(String(id || '')) && q.contaPorId.get(String(id)); return !!c; };
  const PERFIS_OK = () => { try { return new Set(Object.keys((X.PERM() || {}).perfis || {})); } catch (e) { return new Set(); } };
  function limpaAsst(id, b, velho) {
    const o = Object.assign({}, velho);
    if (b.ativo !== undefined) o.ativo = b.ativo === true;
    if (b.resp !== undefined) o.resp = uniq((Array.isArray(b.resp) ? b.resp : []).map(String).filter(contaOk)).slice(0, 30);
    if (b.usuarios !== undefined) o.usuarios = uniq((Array.isArray(b.usuarios) ? b.usuarios : []).map(String).filter(contaOk)).slice(0, 200);
    if (b.perfis !== undefined) { const ok = PERFIS_OK(); o.perfis = uniq((Array.isArray(b.perfis) ? b.perfis : []).map(s => txt(s, 40)).filter(s => ok.has(s) || /^[a-z0-9_]{2,40}$/.test(s))).slice(0, 40); }
    if (b.freq !== undefined) { if (!FREQS.includes(b.freq)) return { erro: 'Frequência inválida.' }; o.freq = b.freq; }
    if (b.dia !== undefined) { const d = Math.round(+b.dia); if (!(d >= 1 && d <= 7)) return { erro: 'Dia da semana inválido.' }; o.dia = d; }
    if (b.hora !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.hora))) return { erro: 'Hora inválida (use HH:MM).' }; o.hora = String(b.hora); }
    if (b.metas !== undefined) {
      if (!Array.isArray(b.metas)) return { erro: 'Metas inválidas.' };
      const ms = []; for (const m of b.metas.slice(0, 30)) { if (!m || typeof m !== 'object') continue; const nome = txt(m.nome, 120); if (!nome) continue; const v = +String(m.valor).replace(',', '.'); if (!isFinite(v)) return { erro: 'A meta "' + nome + '" precisa de um valor numérico.' };
        const pm = (METAS_PAD[id] || []).find(x => x.id === m.id); ms.push(Object.assign({ id: /^[a-z0-9_]{2,40}$/.test(String(m.id || '')) ? String(m.id) : novoId('meta'), nome, valor: v, un: txt(m.un, 20) }, pm && pm.tipo ? { tipo: pm.tipo } : {})); }
      o.metas = ms;
    }
    if (b.limite !== undefined) { const l = b.limite || {}, v = +String(l.valor == null ? 0 : l.valor).replace(',', '.'); if (!(v >= 0) || !isFinite(v)) return { erro: 'Limite inválido.' }; o.limite = { un: l.un === 'tokens' ? 'tokens' : 'R$', valor: v }; }
    if (b.respCidades !== undefined) o.respCidades = b.respCidades === true;
    return { a: o };
  }
  function salvarCfg(conta, req, b) {
    if (!admin(conta)) return { erro: 'Só o Administrador configura os assistentes de IA.', st: 403 };
    let s = {}; try { const r = st.cfgGet.get(); if (r) s = JSON.parse(r.data) || {}; } catch (e) { }
    s.asst = s.asst || {}; const c0 = cfg();
    if (b.global) {
      const g = Object.assign({}, c0.global), x = b.global;
      if (x.limite !== undefined) { const v = +String((x.limite || {}).valor == null ? 0 : x.limite.valor).replace(',', '.'); if (!(v >= 0) || !isFinite(v)) return { erro: 'Limite geral inválido.', st: 400 }; g.limite = { un: (x.limite || {}).un === 'tokens' ? 'tokens' : 'R$', valor: v }; }
      if (x.histDias !== undefined) { const v = Math.round(+x.histDias); if (!(v >= 1 && v <= 365)) return { erro: 'Retenção do histórico: de 1 a 365 dias.', st: 400 }; g.histDias = v; }
      if (x.histMsgs !== undefined) { const v = Math.round(+x.histMsgs); if (!(v >= 0 && v <= 40)) return { erro: 'Histórico: de 0 a 40 mensagens.', st: 400 }; g.histMsgs = v; }
      s.global = g; st.cfgPut.run(JSON.stringify(s), Date.now());
      auditar(conta, req, 'IA169_CFG', 'ia169/global', { limite: c0.global.limite, histDias: c0.global.histDias, histMsgs: c0.global.histMsgs }, { limite: g.limite, histDias: g.histDias, histMsgs: g.histMsgs });
      return { ok: true, cfg: cfg() };
    }
    const id = String(b.asst || ''); if (!AID.has(id)) return { erro: 'Assistente desconhecido.', st: 400 };
    const v = limpaAsst(id, b.dados || {}, c0.asst[id]); if (v.erro) return { erro: v.erro, st: 400 };
    s.asst[id] = v.a; st.cfgPut.run(JSON.stringify(s), Date.now());
    const a0 = c0.asst[id], a1 = v.a, nm = l => (l || []).map(u => nomeConta(u) + ' (' + u + ')');
    const antes = {}, depois = {};
    for (const k of ['ativo', 'perfis', 'freq', 'dia', 'hora', 'limite', 'respCidades']) if (JSON.stringify(a0[k]) !== JSON.stringify(a1[k])) { antes[k] = a0[k]; depois[k] = a1[k]; }
    if (JSON.stringify(a0.resp) !== JSON.stringify(a1.resp)) { antes.responsaveis = nm(a0.resp); depois.responsaveis = nm(a1.resp); }
    if (JSON.stringify(a0.usuarios) !== JSON.stringify(a1.usuarios)) { antes.usuarios = nm(a0.usuarios); depois.usuarios = nm(a1.usuarios); }
    if (JSON.stringify(a0.metas) !== JSON.stringify(a1.metas)) { antes.metas = a0.metas.map(m => m.nome + ': ' + m.valor + ' ' + m.un); depois.metas = a1.metas.map(m => m.nome + ': ' + m.valor + ' ' + m.un); }
    auditar(conta, req, 'IA169_CFG', 'ia169/' + id, antes, depois);
    try { sincronizar(); } catch (e) { console.error('[v169] sincronizar:', e.message); }
    return { ok: true, cfg: cfg() };
  }

  /* ---------------- quem usa e quem recebe ---------------- */
  const frotaCfg = () => { try { return FR.cfgPad(((doc('cfg/empresa') || {}).frota165)); } catch (e) { return { cidades: [], resp: {} }; } };
  const respCidades = () => { const c = frotaCfg(); return uniq([].concat(...(c.cidades || []).map(ci => FR.respDe(c, ci)))); };
  function podeUsar(conta, id, C) {
    C = C || cfg(); const a = C.asst[id]; if (!conta || !a || !a.ativo || !conta.ativo) return false;
    if (a.usuarios.includes(conta.id)) return true;
    const pf = X.perfilDe(conta), pp = X.papelDe(pf);
    if (a.perfis.includes(pf) || a.perfis.includes(pp)) return true;
    if (id === 'frota' && a.respCidades !== false && respCidades().includes(conta.id)) return true;
    return false;
  }
  function responsaveis(id, C) { C = C || cfg(); const a = C.asst[id]; if (!a) return []; let r = a.resp.slice(); if (id === 'frota' && !r.length && a.respCidades !== false) r = respCidades(); return uniq(r).filter(contaOk); }
  /* ferramentas de quem pergunta: o Recursos humanos e compras usa só a parte de SC no Assistente de Suprimentos */
  function ferramentasDe(conta, id, C) {
    let l = (FERR_DE[id] || []).slice(); C = C || cfg();
    if (id === 'suprimentos' && conta && conta.nivel !== 'owner') { const a = C.asst[id], pf = X.perfilDe(conta); if (pf === 'rhcompras' && !a.usuarios.includes(conta.id)) l = ['sc_paradas']; }
    return l.concat(SEMPRE);
  }

  /* ---------------- conversas do chat (contatos dos assistentes) ---------------- */
  const cidDe = (id, u) => 'ia169_' + id + '_' + u;
  function garantirConv(u, id, soResumo) {
    const cid = cidDe(id, u), cp = 'cm/sistema/c/' + cid, ag = Date.now(), v = doc(cp);
    const n = Object.assign({}, v || { id: cid, tipo: 'dm', ts: ag, sistema: true }, { membros: [u], ia169: id, nome: ANOME[id], soResumo: !!soResumo });
    if (!v || JSON.stringify(v) !== JSON.stringify(n)) { q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(n), ag); avisarDoc('set', cp, n, ag); }
    return 'sistema/' + cid;
  }
  function retirarConv(u, id) { const cid = cidDe(id, u), cp = 'cm/sistema/c/' + cid, v = doc(cp); if (v && (v.membros || []).length) { const ag = Date.now(), n = Object.assign({}, v, { membros: [], ex: uniq((v.ex || []).concat([u])) }); q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(n), ag); avisarDoc('set', cp, n, ag); } }
  function meus(conta) {
    const C = cfg(), out = [];
    for (const [id, nome] of ASSIST) {
      const usa = podeUsar(conta, id, C), resp = C.asst[id].ativo && responsaveis(id, C).includes(conta.id);
      if (usa || resp) out.push({ id, nome, conv: garantirConv(conta.id, id, !usa), chat: usa, resp });
      else retirarConv(conta.id, id);
    }
    return out;
  }
  /* depois de mudar a configuração: tira a conversa de quem perdeu o acesso (quem ganhou recebe ao abrir o chat) */
  function sincronizar() {
    const C = cfg();
    for (const r of q.colGet.all('cm/sistema/c')) {
      if (!/^ia169_/.test(r.id)) continue; let v; try { v = JSON.parse(r.data); } catch (e) { continue; }
      const id = v.ia169, u = (v.membros || [])[0]; if (!u || !AID.has(id)) continue;
      const c = q.contaPorId.get(u), usa = c && podeUsar(c, id, C), resp = C.asst[id].ativo && responsaveis(id, C).includes(u);
      if (!usa && !resp) retirarConv(u, id); else garantirConv(u, id, !usa);
    }
  }
  function escreverMsg(u, id, texto, meta) {
    const conv = garantirConv(u, id, !(meta && meta.chat)), ag = Date.now(), mid = 'm' + ag.toString(36) + crypto.randomBytes(4).toString('hex'), mp = 'cm/sistema/m/' + mid;
    const m = { id: mid, k: 'msg', conv, txt: txtL(texto, 12000), ts: ag, men: [], sistema: true, ia169: Object.assign({ asst: id }, meta || {}) };
    delete m.ia169.chat;
    q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(m), ag); avisarDoc('set', mp, m, ag); return m;
  }
  function atualizarMsg(mid, fn) { const mp = 'cm/sistema/m/' + mid, m = doc(mp); if (!m || !m.ia169) return null; fn(m); const ag = Date.now(); q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(m), ag); avisarDoc('set', mp, m, ag); return m; }

  /* ---------------- uso, custo e limites ---------------- */
  const PRECO = { quick: [1, 5], default: [3, 15], complex: [5, 25] }; /* US$ por milhão de tokens (entrada, saída); IA169_PRECO_<NIVEL>=entrada,saída */
  const preco = t => { const e = String(env('IA169_PRECO_' + t.toUpperCase(), '')).split(',').map(Number); return e.length === 2 && e.every(x => x >= 0) ? e : PRECO[t] || PRECO.default; };
  const DOLAR = () => { const v = +env('IA169_DOLAR', 5.6); return v > 0 ? v : 5.6; };
  const custoDe = (tier, tin, tout) => { const p = preco(tier); return (tin * p[0] + tout * p[1]) / 1e6 * DOLAR(); };
  function usoMes() { const ls = st.usoMes.all(mesAtual()), por = {}; let tot = { n: 0, tin: 0, tout: 0, custo: 0 }; for (const r of ls) { por[r.asst] = { n: r.n, tin: r.tin, tout: r.tout, tokens: r.tin + r.tout, custo: r2(r.custo) }; tot.n += r.n; tot.tin += r.tin; tot.tout += r.tout; tot.custo += r.custo; } tot.tokens = tot.tin + tot.tout; tot.custo = r2(tot.custo); return { mes: mesAtual(), por, total: tot }; }
  const passou = (lim, u) => !!lim && +lim.valor > 0 && (lim.un === 'tokens' ? (u.tokens || 0) >= lim.valor : (u.custo || 0) >= lim.valor);
  function limite(id, C) {
    C = C || cfg(); const u = usoMes(), a = C.asst[id];
    if (passou(a.limite, u.por[id] || {})) return 'O limite de custo do mês do ' + ANOME[id] + ' foi atingido (' + (a.limite.un === 'tokens' ? a.limite.valor + ' tokens' : 'R$ ' + a.limite.valor) + '). Peça ao Administrador para ajustar em Sistema › Assistentes de IA.';
    if (passou(C.global.limite, u.total)) return 'O limite geral de custo do mês dos assistentes de IA foi atingido. Peça ao Administrador para ajustar em Sistema › Assistentes de IA.';
    return '';
  }
  const registrarUso = (id, tier, tin, tout) => { const c = custoDe(tier, tin, tout); st.usoAdd.run(mesAtual(), id, tin, tout, c); return c; };

  /* ---------------- leitura como a pessoa (as mesmas regras de /api/db/col) ---------------- */
  function leitor(conta, req, hoje) {
    const cache = new Map(), bloq = new Set();
    const ler = c => { if (cache.has(c)) return cache.get(c); let v = null; if (X.acessoCol(conta, c)) v = X.lerComo(conta, c, req); else bloq.add(c); cache.set(c, v); return v; };
    return { conta, hoje: hoje || hojeBr(), ler, bloq, nomeParc: id => { const l = ler('parc'); const p = l && l.find(x => x.id === id); return p ? (p.fantasia || p.nome || '') : ''; }, nomeProj: id => { const l = ler('proj'); const p = l && l.find(x => x.id === id); return p ? (String(p.codigo || '').trim() || p.nome || '') : ''; }, nomeFunc: id => { const l = ler('func'); const p = l && l.find(x => x.id === id); return p ? p.nome || '' : ''; } };
  }
  const SA = (o, cols, rot) => ({ sem_acesso: true, colecoes: cols, mensagem: 'Não tenho acesso a isso: o perfil de ' + nomeConta(o.conta.id) + ' não lê ' + rot + '.' });
  const F = (tela, rotulo) => ({ tela, rotulo });
  const metaV = (metas, id, d) => { const m = (metas || []).find(x => x.id === id); return m && isFinite(+m.valor) ? +m.valor : d; };
  const lancVal = l => +(l.pago && l.valorPago != null ? l.valorPago : l.valor) || 0;
  const somaV = (l, f) => r2(l.reduce((s, x) => s + (+f(x) || 0), 0));

  /* ---------------- ferramentas (somente leitura; JSON compacto e agregado) ---------------- */
  const T = {};
  const def = (nome, descricao, props, fn) => { T[nome] = { nome, descricao, props: props || {}, fn }; };
  const P = { dias: d => ({ type: 'integer', description: 'Janela em dias (padrão ' + d + ')', minimum: 1, maximum: 365 }) };
  const dias = (a, d) => Math.max(1, Math.min(365, Math.round(+((a || {}).dias) || d)));

  def('contas_a_vencer', 'Contas a pagar e a receber em aberto: vencidas e a vencer nos próximos dias, com as maiores.', { dias: P.dias(15), tipo: { type: 'string', enum: ['pagar', 'receber', 'todos'] } }, (o, a) => {
    const L = o.ler('lanc'); if (!L) return SA(o, ['lanc'], 'o Financeiro (lançamentos)');
    const d = dias(a, 15), lim = maisDias(o.hoje, d), tp = ['pagar', 'receber'].includes(a && a.tipo) ? [a.tipo] : ['pagar', 'receber'];
    const ab = L.filter(l => l.status !== 'cancelado' && !l.pago && tp.includes(l.tipo) && dataOk(l.venc));
    const out = { hoje: o.hoje, janela_dias: d };
    for (const t of tp) { const x = ab.filter(l => l.tipo === t), v = x.filter(l => l.venc < o.hoje), av = x.filter(l => l.venc >= o.hoje && l.venc <= lim); out[t] = { vencidas: { n: v.length, valor: somaV(v, lancVal) }, a_vencer: { n: av.length, valor: somaV(av, lancVal) } }; }
    out.maiores = ab.filter(l => l.venc <= lim).sort((x, y) => lancVal(y) - lancVal(x)).slice(0, 8).map(l => ({ id: l.id, tipo: l.tipo, descricao: txt(l.desc, 80), parceiro: o.nomeParc(l.parcId), venc: l.venc, valor: r2(lancVal(l)), vencida: l.venc < o.hoje }));
    out.fonte = tp.length === 1 ? (tp[0] === 'pagar' ? F('pag', 'Financeiro › Contas a pagar') : F('rec', 'Financeiro › Contas a receber')) : F('fc90', 'Financeiro › Fluxo de 90 dias'); return out;
  });
  def('fluxo_previsto', 'Fluxo de caixa previsto por semana (entradas e saídas em aberto) nos próximos dias.', { dias: P.dias(30) }, (o, a) => {
    const L = o.ler('lanc'); if (!L) return SA(o, ['lanc'], 'o Financeiro (lançamentos)');
    const d = dias(a, 30), sem = [];
    for (let i = 0; i < Math.ceil(d / 7); i++) { const ini = maisDias(o.hoje, i * 7), fim = maisDias(o.hoje, Math.min(d, i * 7 + 7) - 1); const x = L.filter(l => l.status !== 'cancelado' && !l.pago && dataOk(l.venc) && l.venc >= ini && l.venc <= fim); const ent = somaV(x.filter(l => l.tipo === 'receber'), lancVal), sai = somaV(x.filter(l => l.tipo === 'pagar'), lancVal); sem.push({ de: ini, ate: fim, entradas: ent, saidas: sai, saldo: r2(ent - sai) }); }
    const atr = L.filter(l => l.status !== 'cancelado' && !l.pago && dataOk(l.venc) && l.venc < o.hoje);
    return { hoje: o.hoje, semanas: sem, total: { entradas: somaV(sem, s => s.entradas), saidas: somaV(sem, s => s.saidas) }, atrasado: { receber: somaV(atr.filter(l => l.tipo === 'receber'), lancVal), pagar: somaV(atr.filter(l => l.tipo === 'pagar'), lancVal) }, fonte: F('fc90', 'Financeiro › Fluxo de 90 dias') };
  });
  def('inadimplencia', 'Inadimplência: valor a receber vencido e em aberto sobre o total a receber que venceu nos últimos 90 dias, comparado à meta.', {}, (o) => {
    const L = o.ler('lanc'); if (!L) return SA(o, ['lanc'], 'o Financeiro (lançamentos)');
    const ini = maisDias(o.hoje, -90), x = L.filter(l => l.tipo === 'receber' && l.status !== 'cancelado' && dataOk(l.venc) && l.venc >= ini && l.venc < o.hoje);
    const tot = somaV(x, l => l.valor), venc = x.filter(l => !l.pago), v = somaV(venc, l => l.valor), pct = tot ? r2(v / tot * 100) : 0, meta = metaV(o.metas, 'inadimplencia_max', 5);
    const porCli = {}; venc.forEach(l => { const k = o.nomeParc(l.parcId) || 'sem cliente'; porCli[k] = r2((porCli[k] || 0) + (+l.valor || 0)); });
    return { periodo: { de: ini, ate: o.hoje }, recebivel_vencido_total: tot, em_aberto_vencido: v, inadimplencia_pct: pct, meta_max_pct: meta, fora_da_meta: pct > meta, maiores_devedores: Object.entries(porCli).sort((p, q2) => q2[1] - p[1]).slice(0, 6).map(([cliente, valor]) => ({ cliente, valor })), lancamentos: venc.slice(0, 10).map(l => ({ id: l.id, cliente: o.nomeParc(l.parcId), venc: l.venc, valor: r2(l.valor), dias_atraso: difDias(l.venc, o.hoje) })), fonte: F('cobr', 'Financeiro › Cobrança e renegociação') };
  });
  def('notas_pendentes', 'Notas fiscais pendentes: NF-e recebidas ainda sem lançar e NFS-e em rascunho.', {}, (o) => {
    const N = o.ler('notas'), S2 = o.ler('nfse'); if (!N && !S2) return SA(o, ['notas', 'nfse'], 'as notas fiscais');
    const out = { fonte: F('nf', 'Fiscal › Notas Fiscais') };
    if (N) { const rec = N.filter(n => n.recebida && n.status === 'rascunho'); out.nfe_recebidas_sem_lancar = { n: rec.length, valor: somaV(rec, n => n.valor || n.total), mais_antigas: rec.sort((a2, b2) => String(a2.data || a2.recEm || '').localeCompare(String(b2.data || b2.recEm || ''))).slice(0, 6).map(n => ({ numero: n.numero || '', emitente: txt(n.emitNome || n.parcNome || o.nomeParc(n.parcId), 60), data: n.data || n.recEm || '', valor: r2(n.valor || n.total) })) }; out.meta_max = metaV(o.metas, 'notas_pend_max', 5); } else out.nfe = 'sem acesso';
    if (S2) { const r = S2.filter(n => n.status === 'rascunho'); out.nfse_rascunho = { n: r.length, valor: somaV(r, n => n.valor || n.valorServ || n.total) }; } else out.nfse = 'sem acesso';
    return out;
  });
  const medValor = (m, ctr) => { if (isFinite(+m.valor) && +m.valor > 0) return +m.valor; if (isFinite(+m.total) && +m.total > 0) return +m.total; const it = (ctr && ctr.itens) || []; return (m.itens || []).reduce((s, x) => s + (+x.qtd || 0) * (+((it[x.idx] || {}).pu) || 0), 0); };
  def('medicoes_a_faturar', 'Medições ao cliente aprovadas e ainda não faturadas (e em rascunho), com o valor.', {}, (o) => {
    const Md = o.ler('med'); if (!Md) return SA(o, ['med'], 'as medições');
    const C = o.ler('ctr') || [], ctr = id => C.find(c => c.id === id);
    const ap = Md.filter(m => m.status === 'aprovada'), ra = Md.filter(m => m.status === 'rascunho');
    const val = m => r2(medValor(m, ctr(m.ctrId)));
    const semValor = ap.length && ap.every(m => !val(m));
    return { aprovadas_a_faturar: { n: ap.length, valor: semValor ? 'sem acesso aos valores' : somaV(ap, val), itens: ap.slice(0, 10).map(m => ({ contrato: (ctr(m.ctrId) || {}).numero || m.ctrId, numero: m.numero, periodo: (m.ini || '') + ' a ' + (m.fim || ''), valor: semValor ? null : val(m), aprovada_em: m.aprovEm ? new Date(m.aprovEm).toISOString().slice(0, 10) : '' })) }, em_rascunho: { n: ra.length }, meta_faturar_dias: metaV(o.metas, 'faturar_dias', 5), fonte: F('med', 'Comercial › Medições ao cliente') };
  });
  def('contratos_teto', 'Contratos vigentes: valor ou teto, total medido e o percentual consumido (alerta perto do teto).', {}, (o) => {
    const C = o.ler('ctr'); if (!C) return SA(o, ['ctr'], 'os contratos');
    const Md = o.ler('med') || [], alerta = metaV(o.metas, 'teto_alerta', 80);
    const ls = C.filter(c => c.status === 'vigente').map(c => { const lim = +c.teto > 0 ? +c.teto : (c.itens || []).reduce((s, x) => s + (+x.qtd || 0) * (+x.pu || 0), 0); const med = Md.filter(m => m.ctrId === c.id && ['aprovada', 'faturada'].includes(m.status)).reduce((s, m) => s + medValor(m, c), 0); return { id: c.id, numero: c.numero || '', cliente: o.nomeParc(c.parcId), objeto: txt(c.objeto, 80), limite: r2(lim), medido: r2(med), consumido_pct: lim ? r2(med / lim * 100) : null }; });
    const semValor = ls.length && ls.every(x => !x.limite && !x.medido);
    return { vigentes: ls.length, valores: semValor ? 'sem acesso aos valores gerenciais' : undefined, alerta_pct: alerta, perto_do_teto: ls.filter(x => x.consumido_pct != null && x.consumido_pct >= alerta).sort((a2, b2) => b2.consumido_pct - a2.consumido_pct).slice(0, 10), contratos: ls.sort((a2, b2) => (b2.consumido_pct || 0) - (a2.consumido_pct || 0)).slice(0, 15), fonte: F('ctr', 'Comercial › Contratos com clientes') };
  });
  def('obras_custo_vs_orcado', 'Obras ativas: orçamento, valor de venda, custo lançado (contas a pagar da obra), consumo do orçamento e margem prevista contra a meta.', {}, (o) => {
    const Pj = o.ler('proj'); if (!Pj) return SA(o, ['proj'], 'as obras');
    const L = o.ler('lanc'), mm = metaV(o.metas, 'margem_min', 25), al = metaV(o.metas, 'orcamento_alerta', 90);
    const ls = Pj.filter(p => (p.status || 'ativo') === 'ativo').map(p => { const custo = L ? L.filter(l => l.tipo === 'pagar' && l.status !== 'cancelado' && l.projId === p.id).reduce((s, l) => s + lancVal(l), 0) : null; const orc = +p.orcamento || 0, venda = +p.valorVenda || 0;
      const margem = venda && custo != null ? r2((venda - Math.max(custo, orc)) / venda * 100) : null; return { obra: (p.codigo ? p.codigo + ' · ' : '') + (p.nome || ''), orcamento: orc || null, valor_venda: venda || null, custo_lancado: custo == null ? 'sem acesso ao financeiro' : r2(custo), consumo_orcamento_pct: orc && custo != null ? r2(custo / orc * 100) : null, margem_prevista_pct: margem, abaixo_da_meta: margem != null && margem < mm }; });
    return { obras_ativas: ls.length, meta_margem_min_pct: mm, alerta_orcamento_pct: al, valores: ls.length && ls.every(x => x.orcamento == null && x.valor_venda == null) ? 'sem acesso aos valores gerenciais' : undefined, obras: ls.sort((a2, b2) => (b2.consumo_orcamento_pct || 0) - (a2.consumo_orcamento_pct || 0)).slice(0, 15), fonte: F('rproj', 'Obras › Resultado da obra') };
  });
  def('sc_paradas', 'Solicitações de compra paradas (enviadas, em cotação ou aprovação há mais de X dias) e o prazo médio SC → pedido nos últimos 90 dias.', { dias: P.dias(3) }, (o, a) => {
    const Sc = o.ler('sc'); if (!Sc) return SA(o, ['sc'], 'as solicitações de compra');
    const d = a && a.dias ? dias(a, 3) : metaV(o.metas, 'sc_parada_dias', 3), Pd = o.ler('ped') || [], ini = maisDias(o.hoje, -90);
    const par = Sc.filter(s => ['enviada', 'cotacao', 'aprovacao', 'pendente'].includes(s.status) && dataOk(s.data) && difDias(s.data, o.hoje) > d);
    const pz = []; for (const p of Pd) { const ids = uniq([p.scId].concat(Array.isArray(p.scIds) ? p.scIds : [])); for (const sid of ids) { const s = Sc.find(x => x.id === sid); if (s && dataOk(s.data) && dataOk(p.data) && p.data >= ini) pz.push(difDias(s.data, p.data)); } }
    const media = pz.length ? r2(pz.reduce((s, x) => s + x, 0) / pz.length) : null, meta = metaV(o.metas, 'sc_pedido_dias', 5);
    return { paradas_ha_mais_de_dias: d, paradas: { n: par.length, itens: par.sort((x, y) => String(x.data).localeCompare(String(y.data))).slice(0, 10).map(s => ({ numero: s.numero, status: s.status, desde: s.data, dias: difDias(s.data, o.hoje), obra: o.nomeProj(s.projId) || '', necessidade: s.necessidade || '' })) }, prazo_sc_pedido: { media_dias: media, amostras: pz.length, meta_max_dias: meta, fora_da_meta: media != null && media > meta }, fonte: F('sc', 'Suprimentos › Solicitações') };
  });
  def('precos_por_produto', 'Preços pagos por produto nos pedidos de compra: últimos preços, mínimo, máximo e fornecedor. Sem "busca", os produtos com maior variação.', { busca: { type: 'string', description: 'parte do nome do produto' } }, (o, a) => {
    const Pd = o.ler('ped'); if (!Pd) return SA(o, ['ped'], 'os pedidos de compra');
    const b = norm(a && a.busca), por = new Map();
    for (const p of Pd) { if (p.status === 'cancelado') continue; for (const it of (p.itens || [])) { const k = norm(it.desc || it.nome); if (!k || (b && !k.includes(b))) continue; const v = +it.vUnit || +it.preco || 0; if (!(v > 0)) continue; if (!por.has(k)) por.set(k, { produto: txt(it.desc || it.nome, 80), un: it.un || '', precos: [] }); por.get(k).precos.push({ data: p.data || '', fornecedor: o.nomeParc(p.parcId), valor: r2(v), pedido: p.numero || '' }); } }
    const ls = [...por.values()].map(x => { x.precos.sort((p1, p2) => String(p2.data).localeCompare(String(p1.data))); const vs = x.precos.map(p => p.valor), mn = Math.min(...vs), mx = Math.max(...vs); return { produto: x.produto, un: x.un, ultimo: x.precos[0], minimo: mn, maximo: mx, variacao_pct: mn ? r2((mx - mn) / mn * 100) : 0, compras: x.precos.length, ultimos: x.precos.slice(0, 5) }; });
    if (ls.length && ls.every(x => !x.minimo)) return { valores: 'sem acesso aos preços' };
    return { busca: a && a.busca || '', produtos: ls.sort((x, y) => b ? y.compras - x.compras : y.variacao_pct - x.variacao_pct).slice(0, 10), fonte: F('ped', 'Suprimentos › Pedidos de compra') };
  });
  def('estoque_minimo', 'Produtos com saldo no estoque igual ou abaixo do mínimo cadastrado.', {}, (o) => {
    const Pr = o.ler('prod'), Mv = o.ler('mov'); if (!Pr || !Mv) return SA(o, uniq([!Pr && 'prod', !Mv && 'mov']), 'o estoque');
    const sal = new Map(); for (const m of Mv) { const qq = +m.qtd || 0; const v = m.tipo === 'entrada' ? qq : m.tipo === 'saida' ? -qq : m.tipo === 'transf' ? 0 : qq; sal.set(m.prodId, (sal.get(m.prodId) || 0) + v); }
    const ab = Pr.filter(p => (+p.minimo || 0) > 0 && (sal.get(p.id) || 0) <= +p.minimo).map(p => ({ produto: txt(p.nome, 80), saldo: r2(sal.get(p.id) || 0), minimo: +p.minimo, un: p.un || '' }));
    return { abaixo_do_minimo: ab.length, com_minimo_cadastrado: Pr.filter(p => (+p.minimo || 0) > 0).length, itens: ab.sort((x, y) => (x.saldo - x.minimo) - (y.saldo - y.minimo)).slice(0, 20), fonte: F('est', 'Suprimentos › Estoque') };
  });
  def('validades', 'Validades que vencem nos próximos dias (ou já venceram): CA de EPI dos produtos, CNH dos colaboradores e documentos/ASO (só o que o perfil lê).', { dias: P.dias(30) }, (o, a) => {
    const d = dias(a, 30), lim = maisDias(o.hoje, d), out = { hoje: o.hoje, janela_dias: d, grupos: {} }, it = (l, f) => { const v = l.filter(x => dataOk(f(x)) && f(x) <= lim); return { vencidos: v.filter(x => f(x) < o.hoje).length, a_vencer: v.filter(x => f(x) >= o.hoje).length, proximos: v.sort((x, y) => f(x).localeCompare(f(y))).slice(0, 8) }; };
    const Pr = o.ler('prod'); if (Pr) { const r = it(Pr, p => p.caVal || ''); out.grupos.ca_epi = Object.assign(r, { proximos: r.proximos.map(p => ({ produto: txt(p.nome, 60), ca: p.ca || '', validade: p.caVal })) }); out.fonte = F('est', 'Suprimentos › Estoque'); }
    const Fu = o.ler('func'); if (Fu) { const r = it(Fu.filter(f => f.status !== 'desligado'), f => f.cnhValidade || ''); out.grupos.cnh = Object.assign(r, { proximos: r.proximos.map(f => ({ colaborador: f.nome, validade: f.cnhValidade })) }); }
    const Rd = o.ler('rhdoc'); if (Rd) { const r = it(Rd, x => x.validade || ''); out.grupos.documentos_rh = Object.assign(r, { proximos: r.proximos.map(x => ({ colaborador: o.nomeFunc(x.funcId), tipo: txt(x.tipo, 40), validade: x.validade })) }); out.fonte = out.fonte || F('rhdoc', 'Pessoas › Documentos e ASO'); }
    if (!Pr && !Fu && !Rd) return SA(o, ['prod', 'func', 'rhdoc'], 'produtos, colaboradores nem documentos');
    out.sem_acesso_a = [!Pr && 'CA de EPI', !Fu && 'CNH', !Rd && 'documentos e ASO'].filter(Boolean); out.fonte = out.fonte || F('v158cond', 'Frota › Condutores'); return out;
  });
  def('aso_nr_vencendo', 'ASO e certificados de NR vencidos ou a vencer nos próximos dias, por colaborador.', { dias: P.dias(30) }, (o, a) => {
    const Rd = o.ler('rhdoc'); if (!Rd) return SA(o, ['rhdoc'], 'os documentos e ASO dos colaboradores (dados de saúde)');
    const d = a && a.dias ? dias(a, 30) : metaV(o.metas, 'aviso_aso_dias', 30), lim = maisDias(o.hoje, d);
    const ls = Rd.filter(x => dataOk(x.validade) && x.validade <= lim && /aso|nr/i.test(String(x.tipo || '')));
    const g = t => ls.filter(x => (/aso/i.test(String(x.tipo)) ? 'ASO' : 'NR') === t);
    const lin = x => ({ colaborador: o.nomeFunc(x.funcId) || '', tipo: txt(x.tipo, 40), validade: x.validade, vencido: x.validade < o.hoje });
    return { janela_dias: d, aso: { vencidos: g('ASO').filter(x => x.validade < o.hoje).length, a_vencer: g('ASO').filter(x => x.validade >= o.hoje).length }, nr: { vencidos: g('NR').filter(x => x.validade < o.hoje).length, a_vencer: g('NR').filter(x => x.validade >= o.hoje).length }, proximos: ls.sort((x, y) => x.validade.localeCompare(y.validade)).slice(0, 15).map(lin), fonte: F('rhdoc', 'Pessoas › Documentos e ASO') };
  });
  def('horas_extras', 'Horas extras aprovadas no período: total, por colaborador e quem passou da meta de horas por dia. Custo estimado só se o perfil vê salários.', { dias: P.dias(30) }, (o, a) => {
    const H = o.ler('heaut'); if (!H) return SA(o, ['heaut'], 'as horas extras');
    const d = dias(a, 30), ini = maisDias(o.hoje, -d), meta = metaV(o.metas, 'he_max_dia', 2), Fu = o.ler('func') || [];
    const x = H.filter(h => h.status === 'aprovada' && dataOk(h.data) && h.data > ini && h.data <= o.hoje);
    const por = new Map(); x.forEach(h => { const k = h.funcId || '?'; const v = por.get(k) || { horas: 0, dias: 0, acima: 0, max: 0 }; const hh = +h.horas || 0; v.horas += hh; v.dias++; v.max = Math.max(v.max, hh); if (hh > meta) v.acima++; por.set(k, v); });
    const sal = id => { const f = Fu.find(y => y.id === id); return f && f.salario !== undefined ? +f.salario || 0 : null; };
    const veSal = Fu.some(f => f.salario !== undefined);
    const ls = [...por.entries()].map(([id, v]) => ({ colaborador: o.nomeFunc(id) || id, horas: r2(v.horas), dias: v.dias, max_dia: r2(v.max), dias_acima_da_meta: v.acima, custo_estimado: veSal && sal(id) != null ? r2(v.horas * sal(id) / 220 * 1.5) : undefined }));
    return { periodo: { de: maisDias(ini, 1), ate: o.hoje }, total_horas: r2(x.reduce((s, h) => s + (+h.horas || 0), 0)), registros: x.length, meta_max_h_dia: meta, acima_da_meta: ls.filter(l => l.dias_acima_da_meta > 0).length, custo: veSal ? 'estimado pelo salário (hora normal = salário/220, adicional de 50%)' : 'sem acesso aos salários', colaboradores: ls.sort((p, q2) => q2.horas - p.horas).slice(0, 12), fonte: F('hextra', 'Pessoas › Horas extras') };
  });
  def('salarios_resumo', 'Resumo da folha pelo cadastro: total de salários, média e por função (só para perfis que veem salários).', {}, (o) => {
    const Fu = o.ler('func'); if (!Fu) return SA(o, ['func'], 'os colaboradores');
    const at = Fu.filter(f => f.status !== 'desligado'); if (!at.some(f => f.salario !== undefined)) return { sem_acesso: true, colecoes: ['func.salario'], mensagem: 'Não tenho acesso a isso: o perfil de ' + nomeConta(o.conta.id) + ' não vê salários.' };
    const por = {}; at.forEach(f => { const k = txt(f.funcao || 'sem função', 40); const v = por[k] || { n: 0, total: 0 }; v.n++; v.total += +f.salario || 0; por[k] = v; });
    const tot = at.reduce((s, f) => s + (+f.salario || 0), 0);
    return { ativos: at.length, total_salarios: r2(tot), media: at.length ? r2(tot / at.length) : 0, por_funcao: Object.entries(por).sort((p, q2) => q2[1].total - p[1].total).slice(0, 12).map(([funcao, v]) => ({ funcao, n: v.n, total: r2(v.total), media: r2(v.total / v.n) })), fonte: F('func', 'Pessoas › Colaboradores') };
  });
  def('quadro_pessoal', 'Quadro de pessoal ativo: quantidade por obra, por cidade e as funções mais comuns.', {}, (o) => {
    const Fu = o.ler('func'); if (!Fu) return SA(o, ['func'], 'os colaboradores');
    const at = Fu.filter(f => f.status !== 'desligado'), cont = f => { const m = {}; at.forEach(x => { const k = f(x) || '—'; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((p, q2) => q2[1] - p[1]).slice(0, 12).map(([k, n]) => ({ k, n })); };
    return { ativos: at.length, por_obra: cont(f => o.nomeProj(f.projId)), por_cidade: cont(f => f.cidade), por_funcao: cont(f => txt(f.funcao, 40)), fonte: F('quadro', 'Pessoas › Quadro de pessoal por obra') };
  });
  def('colaborador_busca', 'Busca um colaborador pelo nome: função, obra, cidade, situação, admissão e CPF mascarado.', { nome: { type: 'string' } }, (o, a) => {
    const Fu = o.ler('func'); if (!Fu) return SA(o, ['func'], 'os colaboradores');
    const n = norm(a && a.nome); if (n.length < 2) return { erro: 'Informe ao menos 2 letras do nome.' };
    const ls = Fu.filter(f => norm(f.nome).includes(n)).slice(0, 8).map(f => ({ nome: f.nome, funcao: f.funcao || '', obra: o.nomeProj(f.projId), cidade: f.cidade || '', situacao: f.status || 'ativo', admissao: f.admissao || f.adm || '', cpf: f.cpf ? mascCpf(f.cpf) : (f._restrito ? 'sem acesso' : '') }));
    return { encontrados: ls.length, colaboradores: ls, fonte: F('func', 'Pessoas › Colaboradores') };
  });
  def('epi_trocas', 'Entregas e trocas de EPI no período: total, por item e colaboradores com muitas trocas.', { dias: P.dias(30) }, (o, a) => {
    const E = o.ler('epi'); if (!E) return SA(o, ['epi'], 'o controle de EPI');
    const d = dias(a, 30), ini = maisDias(o.hoje, -d), meta = metaV(o.metas, 'epi_trocas_max', 3), x = E.filter(e => dataOk(e.entrega) && e.entrega > ini && e.entrega <= o.hoje);
    const pi = {}, pf = {}; x.forEach(e => { const k = txt(e.item, 60) || 'EPI'; pi[k] = (pi[k] || 0) + (+e.qtd || 1); const f = e.funcId || '?'; pf[f] = (pf[f] || 0) + 1; });
    return { periodo: { de: maisDias(ini, 1), ate: o.hoje }, entregas: x.length, por_item: Object.entries(pi).sort((p, q2) => q2[1] - p[1]).slice(0, 10).map(([item, qtd]) => ({ item, qtd })), meta_max_trocas: meta, acima_da_meta: Object.entries(pf).filter(([, n]) => n > meta).map(([id, n]) => ({ colaborador: o.nomeFunc(id) || id, trocas: n })).slice(0, 10), fonte: F('epi', 'Segurança › Controle de EPI') };
  });
  const kmlMeta = (metas, t) => { const m = (metas || []).find(x => x.tipo === t); return m ? +m.valor : (METAS_PAD.frota.find(x => x.tipo === t) || {}).valor || null; };
  function consumos(Ab, Vc) {
    const out = new Map();
    for (const v of Vc) { const l = Ab.filter(a => a.veicId === v.id && +a.km > 0).sort((a, b) => (+a.km) - (+b.km) || String(a.data).localeCompare(String(b.data))); let ult = null, lit = 0; const tr = [];
      for (const a of l) { if (ult) lit += +a.litros || 0; if (a.cheio) { if (ult && lit > 0 && +a.km > +ult.km) tr.push({ km: +a.km - +ult.km, litros: lit, ate: a.data }); ult = a; lit = 0; } else if (!ult) { /* espera o 1º tanque cheio */ } }
      out.set(v.id, tr); }
    return out;
  }
  def('frota_consumo', 'Consumo (km/l) por veículo entre tanques cheios no período, comparado ao consumo esperado por tipo de veículo.', { dias: P.dias(60) }, (o, a) => {
    const Ab = o.ler('vabas'), Vc = o.ler('veic'); if (!Ab || !Vc) return SA(o, uniq([!Ab && 'vabas', !Vc && 'veic']), 'a frota (abastecimentos e veículos)');
    const d = dias(a, 60), ini = maisDias(o.hoje, -d), al = metaV(o.metas, 'kml_alerta', 75), cs = consumos(Ab, Vc);
    const ls = Vc.filter(v => v.status !== 'inativo').map(v => { const tr = (cs.get(v.id) || []).filter(t => t.ate > ini && t.ate <= o.hoje); const km = tr.reduce((s, t) => s + t.km, 0), lt = tr.reduce((s, t) => s + t.litros, 0), tp = FR.tipoDe(v), esp = kmlMeta(o.metas, tp), kml = lt ? r2(km / lt) : null;
      return { veiculo: (v.placa || '') + (v.modelo ? ' · ' + v.modelo : ''), tipo: FR.tipoNome(tp), km: r2(km), litros: r2(lt), km_l: kml, esperado_km_l: esp, abaixo_do_esperado: kml != null && esp ? kml < esp * al / 100 : false }; }).filter(x => x.litros > 0);
    return { periodo: { de: maisDias(ini, 1), ate: o.hoje }, veiculos_com_dados: ls.length, alerta_pct_do_esperado: al, abaixo: ls.filter(x => x.abaixo_do_esperado).length, veiculos: ls.sort((x, y) => (x.km_l / (x.esperado_km_l || 1)) - (y.km_l / (y.esperado_km_l || 1))).slice(0, 15), fonte: F('vabas', 'Frota › Abastecimentos') };
  });
  def('abastecimentos_alerta', 'Abastecimentos suspeitos no período: km menor que o anterior, litros acima do tanque, dois no mesmo dia e consumo muito abaixo do esperado.', { dias: P.dias(30) }, (o, a) => {
    const Ab = o.ler('vabas'), Vc = o.ler('veic'); if (!Ab || !Vc) return SA(o, uniq([!Ab && 'vabas', !Vc && 'veic']), 'a frota (abastecimentos e veículos)');
    const d = dias(a, 30), ini = maisDias(o.hoje, -d), al = metaV(o.metas, 'kml_alerta', 75), out = [];
    for (const v of Vc) { const l = Ab.filter(x => x.veicId === v.id).sort((x, y) => String(x.data).localeCompare(String(y.data)) || (+x.km) - (+y.km)); const nm = (v.placa || '') + (v.modelo ? ' · ' + v.modelo : '');
      l.forEach((x, i) => { if (!(dataOk(x.data) && x.data > ini && x.data <= o.hoje)) return; const ant = l[i - 1];
        if (ant && +x.km > 0 && +ant.km > 0 && +x.km < +ant.km) out.push({ veiculo: nm, data: x.data, alerta: 'km menor que o abastecimento anterior', km: +x.km, km_anterior: +ant.km });
        if (+v.tanque > 0 && +x.litros > +v.tanque * 1.05) out.push({ veiculo: nm, data: x.data, alerta: 'litros acima da capacidade do tanque', litros: +x.litros, tanque: +v.tanque });
        if (ant && ant.data === x.data) out.push({ veiculo: nm, data: x.data, alerta: 'dois abastecimentos no mesmo dia', litros: +x.litros }); }); }
    const cs = consumos(Ab, Vc); for (const v of Vc) { const esp = kmlMeta(o.metas, FR.tipoDe(v)); for (const t of (cs.get(v.id) || [])) if (t.ate > ini && t.ate <= o.hoje && esp && t.km / t.litros < esp * al / 100) out.push({ veiculo: (v.placa || '') + (v.modelo ? ' · ' + v.modelo : ''), data: t.ate, alerta: 'consumo muito abaixo do esperado', km_l: r2(t.km / t.litros), esperado_km_l: esp }); }
    return { periodo: { de: maisDias(ini, 1), ate: o.hoje }, alertas: out.length, itens: out.slice(0, 20), fonte: F('vabas', 'Frota › Abastecimentos') };
  });
  def('producao_fabrica', 'Ordens de fabricação em andamento por etapa e as atrasadas (prazo vencido).', {}, (o) => {
    const Os = o.ler('osf'); if (!Os) return SA(o, ['osf'], 'as ordens de fabricação');
    const ab = Os.filter(r => !r.cancelada && !['ent', 'env'].includes(r.etapa)), et = {}; ab.forEach(r => { et[r.etapa || '—'] = (et[r.etapa || '—'] || 0) + 1; });
    const atr = ab.filter(r => dataOk(r.prazo) && r.prazo < o.hoje);
    return { em_andamento: ab.length, por_etapa: et, atrasadas: { n: atr.length, meta_max: metaV(o.metas, 'osf_atrasadas_max', 0), itens: atr.sort((x, y) => x.prazo.localeCompare(y.prazo)).slice(0, 10).map(r => ({ numero: r.numero, etapa: r.etapa, prazo: r.prazo, dias_atraso: difDias(r.prazo, o.hoje), obra: o.nomeProj(r.projId) })) }, fonte: F('osfp', 'Fábrica › Painel de produção') };
  });
  def('nao_conformidades', 'Não conformidades abertas: por situação e as abertas há mais tempo que a meta.', {}, (o) => {
    const Nc = o.ler('nc'); if (!Nc) return SA(o, ['nc'], 'as não conformidades');
    const ab = Nc.filter(n => n.status !== 'fechada'), d = metaV(o.metas, 'nc_aberta_dias', 30), stt = {}; ab.forEach(n => { stt[n.status || 'aberta'] = (stt[n.status || 'aberta'] || 0) + 1; });
    const dt = n => n.data || n.abertura || '', vel = ab.filter(n => dataOk(dt(n)) && difDias(dt(n), o.hoje) > d);
    return { abertas: ab.length, por_situacao: stt, meta_dias: d, abertas_ha_mais_tempo: vel.slice(0, 10).map(n => ({ numero: n.numero || '', titulo: txt(n.titulo || n.desc, 80), desde: dt(n), dias: difDias(dt(n), o.hoje) })), fonte: F('nc', 'Qualidade › Não conformidades') };
  });
  def('reunioes_proximas', 'Próximas reuniões agendadas que a pessoa vê (para propor um item de pauta).', {}, (o) => {
    const R = o.ler('reun'); if (!R) return SA(o, ['reun'], 'a Agenda');
    return { reunioes: R.filter(r => r.status !== 'cancelada' && dataOk(r.data) && r.data >= o.hoje).sort((x, y) => String(x.data + x.ini).localeCompare(String(y.data + y.ini))).slice(0, 10).map(r => ({ id: r.id, titulo: txt(r.titulo, 100), data: r.data, ini: r.ini || '' })), fonte: F('agenda', 'Agenda') };
  });
  T.propor_acao = { nome: 'propor_acao', descricao: 'Propõe UMA ação para a pessoa confirmar no chat (nada é executado sem o botão Confirmar). tipo: "tarefa" {descricao, responsavel (nome), prazo (AAAA-MM-DD) ou prazo_dias, prioridade alta|media|baixa}; "sc_rascunho" {itens:[{desc, qtd, un}], obra (código ou nome, opcional), necessidade (AAAA-MM-DD), obs}; "cobranca" {lancamento_id (de contas_a_vencer ou inadimplencia), texto}; "pauta" {reuniao_id (de reunioes_proximas), titulo}.',
    props: { tipo: { type: 'string', enum: ['tarefa', 'sc_rascunho', 'cobranca', 'pauta'] }, titulo: { type: 'string', description: 'resumo da ação em uma linha' }, dados: { type: 'object' } }, fn: null };
  const schema = nome => { const t = T[nome]; return { name: nome, description: t.descricao, input_schema: { type: 'object', properties: t.props, required: nome === 'propor_acao' ? ['tipo', 'titulo', 'dados'] : [] } }; };

  /* ---------------- ações propostas (só com Confirmar) ---------------- */
  function contaPorNome(nome) { const n = norm(nome); if (!n) return ''; const cs = q.contas.all().filter(c => c.ativo); const ex = cs.find(c => norm(c.nome) === n); if (ex) return ex.id; const p = cs.filter(c => norm(c.nome).split(' ')[0] === n.split(' ')[0] && norm(c.nome).includes(n)); return p.length === 1 ? p[0].id : ''; }
  function validarAcao(o, id, a) {
    const tipo = String(a.tipo || ''), d = (a && a.dados && typeof a.dados === 'object') ? a.dados : {};
    if (!ACOES_DE(id).includes(tipo)) return { erro: 'O ' + ANOME[id] + ' não propõe ações do tipo "' + tipo + '".' };
    const titulo = txt(a.titulo, 160);
    if (tipo === 'tarefa') {
      const descricao = txt(d.descricao || a.titulo, 400); if (!descricao) return { erro: 'Tarefa sem descrição.' };
      let prazo = dataOk(d.prazo) ? d.prazo : ''; if (!prazo && +d.prazo_dias > 0) prazo = maisDias(o.hoje, Math.min(365, Math.round(+d.prazo_dias))); if (!prazo) prazo = maisDias(o.hoje, 7);
      const resp = contaOk(d.responsavel) ? String(d.responsavel) : (contaPorNome(d.responsavel) || o.conta.id);
      return { tipo, titulo: titulo || descricao.slice(0, 120), dados: { descricao, resp, respNome: nomeConta(resp), prazo, prioridade: ['alta', 'media', 'baixa'].includes(norm(d.prioridade).replace('é', 'e')) ? norm(d.prioridade) : 'media' } };
    }
    if (tipo === 'sc_rascunho') {
      const itens = (Array.isArray(d.itens) ? d.itens : []).slice(0, 20).map(x => ({ desc: txt(x && (x.desc || x.descricao || x.produto), 160), un: txt(x && x.un, 10) || 'UN', qtd: Math.max(0, +(x && x.qtd) || 0) })).filter(x => x.desc && x.qtd > 0);
      if (!itens.length) return { erro: 'SC sem itens (cada item precisa de descrição e quantidade).' };
      let projId = ''; if (d.obra) { const Pj = o.ler('proj') || [], n = norm(d.obra); const p = Pj.find(x => norm(x.codigo) === n || norm(x.nome) === n || x.id === d.obra) || Pj.find(x => norm(x.nome).includes(n)); if (p) projId = p.id; }
      return { tipo, titulo: titulo || 'SC em rascunho com ' + itens.length + ' item(ns)', dados: { itens, projId, obraNome: projId ? o.nomeProj(projId) : '', necessidade: dataOk(d.necessidade) ? d.necessidade : maisDias(o.hoje, 7), obs: txt(d.obs, 400) } };
    }
    if (tipo === 'cobranca') {
      const lid = String(d.lancamento_id || d.lancId || ''); const L = o.ler('lanc'); const l = L && L.find(x => x.id === lid);
      if (!l) return { erro: 'Lançamento não encontrado ou sem acesso: use o id que veio de contas_a_vencer ou inadimplencia.' };
      if (l.tipo !== 'receber') return { erro: 'Lembrete de cobrança só para conta a receber.' };
      const texto = txtL(d.texto, 1500); if (!texto) return { erro: 'Escreva o texto do lembrete.' };
      return { tipo, titulo: titulo || 'Lembrete de cobrança', dados: { lancId: lid, cliente: o.nomeParc(l.parcId), valor: r2(l.valor), venc: l.venc, texto } };
    }
    if (tipo === 'pauta') {
      const rid = String(d.reuniao_id || d.reunId || ''), R = o.ler('reun'), r = R && R.find(x => x.id === rid);
      if (!r) return { erro: 'Reunião não encontrada ou sem acesso: use o id que veio de reunioes_proximas.' };
      const t2 = txt(d.titulo || a.titulo, 200); if (!t2) return { erro: 'Item de pauta sem título.' };
      return { tipo, titulo: titulo || 'Item de pauta: ' + t2, dados: { reunId: rid, reuniao: txt(r.titulo, 100), data: r.data, titulo: t2 } };
    }
    return { erro: 'Tipo de ação desconhecido.' };
  }
  const ACAO_ROT = { tarefa: 'Criar tarefa', sc_rascunho: 'Criar SC em rascunho', cobranca: 'Registrar lembrete de cobrança', pauta: 'Incluir na pauta' };
  const acaoPub = r => { let d = {}; try { d = JSON.parse(r.dados); } catch (e) { } return { id: r.id, tipo: r.tipo, rot: ACAO_ROT[r.tipo], titulo: d._titulo || '', resumo: resumoAcao(r.tipo, d), st: r.st, res: r.res || '' }; };
  function resumoAcao(tipo, d) {
    if (tipo === 'tarefa') return d.descricao + ' · responsável ' + (d.respNome || '') + ' · prazo ' + fmtBr(d.prazo) + ' · prioridade ' + d.prioridade;
    if (tipo === 'sc_rascunho') return d.itens.map(i => i.qtd + ' ' + i.un + ' ' + i.desc).join('; ') + (d.obraNome ? ' · obra ' + d.obraNome : '') + ' · necessidade ' + fmtBr(d.necessidade);
    if (tipo === 'cobranca') return (d.cliente || 'cliente') + ' · R$ ' + d.valor + ' · venc. ' + fmtBr(d.venc) + '\n' + d.texto;
    if (tipo === 'pauta') return '"' + d.titulo + '" na reunião "' + d.reuniao + '" de ' + fmtBr(d.data);
    return '';
  }
  async function executarAcao(conta, req, r) {
    let d = {}; try { d = JSON.parse(r.dados); } catch (e) { }
    if (r.tipo === 'tarefa') { const x = X.tarefa168(conta, req, { descricao: d.descricao, resp: d.resp, prazo: d.prazo, prioridade: d.prioridade, origem: { tipo: 'ia169', asst: r.asst, nome: ANOME[r.asst] } }); return x && x.erro ? x : { ok: true, msg: 'Tarefa criada (Minha área › Minhas tarefas).', ref: x.tarefa && x.tarefa.id }; }
    if (r.tipo === 'sc_rascunho') {
      const id = novoId('sc'), nums = colRaw('sc').map(s => parseInt(s.numero, 10) || 0), numero = String(Math.max(0, ...nums) + 1);
      const sc = { id, numero, data: hojeBr(), necessidade: d.necessidade, solicitante: nomeConta(conta.id), solUid: conta.id, tipo: d.projId ? 'obra' : 'adm', projId: d.projId || '', status: 'rascunho', itens: d.itens.map(i => ({ desc: i.desc, un: i.un, qtd: i.qtd })), obs: ((d.obs ? d.obs + '\n' : '') + 'Rascunho proposto pelo ' + ANOME[r.asst] + ' e confirmado por ' + nomeConta(conta.id) + '.').slice(0, 600), ia169: r.id };
      const g = X.gravarComo(conta, req, 'sc/' + id, sc, false); return g.erro ? g : { ok: true, msg: 'SC nº ' + numero + ' criada em rascunho (Suprimentos › Solicitações). Revise e envie pela tela.', ref: id };
    }
    if (r.tipo === 'cobranca') {
      const l = doc('lanc/' + d.lancId); if (!l) return { erro: 'Lançamento não existe mais.', st: 404 };
      const g = X.gravarComo(conta, req, 'lanc/' + d.lancId, { cobr169: (Array.isArray(l.cobr169) ? l.cobr169 : []).concat([{ em: Date.now(), por: conta.id, texto: d.texto, asst: r.asst }]).slice(-20) }, true);
      return g.erro ? g : { ok: true, msg: 'Lembrete registrado no lançamento. Copie o texto e envie ao cliente pelo canal de sempre.', ref: d.lancId, texto: d.texto };
    }
    if (r.tipo === 'pauta') {
      const re = doc('reun/' + d.reunId); if (!re) return { erro: 'Reunião não existe mais.', st: 404 };
      const it = Array.isArray(re.pautaItens) ? re.pautaItens.slice() : []; if (it.some(x => norm(x.titulo) === norm(d.titulo))) return { ok: true, msg: 'O item já estava na pauta.' };
      it.push({ id: novoId('pi'), titulo: d.titulo, resp: '', min: 10 });
      const g = X.gravarComo(conta, req, 'reun/' + d.reunId, { pautaItens: it }, true); return g.erro ? g : { ok: true, msg: 'Item incluído na pauta da reunião "' + d.reuniao + '".', ref: d.reunId };
    }
    return { erro: 'Tipo de ação desconhecido.', st: 400 };
  }
  async function decidirAcao(conta, req, b) {
    const r = st.acaoGet.get(String(b.id || '')); if (!r || r.conta !== conta.id) return { erro: 'Proposta não encontrada.', st: 404 };
    if (r.st !== 'proposta') return { erro: r.st === 'feita' ? 'Esta ação já foi confirmada.' : 'Esta proposta já foi ' + (r.st === 'descartada' ? 'descartada.' : 'tratada.'), st: 409 };
    if (b.decisao === 'descartar') { st.acaoSt.run('descartada', Date.now(), '', r.id); if (r.msg) atualizarMsg(r.msg, m => { (m.ia169.acoes || []).forEach(a => { if (a.id === r.id) a.st = 'descartada'; }); }); auditar(conta, req, 'IA169_ACAO', 'ia169/acao/' + r.id, null, { asst: r.asst, tipo: r.tipo, st: 'descartada' }); return { ok: true, st: 'descartada' }; }
    if (b.decisao !== 'confirmar') return { erro: 'Decisão inválida.', st: 400 };
    const x = await executarAcao(conta, req, r);
    const sti = x.erro ? 'proposta' : 'feita'; /* com erro (ex.: o perfil não grava), a proposta continua aberta para a pessoa ver o motivo */
    st.acaoSt.run(sti, Date.now(), x.erro ? 'Erro: ' + x.erro : x.msg, r.id);
    if (r.msg) atualizarMsg(r.msg, m => { (m.ia169.acoes || []).forEach(a => { if (a.id === r.id) { a.st = sti; a.res = x.erro ? 'Não foi possível: ' + x.erro : x.msg; } }); });
    auditar(conta, req, 'IA169_ACAO', 'ia169/acao/' + r.id, null, { asst: r.asst, tipo: r.tipo, st: x.erro ? 'erro' : 'feita', ref: x.ref || '', erro: x.erro ? String(x.erro).slice(0, 200) : undefined });
    return x.erro ? { erro: x.erro, st: x.st || 403 } : Object.assign({ ok: true, st: 'feita' }, x);
  }

  /* ---------------- chamada à Anthropic com ferramentas ---------------- */
  const TIER_CHAT = () => ['quick', 'default', 'complex'].includes(env('IA169_MODELO_CHAT', '')) ? env('IA169_MODELO_CHAT') : 'default';
  const TIER_RES = () => ['quick', 'default', 'complex'].includes(env('IA169_MODELO_RESUMO', '')) ? env('IA169_MODELO_RESUMO') : 'complex';
  async function anthropic(body) {
    const key = X.aiKey(); if (!key) throw { st: 503, msg: 'IA não configurada no servidor.' };
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}), body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { st: r.status === 429 ? 429 : 502, msg: (j.error && j.error.message) || 'Falha na IA.', code: r.status === 429 ? 'rate_limited' : 'upstream_error' };
    return j;
  }
  const regrasTexto = (id, metas, hoje) => 'Você é o ' + ANOME[id] + ' da Central de Gestão (ERP de uma empresa de construção civil, elétrica, ar-condicionado, estrutura metálica e projetos). Hoje é ' + fmtBr(hoje) + ' (horário de Brasília).\n' +
    'Regras:\n- Responda sempre em português do Brasil, curto e direto.\n- Use SÓ os números que vieram das ferramentas. Nunca invente, estime ou complete números. Se não houver dado, diga que não há.\n' +
    '- Cite a tela de origem de cada número como "(fonte: <rotulo>)", usando o campo fonte.rotulo da ferramenta.\n' +
    '- Se uma ferramenta devolver sem_acesso, diga exatamente "Não tenho acesso a isso" e explique que o perfil da pessoa não lê esses dados. Não tente contornar.\n' +
    '- CPF sempre mascarado como veio. Não peça nem repita dados pessoais além do necessário.\n' +
    '- Para sugerir uma ação (tarefa, SC em rascunho, lembrete de cobrança, item de pauta) use a ferramenta propor_acao; diga que ela só acontece quando a pessoa clicar em Confirmar no chat. Nunca diga que já executou.\n' +
    '- Compare com as metas abaixo quando fizer sentido.\nMetas configuradas: ' + JSON.stringify((metas || []).map(m => ({ meta: m.nome, valor: m.valor, un: m.un })));
  function historico(conta, id, C) { const n = C.global.histMsgs; if (!n) return []; const ls = st.histDe.all(conta.id, id, Date.now() - C.global.histDias * 864e5, n).reverse(); const out = []; for (const h of ls) { const role = h.papel === 'user' ? 'user' : 'assistant'; if (!out.length && role !== 'user') continue; if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + h.texto; else out.push({ role, content: h.texto }); } if (out.length && out[out.length - 1].role === 'user') out.pop(); return out; }
  const reqRotina = { headers: {}, socket: { remoteAddress: 'rotina' } };

  async function perguntar(conta, req, b) {
    const id = String(b.asst || ''), C = cfg(); if (!AID.has(id)) return { erro: 'Assistente desconhecido.', st: 400 };
    const pergunta = txtL(b.txt, 4000); if (!pergunta) return { erro: 'Escreva a pergunta.', st: 400 };
    if (!podeUsar(conta, id, C)) { auditar(conta, req, 'IA169_NEGADO', 'ia169/' + id, null, { asst: id }); return { erro: 'Não tenho acesso a isso: seu perfil não usa o ' + ANOME[id] + '. Peça ao Administrador (Sistema › Assistentes de IA).', st: 403 }; }
    const lim = limite(id, C); if (lim) { auditar(conta, req, 'IA169_LIMITE', 'ia169/' + id, null, { asst: id }); const m = escreverMsg(conta.id, id, lim, { chat: true, tipo: 'aviso' }); return { erro: lim, st: 429, msg: m }; }
    const o = Object.assign(leitor(conta, req), { metas: C.asst[id].metas }), ferr = ferramentasDe(conta, id, C), tools = ferr.map(schema);
    const msgs = historico(conta, id, C).concat([{ role: 'user', content: pergunta }]);
    const usadas = [], fontes = [], props = [], semAc = [], tier = TIER_CHAT(); let tin = 0, tout = 0, texto = '', bytes = 0, voltas = 0, erroIa = '';
    try {
      for (voltas = 1; voltas <= 6; voltas++) {
        const j = await anthropic({ model: X.AI_MODELS[tier] || X.AI_MODELS.default, max_tokens: 2500, system: regrasTexto(id, C.asst[id].metas, o.hoje), tools, messages: msgs });
        tin += (j.usage && j.usage.input_tokens) || 0; tout += (j.usage && j.usage.output_tokens) || 0;
        const usos = (j.content || []).filter(c => c.type === 'tool_use');
        if (j.stop_reason !== 'tool_use' || !usos.length || voltas === 6) { texto = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim(); break; }
        msgs.push({ role: 'assistant', content: j.content }); const res = [];
        for (const u of usos) {
          let out; usadas.push(u.name);
          if (!ferr.includes(u.name) || !T[u.name]) out = { erro: 'Ferramenta não disponível para este assistente.' };
          else if (u.name === 'propor_acao') { const v = props.length >= 3 ? { erro: 'Limite de 3 propostas por resposta.' } : validarAcao(o, id, u.input || {}); if (v.erro) out = { erro: v.erro }; else { const aid = novoId('ac'); st.acaoAdd.run(aid, conta.id, id, v.tipo, JSON.stringify(Object.assign({ _titulo: v.titulo }, v.dados)), 'proposta', Date.now(), 0, '', ''); props.push(aid); out = { registrada: true, id: aid, aviso: 'Proposta registrada. Só será executada se a pessoa clicar em Confirmar no chat.' }; } }
          else { try { out = T[u.name].fn(o, u.input || {}); } catch (e) { out = { erro: 'Falha ao ler os dados.' }; console.error('[v169] ferramenta', u.name, e.message); } }
          if (out && out.sem_acesso) semAc.push(u.name);
          if (out && out.fonte && !fontes.some(f => f.tela === out.fonte.tela)) fontes.push(out.fonte);
          const s = JSON.stringify(out || {}); bytes += s.length; res.push({ type: 'tool_result', tool_use_id: u.id, content: s.slice(0, 30000) });
        }
        msgs.push({ role: 'user', content: res });
      }
    } catch (e) { erroIa = e.msg || e.message || 'Falha na IA.'; }
    const custo = tin + tout ? registrarUso(id, tier, tin, tout) : 0;
    const aud = { asst: id, ferramentas: usadas, voltas, pergunta_chars: pergunta.length, resposta_chars: texto.length, resultados_bytes: bytes, tokens_in: tin, tokens_out: tout, custo_estimado: r2(custo), propostas: props.length, sem_acesso: semAc, ok: !erroIa };
    try { X.auditarIa(conta, req, { input: [{ content: pergunta }], funcao: 'assistente169:' + id, modelTier: tier }, !erroIa, erroIa || undefined); } catch (e) { }
    auditar(conta, req, 'IA169_USO', 'ia169/' + id, null, Object.assign(aud, erroIa ? { erro: String(erroIa).slice(0, 200) } : {}));
    if (erroIa) { for (const p of props) st.acaoSt.run('descartada', Date.now(), 'falha na IA', p); return { erro: /configurada/.test(erroIa) ? 'A IA não está configurada no servidor (ANTHROPIC_API_KEY).' : 'Não consegui responder agora: ' + erroIa, st: /configurada/.test(erroIa) ? 503 : 502 }; }
    if (!texto) texto = 'Não consegui montar a resposta. Tente perguntar de outro jeito.';
    if (semAc.length && !/n[aã]o tenho acesso/i.test(texto)) texto += '\n\nNão tenho acesso a parte disso: o seu perfil não lê os dados de ' + uniq(semAc).join(', ') + '.';
    st.histAdd.run(conta.id, id, Date.now(), 'user', pergunta); st.histAdd.run(conta.id, id, Date.now() + 1, 'assistant', texto.slice(0, 6000));
    st.histLimpa.run(Date.now() - C.global.histDias * 864e5);
    const acoes = props.map(p => acaoPub(st.acaoGet.get(p)));
    const m = escreverMsg(conta.id, id, texto, { chat: true, tipo: 'resposta', fontes, acoes });
    for (const p of props) st.acaoMsg.run(m.id, p);
    return { ok: true, msg: m };
  }

  /* ---------------- resumo periódico ---------------- */
  const PERIODO = a => a.freq === 'diario' ? 1 : 7;
  async function resumoPara(id, u, C, motivo) {
    const conta = q.contaPorId.get(u), per = PERIODO(C.asst[id]), hoje = hojeBr(), chave = hoje;
    if (!conta || !conta.ativo) { st.resLog.run(Date.now(), id, u, chave, 'pulado', 'conta inativa ou inexistente'); return { st: 'pulado' }; }
    const lim = limite(id, C); if (lim) { st.resLog.run(Date.now(), id, u, chave, 'pulado', 'limite de custo atingido'); auditar(null, null, 'IA169_RESUMO_PULADO', 'ia169/' + id, null, { asst: id, para: u, motivo: 'limite de custo atingido' }); return { st: 'pulado', motivo: 'limite' }; }
    const ferr = (FERR_DE[id] || []), dados = { atual: {}, anterior: {} }, fontes = [], metas = C.asst[id].metas;
    for (const [k, ref] of [['atual', hoje], ['anterior', maisDias(hoje, -per)]]) { const o = Object.assign(leitor(conta, reqRotina, ref), { metas }); for (const f of ferr) { try { const r = T[f].fn(o, { dias: Math.max(per, ['frota_consumo'].includes(f) ? 30 : per) }); dados[k][f] = r; if (k === 'atual' && r && r.fonte && !fontes.some(x => x.tela === r.fonte.tela)) fontes.push(r.fonte); } catch (e) { dados[k][f] = { erro: 'falha ao ler' }; } } }
    const sys = 'RESUMO169. ' + regrasTexto(id, metas, hoje) + '\nTarefa: escreva o resumo ' + (per === 1 ? 'diário' : 'semanal') + ' para ' + nomeConta(u) + ' com os dados abaixo (período atual e o anterior, lidos com as permissões dessa pessoa).' + (id === 'diretoria' ? ' Como Diretoria, junte só os itens mais importantes de todas as áreas.' : '') +
      ' Responda SÓ com JSON: {"titulo":"...","numeros":[{"nome":"...","atual":"...","anterior":"...","fonte":"..."}],"alertas":["..."],"fora_da_meta":[{"meta":"...","valor":"...","alvo":"..."}],"propostas":[{"titulo":"...","raciocinio":"...","dados":"números que sustentam"}]} com 3 a 5 propostas de melhoria. Números só dos dados; o que veio sem_acesso fica de fora (diga em alertas que não há acesso).';
    const corpo = { model: X.AI_MODELS[TIER_RES()] || X.AI_MODELS.default, max_tokens: 3000, system: sys, messages: [{ role: 'user', content: 'Dados (JSON):\n' + JSON.stringify(dados).slice(0, 150000) }] };
    let j, erroIa = '', tin = 0, tout = 0;
    try { j = await anthropic(corpo); tin = (j.usage && j.usage.input_tokens) || 0; tout = (j.usage && j.usage.output_tokens) || 0; } catch (e) { erroIa = e.msg || e.message || 'falha'; }
    const custo = tin + tout ? registrarUso(id, TIER_RES(), tin, tout) : 0;
    try { X.auditarIa(conta, reqRotina, { input: [{ content: corpo.messages[0].content }], funcao: 'resumo169:' + id, modelTier: TIER_RES() }, !erroIa, erroIa || undefined); } catch (e) { }
    auditar(conta, reqRotina, 'IA169_USO', 'ia169/' + id + '/resumo', null, { asst: id, resumo: true, para: u, ferramentas: ferr, dados_bytes: corpo.messages[0].content.length, tokens_in: tin, tokens_out: tout, custo_estimado: r2(custo), ok: !erroIa, motivo });
    if (erroIa) { st.resLog.run(Date.now(), id, u, chave, 'erro', String(erroIa).slice(0, 200)); return { st: 'erro', erro: erroIa }; }
    const t = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''); let r = null;
    try { const a = t.indexOf('{'), z = t.lastIndexOf('}'); r = JSON.parse(t.slice(a, z + 1)); } catch (e) { }
    if (!r || typeof r !== 'object') { st.resLog.run(Date.now(), id, u, chave, 'erro', 'resposta fora do formato'); return { st: 'erro', erro: 'formato' }; }
    const props = (Array.isArray(r.propostas) ? r.propostas : []).slice(0, 5).map(p => ({ id: novoId('pr'), titulo: txt(p && p.titulo, 200), raciocinio: txtL(p && p.raciocinio, 1200), dados: txtL(p && (typeof p.dados === 'string' ? p.dados : JSON.stringify(p.dados || '')), 800) })).filter(p => p.titulo);
    const L = []; L.push('📊 ' + (txt(r.titulo, 160) || ('Resumo ' + (per === 1 ? 'diário' : 'semanal') + ' · ' + ANOME[id])));
    const nums = (Array.isArray(r.numeros) ? r.numeros : []).slice(0, 12); if (nums.length) { L.push('', 'Números do período (anterior entre parênteses):'); nums.forEach(n => L.push('• ' + txt(n.nome, 120) + ': ' + txt(n.atual, 60) + (n.anterior != null && n.anterior !== '' ? ' (' + txt(n.anterior, 60) + ')' : '') + (n.fonte ? ' — fonte: ' + txt(n.fonte, 80) : ''))); }
    const al = (Array.isArray(r.alertas) ? r.alertas : []).slice(0, 10); if (al.length) { L.push('', 'Alertas:'); al.forEach(a => L.push('⚠️ ' + txt(a, 300))); }
    const fm = (Array.isArray(r.fora_da_meta) ? r.fora_da_meta : []).slice(0, 10); if (fm.length) { L.push('', 'Fora da meta:'); fm.forEach(f => L.push('• ' + txt(f.meta, 120) + ': ' + txt(f.valor, 60) + ' (meta ' + txt(f.alvo, 60) + ')')); }
    if (props.length) L.push('', 'Propostas de melhoria: veja abaixo e marque se foram úteis.');
    const m = escreverMsg(u, id, L.join('\n'), { chat: podeUsar(conta, id, C), tipo: 'resumo', periodo: per === 1 ? 'diario' : 'semanal', fontes, propostas: props });
    st.resLog.run(Date.now(), id, u, chave, 'enviado', motivo || ''); auditar(null, null, 'IA169_RESUMO', 'ia169/' + id, null, { asst: id, para: u, propostas: props.length, msg: m.id });
    return { st: 'enviado', msg: m.id };
  }
  async function resumir(id, forcar, motivo) {
    const C = cfg(), a = C.asst[id]; if (!a) return { erro: 'Assistente desconhecido.' };
    if (!a.ativo && !forcar) return { pulado: 'inativo' };
    const rs = responsaveis(id, C); if (!rs.length) { st.resLog.run(Date.now(), id, '', hojeBr(), 'pulado', 'sem responsáveis'); return { enviados: 0, pulados: 0, para: [] }; }
    const out = { enviados: 0, pulados: 0, erros: 0, para: [] };
    for (const u of rs) { const r = await resumoPara(id, u, C, motivo); out.para.push({ u, st: r.st }); if (r.st === 'enviado') out.enviados++; else if (r.st === 'erro') out.erros++; else out.pulados++; }
    return out;
  }
  /* rotina: a cada minuto confere quem tem resumo vencido (semanal no dia/hora configurados, diário na hora) */
  let rodando = false;
  async function rotina() {
    if (rodando) return; rodando = true;
    try {
      const C = cfg(), ag = agoraBr(), hoje = ag.slice(0, 10), hm = ag.slice(11, 16), dow = ((new Date(hoje + 'T12:00:00Z').getUTCDay() + 6) % 7) + 1;
      for (const [id] of ASSIST) { const a = C.asst[id]; if (!a.ativo || a.freq === 'desligado') continue; if (hm < a.hora) continue; if (a.freq === 'semanal' && dow !== a.dia) continue;
        if (st.resK.run('ia169:' + id + ':' + a.freq + ':' + hoje, Date.now()).changes) await resumir(id, false, 'agendado'); }
      const d = hoje; if (d !== rotina.dia) { rotina.dia = d; st.histLimpa.run(Date.now() - C.global.histDias * 864e5); }
    } catch (e) { console.error('[v169] rotina:', e.message); } finally { rodando = false; }
  }
  if (!/^(0|nao|não)$/i.test(String(process.env.IA169_ROTINA || '1'))) { setTimeout(rotina, 8000).unref(); setInterval(rotina, 60e3).unref(); }

  /* ---------------- retorno (Útil / Não útil) ---------------- */
  function feedback(conta, req, b) {
    const m = doc('cm/sistema/m/' + String(b.msg || '').replace(/[^\w-]/g, ''));
    if (!m || !m.ia169 || m.conv !== 'sistema/' + cidDe(m.ia169.asst, conta.id)) return { erro: 'Mensagem não encontrada.', st: 404 };
    const ref = String(b.ref || ''), ehMsg = ref === m.id, prop = (m.ia169.propostas || []).find(p => p.id === ref), acao = (m.ia169.acoes || []).find(a => a.id === ref);
    if (!ehMsg && !prop && !acao) return { erro: 'Item não encontrado.', st: 404 };
    const util = b.util === true ? 1 : b.util === false ? 0 : null; if (util === null) return { erro: 'Diga se foi útil ou não.', st: 400 };
    const tipo = prop ? 'proposta' : acao ? 'acao' : m.ia169.tipo || 'resposta';
    st.fbPut.run(conta.id, ref, m.ia169.asst, tipo, util, Date.now());
    atualizarMsg(m.id, x => { x.ia169.fb = Object.assign({}, x.ia169.fb || {}, { [ref]: !!util }); });
    auditar(conta, req, 'IA169_FEEDBACK', 'ia169/' + m.ia169.asst, null, { tipo, util: !!util });
    return { ok: true };
  }
  function fbContagem() { const o = {}; for (const r of st.fbCont.all()) { const x = o[r.asst] = o[r.asst] || { util: 0, nao: 0, porTipo: {} }; x.util += r.util || 0; x.nao += r.nao || 0; x.porTipo[r.tipo] = { util: r.util || 0, nao: r.nao || 0 }; } return o; }

  /* ---------------- sugestão de responsáveis pelo nome (nunca aplica sozinha) ---------------- */
  function sugerir(b) {
    const nomes = String(b.nomes || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).slice(0, 40), cs = q.contas.all().filter(c => c.ativo);
    return { ok: true, itens: nomes.map(n => { const k = norm(n); return { nome: n, contas: cs.filter(c => { const cn = norm(c.nome || ''), em = norm(c.email || ''); return cn === k || cn.split(' ').includes(k) || cn.startsWith(k + ' ') || (k.includes(' ') && cn.includes(k)) || em.split('@')[0].split(/[._-]/).includes(k); }).slice(0, 6).map(c => ({ id: c.id, nome: c.nome || c.email, email: c.email })) }; }) };
  }

  /* ---------------- rotas ---------------- */
  function pubCfg() {
    const C = cfg(), us = q.contas.all().map(c => ({ id: c.id, nome: c.nome || c.email, email: c.email, ativo: !!c.ativo, perfil: X.perfilDe(c) }));
    let perfis = []; try { perfis = Object.entries((X.PERM() || {}).perfis || {}).filter(([k, v]) => !['pendente', 'semnivel', 'semid'].includes(k) && !(v && v.antigo)).map(([k, v]) => ({ id: k, nome: v.nome || k })); } catch (e) { }
    return { ok: true, cfg: C, assistentes: ASSIST.map(([id, nome, pf]) => ({ id, nome, perfisPadrao: pf, ferramentas: FERR_DE[id], acoes: ACOES_DE(id), metasPadrao: METAS_PAD[id] })), usuarios: us, perfis, uso: usoMes(), fb: fbContagem(), resumos: st.resUlt.all(), frotaResp: respCidades(), ia: !!X.aiKey(), preco: { dolar: DOLAR(), chat: TIER_CHAT(), resumo: TIER_RES() } };
  }
  async function rota(p, m, req, res, conta) {
    if (!p.startsWith('/api/ia169/') && p !== '/api/admin/ia169/resumo' && p !== '/api/admin/ia169/varrer') return false;
    const fim = r => { if (r && r.erro) json(res, r.st || 403, Object.assign({ code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : r.st === 429 ? 'rate_limited' : r.st === 503 ? 'capability_disabled' : r.st === 502 ? 'upstream_error' : 'not_granted', erro: r.erro }, r.msg ? { msg: r.msg } : {})); else json(res, 200, r || { ok: true }); return true; };
    if (m === 'GET' && p === '/api/ia169/meus') return fim({ ok: true, assistentes: meus(conta), ia: !!X.aiKey() });
    if (m === 'GET' && p === '/api/ia169/cfg') return fim(admin(conta) ? pubCfg() : { erro: 'Só o Administrador configura os assistentes de IA.', st: 403 });
    if (m !== 'POST') return fim({ erro: 'Não encontrado.', st: 404 });
    let b = {}; try { b = (await lerJson(req)) || {}; } catch (e) { return fim({ erro: 'Pedido inválido.', st: 400 }); }
    if (p === '/api/ia169/cfg') return fim(salvarCfg(conta, req, b));
    if (p === '/api/ia169/sugerir') return fim(admin(conta) ? sugerir(b) : { erro: 'Só o Administrador.', st: 403 });
    if (p === '/api/admin/ia169/resumo') { if (!admin(conta)) return fim({ erro: 'Só o Administrador.', st: 403 }); const id = String(b.asst || ''); if (!AID.has(id)) return fim({ erro: 'Assistente desconhecido.', st: 400 }); auditar(conta, req, 'IA169_RESUMO_MANUAL', 'ia169/' + id, null, { asst: id }); return fim(Object.assign({ ok: true }, await resumir(id, !!b.forcar, 'manual'))); }
    if (p === '/api/admin/ia169/varrer') { if (!admin(conta)) return fim({ erro: 'Só o Administrador.', st: 403 }); await rotina(); return fim({ ok: true }); } /* a rotina de cada minuto, na hora (testes e conferência) */
    if (p === '/api/ia169/perguntar') return fim(await perguntar(conta, req, b));
    if (p === '/api/ia169/acao') return fim(await decidirAcao(conta, req, b));
    if (p === '/api/ia169/feedback') return fim(feedback(conta, req, b));
    return fim({ erro: 'Não encontrado.', st: 404 });
  }
  return { rota, cfg, podeUsar, responsaveis, ferramentasDe, meus, sincronizar, resumir, rotina, T, ASSIST, FERR_DE, METAS_PAD, mascCpf, validarAcao, leitor, limite };
};

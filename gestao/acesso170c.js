'use strict';
/* v170 (relatorios/feito_v170.md): núcleo do controle de acesso — só funções puras, sem banco e sem rede.
   Quem chama (acesso170.js) entrega o contexto X:
     X = { cfg: configuração do controle de acesso (cfgPad), hoje: 'AAAA-MM-DD', agora: 'AAAA-MM-DDTHH:MM' (Brasília),
           func, tterc, usr, vaut, vsai, afast, rhdoc, integ: arrays do sistema; pontos, disps, crachas, grupos, vis: arrays
           do controle de acesso; f165: contexto da frota (frota165.js) e t166: contexto de terceiros (terc166.js) }
   Regras:
   - Uma pessoa é colaborador (func), trabalhador terceiro (terc, v166) ou visitante (vis). Cada pessoa tem no máximo UM
     crachá ativo (MIFARE 13,56 MHz, UID em hexadecimal maiúsculo).
   - Grupo de acesso: pontos + horário semanal (faixas por dia, 1 = segunda … 7 = domingo) + feriados (bloqueia ou libera),
     atribuído por função (cargo), perfil do usuário, pessoa, "condutores autorizados" (v165) e "todos os terceiros".
   - Bloqueios automáticos (retiram o crachá do controlador na próxima sincronização): desligado, afastado, terceiro não
     liberado ou com documentação da empresa pendente (v166, configurável), condutor não autorizado no portão de veículos
     (v165) e, opcional, ASO ou integração vencidos.
   - Estado desejado por controlador (a fonte da verdade é o servidor): portas, horários, feriados e cartões. */
const s = v => v == null ? '' : String(v);
const norm = t => s(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const uniq = a => [...new Set((a || []).filter(Boolean))];
const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(s(d));
const horaOk = h => /^([01]\d|2[0-3]):[0-5]\d$/.test(s(h)) || s(h) === '24:00';
const hm = h => { const m = s(h).match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : 0; };
const br = d => dataOk(s(d).slice(0, 10)) ? s(d).slice(8, 10) + '/' + s(d).slice(5, 7) + '/' + s(d).slice(0, 4) : '';
const mascCpf = c => { const d = s(c).replace(/\D/g, ''); if (!d) return ''; if (d.length !== 11) return '***'; return '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-**'; };
/* UID do crachá MIFARE: 4, 7 ou 10 bytes em hexadecimal (aceita "04:A1:B2…", minúsculas e espaços) */
function uidNorm(u) { const h = s(u).toUpperCase().replace(/[^0-9A-F]/g, ''); return [8, 14, 20].includes(h.length) ? h : ''; }
/* dia da semana 1 = segunda … 7 = domingo, de uma data AAAA-MM-DD */
const diaSem = d => { const w = new Date(Date.parse(s(d).slice(0, 10) + 'T12:00:00Z')).getUTCDay(); return w === 0 ? 7 : w; };
const DIAS = [[1, 'seg'], [2, 'ter'], [3, 'qua'], [4, 'qui'], [5, 'sex'], [6, 'sáb'], [7, 'dom']];

const TIPOS_PONTO = [['porta', 'Porta'], ['entrada', 'Entrada / porta social'], ['escritorio', 'Escritório'], ['almoxarifado', 'Almoxarifado'], ['portao_veiculos', 'Portão de veículos']];
const TIPOS_DISP = [['ct3000_2pb', 'Intelbras CT 3000 2PB (2 portas)'], ['ct3000_4pb', 'Intelbras CT 3000 4PB (4 portas)'], ['tuya_fechadura', 'Fechadura Tuya (Smart Life)'], ['tuya_rele', 'Relé Wi-Fi Tuya/Smart Life (portão)']];
const portasDe = t => t === 'ct3000_4pb' ? 4 : t === 'ct3000_2pb' ? 2 : 1;
const ehCt = d => !!d && /^ct3000/.test(s(d.tipo));
const ehTuya = d => !!d && /^tuya/.test(s(d.tipo));
const BLOQ = { desligado: 'Desligado', afastado: 'Afastado', terc_inativo: 'Terceiro inativo', terc_naolib: 'Terceiro não liberado', terc_docemp: 'Documentação da empresa terceira pendente', condutor: 'Condutor não autorizado (portão de veículos)', aso: 'ASO vencido', integ: 'Integração vencida', vis_validade: 'Visita fora da validade', cracha: 'Crachá não ativo' };

function cfgPad(c) {
  c = c && typeof c === 'object' ? c : {};
  const b = c.bloq || {}, a = c.alerta || {}, h = a.horario || {};
  const locais = Array.isArray(c.locais) && c.locais.length ? c.locais.filter(l => l && l.id).map(l => ({ id: s(l.id).slice(0, 30), nome: s(l.nome || l.id).slice(0, 60), cidade: s(l.cidade || l.nome || l.id).slice(0, 60) }))
    : [{ id: 'sp', nome: 'São Paulo', cidade: 'São Paulo' }, { id: 'tuiuti', nome: 'Tuiuti', cidade: 'Tuiuti' }];
  const resp = {}; locais.forEach(l => { resp[l.id] = uniq(((c.resp || {})[l.id] || []).map(String)).slice(0, 20); });
  const n = (v, d, mi, ma) => { const x = Math.round(+v); return isFinite(x) && v !== '' && v != null ? Math.min(ma, Math.max(mi, x)) : d; };
  return {
    locais, resp,
    bloq: { afastado: b.afastado !== false, tercNaoLib: b.tercNaoLib !== false, tercDocEmp: !!b.tercDocEmp, condutorPortao: b.condutorPortao !== false, aso: !!b.aso, integ: !!b.integ },
    alerta: { abertaSeg: n(a.abertaSeg, 60, 5, 3600), negN: n(a.negN, 3, 2, 50), negMin: n(a.negMin, 10, 1, 240), offlineMin: n(a.offlineMin, 5, 2, 240),
      horario: { ini: horaOk(h.ini) ? h.ini : '06:00', fim: horaOk(h.fim) ? h.fim : '20:00', dias: Array.isArray(h.dias) && h.dias.length ? uniq(h.dias.map(Number).filter(d => d >= 1 && d <= 7)) : [1, 2, 3, 4, 5, 6] } },
    feriados: uniq((Array.isArray(c.feriados) ? c.feriados : []).map(s).filter(dataOk)).sort().slice(0, 200),
    pulsoMs: n(c.pulsoMs, 1000, 200, 10000)
  };
}
const localDe = (cfg, id) => cfg.locais.find(l => l.id === id) || null;
/* local pela cidade do veículo (v165: Cidade/base) */
const localDaCidade = (cfg, cidade) => { const c = norm(cidade); return c ? (cfg.locais.find(l => norm(l.cidade) === c || norm(l.nome) === c) || null) : null; };

/* ---------------------------------------------------------------- horário */
function faixasOk(fx) {
  return (Array.isArray(fx) ? fx : []).map(f => ({ dias: uniq((f.dias || []).map(Number).filter(d => d >= 1 && d <= 7)).sort(), ini: horaOk(f.ini) ? f.ini : '', fim: horaOk(f.fim) ? f.fim : '' }))
    .filter(f => f.dias.length && f.ini && f.fim && hm(f.fim) > hm(f.ini)).slice(0, 12);
}
/* o horário do grupo vale agora? (feriado: o grupo diz se bloqueia ou libera) */
function noHorario(g, data, hora, feriados) {
  if (!g) return false; if (g.sempre) return true;
  if ((feriados || []).includes(data) && g.feriados !== 'libera') return false;
  const d = diaSem(data), m = hm(hora);
  return faixasOk(g.faixas).some(f => f.dias.includes(d) && m >= hm(f.ini) && m < hm(f.fim));
}
const faixasTxt = g => g && g.sempre ? 'sempre' : faixasOk(g && g.faixas).map(f => f.dias.map(d => DIAS[d - 1][1]).join(', ') + ' ' + f.ini + '–' + f.fim).join('; ') || 'sem horário';

/* ---------------------------------------------------------------- pessoas */
const pessoaKey = p => p.t + ':' + p.id;
function pessoaReg(X, t, id) {
  if (t === 'func') return (X.func || []).find(f => f.id === id) || null;
  if (t === 'terc') return (X.tterc || []).find(f => f.id === id) || null;
  if (t === 'vis') return (X.vis || []).find(f => f.id === id) || null;
  return null;
}
const pessoaNome = (X, t, id) => { const r = pessoaReg(X, t, id); return r ? s(r.nome) : '(não encontrado)'; };
const perfilDoFunc = (X, f) => { if (!f || !f.usrId) return ''; const u = (X.usr || []).find(x => x.uid === f.usrId || x.id === f.usrId); return u ? s(u.perfil) : ''; };
/* ASO e integração do colaborador: o registro mais novo (validade) */
function asoVal(X, funcId) { const l = (X.rhdoc || []).filter(r => r.funcId === funcId && /aso/i.test(s(r.tipo)) && dataOk(r.validade)).map(r => r.validade).sort(); return l.length ? l[l.length - 1] : ''; }
function integVal(X, funcId) { const l = (X.integ || []).filter(r => r.funcId === funcId && r.tipo !== 'externa' && dataOk(r.validade)).map(r => r.validade).sort(); return l.length ? l[l.length - 1] : ''; }
/* condutor autorizado (v165): "Autorizado" ou "Vence em breve" */
function condutor(X, f, F165) {
  if (!f || !F165 || !X.f165) return { ok: false, txt: 'sem a frota' };
  try { const sit = F165.autSit(X.f165, f); return { ok: sit.k === 'aut' || sit.k === 'vence', txt: sit.txt, motivos: sit.motivos || [] }; } catch (e) { return { ok: false, txt: 'erro: ' + e.message }; }
}

/* bloqueios da pessoa (valem para todos os pontos): [{k, txt}] */
function bloqueios(X, t, reg, F165, T166) {
  const c = X.cfg.bloq, out = [], add = (k, extra) => out.push({ k, txt: BLOQ[k] + (extra ? ': ' + extra : '') });
  if (!reg) { add('cracha', 'pessoa não encontrada'); return out; }
  if (t === 'func') {
    if (reg.status === 'desligado' || reg.ativo === false) add('desligado');
    else {
      if (c.afastado && F165 && F165.afastado({ afast: X.afast, hoje: X.hoje }, reg)) add('afastado');
      if (c.aso) { const v = asoVal(X, reg.id); if (v && v < X.hoje) add('aso', 'venceu em ' + br(v)); }
      if (c.integ) { const v = integVal(X, reg.id); if (v && v < X.hoje) add('integ', 'venceu em ' + br(v)); }
    }
  } else if (t === 'terc') {
    if (reg.ativo === false) add('terc_inativo');
    else if (T166 && X.t166) {
      if (c.tercNaoLib) { const st = T166.trabStatus(X.t166, reg, ''); if (!st.lib) add('terc_naolib', st.motivos.slice(0, 4).join(', ')); }
      if (c.tercDocEmp && reg.parcId) { const f = T166.empFaltas(X.t166, reg.parcId); if (f.length) add('terc_docemp', f.slice(0, 3).join('; ')); }
    }
  } else if (t === 'vis') {
    const ag = X.agora;
    if (reg.st === 'encerrada' || !(s(reg.de) <= ag && ag < s(reg.ate))) add('vis_validade', br(reg.de) + ' ' + s(reg.de).slice(11, 16) + ' a ' + br(reg.ate) + ' ' + s(reg.ate).slice(11, 16));
  }
  return out;
}
/* grupos que valem para a pessoa */
function gruposDe(X, t, reg, F165) {
  if (!reg || t === 'vis') return [];
  const fn = t === 'func' ? [norm(reg.funcao), norm(reg.cargo)].filter(Boolean) : [norm(reg.funcao)].filter(Boolean);
  const pf = t === 'func' ? perfilDoFunc(X, reg) : '';
  let cond = null;
  return (X.grupos || []).filter(g => {
    if (!g || g.ativo === false) return false;
    if ((g.pessoas || []).some(p => p && p.t === t && p.id === reg.id)) return true;
    if (t === 'func' && (g.funcoes || []).some(f => fn.includes(norm(f)))) return true;
    if (t === 'func' && pf && (g.perfis || []).includes(pf)) return true;
    if (t === 'terc' && g.terceiros) return true;
    if (t === 'func' && g.condutores) { if (cond === null) cond = condutor(X, reg, F165).ok; if (cond) return true; }
    return false;
  });
}
/* acesso efetivo da pessoa: pontos liberados (com os grupos), pontos recusados (com o motivo) e bloqueios gerais */
function acesso(X, t, id, F165, T166) {
  const reg = pessoaReg(X, t, id), bl = bloqueios(X, t, reg, F165, T166), pts = new Map(), recus = [];
  if (t === 'vis' && reg) (reg.pontos || []).forEach(pid => { if ((X.pontos || []).some(p => p.id === pid && p.ativo !== false)) pts.set(pid, [{ id: 'vis:' + reg.id, nome: 'Visita', sempre: true }]); });
  for (const g of gruposDe(X, t, reg, F165)) for (const pid of (g.pontos || [])) { if (!(X.pontos || []).some(p => p.id === pid && p.ativo !== false)) continue; const l = pts.get(pid) || []; l.push(g); pts.set(pid, l); }
  let cond = null;
  for (const [pid] of [...pts]) {
    const p = (X.pontos || []).find(x => x.id === pid);
    if (p && p.tipo === 'portao_veiculos' && X.cfg.bloq.condutorPortao && t !== 'vis') {
      if (cond === null) cond = t === 'func' ? condutor(X, reg, F165) : { ok: false, txt: 'terceiro não é condutor da empresa' };
      if (!cond.ok) { recus.push({ pontoId: pid, k: 'condutor', txt: BLOQ.condutor + ': ' + (cond.txt || '') + (cond.motivos && cond.motivos.length ? ' — ' + cond.motivos.slice(0, 2).join(' ') : '') }); pts.delete(pid); }
    }
  }
  return { reg, bloqueios: bl, pontos: bl.length ? new Map() : pts, potenciais: pts, recusados: bl.length ? [] : recus };
}
const crachaAtivo = (X, t, id) => (X.crachas || []).find(c => c.pt === t && c.pid === id && c.st === 'ativo') || null;

/* ---------------------------------------------------------------- estado desejado por controlador (CT 3000) */
/* horários: cada combinação de grupos numa porta vira um horário do controlador (índice 1..120; 255 = sempre) */
function estadoDesejado(X, F165, T166) {
  const out = {}, porDisp = {}, combos = {};
  for (const d of (X.disps || [])) if (ehCt(d) && d.ativo !== false) { out[d.id] = { portas: {}, horarios: {}, feriados: X.cfg.feriados.slice(), cartoes: {} }; porDisp[d.id] = d; combos[d.id] = new Map(); }
  for (const p of (X.pontos || [])) if (p.ativo !== false && out[p.dispId]) out[p.dispId].portas[String(+p.porta || 1)] = { porta: +p.porta || 1, nome: s(p.nome).slice(0, 30), abertaSeg: +p.abertaSeg || X.cfg.alerta.abertaSeg, ponto: p.id };
  const hIdx = (dispId, gs) => {
    if (gs.some(g => g.sempre)) return 255;
    const k = gs.map(g => g.id).sort().join('+'), m = combos[dispId];
    if (!m.has(k)) {
      const n = m.size + 1; if (n > 120) return 0; m.set(k, n);
      const fx = faixasOk([].concat(...gs.map(g => g.faixas || []))), fer = gs.every(g => g.feriados === 'libera') ? 'libera' : 'bloqueia';
      out[dispId].horarios[String(n)] = { idx: n, nome: gs.map(g => s(g.nome)).join(' + ').slice(0, 40), faixas: fx, feriados: fer };
    }
    return m.get(k);
  };
  const ags = (X.crachas || []).filter(c => c.st === 'ativo' && c.uid).sort((a, b) => (+a.n || 0) - (+b.n || 0));
  for (const c of ags) {
    const a = acesso(X, c.pt, c.pid, F165, T166); if (!a.reg || a.bloqueios.length) continue;
    const reg = a.reg, por = {};
    for (const [pid, gs] of a.pontos) { const p = (X.pontos || []).find(x => x.id === pid); if (!p || !out[p.dispId]) continue; (por[p.dispId] = por[p.dispId] || []).push({ porta: +p.porta || 1, gs }); }
    for (const [did, l] of Object.entries(por)) {
      const regras = l.map(x => ({ porta: x.porta, h: hIdx(did, x.gs) })).filter(x => x.h).sort((a, b) => a.porta - b.porta);
      if (!regras.length) continue;
      out[did].cartoes[c.uid] = { uid: c.uid, usuario: String(+c.n || 0), nome: s(reg.nome).slice(0, 30), regras, de: c.pt === 'vis' ? s(reg.de) : '', ate: c.pt === 'vis' ? s(reg.ate) : '' };
    }
  }
  return out;
}
/* chaves planas do estado (para comparar com o que já foi mandado): 'p:1', 'h:3', 'f', 'c:<uid>' */
function chaves(est) {
  const o = {}; Object.values(est.portas).forEach(p => { o['p:' + p.porta] = p; }); Object.values(est.horarios).forEach(h => { o['h:' + h.idx] = h; });
  o.f = { feriados: est.feriados }; Object.values(est.cartoes).forEach(c => { o['c:' + c.uid] = c; }); return o;
}

/* ---------------------------------------------------------------- abrir pelo sistema */
/* a pessoa (colaborador ligado ao usuário) pode abrir este ponto agora? '' = pode; senão o motivo */
function podeAbrirPessoa(X, funcId, pontoId, F165, T166) {
  const f = (X.func || []).find(x => x.id === funcId); if (!f) return 'Seu usuário não está ligado a um colaborador (Pessoal › Colaboradores › usuário do sistema).';
  const a = acesso(X, 'func', f.id, F165, T166);
  if (a.bloqueios.length) return 'Bloqueado: ' + a.bloqueios.map(b => b.txt).join('; ') + '.';
  const rc = a.recusados.find(r => r.pontoId === pontoId); if (rc) return rc.txt + '.';
  const gs = (a.pontos.get(pontoId) || []).filter(g => g.remoto); if (!gs.length) return 'Nenhum grupo de acesso seu permite abrir este ponto pelo sistema.';
  const hora = s(X.agora).slice(11, 16);
  if (!gs.some(g => noHorario(g, X.hoje, hora, X.cfg.feriados))) return 'Fora do horário do seu grupo de acesso (' + gs.map(faixasTxt).join(' | ') + ').';
  return '';
}
/* horário de funcionamento do local (alerta "acesso fora do horário") */
const foraHorario = (cfg, data, hora) => { const h = cfg.alerta.horario; if (cfg.feriados.includes(data)) return true; const d = diaSem(data), m = hm(hora); return !h.dias.includes(d) || m < hm(h.ini) || m >= hm(h.fim); };

module.exports = { s, norm, uniq, dataOk, horaOk, hm, br, mascCpf, uidNorm, diaSem, DIAS, TIPOS_PONTO, TIPOS_DISP, BLOQ, portasDe, ehCt, ehTuya, cfgPad, localDe, localDaCidade,
  faixasOk, noHorario, faixasTxt, pessoaKey, pessoaReg, pessoaNome, perfilDoFunc, asoVal, integVal, condutor, bloqueios, gruposDe, acesso, crachaAtivo, estadoDesejado, chaves, podeAbrirPessoa, foraHorario };

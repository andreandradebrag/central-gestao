'use strict';
/* v165 (relatorios/feito_v165.md): núcleo da frota — reserva, saída, retorno, cidade/base, responsável da cidade, autorização
   do condutor, relatório da Sem Parar (CTF), recibo, conferências, consumo, painel por cidade e fatura do mês.
   O MESMO arquivo roda no servidor (ajuste165.js) e no navegador (patch147.py embute este texto em new_v165.js como V165C),
   para as regras e as contas darem igual dos dois lados. Só funções puras: quem chama entrega o contexto X:
     X = { veic, vsai, vres, vaut, vav, vabas, vman, func, afast: arrays; cfg: cfg/empresa.frota165; mig: marca da migração;
           hoje: 'AAAA-MM-DD', agora: 'AAAA-MM-DDTHH:MM' (hora de Brasília) }
   e "quem": { uid, funcId, admin, frotaTodos, frotaW, nome }. As funções que gravam devolvem { erro } ou { docs:[{c,d}] }. */
const r2 = v => Math.round((+v || 0) * 100) / 100;
const r1 = v => Math.round((+v || 0) * 10) / 10;
const s = v => v == null ? '' : String(v);
const norm = t => s(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const placaN = p => s(p).toUpperCase().replace(/[^A-Z0-9]/g, '');
const digitos = v => s(v).replace(/\D/g, '');
const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(s(d));
const dtOk = d => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s(d));
const dt = (d, h) => dataOk(d) ? d + 'T' + (/^\d{2}:\d{2}/.test(s(h)) ? s(h).slice(0, 5) : '00:00') : '';
const maisDias = (d, n) => new Date(Date.parse(s(d).slice(0, 10) + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const difDias = (a, b) => Math.round((Date.parse(s(a).slice(0, 10) + 'T12:00:00Z') - Date.parse(s(b).slice(0, 10) + 'T12:00:00Z')) / 864e5);
const minutos = (a, b) => Math.round((Date.parse(s(a) + ':00Z') - Date.parse(s(b) + ':00Z')) / 6e4);
const br = d => dataOk(s(d).slice(0, 10)) ? s(d).slice(8, 10) + '/' + s(d).slice(5, 7) + '/' + s(d).slice(0, 4) : '';
const brDt = v => dtOk(v) ? br(v) + ' ' + v.slice(11, 16) : br(v);
const uniq = a => [...new Set(a.filter(Boolean))];
/* número em texto brasileiro ("1.234,56", "-12", "55.421") ou número */
function num(v) {
  if (v === null || v === undefined || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null;
  let t = s(v).trim().replace(/[^\d,.\-]/g, ''); if (!t || t === '-') return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.'); else if ((t.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
  const n = parseFloat(t); return isFinite(n) ? n : null;
}

/* ---------------------------------------------------------------- configuração */
const TIPOS = [['leve', 'Leve (carro)'], ['utilitario', 'Utilitário / van'], ['caminhao', 'Caminhão'], ['maquina', 'Máquina / empilhadeira']];
const CURSOS = { dd: 'Direção defensiva', nr11: 'NR-11 (máquinas e empilhadeiras)' };
const CK_PAD = ['Pneus', 'Luzes', 'Documentos', 'Triângulo', 'Macaco', 'Estepe', 'Limpeza'];
const FOTOS = [['frente', 'Frente'], ['tras', 'Traseira'], ['esq', 'Lado esquerdo'], ['dir', 'Lado direito'], ['painel', 'Painel (km e combustível)']];
const COMB4 = [['0', 'Vazio'], ['1/4', '1/4'], ['1/2', '1/2'], ['3/4', '3/4'], ['1', 'Cheio']];
const COMB8 = [['0', 'Vazio'], ['1/8', '1/8'], ['1/4', '1/4'], ['3/8', '3/8'], ['1/2', '1/2'], ['5/8', '5/8'], ['3/4', '3/4'], ['7/8', '7/8'], ['1', 'Cheio']];
const fracN = f => { const t = s(f); if (t === '1') return 1; if (t === '0') return 0; const m = /^(\d)\/(\d)$/.exec(t); return m ? +m[1] / +m[2] : null; };
const combNome = f => (COMB8.find(x => x[0] === s(f)) || [0, s(f) || '—'])[1];
function cfgPad(c) {
  c = c && typeof c === 'object' ? c : {};
  const o = Object.assign({ cidades: ['Tuiuti', 'São Paulo'], resp: {}, saidaDireta: false, fotosObrig: true, frac8: false, checklist: CK_PAD.slice(),
    diasAviso: 30, autMeses: 12, quedaKmlPct: 20, kmMax: 2000, kmMin: 20, tolKm: 50, precoPct: 15, exigeRecibo: false, tolMatchDias: 1, tolLitros: 0.5, tolValor: 0.5,
    reqTipo: { leve: { cat: 'B', cursos: [] }, utilitario: { cat: 'B', cursos: ['dd'] }, caminhao: { cat: 'C', cursos: ['dd'] }, maquina: { cat: 'B', cursos: ['nr11'] } } }, c);
  if (!Array.isArray(o.cidades) || !o.cidades.length) o.cidades = ['Tuiuti', 'São Paulo'];
  o.cidades = uniq(o.cidades.map(x => s(x).trim()).filter(Boolean)).slice(0, 30);
  if (!Array.isArray(o.checklist) || !o.checklist.length) o.checklist = CK_PAD.slice();
  o.resp = o.resp && typeof o.resp === 'object' ? o.resp : {};
  return o;
}
const combOpts = cfg => cfg.frac8 ? COMB8 : COMB4;
/* responsáveis da cidade (titular e substituto) e as cidades de uma pessoa */
const respDe = (cfg, cidade) => { const r = (cfg.resp || {})[cidade] || {}; return uniq([r.uid, r.sub]); };
const cidadesDe = (cfg, uid) => !uid ? [] : cfg.cidades.filter(c => respDe(cfg, c).includes(uid));
/* escopo de cidades de quem: null = todas; Set = só estas. ver: o que a tela mostra (o frotaadm que é responsável começa na
   cidade dele e pode ver todas); gerir: o que o servidor deixa aprovar e alterar */
function escopo(cfg, quem, ver) {
  if (!quem) return new Set();
  if (quem.admin) return null;
  const cs = cidadesDe(cfg, quem.uid);
  if (cs.length) return quem.frotaTodos && (!ver || quem.todas) ? null : new Set(cs);
  return quem.frotaTodos || quem.frotaW ? null : new Set();
}
const ehResp = (cfg, quem, cidade) => { const e = escopo(cfg, quem, false); return e === null || e.has(cidade); };
/* aprovar reserva e saída sem reserva: Administrador, Administrador de frota e o responsável da cidade (não basta gravar a frota) */
const podeAprovar = (cfg, quem, cidade) => !!(quem && (quem.admin || quem.frotaTodos || cidadesDe(cfg, quem.uid).includes(cidade)));

/* ---------------------------------------------------------------- veículo */
const cidadeDe = v => s(v && (v.cidade || v.base));
function tipoDe(v) {
  if (!v) return 'leve'; if (v.tipoAut && TIPOS.some(t => t[0] === v.tipoAut)) return v.tipoAut;
  const t = norm(v.tipo); return t.startsWith('caminh') ? 'caminhao' : t.startsWith('maquin') || t.startsWith('empilh') ? 'maquina' : t.startsWith('utilit') || t === 'van' ? 'utilitario' : 'leve';
}
const tipoNome = t => (TIPOS.find(x => x[0] === t) || [0, t])[1];
/* combustíveis que o veículo aceita (Flex: gasolina e etanol) */
function combAceita(v, tipoComb) {
  const c = norm(v && v.combustivel), t = norm(tipoComb); if (!c || !t) return true;
  const fam = /diesel|s-?10|s-?500/.test(t) ? 'diesel' : /etanol|alcool/.test(t) ? 'etanol' : /gasolina/.test(t) ? 'gasolina' : /gnv|gas natural/.test(t) ? 'gnv' : /arla/.test(t) ? 'arla' : 'outro';
  if (fam === 'arla' || fam === 'outro') return true;
  if (c === 'flex') return fam === 'gasolina' || fam === 'etanol';
  if (c.startsWith('diesel')) return fam === 'diesel';
  if (c.startsWith('gasolina')) return fam === 'gasolina';
  if (c.startsWith('etanol')) return fam === 'etanol';
  if (c.startsWith('gnv')) return fam === 'gnv' || fam === 'gasolina';
  if (c.startsWith('eletr')) return false;
  return true;
}
const saidaAberta = (X, vid) => (X.vsai || []).find(x => x.veicId === vid && !x.retornoEm) || null;
const avariaGrave = (X, vid) => (X.vav || []).find(a => a.veicId === vid && a.grave && a.st !== 'resolvida') || null;
const manutAberta = (X, v) => v.status === 'oficina' || (X.vman || []).some(m => m.veicId === v.id && m.status === 'agendada' && s(m.data) <= X.hoje && m.parado165 !== false);
/* situação: disp | uso | manut | grave | baixado */
function veicSit(X, v) {
  if (!v) return { k: 'baixado', txt: 'Veículo não encontrado' };
  if (v.status === 'baixado') return { k: 'baixado', txt: 'Baixado' };
  const sa = saidaAberta(X, v.id);
  if (sa) return { k: 'uso', txt: 'Em uso por ' + nomeFunc(X, sa.funcId), s: sa };
  if (manutAberta(X, v)) return { k: 'manut', txt: 'Em manutenção' };
  const g = avariaGrave(X, v.id); if (g) return { k: 'grave', txt: 'Avaria grave aberta: ' + s(g.desc).slice(0, 60), av: g };
  return { k: 'disp', txt: 'Disponível' };
}
const nomeFunc = (X, id) => { const f = (X.func || []).find(x => x.id === id); return f ? s(f.nome) : '—'; };
/* km conhecido mais alto do veículo (saídas, retornos e abastecimentos), sem o registro "exceto" */
function kmUlt(X, vid, exceto) {
  let k = 0; const v = (X.veic || []).find(x => x.id === vid); if (v) k = +v.kmInicial || 0;
  for (const x of X.vsai || []) if (x.veicId === vid && x.id !== exceto) k = Math.max(k, +x.kmSaida || 0, +x.kmRetorno || 0);
  return k;
}

/* ---------------------------------------------------------------- autorização do condutor */
const ORD = ['A', 'B', 'C', 'D', 'E'];
/* CNH: C, D e E incluem B; D inclui C; E inclui C e D */
function catOk(cnhCat, precisa) {
  const c = s(cnhCat).toUpperCase().replace(/[^A-E]/g, ''), p = s(precisa).toUpperCase(); if (!p) return true; if (!c) return false;
  if (p === 'A') return c.includes('A');
  const mx = Math.max(...c.split('').filter(x => x !== 'A').map(x => ORD.indexOf(x)), -1);
  return mx >= ORD.indexOf(p);
}
const precisaTox = cnhCat => /[CDE]/.test(s(cnhCat).toUpperCase());
const temCnh = f => !!(f && (f.cnhNum || f.cnhCat));
/* afastamento vigente (registro de afastamento ativo hoje ou cadastro "afastado") */
function afastado(X, f) {
  if (!f) return false; if (f.status === 'afastado') return true;
  return (X.afast || []).some(a => a.funcId === f.id && !['encerrado', 'cancelado'].includes(a.status) && dataOk(a.ini) && a.ini <= X.hoje && maisDias(a.ini, Math.max(1, +a.dias || 1) - 1) >= X.hoje && (!a.retorno || a.retorno > X.hoje));
}
const autDe = (X, funcId) => (X.vaut || []).find(a => a.funcId === funcId || a.id === funcId) || null;
/* migração (v165): sem registro de autorização, quem saiu com veículo nos 90 dias antes da migração entra como
   "Autorizado (migração)" por 30 dias. No servidor a migração grava os registros (X.mig existe); no navegador sem servidor
   a mesma regra é calculada. */
function autVirtual(X, f) {
  if (X.mig || !f || !temCnh(f)) return null;
  const ini = maisDias(X.hoje, -90);
  if (!(X.vsai || []).some(x => x.funcId === f.id && s(x.saidaEm) >= ini)) return null;
  return { id: f.id, funcId: f.id, st: 'ativa', migracao: true, validade: maisDias(X.hoje, 30), tipos: tiposMig(X.cfg, f.cnhCat), virtual: true };
}
/* tipos da migração: os que a CNH permite e que não pedem curso (o Administrador confirma e completa depois) */
const tiposMig = (cfg, cnhCat) => { const l = TIPOS.map(t => t[0]).filter(t => { const r = (cfg.reqTipo || {})[t] || {}; return catOk(cnhCat, r.cat || 'B') && !(r.cursos || []).length; }); return l.length ? l : ['leve']; };
/* status calculado: aut (Autorizado, verde) | vence (Vence em breve, amarelo) | bloq (Bloqueado, vermelho) | nao (Não autorizado, cinza) */
function autSit(X, f, a) {
  const cfg = X.cfg, h = X.hoje, lim = maisDias(h, +cfg.diasAviso || 30), mot = [], venc = [];
  if (a === undefined) a = f ? (autDe(X, f.id) || autVirtual(X, f)) : null;
  const R = (k, txt) => ({ k, txt, cor: k === 'aut' ? 'pos' : k === 'vence' ? 'warn' : k === 'bloq' ? 'neg' : '', motivos: mot, venc, a, mig: !!(a && a.migracao) });
  if (!f) { mot.push('Colaborador não encontrado.'); return R('nao', 'Não autorizado'); }
  if (f.status === 'desligado') { mot.push('Desligado: a autorização foi revogada.'); return R('nao', 'Não autorizado'); }
  if (!a || a.st === 'revogada') { mot.push(a ? 'Autorização revogada' + (a.motivo ? ': ' + a.motivo : '') + '.' : 'A empresa ainda não autorizou este condutor (Frota › Condutores › Autorizar).'); return R('nao', 'Não autorizado'); }
  if (afastado(X, f)) { mot.push('Afastado: a autorização fica suspensa até o retorno.'); return R('bloq', 'Bloqueado'); }
  const chk = (o, d) => { if (!dataOk(d)) { mot.push(o + ': sem validade informada.'); return; } if (d < h) mot.push(o + ' venceu em ' + br(d) + '.'); else if (d <= lim) venc.push({ o, d }); };
  if (!temCnh(f)) mot.push('Sem CNH no cadastro.'); else chk('CNH', f.cnhValidade);
  if (a.migracao) { if (!dataOk(a.validade) || a.validade < h) mot.push('Autorização da migração venceu' + (dataOk(a.validade) ? ' em ' + br(a.validade) : '') + ': confirme o condutor.'); } else chk('Autorização', a.validade); /* migração: 30 dias para confirmar, sem o aviso de "vence em breve" */
  if (a.dirigeFuncao && !a.ear) mot.push('Dirigir faz parte da função: a CNH precisa ter EAR (exerce atividade remunerada).');
  if (precisaTox(f.cnhCat)) chk('Exame toxicológico', a.toxVal);
  const tipos = Array.isArray(a.tipos) && a.tipos.length ? a.tipos : ['leve'];
  const cursos = uniq([].concat(...tipos.map(t => ((cfg.reqTipo || {})[t] || {}).cursos || [])));
  cursos.forEach(c => chk('Curso ' + (CURSOS[c] || c), (a.cursos || {})[c]));
  if (mot.length) return R('bloq', 'Bloqueado');
  if (venc.length) return R('vence', 'Vence em breve');
  return R('aut', a.migracao ? 'Autorizado (migração)' : 'Autorizado');
}
const autVenceEm = sit => sit.venc.length ? sit.venc.map(x => x.d).sort()[0] : '';
/* pode dirigir ESTE veículo? '' = pode; senão o motivo (mostrado na tela) */
function podeDirigir(X, f, v) {
  const sit = autSit(X, f);
  if (sit.k !== 'aut' && sit.k !== 'vence') return (f ? s(f.nome) + ': ' : '') + sit.txt.toLowerCase() + ' — ' + sit.motivos.join(' ');
  if (!v) return '';
  const a = sit.a, t = tipoDe(v), tipos = Array.isArray(a.tipos) && a.tipos.length ? a.tipos : ['leve'];
  if (!tipos.includes(t)) return s(f.nome) + ' não está autorizado(a) a dirigir ' + tipoNome(t).toLowerCase() + ' (autorizado: ' + tipos.map(tipoNome).join(', ') + ').';
  const need = ((X.cfg.reqTipo || {})[t] || {}).cat || 'B';
  if (s(v.tipo) === 'Moto' ? !catOk(f.cnhCat, 'A') : !catOk(f.cnhCat, need)) return 'A CNH de ' + s(f.nome) + ' (categoria ' + (s(f.cnhCat) || '—') + ') não permite ' + tipoNome(t).toLowerCase() + ' (precisa ' + (s(v.tipo) === 'Moto' ? 'A' : need) + ').';
  if (Array.isArray(a.veics) && a.veics.length && !a.veics.includes(v.id)) return s(f.nome) + ' só está autorizado(a) para veículos específicos (' + a.veics.length + '), e este não é um deles.';
  if (a.cidade && cidadeDe(v) && a.cidade !== cidadeDe(v)) return s(f.nome) + ' só está autorizado(a) para veículos de ' + a.cidade + '.';
  return '';
}
/* conferência do registro de autorização (tipos × categoria da CNH) antes de gravar */
function autValida(X, f, a) {
  if (!f) return 'Colaborador não encontrado.'; if (f.status === 'desligado') return 'Colaborador desligado não pode ser autorizado.';
  if (!temCnh(f)) return 'O colaborador não tem CNH no cadastro.';
  const tipos = Array.isArray(a.tipos) ? a.tipos.filter(t => TIPOS.some(x => x[0] === t)) : [];
  if (!tipos.length) return 'Escolha os tipos de veículo que o condutor pode dirigir.';
  for (const t of tipos) { const need = ((X.cfg.reqTipo || {})[t] || {}).cat || 'B'; if (!catOk(f.cnhCat, need)) return 'A CNH categoria ' + (s(f.cnhCat) || '—') + ' não permite ' + tipoNome(t).toLowerCase() + ' (precisa ' + need + ').'; }
  if (!dataOk(a.validade)) return 'Informe a validade da autorização.';
  return '';
}

/* ---------------------------------------------------------------- reserva */
const RES_ST = { pendente: ['Aguardando aprovação', 'warn'], aprovada: ['Aprovada', 'pos'], recusada: ['Recusada', 'neg'], cancelada: ['Cancelada', ''], usada: ['Usada na saída', 'acc'] };
const sobrepoe = (a, b) => s(a.ini) < s(b.fim) && s(b.ini) < s(a.fim);
function conflito(X, veicId, ini, fim, exceto) {
  return (X.vres || []).find(r => r.id !== exceto && r.veicId === veicId && r.st === 'aprovada' && sobrepoe({ ini, fim }, r)) || null;
}
const funcDe = (X, quem) => quem && quem.funcId ? (X.func || []).find(f => f.id === quem.funcId) || null : null;
/* quem registra para outra pessoa: Administrador, Administrador de frota, quem grava a frota e o responsável da cidade */
const gestor = (X, quem, cidade) => !!(quem && (quem.admin || quem.frotaTodos || quem.frotaW || (cidade != null ? ehResp(X.cfg, quem, cidade) : cidadesDe(X.cfg, quem.uid).length)));
function condutorPara(X, quem, funcId, cidade) {
  const meu = funcDe(X, quem);
  if (!funcId || (meu && funcId === meu.id)) return meu ? { f: meu } : { erro: 'Seu usuário não está ligado a um colaborador (Pessoal › Colaboradores › usuário do sistema). Peça ao RH.' };
  if (!gestor(X, quem, cidade)) return { erro: 'Você registra reserva, saída e retorno só para você mesmo(a).' };
  const f = (X.func || []).find(x => x.id === funcId); return f ? { f } : { erro: 'Condutor não encontrado.' };
}
function reservar(X, quem, b, id) {
  b = b || {}; const cfg = X.cfg;
  const ini = s(b.ini).slice(0, 16), fim = s(b.fim).slice(0, 16);
  if (!dtOk(ini) || !dtOk(fim)) return { erro: 'Informe a data e a hora de saída e o retorno previsto.' };
  if (fim <= ini) return { erro: 'O retorno previsto tem de ser depois da saída.' };
  if (ini < maisDias(X.hoje, -1) + 'T00:00') return { erro: 'A saída da reserva não pode ser no passado.' };
  const v = b.veicId ? (X.veic || []).find(x => x.id === b.veicId) : null;
  if (b.veicId && !v) return { erro: 'Veículo não encontrado.' };
  const cidade = v ? cidadeDe(v) : s(b.cidade);
  if (!v && !cfg.cidades.includes(cidade)) return { erro: 'Escolha o veículo ou a cidade ("qualquer disponível na minha cidade").' };
  const c = condutorPara(X, quem, b.funcId, cidade); if (c.erro) return c;
  const e = podeDirigir(X, c.f, v); if (e) return { erro: 'Reserva bloqueada: ' + e };
  if (v) { if (v.status === 'baixado') return { erro: 'Veículo baixado.' }; const k = conflito(X, v.id, ini, fim); if (k) return { erro: 'Este veículo já tem reserva aprovada de ' + brDt(k.ini) + ' a ' + brDt(k.fim) + '. Escolha outro horário ou outro veículo.' }; }
  if (String(b.destino || '').trim().length < 2) return { erro: 'Informe o destino ou a obra.' };
  if (String(b.motivo || '').trim().length < 3) return { erro: 'Informe o motivo.' };
  const r = { id, v165: 1, funcId: c.f.id, uid: quem.uid || '', cidade, veicId: v ? v.id : '', qualquer: !v, ini, fim, projId: s(b.projId).slice(0, 64), destino: s(b.destino).trim().slice(0, 200), motivo: s(b.motivo).trim().slice(0, 300), st: 'pendente', crEm: X.agora };
  return { docs: [{ c: 'vres165', d: r }], res: r, avisar: respDe(cfg, cidade) };
}
function decidir(X, quem, r, b) {
  b = b || {}; if (!r) return { erro: 'Reserva não encontrada.' };
  if (r.st !== 'pendente' && !(r.st === 'aprovada' && b.aprovar === false)) return { erro: 'Esta reserva já foi ' + (RES_ST[r.st] || [r.st])[0].toLowerCase() + '.' };
  const v = b.aprovar === false ? null : (X.veic || []).find(x => x.id === (b.veicId || r.veicId));
  const cidade = v ? cidadeDe(v) : r.cidade;
  if (!podeAprovar(X.cfg, quem, r.cidade) || (v && !podeAprovar(X.cfg, quem, cidade))) return { erro: 'Só o responsável pela frota de ' + (v && cidade !== r.cidade ? cidade : r.cidade || 'outra cidade') + ' (ou o Administrador) aprova esta reserva.' };
  const n = Object.assign({}, r, { decPor: quem.uid || '', decEm: X.agora });
  if (b.aprovar === false) { if (String(b.motivo || '').trim().length < 3) return { erro: 'Informe o motivo da recusa.' }; n.st = 'recusada'; n.motRec = s(b.motivo).trim().slice(0, 300); }
  else {
    if (!v) return { erro: 'Escolha o veículo para aprovar a reserva.' };
    if (v.status === 'baixado') return { erro: 'Veículo baixado.' };
    const f = (X.func || []).find(x => x.id === r.funcId), e = podeDirigir(X, f, v); if (e) return { erro: 'Não dá para aprovar: ' + e };
    const k = conflito(X, v.id, r.ini, r.fim, r.id); if (k) return { erro: 'Reserva sobreposta: este veículo já está reservado de ' + brDt(k.ini) + ' a ' + brDt(k.fim) + ' (' + nomeFunc(X, k.funcId) + ').' };
    n.st = 'aprovada'; n.veicId = v.id; n.cidade = cidade; if (r.veicId && r.veicId !== v.id) n.trocou = r.veicId;
  }
  return { docs: [{ c: 'vres165', d: n }], res: n };
}

/* ---------------------------------------------------------------- saída e retorno */
function ckErro(cfg, ck, obs, fase) {
  ck = ck && typeof ck === 'object' ? ck : {};
  const falta = cfg.checklist.filter(i => !['ok', 'nok'].includes(ck[i])); if (falta.length) return 'Checklist de ' + fase + ': marque ' + falta.join(', ') + '.';
  if (cfg.checklist.some(i => ck[i] === 'nok') && String(obs || '').trim().length < 3) return 'Checklist de ' + fase + ': descreva o problema do item reprovado.';
  return '';
}
function fotosErro(cfg, fotos, srv, fase) {
  if (!cfg.fotosObrig || !srv) return '';
  const f = fotos && typeof fotos === 'object' ? fotos : {}, falta = FOTOS.filter(x => !(f[x[0]] && f[x[0]].id));
  return falta.length ? 'Fotos da ' + fase + ': falta ' + falta.map(x => x[1].toLowerCase()).join(', ') + '.' : '';
}
const ultFechada = (X, vid) => (X.vsai || []).filter(x => x.veicId === vid && x.retornoEm).sort((a, b) => (dt(b.retornoEm, b.horaRet) + b.id).localeCompare(dt(a.retornoEm, a.horaRet) + a.id))[0] || null;
const avDocs = (X, lista, base) => (Array.isArray(lista) ? lista : []).slice(0, 20).map((a, i) => ({ c: 'vav165', d: Object.assign({ id: base.id + '_' + i, v165: 1, desc: s(a.desc).trim().slice(0, 300), foto: a.foto && a.foto.id ? { id: s(a.foto.id), nome: s(a.foto.nome).slice(0, 120) } : null, grave: !!a.grave, st: 'aberta', em: X.agora }, base.d) }));
/* b: { resId | veicId, funcId, data, hora, km, comb, ck, ckObs, fotos, avPre:[{desc,foto,grave}], destino, projId, pass, retPrev, obs } */
function saida(X, quem, b, id, srv) {
  b = b || {}; const cfg = X.cfg; let r = null, v = null;
  if (b.resId) { r = (X.vres || []).find(x => x.id === b.resId); if (!r) return { erro: 'Reserva não encontrada.' }; if (r.st !== 'aprovada') return { erro: 'A reserva não está aprovada (' + (RES_ST[r.st] || [r.st])[0].toLowerCase() + ').' }; v = (X.veic || []).find(x => x.id === r.veicId); }
  else v = (X.veic || []).find(x => x.id === b.veicId);
  if (!v) return { erro: 'Escolha o veículo.' };
  const cidade = cidadeDe(v);
  const c = condutorPara(X, quem, r ? r.funcId : b.funcId, cidade); if (c.erro) return c;
  if (!r && !(podeAprovar(cfg, quem, cidade) || cfg.saidaDireta)) return { erro: 'Saída só com reserva aprovada. Peça a reserva em Frota › Reservar veículo (saída direta só pelo responsável pela frota de ' + (cidade || 'cada cidade') + ' ou pelo Administrador).' };
  if (r && r.funcId !== c.f.id) return { erro: 'Esta reserva é de outro condutor.' };
  const e = podeDirigir(X, c.f, v); if (e) return { erro: 'Saída bloqueada: ' + e };
  const sit = veicSit(X, v);
  if (sit.k === 'uso') return { erro: 'O veículo está em uso (' + sit.txt.replace('Em uso por ', '') + ' desde ' + brDt(dt(sit.s.saidaEm, sit.s.hora)) + '). Registre o retorno antes.' };
  if (sit.k === 'manut') return { erro: 'Saída bloqueada: o veículo está em manutenção.' };
  if (sit.k === 'grave') return { erro: 'Saída bloqueada: o veículo tem avaria grave aberta (' + s(sit.av.desc).slice(0, 80) + '). O responsável pela frota resolve antes.' };
  if (sit.k === 'baixado') return { erro: 'Veículo baixado.' };
  const km = num(b.km); if (!(km > 0)) return { erro: 'Informe o km do painel.' };
  const ult = kmUlt(X, v.id); if (km < ult) return { erro: 'O km do painel (' + km + ') é menor que o último registrado (' + ult + '). Confira o painel.' };
  if (!combOpts(cfg).some(x => x[0] === s(b.comb))) return { erro: 'Marque o combustível no painel.' };
  let m = ckErro(cfg, b.ck, b.ckObs, 'saída'); if (m) return { erro: m };
  m = fotosErro(cfg, b.fotos, srv, 'saída'); if (m) return { erro: m };
  const av = Array.isArray(b.avPre) ? b.avPre.filter(a => a && (a.desc || a.foto)) : [];
  for (const a of av) { if (String(a.desc || '').trim().length < 3) return { erro: 'Descreva cada avaria encontrada.' }; if (srv && !(a.foto && a.foto.id)) return { erro: 'Tire a foto de cada avaria encontrada antes de sair.' }; }
  const retPrev = s(b.retPrev || (r && r.fim)).slice(0, 16); if (!dtOk(retPrev)) return { erro: 'Informe o retorno previsto (data e hora).' };
  const data = dataOk(b.data) ? b.data : X.hoje, hora = /^\d{2}:\d{2}$/.test(s(b.hora)) ? b.hora : X.agora.slice(11, 16);
  if (retPrev <= dt(data, hora)) return { erro: 'O retorno previsto tem de ser depois da saída.' };
  const destino = s(b.destino || (r && r.destino)).trim().slice(0, 200); if (destino.length < 2) return { erro: 'Informe o destino ou a obra.' };
  const sd = { id, v165: 1, veicId: v.id, funcId: c.f.id, condUid: c.f.usrId || (quem.funcId === c.f.id ? quem.uid || '' : ''), resId: r ? r.id : '', cidade, projId: s(b.projId || (r && r.projId)).slice(0, 64), destino,
    saidaEm: data, hora, kmSaida: km, comb165: s(b.comb), ck165: Object.assign({}, b.ck), ckObs165: s(b.ckObs).slice(0, 300), fotos165: b.fotos || {}, pass165: s(b.pass).slice(0, 300), retPrev165: retPrev,
    retornoEm: '', kmRetorno: '', obs: s(b.obs).slice(0, 300), regPor: quem.uid || '' };
  const docs = [{ c: 'vsai', d: sd }];
  if (r) docs.push({ c: 'vres165', d: Object.assign({}, r, { st: 'usada', vsaiId: id }) });
  const ant = ultFechada(X, v.id);
  avDocs(X, av, { id: id + '_pre', d: { veicId: v.id, vsaiId: id, fase: 'saida', atrib: ant ? ant.id : '', atribFunc: ant ? ant.funcId : '', cidade } }).forEach(x => docs.push(x));
  return { docs, saida: sd, avisar: av.length ? respDe(cfg, cidade) : [] };
}
/* b: { km, comb, ck, ckObs, fotos, avarias:[{desc,foto,grave}], abast:[{litros,valor,km,posto,data,hora,foto,dados}], data, hora, obs } */
function retorno(X, quem, sd, b, srv) {
  b = b || {}; const cfg = X.cfg;
  if (!sd) return { erro: 'Saída não encontrada.' }; if (sd.retornoEm) return { erro: 'Esta saída já tem retorno.' };
  const meu = funcDe(X, quem), proprio = !!((meu && sd.funcId === meu.id) || (quem.uid && sd.condUid === quem.uid && !sd.funcId));
  if (!proprio && !(quem.admin || ehResp(cfg, quem, sd.cidade || '') || quem.frotaTodos || quem.frotaW)) return { erro: 'Só o condutor da saída (ou o responsável pela frota da cidade) registra o retorno.' };
  const km = num(b.km); if (!(km > 0)) return { erro: 'Informe o km de chegada.' };
  if (km < (+sd.kmSaida || 0)) return { erro: 'O km de chegada (' + km + ') não pode ser menor que o da saída (' + (+sd.kmSaida || 0) + ').' };
  if (!combOpts(cfg).some(x => x[0] === s(b.comb))) return { erro: 'Marque o combustível na chegada.' };
  const v165 = !!sd.v165;
  let m = v165 ? ckErro(cfg, b.ck, b.ckObs, 'retorno') : ''; if (m) return { erro: m };
  m = v165 ? fotosErro(cfg, b.fotos, srv, 'chegada') : ''; if (m) return { erro: m };
  const av = Array.isArray(b.avarias) ? b.avarias.filter(a => a && (a.desc || a.foto)) : [];
  for (const a of av) { if (String(a.desc || '').trim().length < 3) return { erro: 'Descreva cada avaria nova.' }; if (srv && !(a.foto && a.foto.id)) return { erro: 'Tire a foto de cada avaria nova.' }; }
  const data = dataOk(b.data) ? b.data : X.hoje, hora = /^\d{2}:\d{2}$/.test(s(b.hora)) ? b.hora : X.agora.slice(11, 16);
  if (dt(data, hora) < dt(sd.saidaEm, sd.hora)) return { erro: 'O retorno não pode ser antes da saída.' };
  const ab = (Array.isArray(b.abast) ? b.abast : []).slice(0, 10);
  for (const a of ab) { if (!(num(a.litros) > 0) || !(num(a.valor) > 0)) return { erro: 'Abastecimento: informe litros e valor (do cupom).' }; if (srv && !(a.foto && a.foto.id)) return { erro: 'Abastecimento: tire a foto do cupom.' }; }
  const atraso = sd.retPrev165 && dt(data, hora) > sd.retPrev165 ? minutos(dt(data, hora), sd.retPrev165) : 0;
  const n = Object.assign({}, sd, { retornoEm: data, horaRet: hora, kmRetorno: km, combRet165: s(b.comb), ckR165: Object.assign({}, b.ck || {}), ckRObs165: s(b.ckObs).slice(0, 300), fotosR165: b.fotos || {}, retPor: quem.uid || '', abast: ab.length > 0 || !!sd.abast, atraso165: atraso || 0, obsRet165: s(b.obs).slice(0, 300) });
  const docs = [{ c: 'vsai', d: n }];
  const avs = avDocs(X, av, { id: sd.id + '_ret', d: { veicId: sd.veicId, vsaiId: sd.id, fase: 'retorno', atrib: sd.id, atribFunc: sd.funcId, cidade: sd.cidade || cidadeDe((X.veic || []).find(x => x.id === sd.veicId)) } });
  avs.forEach(x => docs.push(x));
  ab.forEach((a, i) => docs.push({ c: 'vabas', d: reciboDoc(X, quem, { veicId: sd.veicId, vsaiId: sd.id, funcId: sd.funcId, projId: sd.projId, cidade: n.cidade, dados: Object.assign({ litros: a.litros, valor: a.valor, km: a.km || km, data: a.data || data, hora: a.hora || hora, posto: a.posto }, a.dados || {}), foto: a.foto }, sd.id + '_ab' + i) }));
  const baixo = (fracN(b.comb) ?? 1) <= 0.25;
  return { docs, saida: n, baixo, atraso, avarias: avs.map(x => x.d), avisar: respDe(cfg, n.cidade || '') };
}

/* ---------------------------------------------------------------- multas: quem estava com o veículo */
function condutorNa(X, veicId, data, hora) {
  const t = dt(data, hora || '12:00'), sem = !/^\d{2}:\d{2}/.test(s(hora));
  const l = (X.vsai || []).filter(x => x.veicId === veicId && dataOk(x.saidaEm)).filter(x => {
    const a = sem ? x.saidaEm + 'T00:00' : dt(x.saidaEm, x.hora), z = x.retornoEm ? (sem ? x.retornoEm + 'T23:59' : dt(x.retornoEm, x.horaRet || '23:59')) : '9999';
    return a <= t && t <= z;
  }).sort((a, b) => dt(b.saidaEm, b.hora).localeCompare(dt(a.saidaEm, a.hora)));
  return l[0] ? { funcId: l[0].funcId, vsaiId: l[0].id, saida: l[0] } : null;
}

/* ---------------------------------------------------------------- abastecimentos: recibo, relatório e conferências */
const kmAbas = a => +(a && a.hodCorr165 && a.hodCorr165.km != null ? a.hodCorr165.km : a && a.km) || 0;
/* recibo (cupom) lido ou digitado: abastecimento PROVISÓRIO, "aguardando relatório" */
function reciboDoc(X, quem, o, id) {
  const d = o.dados || {}, litros = r2(num(d.litros ?? d.volume)), valor = r2(num(d.valor));
  return { id, v165: 1, veicId: o.veicId, vsaiId: o.vsaiId || '', funcId: o.funcId || '', projId: o.projId || '', comum: !o.projId, cidade: o.cidade || '', data: dataOk(d.data) ? d.data : X.hoje, hora165: /^\d{2}:\d{2}/.test(s(d.hora)) ? s(d.hora).slice(0, 5) : '',
    km: num(d.km) || 0, litros, valor, combustivel: s(d.comb).slice(0, 40), posto: s(d.posto || d.cnpj).slice(0, 120), cheio: d.cheio !== false, gerarLanc: false, pago: false, lancId: '',
    st165: 'aguardando', rec165: { aut: digitos(d.aut).slice(0, 20), nsu: digitos(d.nsu).slice(0, 20), placa: placaN(d.placa), km: num(d.km), litros, valor, cnpj: digitos(d.cnpj).slice(0, 14), data: dataOk(d.data) ? d.data : '', hora: s(d.hora).slice(0, 5), comb: s(d.comb).slice(0, 40), ia: !!d.ia, foto: o.foto && o.foto.id ? { id: s(o.foto.id), nome: s(o.foto.nome).slice(0, 120) } : null, por: quem.uid || '', em: X.agora },
    alertas165: [], obs: 'Recibo do posto (aguardando o relatório da Sem Parar)' };
}
/* colunas do relatório "Relatório Utilização Combustível" pelo NOME (Cod. Centro Custo / Nome aparecem duas vezes:
   a primeira é do motorista e a segunda do veículo) */
const COLS = [['aut', 'Autorização'], ['autCupom', 'Autorização Cupom'], ['idCli', 'ID Cliente Resp. Portador Cartão'], ['cli', 'Cliente Resp. Portador Cartão'], ['cartao', 'Cartão'], ['data', 'Data'], ['hora', 'Hora'],
  ['cpf', 'CPF Motorista'], ['motorista', 'Motorista'], ['numFunc', 'Número do Funcionário'], ['ccMot', 'Cod. Centro Custo'], ['ccMotNome', 'Nome'], ['frota', 'Número da Frota'], ['placa', 'Placa'], ['marca', 'Marca'], ['modelo', 'Modelo'],
  ['ccVei', 'Cod. Centro Custo'], ['ccVeiNome', 'Nome'], ['ano', 'Ano'], ['rede', 'Rede Goodcard'], ['cnpj', 'CNPJ'], ['logradouro', 'Logradouro'], ['bairro', 'Bairro'], ['cidade', 'Cidade'], ['uf', 'UF'], ['cep', 'CEP'],
  ['tipoComb', 'Tipo Combustível'], ['litros', 'Litros Combustível'], ['valorComb', 'Combustível(R$)'], ['preco', 'Preço/Litro(R$) Combustível'], ['litrosOleo', 'Litros Óleo'], ['valorOleo', 'Óleo(R$)'], ['precoOleo', 'Preço/Litro(R$) Óleo'],
  ['tipoManut', 'Tipo Manutenção'], ['valorManut', 'Manutenção(R$)'], ['total', 'Valor Total Transação'], ['hodAnt', 'Hodômetro Anterior'], ['hodInf', 'Hodômetro Informado'], ['kmRod', 'Km Rodado'], ['custoKm', 'Custo Km Rodado(R$)'],
  ['mediaComb', 'Média Comb'], ['mediaArla', 'Média Arla'], ['cont', 'Abastecimento em Contingência'], ['g1m', 'Grupo 1 - Motorista'], ['g2m', 'Grupo 2 - Motorista'], ['g3m', 'Grupo 3 - Motorista'], ['g4m', 'Grupo 4 - Motorista'],
  ['g1v', 'Grupo 1 - Veículo'], ['g2v', 'Grupo 2 - Veículo'], ['g3v', 'Grupo 3 - Veículo'], ['g4v', 'Grupo 4 - Veículo']];
const OBRIG = ['aut', 'data', 'placa', 'litros', 'hodInf'];
const NUMS = ['litros', 'valorComb', 'preco', 'litrosOleo', 'valorOleo', 'precoOleo', 'valorManut', 'total', 'hodAnt', 'hodInf', 'kmRod', 'custoKm', 'mediaComb', 'mediaArla'];
function mapaColunas(cab) {
  const nc = cab.map(norm), out = {}, usados = new Set();
  for (const [k, nome] of COLS) { const n = norm(nome); const i = nc.findIndex((x, j) => x === n && !usados.has(j)); if (i >= 0) { out[k] = i; usados.add(i); } }
  return out;
}
const dataBr = v => { const t = s(v).trim(); let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'); m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t); return m ? m[0] : ''; };
const mascCpf = v => { const d = digitos(v); return d.length === 11 ? d.slice(0, 3) + '.***.***-' + d.slice(9) : d ? '***' : ''; };
/* linhas da planilha (sheet_to_json header:1, texto) → linhas do relatório. Acha a linha dos nomes das colunas (normalmente a 8ª)
   e lê até a primeira linha sem Autorização (o total no fim do relatório fica de fora). */
function lerRelatorio(rows) {
  rows = Array.isArray(rows) ? rows : [];
  const hi = rows.findIndex(r => Array.isArray(r) && r.some(c => norm(c) === 'autorizacao') && r.some(c => norm(c) === 'placa'));
  if (hi < 0) return { erro: 'Não achei a linha dos nomes das colunas (Autorização, Placa…). Use o "Relatório Utilização Combustível" do portal da Sem Parar, em .xls.' };
  const M = mapaColunas(rows[hi].map(s)), falta = OBRIG.filter(k => M[k] == null);
  if (falta.length) return { erro: 'Faltam colunas no relatório: ' + falta.map(k => COLS.find(c => c[0] === k)[1]).join(', ') + '.' };
  const linhas = [];
  for (let i = hi + 1; i < rows.length && linhas.length < 5000; i++) {
    const r = rows[i] || [], g = k => M[k] == null ? '' : s(r[M[k]]).trim();
    if (!digitos(g('aut'))) break;
    const o = {}; COLS.forEach(([k]) => { if (M[k] != null) o[k] = g(k); });
    NUMS.forEach(k => { if (o[k] !== undefined) o[k] = num(o[k]); });
    o.data = dataBr(o.data); o.hora = s(o.hora).slice(0, 5); o.placa = placaN(o.placa); o.aut = digitos(o.aut); o.autCupom = digitos(o.autCupom); o.cpf = digitos(o.cpf); o.cnpj = digitos(o.cnpj);
    o.cont = /^s/i.test(s(o.cont)); o.linha = i + 1;
    linhas.push(o);
  }
  return { linhas, cab: hi };
}
const mediana = a => { const l = a.filter(x => x > 0).sort((x, y) => x - y); if (!l.length) return null; const m = Math.floor(l.length / 2); return l.length % 2 ? l[m] : (l[m - 1] + l[m]) / 2; };
/* saída que cobre a data/hora (para obra, condutor e km) */
function saidaNa(X, veicId, data, hora) { const c = condutorNa(X, veicId, data, hora); return c ? c.saida : null; }
/* consumo do veículo (km/l) entre abastecimentos de tanque cheio, com o hodômetro corrigido */
function consumoVeic(abasL) {
  const l = abasL.filter(a => kmAbas(a) > 0).sort((a, b) => kmAbas(a) - kmAbas(b) || s(a.data).localeCompare(s(b.data)));
  const pares = []; for (let i = 1; i < l.length; i++) { const km = kmAbas(l[i]) - kmAbas(l[i - 1]), lt = +l[i].litros || 0; if (l[i].cheio !== false && l[i - 1].cheio !== false && km > 0 && lt > 0) pares.push({ a: l[i], km, lt, kml: km / lt }); }
  const km = pares.reduce((t, p) => t + p.km, 0), lt = pares.reduce((t, p) => t + p.lt, 0);
  return { media: lt > 0 ? km / lt : null, pares, ult: pares.length ? pares[pares.length - 1] : null };
}
/* conferências de uma linha do relatório (ou de um abastecimento importado) */
function checar(X, L, ctx) {
  const cfg = X.cfg, al = [], A = (k, txt) => al.push({ k, txt });
  const v = ctx.v, kr = L.kmRod, hod = L.hodCorr != null ? L.hodCorr : L.hodInf, ant = +L.hodAnt || 0;
  if (!v) A('placa', 'Placa ' + (L.placa || '—') + ' não cadastrada na frota.');
  if (!ctx.f) A('cpf', 'Motorista do cartão sem colaborador com esse CPF.');
  if (L.cont) A('cont', 'Abastecimento em contingência (sem senha/km pela rede).');
  const krE = L.hodCorr != null && ant > 0 ? L.hodCorr - ant : kr;
  if (krE != null && krE < 0) A('kmNeg', 'Km rodado negativo (' + krE + ' km): hodômetro digitado errado.');
  else if (krE != null && krE > (+cfg.kmMax || 2000)) A('kmAlto', 'Km rodado alto (' + krE + ' km, limite ' + (+cfg.kmMax || 2000) + ').');
  if (ant > 0 && hod > 0 && hod / ant > 5 && L.hodCorr == null) A('digito', 'Hodômetro informado ' + hod + ' ≈ 10× o anterior (' + ant + '): provável dígito a mais.');
  if (krE != null && krE >= 0 && krE < (+cfg.kmMin || 20)) A('kmBaixo', 'Km rodado baixo (' + krE + ' km desde o abastecimento anterior).');
  if (ctx.mesmoDia) A('doisDia', 'Dois abastecimentos do veículo no mesmo dia' + (ctx.mesmoDia.outroMot ? ' por motoristas diferentes' : '') + '.');
  const sd = ctx.sd;
  if (v && !sd) A('semSaida', 'Nenhuma saída do veículo cobre ' + brDt(dt(L.data, L.hora)) + '.');
  if (sd) {
    const tol = +cfg.tolKm || 50, lo = (+sd.kmSaida || 0) - tol, hi = (sd.retornoEm ? +sd.kmRetorno || 0 : Infinity) + tol;
    if (hod > 0 && (hod < lo || hod > hi)) A('hodSaida', 'Hodômetro ' + hod + ' fora do km da saída (' + (+sd.kmSaida || 0) + ' a ' + (sd.retornoEm ? +sd.kmRetorno : 'em uso') + ', tolerância ' + tol + ').');
    if (ctx.f && sd.funcId && sd.funcId !== ctx.f.id) A('motDif', 'Motorista do cartão (' + s(ctx.f.nome) + ') não é o condutor da saída (' + nomeFunc(X, sd.funcId) + ').');
  }
  if (v && L.tipoComb && !combAceita(v, L.tipoComb)) A('combInc', L.tipoComb + ' em veículo ' + (v.combustivel || '') + '.');
  if (v && +v.tanque > 0 && +L.litros > +v.tanque) A('tanque', r2(L.litros) + ' litros passam da capacidade do tanque (' + v.tanque + ' L).');
  const pr = +L.preco || (+L.litros > 0 ? +L.valorComb / +L.litros : 0);
  if (pr > 0 && ctx.medPreco > 0 && pr > ctx.medPreco * (1 + (+cfg.precoPct || 15) / 100)) A('preco', 'R$/litro ' + pr.toFixed(3).replace('.', ',') + ' acima da mediana do posto/cidade (' + ctx.medPreco.toFixed(3).replace('.', ',') + ') em mais de ' + (+cfg.precoPct || 15) + '%.');
  if (ctx.media > 0 && krE > 0 && +L.litros > 0) { const k = krE / +L.litros; if (k < ctx.media * (1 - (+cfg.quedaKmlPct || 20) / 100)) A('kmlQueda', 'Consumo ' + k.toFixed(1).replace('.', ',') + ' km/l, abaixo da média do veículo (' + ctx.media.toFixed(1).replace('.', ',') + ') em mais de ' + (+cfg.quedaKmlPct || 20) + '%.'); }
  if (+L.valorOleo > 0 || +L.litrosOleo > 0) A('oleo', 'Óleo na mesma transação (' + r2(L.valorOleo) + '): fica como item separado.');
  if (+L.valorManut > 0) A('manut', 'Manutenção na transação (' + (L.tipoManut || '') + ' ' + r2(L.valorManut) + '): o custo da manutenção vai pela nota (v163).');
  return al;
}
const ALERTAS = { placa: 'Placa desconhecida', cpf: 'CPF sem colaborador', cont: 'Contingência', kmNeg: 'Km negativo', kmAlto: 'Km alto', digito: 'Dígito a mais', kmBaixo: 'Km baixo', doisDia: 'Dois no mesmo dia', semSaida: 'Sem saída', hodSaida: 'Hodômetro × saída', motDif: 'Motorista ≠ condutor', combInc: 'Combustível errado', tanque: 'Acima do tanque', preco: 'Preço alto', kmlQueda: 'Queda de km/l', oleo: 'Óleo', manut: 'Manutenção', difRecibo: 'Recibo diferente', reciboSem: 'Recibo sem transação', semRecibo: 'Sem recibo' };
/* linha do relatório → abastecimento (novo ou o mesmo de antes) e as conferências */
function importar(X, quem, linhas, origem, opc) {
  opc = opc || {}; const cfg = X.cfg, lote = s(opc.lote) || 'imp', esc = escopo(cfg, quem, false);
  const porPlaca = new Map((X.veic || []).map(v => [placaN(v.placa), v])), porCpf = new Map((X.func || []).filter(f => digitos(f.cpf).length === 11).map(f => [digitos(f.cpf), f]));
  const porAut = new Map((X.vabas || []).filter(a => a.imp165 && a.imp165.aut).map(a => [a.imp165.aut, a]));
  const prov = (X.vabas || []).filter(a => a.st165 === 'aguardando' && a.rec165);
  const usados = new Set(), docs = [], prev = [];
  const grupoP = L => (L.cnpj || norm(L.cidade + '/' + L.uf)) + '|' + norm(L.tipoComb).split(' ')[0];
  const precos = new Map(); const addP = (k, p) => { if (p > 0) { if (!precos.has(k)) precos.set(k, []); precos.get(k).push(p); } };
  (X.vabas || []).forEach(a => { if (a.imp165 && a.imp165.orig) addP(grupoP(a.imp165.orig), +a.imp165.orig.preco || 0); });
  linhas.forEach(L => addP(grupoP(L), +L.preco || (+L.litros > 0 ? +L.valorComb / +L.litros : 0)));
  const dias = new Map(); const addD = (vid, d, f, id) => { const k = vid + '|' + d; if (!dias.has(k)) dias.set(k, []); dias.get(k).push({ f, id }); };
  (X.vabas || []).forEach(a => { if (a.veicId && !(a.imp165 && linhas.some(L => L.aut === a.imp165.aut))) addD(a.veicId, a.data, a.funcId, a.id); });
  linhas.forEach(L => { const v = porPlaca.get(L.placa), f = porCpf.get(L.cpf); if (v) addD(v.id, L.data, f ? f.id : L.cpf, 'L' + L.aut); });
  const hist = new Map(); (X.vabas || []).forEach(a => { if (!a.veicId) return; if (!hist.has(a.veicId)) hist.set(a.veicId, []); hist.get(a.veicId).push(a); });
  let ini = '', fim = '';
  for (const L of linhas) {
    const v = porPlaca.get(L.placa) || null, f = porCpf.get(L.cpf) || null, ex = porAut.get(L.aut) || null;
    if (!ini || L.data < ini) ini = L.data; if (!fim || L.data > fim) fim = L.data;
    const cid = cidadeDe(v), fora = !!(esc && v && !esc.has(cid)) || !!(esc && !v);
    const sd = v ? saidaNa(X, v.id, L.data, L.hora) : null;
    const mesmo = v ? (dias.get(v.id + '|' + L.data) || []).filter(x => x.id !== 'L' + L.aut && x.id !== (ex && ex.id)) : [];
    const ctx = { v, f, sd, medPreco: mediana(precos.get(grupoP(L)) || []), media: v ? consumoVeic((hist.get(v.id) || []).filter(a => !(a.imp165 && a.imp165.aut === L.aut))).media : null, mesmoDia: mesmo.length ? { outroMot: mesmo.some(x => x.f && x.f !== (f ? f.id : L.cpf)) } : null };
    if (ex && ex.hodCorr165) L.hodCorr = ex.hodCorr165.km;
    const al = checar(X, L, ctx);
    let rec = null;
    if (!ex && v) { const tol = +cfg.tolMatchDias || 1; rec = prov.find(a => !usados.has(a.id) && a.veicId === v.id && L.autCupom && a.rec165.aut && a.rec165.aut.replace(/^0+/, '') === L.autCupom.replace(/^0+/, '') && (!a.rec165.placa || a.rec165.placa === L.placa) && Math.abs(difDias(a.rec165.data || a.data, L.data)) <= tol) || null; }
    if (rec) { usados.add(rec.id); const R = rec.rec165, d = [];
      if (R.km != null && Math.abs((+R.km || 0) - (+L.hodInf || 0)) > (+cfg.tolKm || 50)) d.push('km ' + R.km + ' × ' + L.hodInf);
      if (R.litros != null && Math.abs((+R.litros || 0) - (+L.litros || 0)) > (+cfg.tolLitros || 0.5)) d.push('litros ' + r2(R.litros) + ' × ' + r2(L.litros));
      if (R.valor != null && Math.abs((+R.valor || 0) - (+L.valorComb || +L.total || 0)) > (+cfg.tolValor || 0.5)) d.push('valor ' + r2(R.valor) + ' × ' + r2(L.valorComb || L.total));
      if (d.length) al.push({ k: 'difRecibo', txt: 'Recibo diferente do relatório: ' + d.join('; ') + '.' }); }
    else if (!ex && cfg.exigeRecibo) al.push({ k: 'semRecibo', txt: 'Abastecimento sem recibo (cupom) registrado.' });
    const st = fora ? 'fora' : ex ? 'dup' : rec ? 'casado' : 'novo';
    prev.push({ linha: L.linha, aut: L.aut, autCupom: L.autCupom, placa: L.placa, veicId: v ? v.id : '', data: L.data, hora: L.hora, motorista: f ? s(f.nome) : s(L.motorista), funcId: f ? f.id : '', cpfMasc: mascCpf(L.cpf), litros: r2(L.litros), valor: r2(L.valorComb), total: r2(L.total), tipoComb: s(L.tipoComb), kmRod: L.kmRod, hodInf: L.hodInf, cont: !!L.cont, projId: sd ? s(sd.projId) : '', cidade: cid, st, alertas: al, vabasId: ex ? ex.id : rec ? rec.id : 'sp_' + L.aut });
    if (fora || !v) continue;
    const base = ex || rec || {};
    const orig = { hodAnt: L.hodAnt, hodInf: L.hodInf, kmRod: L.kmRod, litros: L.litros, valorComb: L.valorComb, preco: L.preco, total: L.total, tipoComb: s(L.tipoComb), cnpj: L.cnpj, cidade: s(L.cidade), uf: s(L.uf), litrosOleo: L.litrosOleo, valorOleo: L.valorOleo, tipoManut: s(L.tipoManut), valorManut: L.valorManut, mediaComb: L.mediaComb, frota: s(L.frota), data: L.data, hora: L.hora };
    const itens = []; if (+L.valorOleo > 0 || +L.litrosOleo > 0) itens.push({ tipo: 'oleo', litros: r2(L.litrosOleo), valor: r2(L.valorOleo) }); if (+L.valorManut > 0) itens.push({ tipo: 'manut', desc: s(L.tipoManut).slice(0, 80), valor: r2(L.valorManut), viaNota: true });
    const d = Object.assign({}, base, { id: base.id || 'sp_' + L.aut, v165: 1, veicId: v.id, data: L.data, hora165: L.hora, km: base.hodCorr165 ? base.hodCorr165.km : (+L.hodInf || 0), litros: r2(L.litros), valor: r2(L.valorComb != null ? L.valorComb : L.total),
      combustivel: s(L.tipoComb).slice(0, 40), posto: [s(L.rede), s(L.cidade) + (L.uf ? '/' + s(L.uf) : '')].filter(Boolean).join(' · ').slice(0, 120), cheio: base.cheio !== undefined ? base.cheio : true,
      gerarLanc: false, pago: base.pago || false, lancId: base.lancId || '', funcId: f ? f.id : (base.funcId || ''), vsaiId: sd ? sd.id : (base.vsaiId || ''), projId: sd ? s(sd.projId) : (base.projId || ''), comum: !(sd && sd.projId), cidade: cid,
      st165: 'confirmado', alertas165: al, itens165: itens,
      imp165: { lote, origem: s(origem).slice(0, 40), aut: L.aut, autCupom: L.autCupom, cartao: s(L.cartao).slice(0, 30), cpfMasc: mascCpf(L.cpf), motorista: f ? '' : s(L.motorista).slice(0, 80), numFunc: s(L.numFunc).slice(0, 20), cont: !!L.cont, orig, em: X.agora, por: quem.uid || '', reimp: ex ? ((ex.imp165 && ex.imp165.reimp) || 0) + 1 : 0 } });
    if (rec) d.rec165 = Object.assign({}, rec.rec165, { casadoEm: X.agora });
    docs.push({ c: 'vabas', d });
  }
  /* recibo sem transação: provisório até o fim do período do relatório que não casou com nenhuma linha */
  const semTx = [];
  if (fim) for (const a of prov) { if (usados.has(a.id)) continue; const v = (X.veic || []).find(x => x.id === a.veicId); if (esc && !esc.has(cidadeDe(v))) continue; if (s(a.rec165.data || a.data) > fim) continue;
    const al = (a.alertas165 || []).filter(x => x.k !== 'reciboSem').concat([{ k: 'reciboSem', txt: 'Recibo sem transação no relatório da Sem Parar importado em ' + br(X.hoje) + '.' }]);
    semTx.push(a.id); docs.push({ c: 'vabas', d: Object.assign({}, a, { alertas165: al }) }); }
  const resumo = { n: linhas.length, novos: prev.filter(p => p.st === 'novo').length, dups: prev.filter(p => p.st === 'dup').length, casados: prev.filter(p => p.st === 'casado').length, fora: prev.filter(p => p.st === 'fora').length,
    semPlaca: prev.filter(p => !p.veicId).length, comAlerta: prev.filter(p => p.alertas.length).length, reciboSem: semTx.length, ini, fim, total: r2(prev.filter(p => p.st !== 'fora').reduce((t, p) => t + (+p.total || +p.valor || 0), 0)) };
  return { prev, docs, resumo };
}
/* correção do hodômetro (o original fica no histórico); as conferências do veículo são refeitas */
function corrigirHod(X, quem, a, km, motivo) {
  if (!a) return { erro: 'Abastecimento não encontrado.' };
  const v = (X.veic || []).find(x => x.id === a.veicId);
  if (!podeAprovar(X.cfg, quem, cidadeDe(v))) return { erro: 'Só o responsável pela frota da cidade do veículo ou o Administrador de frota corrige o hodômetro.' };
  km = num(km); if (!(km > 0)) return { erro: 'Informe o hodômetro corrigido.' };
  if (String(motivo || '').trim().length < 5) return { erro: 'Informe o motivo da correção (obrigatório).' };
  const orig = a.hodCorr165 ? a.hodCorr165.orig : (a.imp165 && a.imp165.orig ? a.imp165.orig.hodInf : a.km);
  const h = (Array.isArray(a.hodHist165) ? a.hodHist165 : []).concat([{ de: kmAbas(a), para: km, motivo: s(motivo).trim().slice(0, 300), por: quem.uid || '', em: X.agora }]);
  const n = Object.assign({}, a, { km, hodCorr165: { km, orig, motivo: s(motivo).trim().slice(0, 300), por: quem.uid || '', em: X.agora }, hodHist165: h });
  if (n.imp165 && n.imp165.orig) {
    const o = n.imp165.orig, L = Object.assign({}, o, { placa: v ? placaN(v.placa) : '', hodCorr: km, cont: !!n.imp165.cont });
    const outros = (X.vabas || []).filter(x => x.veicId === a.veicId && x.id !== a.id);
    const sd = saidaNa(X, a.veicId, o.data || a.data, o.hora || a.hora165), f = (X.func || []).find(x => x.id === a.funcId) || null;
    const al = checar(X, L, { v, f, sd, media: consumoVeic(outros).media, medPreco: 0, mesmoDia: outros.some(x => x.data === a.data) ? { outroMot: outros.some(x => x.data === a.data && x.funcId !== a.funcId) } : null });
    n.alertas165 = al.concat((a.alertas165 || []).filter(x => ['preco', 'difRecibo', 'reciboSem', 'semRecibo'].includes(x.k)));
  }
  return { docs: [{ c: 'vabas', d: n }], abas: n };
}
/* fatura do mês: total importado, rateio por veículo, obra e cidade (sem saída: custo geral da frota da cidade) */
function fatura(X, mes, esc) {
  const l = (X.vabas || []).filter(a => a.imp165 && s(a.data).slice(0, 7) === mes && (!esc || esc.has(s(a.cidade))));
  const soma = (k, f) => { const m = new Map(); l.forEach(a => { const x = f(a); m.set(x, r2((m.get(x) || 0) + (+a.valor || 0) + (a.itens165 || []).filter(i => i.tipo === 'oleo').reduce((t, i) => t + (+i.valor || 0), 0))); }); return [...m.entries()].map(([kk, valor]) => ({ [k]: kk, valor })).sort((a, b) => b.valor - a.valor); };
  const total = r2(l.reduce((t, a) => t + (+a.valor || 0) + (a.itens165 || []).filter(i => i.tipo === 'oleo').reduce((x, i) => x + (+i.valor || 0), 0), 0));
  const manut = r2(l.reduce((t, a) => t + (a.itens165 || []).filter(i => i.tipo === 'manut').reduce((x, i) => x + (+i.valor || 0), 0), 0));
  const porObra = soma('projId', a => a.projId || ''), porCidade = soma('cidade', a => s(a.cidade)), porVeic = soma('veicId', a => a.veicId);
  const rateio = porObra.filter(o => o.projId).map(o => ({ projId: o.projId, valor: o.valor, pct: total > 0 ? Math.round(o.valor / total * 10000) / 100 : 0 }));
  const geral = porObra.filter(o => !o.projId).reduce((t, o) => t + o.valor, 0);
  return { mes, n: l.length, total, manut, porObra, porCidade, porVeic, rateio, geral: r2(geral), ids: l.map(a => a.id), faturados: l.filter(a => a.fat165).length };
}

/* ---------------------------------------------------------------- painel por cidade */
function painel(X, esc) {
  const cfg = X.cfg, h = X.hoje, lim = maisDias(h, +cfg.diasAviso || 30), okC = c => !esc || esc.has(c);
  const vs = (X.veic || []).filter(v => v.status !== 'baixado' && okC(cidadeDe(v))), ids = new Set(vs.map(v => v.id)), de = r => r && ids.has(r.veicId);
  const o = { disp: [], uso: [], manut: [], grave: [], atrasados: [], combBaixo: [], avarias: [], resPend: [], venc: [], cnh: [], bloq: [], autVenc: [], abasAl: [], kml: [], desligEmUso: [] };
  vs.forEach(v => { const st = veicSit(X, v); (st.k === 'disp' ? o.disp : st.k === 'uso' ? o.uso : st.k === 'manut' ? o.manut : o.grave).push({ v, st });
    [['Licenciamento', v.licenciamento], ['Seguro', v.seguro], ['IPVA', v.ipva]].forEach(([t, d]) => { if (dataOk(d) && d <= lim) o.venc.push({ v, t, d }); }); });
  (X.vman || []).forEach(m => { if (de(m) && m.status !== 'agendada' && dataOk(m.proxData) && m.proxData <= lim) o.venc.push({ v: (X.veic || []).find(x => x.id === m.veicId), t: 'Revisão', d: m.proxData }); });
  o.venc.sort((a, b) => a.d.localeCompare(b.d));
  (X.vsai || []).forEach(x => { if (!de(x)) return;
    if (!x.retornoEm && x.retPrev165 && x.retPrev165 < X.agora) o.atrasados.push({ s: x, min: minutos(X.agora, x.retPrev165) });
    if (x.retornoEm && x.v165 && (fracN(x.combRet165) ?? 1) <= 0.25) { const t = dt(x.retornoEm, x.horaRet), depois = (X.vabas || []).some(a => a.veicId === x.veicId && a.vsaiId !== x.id && dt(a.data, a.hora165 || '23:59') >= t) || (X.vsai || []).some(y => y.veicId === x.veicId && y.id !== x.id && dt(y.saidaEm, y.hora) >= t && (fracN(y.comb165) ?? 0) > 0.25); if (!depois) o.combBaixo.push({ s: x }); }
    if (!x.retornoEm) { const f = (X.func || []).find(y => y.id === x.funcId); if (f && f.status === 'desligado') o.desligEmUso.push({ s: x, f }); } });
  o.combBaixo = o.combBaixo.filter((x, i, a) => a.findIndex(y => y.s.veicId === x.s.veicId) === i);
  o.avarias = (X.vav || []).filter(a => de(a) && a.st !== 'resolvida').sort((a, b) => s(b.em).localeCompare(s(a.em)));
  o.resPend = (X.vres || []).filter(r => r.st === 'pendente' && okC(r.cidade)).sort((a, b) => s(a.ini).localeCompare(s(b.ini)));
  o.abasAl = (X.vabas || []).filter(a => de(a) && (a.alertas165 || []).some(x => !['cont', 'oleo'].includes(x.k)) && s(a.data) >= maisDias(h, -60)).sort((a, b) => s(b.data).localeCompare(s(a.data)));
  vs.forEach(v => { const c = consumoVeic((X.vabas || []).filter(a => a.veicId === v.id)); if (c.ult && c.media > 0 && c.ult.kml < c.media * (1 - (+cfg.quedaKmlPct || 20) / 100)) o.kml.push({ v, ult: c.ult.kml, media: c.media }); });
  (X.func || []).filter(f => f.status !== 'desligado' && temCnh(f)).forEach(f => {
    const a = autDe(X, f.id) || autVirtual(X, f); if (a && a.cidade && esc && !esc.has(a.cidade)) return;
    if (dataOk(f.cnhValidade) && f.cnhValidade <= lim) o.cnh.push({ f, d: f.cnhValidade });
    if (!a || a.st === 'revogada') return;
    const st = autSit(X, f, a); if (st.k === 'bloq') o.bloq.push({ f, st }); else if (st.k === 'vence') o.autVenc.push({ f, st, d: autVenceEm(st) }); });
  o.cnh.sort((a, b) => a.d.localeCompare(b.d)); o.autVenc.sort((a, b) => a.d.localeCompare(b.d));
  o.vs = vs; return o;
}

/* ---------------------------------------------------------------- modelo das telas de reserva, saída e retorno */
function modelo(X, quem) {
  const cfg = X.cfg, f = funcDe(X, quem), esc = escopo(cfg, quem, true);
  const cs = cidadesDe(cfg, quem.uid), sit = f ? autSit(X, f) : null;
  const veicMin = v => { const st = veicSit(X, v); return { id: v.id, placa: s(v.placa), modelo: s(v.modelo), marca: s(v.marca), tipo: s(v.tipo), tipoAut: tipoDe(v), cidade: cidadeDe(v), combustivel: s(v.combustivel), tanque: +v.tanque || 0, sit: st.k, sitTxt: st.txt, km: kmUlt(X, v.id) }; };
  const cidadeMinha = (sit && sit.a && sit.a.cidade) || cs[0] || '';
  const vsVer = (X.veic || []).filter(v => v.status !== 'baixado' && (gestor(X, quem) ? (!esc || esc.has(cidadeDe(v))) : (!cidadeMinha || cidadeDe(v) === cidadeMinha)));
  const minhaRes = f ? (X.vres || []).filter(r => r.funcId === f.id).sort((a, b) => s(b.ini).localeCompare(s(a.ini))).slice(0, 30) : [];
  const minhasSai = f ? (X.vsai || []).filter(x => x.funcId === f.id && !x.retornoEm) : [];
  const gere = gestor(X, quem);
  const resGerir = gere ? (X.vres || []).filter(r => (r.st === 'pendente' || (r.st === 'aprovada' && s(r.fim) >= X.agora)) && (!esc || esc.has(r.cidade))).sort((a, b) => s(a.ini).localeCompare(s(b.ini))).slice(0, 100) : [];
  const saiGerir = gere ? (X.vsai || []).filter(x => !x.retornoEm && (!esc || esc.has(x.cidade || cidadeDe((X.veic || []).find(v => v.id === x.veicId))))).slice(0, 200) : [];
  const cond = gere ? (X.func || []).filter(x => x.status !== 'desligado' && temCnh(x)).map(x => ({ id: x.id, nome: s(x.nome), sit: autSit(X, x).k })) : [];
  return { cfg: { cidades: cfg.cidades, checklist: cfg.checklist, fotosObrig: !!cfg.fotosObrig, frac8: !!cfg.frac8, saidaDireta: !!cfg.saidaDireta, resp: cfg.resp },
    eu: { uid: quem.uid, funcId: f ? f.id : '', nome: f ? s(f.nome) : s(quem.nome), sit: sit ? { k: sit.k, txt: sit.txt, motivos: sit.motivos, tipos: sit.a && sit.a.tipos || [], cidade: sit.a && sit.a.cidade || '' } : null, cidades: cs, gestor: gere, admin: !!quem.admin, frotaTodos: !!quem.frotaTodos, todas: !!quem.todas, cidade: cidadeMinha },
    veics: vsVer.map(veicMin), minhaRes, minhasSai, resGerir, saiGerir, cond, agora: X.agora };
}

module.exports = { num, norm, placaN, digitos, dt, dtOk, dataOk, maisDias, br, brDt, mascCpf, TIPOS, CURSOS, FOTOS, COMB4, COMB8, CK_PAD, RES_ST, ALERTAS, COLS, cfgPad, combOpts, combNome, fracN,
  respDe, cidadesDe, escopo, ehResp, cidadeDe, tipoDe, tipoNome, combAceita, veicSit, kmUlt, catOk, precisaTox, temCnh, afastado, autDe, autVirtual, autSit, autVenceEm, tiposMig, podeDirigir, autValida,
  conflito, podeAprovar, reservar, decidir, saida, retorno, condutorNa, reciboDoc, lerRelatorio, mapaColunas, importar, checar, consumoVeic, kmAbas, corrigirHod, fatura, painel, modelo, gestor, saidaAberta };

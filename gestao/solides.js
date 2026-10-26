'use strict';
/* Integração com o Sólides DP (antigo Tangerino) — ponto oficial
   Recebe: marcações de ponto (consulta incremental por lastUpdate), gravadas na coleção pmmes
           (um documento por funcionário e mês), que o sistema já usa no espelho, banco de horas e obras.
   Envia:  obras como locais de trabalho, funcionários e ajustes (férias e afastamentos).
   O token fica só no ambiente da VPS (SOLIDES_TOKEN) e nunca é enviado ao navegador.
   Os nomes de campos da Sólides seguem a documentação pública; a leitura é tolerante a variações
   e o modo de teste (/api/solides/testar) mostra a resposta bruta para conferir na primeira ligação. */
const TOKEN = (process.env.SOLIDES_TOKEN || '').trim();
const PUNCH = (process.env.SOLIDES_PUNCH_URL || 'https://api.tangerino.com.br/api/punch').replace(/\/$/, '');
const EMPLOYER = (process.env.SOLIDES_EMPLOYER_URL || 'https://employer.tangerino.com.br').replace(/\/$/, '');
const PUNCHES = (process.env.SOLIDES_PUNCHES_URL || 'https://apis.tangerino.com.br').replace(/\/$/, '');
const INTERVALO = Math.max(5, +process.env.SOLIDES_INTERVALO_MIN || 15);
const DIAS_INI = Math.min(120, Math.max(1, +process.env.SOLIDES_DIAS_INICIAIS || 35));
const TZ = process.env.SOLIDES_TZ || 'America/Sao_Paulo';
const TZ_SOL = process.env.SOLIDES_TIMEZONE || 'SAO_PAULO';

module.exports = function (ctx) {
  const { q, db, avisarDoc, json, lerJson, NIV } = ctx;
  const cfgGet = db.prepare('SELECT v FROM cfg WHERE k=?'), cfgPut = db.prepare('INSERT INTO cfg(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
  const est = () => { try { const r = cfgGet.get('solides'); return r ? JSON.parse(r.v) : {}; } catch (e) { return {}; } };
  const salvaEst = o => cfgPut.run('solides', JSON.stringify(o));
  const docGet = p => { const r = q.docGet.get(p); return r ? JSON.parse(r.data) : null; };
  const docPut = (p, data) => { const seg = p.split('/'), ts = Date.now(); q.docPut.run(p, seg.slice(0, -1).join('/'), seg[seg.length - 1], JSON.stringify(data), ts); avisarDoc('set', p, data, ts); };
  const col = c => q.colGet.all(c).map(r => Object.assign({ id: r.id }, JSON.parse(r.data))).filter(r => !r._del);
  const dig = s => String(s == null ? '' : s).replace(/\D/g, '');
  const ms = d => d ? new Date(String(d).slice(0, 10) + 'T12:00:00-03:00').getTime() : undefined;
  const fmtLocal = t => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)); const g = k => (p.find(x => x.type === k) || {}).value; return { data: g('year') + '-' + g('month') + '-' + g('day'), hora: g('hour') + ':' + g('minute') }; };

  /* ---------- chamada à API da Sólides ---------- */
  async function sol(base, caminho, op) {
    if (!TOKEN) throw { st: 503, msg: 'Token da Sólides não configurado (SOLIDES_TOKEN no .env da VPS).' };
    op = op || {}; const u = new URL(base + caminho);
    Object.entries(op.query || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v)); });
    const auth = /^(basic|bearer)\s/i.test(TOKEN) ? TOKEN : 'Basic ' + TOKEN;
    let r;
    try { r = await fetch(u, { method: op.method || 'GET', headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' }, body: op.body ? JSON.stringify(op.body) : undefined, signal: AbortSignal.timeout(60000) }); }
    catch (e) { throw { st: 502, msg: 'A Sólides não respondeu (' + (e.message || e) + ').' }; }
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = { texto: t.slice(0, 2000) }; }
    if (!r.ok) throw { st: r.status === 401 || r.status === 403 ? 401 : 502, msg: 'Sólides respondeu ' + r.status + (r.status === 401 || r.status === 403 ? ' (token inválido ou sem permissão)' : '') + ': ' + String((j && (j.message || j.error || j.texto)) || '').slice(0, 300), bruto: j };
    return j;
  }
  /* endereço da lista de marcações: a Sólides publica o módulo de ponto em /api/punch; o caminho exato varia
     (com ou sem barra, versão). Testa os candidatos, lê a especificação (Swagger) do próprio módulo se preciso
     e guarda o que funcionou. */
  async function punchUrl() {
    const e = est(); if (e.punchUrl) return e.punchUrl;
    const cand = [PUNCH + '/', PUNCH, PUNCH + '/punch', PUNCH + '/v1/', PUNCH + '/punches'];
    try {
      const origem = new URL(PUNCH).origin;
      for (const docs of ['/v2/api-docs', '/v3/api-docs']) {
        const r = await fetch(PUNCH + docs, { headers: { Accept: 'application/json', Authorization: /^(basic|bearer)\s/i.test(TOKEN) ? TOKEN : 'Basic ' + TOKEN }, signal: AbortSignal.timeout(20000) }).catch(() => null);
        if (!r || !r.ok) continue; const j = await r.json().catch(() => null); if (!j || !j.paths) continue;
        const base = (j.basePath || (j.servers && j.servers[0] && new URL(j.servers[0].url, origem).pathname) || '').replace(/\/$/, '');
        for (const [cam, ops] of Object.entries(j.paths)) { const g = ops && ops.get; if (!g) continue; const ps = (g.parameters || []).map(x => x && x.name);
          if (ps.includes('lastUpdate') || (ps.includes('startDate') && ps.includes('endDate') && !/observation|historical|report/i.test(cam))) cand.unshift(origem + base + cam); }
        break;
      }
    } catch (x) { }
    const desde = Date.now() - 864e5, vistos = new Set(); let ult = null;
    for (const c of cand) { if (vistos.has(c)) continue; vistos.add(c);
      try { await sol(c, '', { query: { startDate: desde, endDate: Date.now(), page: 0, size: 1 } }); const e2 = est(); e2.punchUrl = c; salvaEst(e2); return c; }
      catch (er) { ult = er; if (!/ 404|405/.test(String(er.msg || ''))) throw er; } }
    throw { st: 502, msg: 'Não encontrei o endereço de marcações da Sólides (todos responderam 404). Peça à Sólides o endereço da API de marcações (punch) liberado para o seu token.' };
  }
  /* marcações por funcionário (API atual da Sólides): lista os funcionários no cadastro do empregador e busca as
     marcações de cada um em apis.tangerino.com.br/punch/v2/punches/employees/{id}. Cada marcação é um período
     com entrada (startDate) e saída (endDate) em horário local. */
  const localMs = v => { const t = String(v || ''); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return NaN; return Date.parse(t.slice(0, 19) + '-03:00'); };
  async function funcionariosSolides(comDemitidos) { return await todas(EMPLOYER, '/employee/find-all', comDemitidos ? { showFired: 1 } : {}, 30); }
  async function marcacoesDe(empId, ini, fim) { const r = await sol(PUNCHES, '/punch/v2/punches/employees/' + encodeURIComponent(empId), { query: { startDate: Math.round(ini), endDate: Math.round(fim) } }); return Array.isArray(r) ? r : lista(r); }
  async function buscarPorFuncionario(ini, fim, comDemitidos) {
    const emps = (await funcionariosSolides(comDemitidos)).filter(x => x && x.id != null && x.recordsPunch !== false);
    const out = [], fila = emps.slice(); let erro404 = 0, ok = 0;
    const trab = async () => { while (fila.length) { const x = fila.shift(); let ps;
      try { ps = await marcacoesDe(x.id, ini, fim); ok++; } catch (er) { if (/ 404/.test(String(er.msg || ''))) { erro404++; continue; } throw er; }
      const emp = { id: x.id, name: x.name || x.socialName || '', cpf: x.cpf || '', externalId: x.externalId || '' };
      for (const pz of ps) { const a = localMs(pz.startDate), b = localMs(pz.endDate);
        out.push({ id: pz.id, dateIn: isNaN(a) ? undefined : a, dateOut: isNaN(b) ? undefined : b, employee: emp, deleted: !!pz.canceled }); } } };
    await Promise.all([trab(), trab(), trab(), trab()]);
    if (!ok && erro404) throw { st: 502, msg: 'Sólides respondeu 404 nas marcações por funcionário.' };
    return out;
  }
  const lista = r => Array.isArray(r) ? r : (r && (r.content || r.data || r.items || r.list || r.punches || r.result || r.records)) || [];
  async function todas(base, caminho, query, max) {
    const out = []; let page = 0, tot = 1;
    while (page < tot && page < (max || 200)) {
      const r = await sol(base, caminho, { query: Object.assign({}, query, { page, size: 100 }) });
      const l = lista(r); out.push(...l);
      tot = r && typeof r.totalPages === 'number' ? r.totalPages : (l.length >= 100 ? page + 2 : page + 1);
      page++;
    }
    return out;
  }

  /* ---------- leitura tolerante de uma marcação ---------- */
  const num = v => typeof v === 'number' ? v : (typeof v === 'string' && /^\d{10,}$/.test(v) ? +v : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? Date.parse(v) : NaN));
  function normPunch(o) {
    const e = o.employee || o.employeeDTO || o.funcionario || {}, w = o.workplace || o.workPlace || e.workplace || {};
    const tempos = [];
    ['date', 'punchDate', 'dateTime', 'datePunch', 'registerDate', 'dateInMillis', 'time', 'data'].forEach(k => { const t = num(o[k]); if (!isNaN(t) && !tempos.length) tempos.push([t, '']); });
    if (!tempos.length) { const a = num(o.dateIn), b = num(o.dateOut); if (!isNaN(a)) tempos.push([a, 'i']); if (!isNaN(b)) tempos.push([b, 'o']); }
    const st = String(o.status || o.situation || o.punchStatus || '');
    return {
      id: String(o.id != null ? o.id : (o.punchId != null ? o.punchId : '')),
      tempos, empId: String(e.id != null ? e.id : (o.employeeId != null ? o.employeeId : '')), ext: String(e.externalId || o.externalId || o.employeeExternalId || ''),
      cpf: dig(e.cpf || o.cpf || o.employeeCpf), nome: String(e.name || o.employeeName || o.name || ''),
      local: String(w.name || w.description || o.workplaceName || ''),
      excluida: o.deleted === true || o.active === false || o.excluded === true || /delet|exclu|reprov|cancel|inativ|removid/i.test(st)
    };
  }

  /* ---------- sincronização de marcações ---------- */
  let rodando = false;
  async function sincronizar(op) {
    if (rodando) return { ok: false, msg: 'Já há uma sincronização em andamento.' };
    rodando = true; const e = est(), ini = Date.now();
    try {
      let query;
      if (op && op.ini && op.fim) query = { startDate: ms(op.ini) - 12 * 3600e3, endDate: ms(op.fim) + 12 * 3600e3 };
      else if (e.lastUpdate) query = { lastUpdate: e.lastUpdate - 5 * 60e3 };
      else query = { startDate: Date.now() - DIAS_INI * 864e5, endDate: Date.now() };
      let brutos;
      const jan = query.lastUpdate ? { ini: Date.now() - 3 * 864e5, fim: Date.now() } : { ini: query.startDate, fim: query.endDate };
      try { brutos = await buscarPorFuncionario(jan.ini, jan.fim, !!(op && op.ini)); }
      catch (er) { if (!/ 404/.test(String(er.msg || ''))) throw er; brutos = await todas(await punchUrl(), '', query); }
      const funcs = col('func'), porExt = new Map(), porSol = new Map(), porCpf = new Map(), vinc = e.vinculos || {};
      funcs.forEach(f => { porExt.set(f.id, f.id); if (f.solidesId) porSol.set(String(f.solidesId), f.id); const c = dig(f.cpf); if (c.length === 11) porCpf.set(c, f.id); });
      const docs = new Map(), sem = new Map(), empDe = new Map(); let n = 0, ex = 0;
      for (const o of brutos) {
        const p = normPunch(o); if (!p.tempos.length) continue;
        const fid = (p.ext && porExt.get(p.ext)) || (p.empId && (porSol.get(p.empId) || vinc[p.empId])) || (p.cpf && porCpf.get(p.cpf)) || '';
        if (fid && p.empId) empDe.set(fid, p.empId);
        if (!fid) { const k = p.empId || p.cpf || p.nome; if (k && !sem.has(k)) sem.set(k, { solidesId: p.empId, nome: p.nome, cpf: p.cpf ? '***.' + p.cpf.slice(3, 6) + '.' + p.cpf.slice(6, 9) + '-**' : '' }); continue; }
        for (const [t, suf] of p.tempos) {
          const L = fmtLocal(t), id = 'pm_' + fid + '_' + L.data.slice(0, 7), key = (p.id || String(t)) + suf;
          if (!docs.has(id)) docs.set(id, docGet('pmmes/' + id) || { id, funcId: fid, ym: L.data.slice(0, 7), dias: {} });
          const d = docs.get(id), dia = d.dias[L.data] || (d.dias[L.data] = { m: [], dep: '', oc: '', t: {} });
          dia.p = dia.p || {};
          const antes = new Set(Object.values(dia.p)), outras = (dia.m || []).filter(h => !antes.has(h)); /* horários vindos de arquivo ficam */
          Object.keys(dia.p).forEach(k => { if (k.split('#')[0] === key) delete dia.p[k]; });
          if (p.excluida) ex++; else { dia.p[key + '#' + L.hora] = L.hora; n++; }
          if (p.local) dia.dep = p.local;
          dia.src = 'solides';
          dia.m = [...new Set(outras.concat(Object.values(dia.p)))].sort();
        }
      }
      /* totais fechados pela Sólides no mês (trabalhadas, extras, faltas, atrasos e banco), para a Conferência do mês */
      const fila = [...docs.values()].filter(d => empDe.get(d.funcId)), minDe = v => typeof v === 'number' ? Math.round(v / 60000) : null;
      await Promise.all([0, 1, 2, 3].map(async () => { while (fila.length) { const d = fila.shift(); const [y, mo] = d.ym.split('-').map(Number);
        const i0 = Date.parse(d.ym + '-01T00:00:00-03:00'), f0 = Math.min(Date.now(), Date.parse(new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10) + 'T00:00:00-03:00') - 1);
        try { const r = await sol(PUNCHES, '/punch/v2/punches/employees/' + encodeURIComponent(empDe.get(d.funcId)) + '/summary', { query: { startDate: i0, endDate: f0 } });
          if (r && typeof r === 'object') d.sum = { trab: minDe(r.totalWorked), prev: minDe(r.totalExpected), ext: minDe(r.overtime), atraso: minDe(r.delays), falta: typeof r.absences === 'number' ? r.absences : null, bh: minDe(r.hoursBank), em: Date.now() }; } catch (x) { } } }));
      docs.forEach((d, id) => { d.v = Date.now(); d.imp = 'solides'; docPut('pmmes/' + id, d); });
      const novo = Object.assign(e, { lastUpdate: ini, ultimo: Date.now(), ok: true, erro: '', recebidas: n, excluidas: ex, docs: docs.size, semVinculo: [...sem.values()].slice(0, 200) });
      salvaEst(novo);
      return { ok: true, recebidas: n, excluidas: ex, dias: docs.size, semVinculo: novo.semVinculo.length };
    } catch (err) {
      const e2 = est(); e2.ultimaFalha = Date.now(); e2.ok = false; e2.erro = err.msg || String(err.message || err); if (/ 404/.test(e2.erro)) delete e2.punchUrl; salvaEst(e2);
      throw err;
    } finally { rodando = false; }
  }
  if (TOKEN) {
    setTimeout(() => sincronizar().catch(e => console.log('Sólides: ' + (e.msg || e))), 20000);
    setInterval(() => sincronizar().catch(e => console.log('Sólides: ' + (e.msg || e))), INTERVALO * 60e3);
  }

  /* ---------- envio para a Sólides ---------- */
  const projNome = p => p.codigo && p.nome && p.nome !== p.codigo ? p.codigo + ' · ' + p.nome : (p.nome || p.codigo || 'Obra');
  const idDe = r => r && (r.id != null ? r.id : (r.data && r.data.id != null ? r.data.id : (r.content && r.content.id)));
  async function enviarObras(ids) {
    const out = [];
    for (const id of ids || []) {
      const p = docGet('proj/' + id); if (!p) { out.push({ id, ok: false, erro: 'Obra não encontrada.' }); continue; }
      const end = [p.obraEnd, p.obraNum, p.obraBairro, p.obraCidade, p.obraUf].filter(Boolean).join(', ');
      const corpo = { name: projNome(p).slice(0, 100), externalId: p.id, description: end || undefined, latitude: +p.obraLat || undefined, longitude: +p.obraLng || undefined, radius: +p.obraRaio || undefined };
      try { const r = await sol(EMPLOYER, '/workplace/register', { method: 'POST', body: corpo }); const sid = idDe(r); docPut('proj/' + id, Object.assign(p, { solidesWp: sid != null ? String(sid) : (p.solidesWp || ''), solidesWpEm: Date.now() })); out.push({ id, ok: true, solidesId: sid }); }
      catch (e) { out.push({ id, ok: false, erro: e.msg || String(e) }); }
    }
    return out;
  }
  async function enviarFuncionarios(ids, padrao) {
    const out = [], e = est();
    for (const id of ids || []) {
      const f = docGet('func/' + id); if (!f) { out.push({ id, ok: false, erro: 'Funcionário não encontrado.' }); continue; }
      if (dig(f.cpf).length !== 11) { out.push({ id, nome: f.nome, ok: false, erro: 'CPF ausente ou inválido no cadastro.' }); continue; }
      const proj = f.projId ? docGet('proj/' + f.projId) : null, wp = (proj && proj.solidesWp) || (padrao && padrao.local) || '';
      const esc = f.solidesEscala || (padrao && padrao.escala) || '';
      if (!wp || !esc) { out.push({ id, nome: f.nome, ok: false, erro: !wp ? 'Sem local de trabalho: envie a obra do funcionário ou escolha um local padrão.' : 'Escolha a escala padrão.' }); continue; }
      const corpo = {
        id: f.solidesId ? +f.solidesId || f.solidesId : undefined, externalId: f.id, name: f.nome, email: f.email || undefined, phone: f.telefone || undefined,
        cpf: dig(f.cpf), pis: dig(f.pis) || undefined, ctps: f.ctpsNum || undefined, series: f.ctpsSerie || undefined,
        birthDateInMillis: ms(f.nasc), admissionDate: ms(f.admissao), effectiveDate: ms(f.admissao),
        workSchedule: { id: +esc || esc }, workplace: { id: +wp || wp }, timeZone: TZ_SOL
      };
      try { const r = await sol(EMPLOYER, '/employee/register', { method: 'POST', body: corpo }); const sid = idDe(r); docPut('func/' + id, Object.assign(f, { solidesId: sid != null ? String(sid) : (f.solidesId || ''), solidesEnvio: Date.now() })); out.push({ id, nome: f.nome, ok: true, solidesId: sid }); }
      catch (err) { out.push({ id, nome: f.nome, ok: false, erro: err.msg || String(err) }); }
    }
    e.ultimoEnvioFunc = Date.now(); salvaEst(e);
    return out;
  }
  async function enviarAjustes(itens) {
    const out = [], e = est(); e.ajEnviados = e.ajEnviados || {};
    for (const it of itens || []) {
      const f = docGet('func/' + it.funcId); if (!f) { out.push({ k: it.k, ok: false, erro: 'Funcionário não encontrado.' }); continue; }
      if (!it.motivo) { out.push({ k: it.k, ok: false, erro: 'Sem motivo da Sólides para este tipo.' }); continue; }
      const corpo = { employee: f.solidesId ? { id: +f.solidesId || f.solidesId } : { externalId: f.id }, employeeId: f.solidesId ? +f.solidesId || f.solidesId : undefined, externalId: f.solidesId ? undefined : f.id, adjustmentReason: { id: +it.motivo || it.motivo }, startDate: ms(it.ini), endDate: ms(it.fim) + 12 * 3600e3 - 60e3, status: 'APROVADO', observation: String(it.obs || '').slice(0, 250) || undefined };
      try { const r = await sol(EMPLOYER, '/adjustment/register', { method: 'POST', body: corpo }); e.ajEnviados[it.k] = { em: Date.now(), id: idDe(r) }; out.push({ k: it.k, ok: true }); }
      catch (err) { out.push({ k: it.k, ok: false, erro: err.msg || String(err) }); }
    }
    salvaEst(e); return out;
  }

  /* ---------- rotas /api/solides/* (só administradores) ---------- */
  return async function rota(p, m, req, res, conta, u) {
    if (!p.startsWith('/api/solides/')) return false;
    if (NIV[conta.nivel] < NIV.admin) { json(res, 403, { erro: 'Apenas administradores.' }); return true; }
    const r = p.slice('/api/solides/'.length);
    try {
      if (r === 'status') { const e = est(); json(res, 200, { configurado: !!TOKEN, intervaloMin: INTERVALO, ultimo: e.ultimo || 0, ok: e.ok !== false, erro: e.erro || '', ultimaFalha: e.ultimaFalha || 0, recebidas: e.recebidas || 0, semVinculo: e.semVinculo || [], vinculos: e.vinculos || {}, ajEnviados: e.ajEnviados || {}, rodando }); return true; }
      if (r === 'testar') { const x = await sol(EMPLOYER, '/workplace/find-all', { query: { page: 0, size: 3 } }); let pu = '', puErro = ''; try { const em = (await funcionariosSolides(false))[0]; if (em) { await marcacoesDe(em.id, Date.now() - 864e5, Date.now()); pu = 'ok'; } else pu = 'ok'; } catch (er) { puErro = er.msg || String(er); } json(res, 200, { ok: true, amostra: x, marcacoes: pu ? 'ok' : 'falhou', marcacoesErro: puErro }); return true; }
      if (r === 'amostra-pontos') { const em = (await funcionariosSolides(false)).slice(0, 3); let lst = []; for (const x of em) { const ps = await marcacoesDe(x.id, Date.now() - 3 * 864e5, Date.now()); lst = lst.concat(ps.slice(0, 3).map(pz => ({ id: pz.id, dateIn: localMs(pz.startDate), dateOut: localMs(pz.endDate), employee: { id: x.id, name: x.name, cpf: x.cpf || '' }, deleted: !!pz.canceled }))); } const x = { content: lst }; json(res, 200, { ok: true, amostra: x, lidas: lista(x).map(normPunch) }); return true; }
      if (r === 'sincronizar' && m === 'POST') { const b = await lerJson(req); json(res, 200, await sincronizar(b && b.ini && b.fim ? { ini: b.ini, fim: b.fim } : null)); return true; }
      if (r === 'locais') { const l = await todas(EMPLOYER, '/workplace/find-all', {}, 20); json(res, 200, l.map(x => ({ id: String(x.id), nome: x.name || x.description || '', externalId: x.externalId || '' }))); return true; }
      if (r === 'escalas') { const l = await todas(EMPLOYER, '/work-schedule', {}, 20); json(res, 200, l.map(x => ({ id: String(x.id), nome: x.name || x.description || ('Escala ' + x.id) }))); return true; }
      if (r === 'motivos') { const l = await todas(EMPLOYER, '/adjustment-reason/find-all', {}, 20); json(res, 200, l.map(x => ({ id: String(x.id), nome: x.name || x.description || ('Motivo ' + x.id) }))); return true; }
      if (r === 'vincular' && m === 'POST') { const b = await lerJson(req), e = est(); e.vinculos = Object.assign({}, e.vinculos || {}); Object.entries(b.vinculos || {}).forEach(([k, v]) => { if (v) e.vinculos[String(k)] = String(v); else delete e.vinculos[String(k)]; }); salvaEst(e); json(res, 200, { ok: true }); return true; }
      if (r === 'enviar-obras' && m === 'POST') { const b = await lerJson(req); json(res, 200, { itens: await enviarObras((b.ids || []).slice(0, 300)) }); return true; }
      if (r === 'enviar-funcionarios' && m === 'POST') { const b = await lerJson(req); json(res, 200, { itens: await enviarFuncionarios((b.ids || []).slice(0, 500), b.padrao || {}) }); return true; }
      if (r === 'enviar-ajustes' && m === 'POST') { const b = await lerJson(req); json(res, 200, { itens: await enviarAjustes((b.itens || []).slice(0, 500)) }); return true; }
      json(res, 404, { erro: 'Rota da Sólides não encontrada.' }); return true;
    } catch (e) { json(res, e.st || 500, { erro: e.msg || String(e.message || e), bruto: e.bruto }); return true; }
  };
};

'use strict';
/* Adaptador do controlador Intelbras CT 3000 (API HTTP, CGI com autenticação digest).
   Só monta os pedidos: endereços e nomes de campo vêm de mapa-ct3000.js (ajuste lá para o firmware do aparelho).
   VALIDAR COM O APARELHO REAL antes de usar em produção (veja o README).
   Funções: info(), aplicar(mudanças, cache, completo), abrir(porta), eventos(cursor). */
const crypto = require('node:crypto');
const MAPA = require('./mapa-ct3000.js');
const md5 = t => crypto.createHash('md5').update(t, 'utf8').digest('hex');
const pad = n => String(n).padStart(2, '0');
const enc = v => encodeURIComponent(v).replace(/'/g, '%27'); /* igual ao que o fetch manda (a autenticação digest confere o endereço exato) */

/* "a=1\r\nb.c=2" → { a: '1', 'b.c': '2' } (respostas de config e de busca de registros) */
function kv(t) { const o = {}; String(t || '').split(/\r?\n/).forEach(l => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }); return o; }
/* registros "records[0].Campo=valor" → [{ Campo: valor }] */
function registros(t) { const o = kv(t), out = []; for (const [k, v] of Object.entries(o)) { const m = k.match(/^records\[(\d+)\]\.(\w+)$/); if (m) (out[+m[1]] = out[+m[1]] || {})[m[2]] = v; } return out.filter(Boolean); }
const fmtData = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
/* 'AAAA-MM-DDTHH:MM' (hora de Brasília, do servidor) → 'AAAA-MM-DD HH:MM:00' (o controlador trabalha na hora local) */
const dataLocal = s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) + ' ' + String(s).slice(11, 16) + ':00' : '';

module.exports = function criar(o) {
  const mapa = o.mapa || MAPA, base = String(o.url || '').replace(/\/+$/, ''), fetchF = o.fetch || ((...a) => fetch(...a)), TO = o.timeoutMs || 8000;
  let dig = null, nc = 0;
  function cabDigest(metodo, uri) {
    if (!dig) return null; nc++;
    const ha1 = md5(o.usuario + ':' + dig.realm + ':' + o.senha), ha2 = md5(metodo + ':' + uri), cn = crypto.randomBytes(8).toString('hex'), ncs = nc.toString(16).padStart(8, '0');
    const resp = dig.qop ? md5(ha1 + ':' + dig.nonce + ':' + ncs + ':' + cn + ':auth:' + ha2) : md5(ha1 + ':' + dig.nonce + ':' + ha2);
    return 'Digest username="' + o.usuario + '", realm="' + dig.realm + '", nonce="' + dig.nonce + '", uri="' + uri + '", response="' + resp + '"' + (dig.opaque ? ', opaque="' + dig.opaque + '"' : '') + (dig.qop ? ', qop=auth, nc=' + ncs + ', cnonce="' + cn + '"' : '') + ', algorithm=MD5';
  }
  async function http(metodo, uri, corpo) {
    for (let tent = 0; tent < 2; tent++) {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), TO), h = {};
      const a = cabDigest(metodo, uri); if (a) h.authorization = a; if (corpo !== undefined) h['content-type'] = 'application/json';
      let r; try { r = await fetchF(base + uri, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: ctl.signal }); } finally { clearTimeout(to); }
      if (r.status === 401) {
        const w = String(r.headers.get('www-authenticate') || ''); await r.text().catch(() => '');
        if (!/^Digest/i.test(w) || tent) throw new Error('Usuário ou senha do controlador recusados (401).');
        const g = k => { const m = w.match(new RegExp(k + '="?([^",]+)"?', 'i')); return m ? m[1] : ''; };
        dig = { realm: g('realm'), nonce: g('nonce'), opaque: g('opaque'), qop: /qop="?[^"]*auth/i.test(w) }; nc = 0; continue;
      }
      const t = await r.text();
      if (r.status >= 400) throw new Error('Controlador respondeu HTTP ' + r.status + ': ' + t.slice(0, 120));
      return t;
    }
    throw new Error('Falha de autenticação no controlador.');
  }
  const json = t => { try { return JSON.parse(t); } catch (e) { return null; } };
  const ok = t => /^\s*OK\s*$/i.test(t) || (json(t) !== null);
  const sub = (s, o2) => String(s).replace(/\{(\w+)\}/g, (_, k) => enc(o2[k] == null ? '' : o2[k]));
  const qsLista = (nome, l) => l.map((v, i) => nome + '[' + i + ']=' + enc(v)).join('&');
  const setConfig = async (caminho, pares) => { const q = pares.map(([k, v]) => enc(k).replace(/%5B/g, '[').replace(/%5D/g, ']') + '=' + enc(v)).join('&'); const t = await http('GET', caminho + '&' + q); if (!ok(t)) throw new Error('setConfig recusado: ' + t.slice(0, 80)); };

  async function info() { const t = await http('GET', mapa.info.caminho); return kv(t); }

  /* -------- usuários e cartões -------- */
  const U = mapa.usuario, Cc = mapa.cartao;
  function usuarioDe(c) {
    const f = U.campos, v = U.valores, o2 = {};
    o2[f.id] = String(c.usuario); o2[f.nome] = String(c.nome || '').slice(0, 30); o2[f.tipo] = v.tipoNormal; o2[f.status] = v.statusAtivo; o2[f.autoridade] = v.autoridadeUsuario;
    o2[f.portas] = c.regras.map(r => r.porta - 1 + mapa.portaBase); o2[f.horarios] = c.regras.map(r => r.h);
    o2[f.inicio] = dataLocal(c.de) || '2020-01-01 00:00:00'; o2[f.fim] = dataLocal(c.ate) || v.fimPadrao;
    return o2;
  }
  async function gravarUsuario(c) {
    const corpo = {}; corpo[U.atualizar.lista] = [usuarioDe(c)];
    let t = null; try { t = await http(U.atualizar.metodo, U.atualizar.caminho, corpo); } catch (e) { t = null; }
    if (!t || !ok(t)) { const t2 = await http(U.inserir.metodo, U.inserir.caminho, corpo); if (!ok(t2)) throw new Error('usuário ' + c.usuario + ' recusado'); }
    const cc = {}; const card = {}; card[Cc.campos.usuario] = String(c.usuario); card[Cc.campos.numero] = c.uid; card[Cc.campos.tipo] = Cc.valores.tipoNormal; card[Cc.campos.status] = Cc.valores.statusAtivo; cc[Cc.inserir.lista] = [card];
    try { await http(Cc.inserir.metodo, Cc.inserir.caminho, cc); } catch (e) { if (!/exist|409|duplic/i.test(e.message)) throw e; }
  }
  async function removerUsuario(usuario, uid) {
    if (uid) { try { await http(Cc.remover.metodo, Cc.remover.caminho + '&' + qsLista(Cc.remover.param, [uid])); } catch (e) { } }
    if (usuario) await http(U.remover.metodo, U.remover.caminho + '&' + qsLista(U.remover.param, [String(usuario)]));
  }
  async function listarUsuarios() {
    const t = json(await http(U.buscarInicio.metodo, U.buscarInicio.caminho)) || {}, tok = t[U.buscarInicio.token], tot = +t[U.buscarInicio.total] || 0, out = [];
    try { for (let de = 0; de < tot; de += 100) { const r = json(await http(U.buscar.metodo, sub(U.buscar.caminho, { token: tok, de, n: 100 }))) || {}; (r[U.buscar.lista] || []).forEach(u => out.push(String(u[U.campos.id]))); } }
    finally { try { await http(U.buscarFim.metodo, sub(U.buscarFim.caminho, { token: tok })); } catch (e) { } }
    return out;
  }

  /* -------- horários, feriados, portas -------- */
  const hh = h => h === '24:00' ? '23:59:59' : h + ':00';
  async function gravarHorario(h) {
    const H = mapa.horario, ch = H.chave.replace('{idx}', h.idx), pares = [[ch + '.' + H.ativo, 'true'], [ch + '.' + H.nome, String(h.nome || '').slice(0, 30)]], porDia = {};
    for (const f of h.faixas) for (const d of f.dias) (porDia[H.diaDoSistema(d)] = porDia[H.diaDoSistema(d)] || []).push(f);
    const err = [];
    for (let d = 0; d <= 7; d++) {
      const l = d === H.diaFeriado ? (h.feriados === 'libera' ? [{ ini: '00:00', fim: '24:00' }] : []) : (porDia[d] || []);
      if (l.length > H.faixasPorDia) err.push('horário ' + h.idx + ': mais de ' + H.faixasPorDia + ' faixas no dia ' + d + ' (o controlador guarda só as ' + H.faixasPorDia + ' primeiras)');
      for (let n = 0; n < H.faixasPorDia; n++) { const f = l[n]; pares.push([ch + '.' + H.faixa.replace('{dia}', d).replace('{n}', n), f ? '1 ' + hh(f.ini) + '-' + hh(f.fim) : '0 00:00:00-00:00:00']); }
    }
    await setConfig(H.caminho, pares); return err;
  }
  async function desligarHorario(idx) { const H = mapa.horario; await setConfig(H.caminho, [[H.chave.replace('{idx}', idx) + '.' + H.ativo, 'false']]); }
  async function gravarFeriados(l) { const F = mapa.feriados, pares = []; for (let n = 0; n < F.maximo; n++) pares.push([F.chave + '.' + F.dia.replace('{n}', n), l[n] || '']); await setConfig(F.caminho, pares); }
  async function gravarPorta(p) { const P = mapa.porta, ch = P.chave.replace('{i}', p.porta - 1 + mapa.portaBase); await setConfig(P.config, [[ch + '.' + P.nome, String(p.nome || '').slice(0, 30)], [ch + '.' + P.tempoAberta, String(p.abertaSeg || 60)]]); }
  async function abrir(porta) { const A = mapa.porta.abrir, t = await http(A.metodo, sub(A.caminho, { canal: +porta })); if (!ok(t)) throw new Error('abertura recusada: ' + t.slice(0, 80)); return true; }

  /* aplica as mudanças de um controlador. cache = { uid: usuario } do que já está no aparelho (a ponte guarda).
     Devolve { erros: [] } (cada falha) — o que falhou é tentado de novo na próxima sincronização. */
  async function aplicar(m, cache, completo) {
    const erros = [], tenta = async (o2, fn) => { try { const e = await fn(); if (Array.isArray(e)) erros.push(...e); } catch (e) { erros.push(o2 + ': ' + e.message); } };
    for (const p of m.portas || []) await tenta('porta ' + p.porta, () => gravarPorta(p));
    for (const h of m.horarios || []) await tenta('horário ' + h.idx, () => gravarHorario(h));
    if (m.feriados) await tenta('feriados', () => gravarFeriados(m.feriados));
    for (const uid of (m.removidos && m.removidos.cartoes) || []) await tenta('remover ' + uid, async () => { await removerUsuario(cache[uid], uid); delete cache[uid]; });
    for (const c of m.cartoes || []) await tenta('cartão ' + c.uid, async () => { if (cache[c.uid] && cache[c.uid] !== c.usuario) await removerUsuario(cache[c.uid], ''); await gravarUsuario(c); cache[c.uid] = c.usuario; });
    for (const i of (m.removidos && m.removidos.horarios) || []) await tenta('desligar horário ' + i, () => desligarHorario(i));
    if (completo) await tenta('conferência', async () => { const quer = new Set((m.cartoes || []).map(c => String(c.usuario))); for (const u of await listarUsuarios()) if (!quer.has(u)) { await removerUsuario(u, Object.keys(cache).find(k => cache[k] === u) || ''); Object.keys(cache).forEach(k => { if (cache[k] === u) delete cache[k]; }); } });
    return { erros };
  }

  /* registros novos desde o cursor { c: último RecNo de acesso, a: de alarme, t: segundos } → eventos para o servidor */
  async function eventos(cur) {
    cur = Object.assign({ c: 0, a: 0, t: 0 }, cur || {});
    const E = mapa.eventos, agora = Math.floor(Date.now() / 1000), ini = cur.t ? cur.t - 120 : agora - 86400, out = [];
    const busca = async (q, chave) => {
      const regs = registros(await http('GET', sub(q.caminho, { ini, fim: agora + 60, n: E.lote })));
      if (regs.length >= E.lote) cheio = Math.min(cheio, Math.max(...regs.map(r => +r[q.campos.hora] || 0))); /* lote cheio: a próxima busca continua daí */
      let ult = cur[chave];
      for (const r of regs) {
        const rn = +r[q.campos.recno] || 0; if (rn <= cur[chave]) continue; ult = Math.max(ult, rn);
        const hora = (+r[q.campos.hora] || agora) * 1000, porta = (+r[q.campos.porta] || 0) - mapa.portaBase + 1;
        if (chave === 'c') { const okk = String(r[q.campos.ok]) === '1'; out.push({ id: 'c:' + rn + ':' + r[q.campos.hora], ts: hora, porta, uid: String(r[q.campos.cartao] || ''), res: E.metodos[r[q.campos.metodo]] === 'botao' ? 'saida' : okk ? 'liberado' : 'negado', metodo: E.metodos[r[q.campos.metodo]] || 'cartao', motivo: okk ? '' : (E.erros[r[q.campos.erro]] || ''), tipo: 'acesso' }); }
        else out.push({ id: 'a:' + rn + ':' + r[q.campos.hora], ts: hora, porta, res: E.alarmes2[r[q.campos.evento]] || 'violacao', tipo: 'alarme', motivo: String(r[q.campos.evento] || '') });
      }
      cur[chave] = ult;
    };
    let cheio = Infinity;
    await busca(E.acessos, 'c'); await busca(E.alarmes, 'a'); cur.t = cheio < Infinity ? cheio : agora;
    return { eventos: out, cursor: cur };
  }
  return { info, aplicar, abrir, eventos, listarUsuarios, _http: http };
};
module.exports.kv = kv; module.exports.registros = registros; module.exports.fmtData = fmtData;

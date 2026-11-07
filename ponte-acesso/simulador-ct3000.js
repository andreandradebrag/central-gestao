#!/usr/bin/env node
'use strict';
/* Simulador do controlador Intelbras CT 3000, para os testes e para uma demonstração sem aparelho.
   Implementa a MESMA API do mapa (adaptadores/mapa-ct3000.js), com autenticação digest, e decide o acesso como um
   controlador faria (sozinho, sem internet): cartão cadastrado, validade, porta permitida, horário (com feriados).
   Uso: node simulador-ct3000.js --porta 8081 --usuario admin --senha admin123 --portas 4
   Comandos de teste (sem autenticação, só no simulador):
     POST /sim/passar  {"porta":1,"cartao":"04A1B2C3"}  apresenta um crachá no leitor da porta
     POST /sim/alarme  {"porta":1,"evento":"BreakIn"}   BreakIn (forçada), DoorNotClosed (aberta), ChassisIntruded (violação)
     POST /sim/botao   {"porta":1}                       botão de saída
     POST /sim/hora    {"local":"2026-11-09T10:00"}      fixa o relógio (hora local); {"local":""} volta ao relógio real
     POST /sim/offline {"on":true}                       finge que caiu (fecha as conexões da API)
     GET  /sim/estado                                    usuários, cartões, horários, feriados, portas e registros */
const http = require('node:http'), crypto = require('node:crypto');
const MAPA = require('./adaptadores/mapa-ct3000.js');

function criarSimulador(o) {
  o = Object.assign({ usuario: 'admin', senha: 'admin123', portas: 4, realm: 'CT3000-simulador' }, o || {});
  const S = { users: new Map(), cards: new Map(), cfg: {}, rec: [], alr: [], recNo: 0, alrNo: 0, offline: false, hora: '', nonces: new Set() };
  const md5 = t => crypto.createHash('md5').update(t, 'utf8').digest('hex');
  const agoraLocal = () => S.hora || new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 16);
  const epoch = () => S.hora ? Math.floor(Date.parse(S.hora + ':00-03:00') / 1000) : Math.floor(Date.now() / 1000);
  function autenticado(req) {
    const a = String(req.headers.authorization || ''); if (!/^Digest /i.test(a)) return false;
    const g = k => { const m = a.match(new RegExp('\\b' + k + '="?([^",]+)"?', 'i')); return m ? m[1] : ''; };
    if (g('username') !== o.usuario || !S.nonces.has(g('nonce'))) return false;
    const ha1 = md5(o.usuario + ':' + o.realm + ':' + o.senha), ha2 = md5(req.method + ':' + g('uri'));
    const esp = g('qop') ? md5(ha1 + ':' + g('nonce') + ':' + g('nc') + ':' + g('cnonce') + ':' + g('qop') + ':' + ha2) : md5(ha1 + ':' + g('nonce') + ':' + ha2);
    return esp === g('response') && g('uri') === req.url;
  }
  const lista = (u, nome) => { const out = []; for (const [k, v] of u.searchParams) { const m = k.match(new RegExp('^' + nome + '\\[(\\d+)\\]$')); if (m) out[+m[1]] = v; } return out.filter(x => x != null); };
  const UC = MAPA.usuario.campos, CC = MAPA.cartao.campos;
  function horarioOk(idx, local) {
    if (+idx === MAPA.usuario.valores.sempre) return true;
    const ch = MAPA.horario.chave.replace('{idx}', idx); if (String(S.cfg[ch + '.' + MAPA.horario.ativo]) !== 'true') return false;
    const data = local.slice(0, 10), fer = Object.entries(S.cfg).some(([k, v]) => k.startsWith(MAPA.feriados.chave + '.') && v === data);
    const d = fer ? MAPA.horario.diaFeriado : new Date(Date.parse(data + 'T12:00:00Z')).getUTCDay(), m = (+local.slice(11, 13)) * 60 + (+local.slice(14, 16));
    for (let n = 0; n < MAPA.horario.faixasPorDia; n++) {
      const v = String(S.cfg[ch + '.' + MAPA.horario.faixa.replace('{dia}', d).replace('{n}', n)] || ''), x = v.match(/^1 (\d\d):(\d\d):\d\d-(\d\d):(\d\d):(\d\d)$/);
      if (x && m >= (+x[1]) * 60 + (+x[2]) && m <= (+x[3]) * 60 + (+x[4]) - (x[5] === '59' ? 0 : 1)) return true;
    }
    return false;
  }
  /* decisão do controlador, com a lista que ele tem (funciona sem internet) */
  function passar(porta, cartao) {
    const card = S.cards.get(String(cartao).toUpperCase()), local = agoraLocal(), dl = local.replace('T', ' ') + ':00';
    let erro = 0; const u = card ? S.users.get(card[CC.usuario]) : null;
    if (!card || !u) erro = 16;
    else if (String(u[UC.status]) !== '0' || String(card[CC.status]) !== '0') erro = 20;
    else if ((u[UC.inicio] && dl < u[UC.inicio]) || (u[UC.fim] && dl > u[UC.fim])) erro = 18;
    else { const i = (u[UC.portas] || []).indexOf(porta - 1 + MAPA.portaBase); if (i < 0) erro = 19; else if (!horarioOk((u[UC.horarios] || [])[i], local)) erro = 17; }
    const r = { RecNo: ++S.recNo, CreateTime: epoch(), CardNo: String(cartao).toUpperCase(), UserID: u ? u[UC.id] : '', Door: porta - 1 + MAPA.portaBase, Status: erro ? 0 : 1, Method: 1, ErrorCode: erro };
    S.rec.push(r); return { liberado: !erro, erro, rec: r };
  }
  function regsTxt(l, q) {
    const ini = +q.get('StartTime') || 0, fim = +q.get('EndTime') || 9e12, n = Math.min(1000, +q.get('count') || 100);
    const sel = l.filter(r => r.CreateTime >= ini && r.CreateTime <= fim).sort((a, b) => a.RecNo - b.RecNo).slice(0, n);
    return 'totalCount=' + sel.length + '\r\nfound=' + sel.length + '\r\n' + sel.map((r, i) => Object.entries(r).map(([k, v]) => 'records[' + i + '].' + k + '=' + v).join('\r\n')).join('\r\n') + '\r\n';
  }
  const corpo = req => new Promise(r => { const b = []; req.on('data', x => b.push(x)); req.on('end', () => { try { r(JSON.parse(Buffer.concat(b).toString('utf8') || '{}')); } catch (e) { r({}); } }); });
  const env = (res, st, t, ct) => { res.writeHead(st, { 'content-type': ct || 'text/plain; charset=utf-8' }); res.end(t); };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname, a = u.searchParams.get('action');
    if (p.startsWith('/sim/')) {
      const b = req.method === 'POST' ? await corpo(req) : {};
      if (p === '/sim/passar') return env(res, 200, JSON.stringify(passar(+b.porta || 1, b.cartao || '')), 'application/json');
      if (p === '/sim/alarme') { const r = { RecNo: ++S.alrNo, CreateTime: epoch(), Door: (+b.porta || 1) - 1 + MAPA.portaBase, Event: String(b.evento || 'BreakIn') }; S.alr.push(r); return env(res, 200, JSON.stringify(r), 'application/json'); }
      if (p === '/sim/botao') { const r = { RecNo: ++S.recNo, CreateTime: epoch(), CardNo: '', UserID: '', Door: (+b.porta || 1) - 1 + MAPA.portaBase, Status: 1, Method: 5, ErrorCode: 0 }; S.rec.push(r); return env(res, 200, JSON.stringify(r), 'application/json'); }
      if (p === '/sim/hora') { S.hora = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(b.local || '')) ? b.local : ''; return env(res, 200, '{"ok":true}', 'application/json'); }
      if (p === '/sim/offline') { S.offline = !!b.on; return env(res, 200, '{"ok":true}', 'application/json'); }
      if (p === '/sim/estado') return env(res, 200, JSON.stringify({ usuarios: [...S.users.values()], cartoes: [...S.cards.values()], config: S.cfg, registros: S.rec, alarmes: S.alr, hora: agoraLocal() }), 'application/json');
      return env(res, 404, 'not found');
    }
    if (S.offline) { req.socket.destroy(); return; }
    if (!autenticado(req)) { const n = crypto.randomBytes(12).toString('hex'); S.nonces.add(n); if (S.nonces.size > 500) S.nonces.delete(S.nonces.values().next().value); res.writeHead(401, { 'www-authenticate': 'Digest realm="' + o.realm + '", qop="auth", nonce="' + n + '", opaque="' + md5(o.realm) + '"' }); return res.end('Unauthorized'); }
    try {
      if (p === '/cgi-bin/magicBox.cgi' && a === 'getSystemInfo') return env(res, 200, 'deviceType=CT3000-' + o.portas + 'PB-SIMULADOR\r\nserialNumber=SIM' + o.portas + '\r\n');
      if (p === '/cgi-bin/AccessUser.cgi') {
        if (a === 'insertMulti' || a === 'updateMulti') { const b = await corpo(req), l = b[MAPA.usuario.inserir.lista] || [];
          for (const x of l) { const id = String(x[UC.id] || ''); if (!id) return env(res, 400, 'Error\r\nBad UserID'); if (a === 'insertMulti' && S.users.has(id)) return env(res, 400, 'Error\r\nUser exists'); if (a === 'updateMulti' && !S.users.has(id)) return env(res, 400, 'Error\r\nUser not exist'); }
          l.forEach(x => S.users.set(String(x[UC.id]), Object.assign({}, x, { [UC.id]: String(x[UC.id]) }))); return env(res, 200, 'OK'); }
        if (a === 'removeMulti') { lista(u, MAPA.usuario.remover.param).forEach(id => { S.users.delete(id); for (const [k, c] of S.cards) if (c[CC.usuario] === id) S.cards.delete(k); }); return env(res, 200, 'OK'); }
        if (a === 'startFind') return env(res, 200, JSON.stringify({ Token: 7, Total: S.users.size }), 'application/json');
        if (a === 'doFind') { const de = +u.searchParams.get('Offset') || 0, n = +u.searchParams.get('Count') || 100; return env(res, 200, JSON.stringify({ Info: [...S.users.values()].slice(de, de + n) }), 'application/json'); }
        if (a === 'stopFind') return env(res, 200, 'OK');
      }
      if (p === '/cgi-bin/AccessCard.cgi') {
        if (a === 'insertMulti') { const b = await corpo(req), l = b[MAPA.cartao.inserir.lista] || []; let ex = false;
          for (const x of l) { const k = String(x[CC.numero] || '').toUpperCase(); if (!k) return env(res, 400, 'Error\r\nBad CardNo'); if (S.cards.has(k) && S.cards.get(k)[CC.usuario] === String(x[CC.usuario])) ex = true; S.cards.set(k, Object.assign({}, x, { [CC.numero]: k, [CC.usuario]: String(x[CC.usuario]) })); }
          return ex ? env(res, 400, 'Error\r\nCard exist') : env(res, 200, 'OK'); }
        if (a === 'removeMulti') { lista(u, MAPA.cartao.remover.param).forEach(k => S.cards.delete(String(k).toUpperCase())); return env(res, 200, 'OK'); }
      }
      if (p === '/cgi-bin/configManager.cgi' && a === 'setConfig') { for (const [k, v] of u.searchParams) if (k !== 'action') S.cfg[k] = v; return env(res, 200, 'OK'); }
      if (p === '/cgi-bin/configManager.cgi' && a === 'getConfig') { const nm = u.searchParams.get('name') || ''; return env(res, 200, Object.entries(S.cfg).filter(([k]) => k.startsWith(nm)).map(([k, v]) => 'table.' + k + '=' + v).join('\r\n')); }
      if (p === '/cgi-bin/accessControl.cgi' && a === 'openDoor') { const ch = +u.searchParams.get('channel') || 1; if (ch < 1 || ch > o.portas) return env(res, 400, 'Error\r\nBad channel'); S.rec.push({ RecNo: ++S.recNo, CreateTime: epoch(), CardNo: '', UserID: '', Door: ch - 1 + MAPA.portaBase, Status: 1, Method: 4, ErrorCode: 0 }); return env(res, 200, 'OK'); }
      if (p === '/cgi-bin/recordFinder.cgi' && a === 'find') { const nm = u.searchParams.get('name'); if (nm === 'AccessControlCardRec') return env(res, 200, regsTxt(S.rec, u.searchParams)); if (nm === 'AccessControlAlarmRecord') return env(res, 200, regsTxt(S.alr, u.searchParams)); }
      return env(res, 400, 'Error\r\nBad Request');
    } catch (e) { return env(res, 500, 'Error\r\n' + e.message); }
  });
  return { srv, S, passar, ouvir: (porta, host) => new Promise(r => srv.listen(porta || 0, host || '127.0.0.1', () => r(srv.address().port))), fechar: () => new Promise(r => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(() => r()); }) };
}
module.exports = criarSimulador;
if (require.main === module) {
  const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
  const s = criarSimulador({ usuario: arg('usuario') || 'admin', senha: arg('senha') || 'admin123', portas: +(arg('portas') || 4) });
  s.ouvir(+(arg('porta') || 8081), arg('host') || '127.0.0.1').then(p => console.log('Simulador CT 3000 (' + (+(arg('portas') || 4)) + ' portas) em http://' + (arg('host') || '127.0.0.1') + ':' + p + ' — usuário ' + (arg('usuario') || 'admin')));
}

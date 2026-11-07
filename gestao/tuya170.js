'use strict';
/* v170 (relatorios/feito_v170.md): adaptador da nuvem Tuya (Tuya IoT / Smart Life) no servidor.
   Cobre a fechadura Tuya do almoxarifado de São Paulo (abrir pelo sistema, senha temporária quando a fechadura aceita,
   registro de aberturas) e o relé Wi-Fi do portão de veículos de Tuiuti (NovaDigital, compatível com Tuya/Smart Life:
   pulso liga → desliga).
   Variáveis: TUYA_CLIENT_ID e TUYA_SECRET (projeto de nuvem no Tuya IoT Platform), TUYA_REGIAO (us, ueaz, eu, weaz, in, cn;
   padrão us) e, só para testes, TUYA_URL (troca o endereço da API). O id de cada aparelho fica no cadastro do sistema.
   Assinatura (Tuya OpenAPI v2, HMAC-SHA256): sign = HMAC(secret, client_id [+ access_token] + t + nonce + stringToSign),
   stringToSign = MÉTODO \n SHA256(corpo) \n \n caminho?query (query em ordem alfabética).
   Os caminhos e os códigos ficam em CAMINHOS/CODIGOS abaixo: confira com o aparelho real (categoria e "instruction set"
   no Tuya IoT Platform › Devices › Debug Device) antes de usar em produção. */
const crypto = require('node:crypto');
const REGIOES = { us: 'https://openapi.tuyaus.com', ueaz: 'https://openapi-ueaz.tuyaus.com', eu: 'https://openapi.tuyaeu.com', weaz: 'https://openapi-weaz.tuyaeu.com', in: 'https://openapi.tuyain.com', cn: 'https://openapi.tuyacn.com' };
const CAMINHOS = {
  token: '/v1.0/token?grant_type=1',
  status: id => '/v1.0/devices/' + id,
  comandos: id => '/v1.0/iot-03/devices/' + id + '/commands',
  ticket: id => '/v1.0/devices/' + id + '/door-lock/password-ticket',
  abrirSemSenha: id => '/v1.0/smart-lock/devices/' + id + '/password-free/door-operate',
  senhaTemp: id => '/v1.0/devices/' + id + '/door-lock/temp-password',
  logs: id => '/v1.0/devices/' + id + '/door-lock/open-logs'
};
/* códigos de status das aberturas (fechadura "ms"): o que cada um vira no registro de acessos */
const CODIGOS_ABERTURA = { unlock_fingerprint: 'digital', unlock_password: 'senha', unlock_temporary: 'senha temporária', unlock_dynamic: 'senha dinâmica', unlock_card: 'cartão', unlock_key: 'chave', unlock_app: 'aplicativo', unlock_ble: 'bluetooth', unlock_remote: 'remoto', remote_no_pd_setkey: 'remoto', remote_no_dp_key: 'remoto', unlock_face: 'face', door_opened: 'porta aberta', hijack: 'alarme de coação', alarm_lock: 'alarme' };

module.exports = function (o) {
  o = o || {};
  const env = o.env || process.env, fetchF = o.fetch || ((...a) => fetch(...a));
  const cfgEnv = () => ({ id: String(env.TUYA_CLIENT_ID || ''), seg: String(env.TUYA_SECRET || ''), base: String(env.TUYA_URL || REGIOES[String(env.TUYA_REGIAO || 'us').toLowerCase()] || REGIOES.us).replace(/\/+$/, '') });
  const configurado = () => { const c = cfgEnv(); return !!(c.id && c.seg); };
  let tok = null;
  const sha256 = t => crypto.createHash('sha256').update(t || '', 'utf8').digest('hex');
  function caminhoOrdenado(p) { const [a, qs] = p.split('?'); if (!qs) return a; return a + '?' + qs.split('&').filter(Boolean).sort().join('&'); }
  function assinar(c, metodo, caminho, corpo, accessToken, t, nonce) {
    const str = metodo + '\n' + sha256(corpo) + '\n\n' + caminhoOrdenado(caminho);
    return crypto.createHmac('sha256', c.seg).update(c.id + (accessToken || '') + t + nonce + str, 'utf8').digest('hex').toUpperCase();
  }
  async function chamar(metodo, caminho, corpo, semToken) {
    const c = cfgEnv(); if (!c.id || !c.seg) throw new Error('Nuvem Tuya não configurada (TUYA_CLIENT_ID e TUYA_SECRET).');
    const at = semToken ? '' : await token(), t = String(Date.now()), nonce = crypto.randomBytes(8).toString('hex'), b = corpo === undefined ? '' : JSON.stringify(corpo);
    const h = { client_id: c.id, t, nonce, sign_method: 'HMAC-SHA256', sign: assinar(c, metodo, caminho, b, at, t, nonce) };
    if (at) h.access_token = at; if (b) h['content-type'] = 'application/json';
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
    let r; try { r = await fetchF(c.base + caminho, { method: metodo, headers: h, body: b || undefined, signal: ctl.signal }); } finally { clearTimeout(to); }
    let j; try { j = await r.json(); } catch (e) { throw new Error('Resposta inválida da nuvem Tuya (HTTP ' + r.status + ').'); }
    if (!j || j.success !== true) {
      if (!semToken && j && (j.code === 1010 || j.code === 1011)) { tok = null; } /* token vencido: pede outro na próxima */
      throw new Error('Nuvem Tuya recusou: ' + ((j && (j.msg || j.code)) || 'erro') + '.');
    }
    return j.result;
  }
  async function token() {
    if (tok && tok.ate > Date.now() + 60e3) return tok.v;
    const r = await chamar('GET', CAMINHOS.token, undefined, true);
    tok = { v: String(r.access_token), ate: Date.now() + (+r.expire_time || 3600) * 1000 }; return tok.v;
  }
  const idOk = id => /^[A-Za-z0-9_-]{6,64}$/.test(String(id || ''));
  const conf = id => { if (!idOk(id)) throw new Error('Id do aparelho Tuya inválido.'); };
  async function status(id) { conf(id); const r = await chamar('GET', CAMINHOS.status(id)); return { online: !!(r && r.online), nome: r && r.name || '', categoria: r && r.category || '' }; }
  async function comandos(id, lista) { conf(id); return chamar('POST', CAMINHOS.comandos(id), { commands: lista }); }
  /* portão: pulso no relé (liga, espera, desliga) */
  async function pulso(id, codigo, ms) {
    const k = /^[a-z0-9_]{2,40}$/.test(String(codigo || '')) ? codigo : 'switch_1';
    await comandos(id, [{ code: k, value: true }]);
    await new Promise(r => setTimeout(r, Math.min(10000, Math.max(200, +ms || 1000))));
    await comandos(id, [{ code: k, value: false }]);
    return { ok: true };
  }
  /* fechadura: abrir sem senha (ticket + door-operate) */
  async function desbloquear(id) {
    conf(id); const tk = await chamar('POST', CAMINHOS.ticket(id), {});
    await chamar('POST', CAMINHOS.abrirSemSenha(id), { ticket_id: tk.ticket_id, open: true });
    return { ok: true };
  }
  /* senha temporária (quando a fechadura aceita): a chave do ticket vem cifrada com o segredo (AES-256-ECB) e a senha vai
     cifrada com a chave do ticket (AES-128-ECB), em hexadecimal maiúsculo */
  function cifraSenha(senha, ticketKey) {
    const seg = Buffer.from(cfgEnv().seg, 'utf8'), k32 = Buffer.concat([seg, Buffer.alloc(32)]).subarray(0, 32);
    const d = crypto.createDecipheriv('aes-256-ecb', k32, null); const chave = Buffer.concat([d.update(Buffer.from(String(ticketKey), 'hex')), d.final()]).subarray(0, 16);
    const c = crypto.createCipheriv('aes-128-ecb', chave, null); return Buffer.concat([c.update(Buffer.from(String(senha), 'utf8')), c.final()]).toString('hex').toUpperCase();
  }
  async function senhaTemp(id, o2) {
    conf(id); const senha = String(o2.senha || ''); if (!/^\d{6,10}$/.test(senha)) throw new Error('A senha temporária tem de 6 a 10 dígitos.');
    const tk = await chamar('POST', CAMINHOS.ticket(id), {});
    const r = await chamar('POST', CAMINHOS.senhaTemp(id), { name: String(o2.nome || 'Visitante').slice(0, 20), password: cifraSenha(senha, tk.ticket_key), password_type: 'ticket', ticket_id: tk.ticket_id, effective_time: Math.floor(o2.de / 1000), invalid_time: Math.floor(o2.ate / 1000) });
    return { ok: true, id: r && (r.id || r.password_id) || '' };
  }
  /* registro de aberturas da fechadura (página a página); devolve [{id, ts, tipo, quem}] */
  async function logs(id, de, ate) {
    conf(id); const out = [];
    for (let pg = 1; pg <= 5; pg++) {
      const r = await chamar('GET', CAMINHOS.logs(id) + '?end_time=' + Math.floor(ate) + '&page_no=' + pg + '&page_size=50&start_time=' + Math.floor(de));
      const ls = (r && (r.logs || r.list)) || [];
      for (const l of ls) {
        const st = Array.isArray(l.status) ? l.status[0] : l.status || {}, ts = +l.update_time || +l.time || 0;
        out.push({ id: 'tuya:' + id + ':' + ts + ':' + String(st.code || '') + ':' + String(st.value == null ? '' : st.value), ts: ts < 1e12 ? ts * 1000 : ts, codigo: String(st.code || ''), tipo: CODIGOS_ABERTURA[st.code] || String(st.code || 'abertura'), quem: String(l.nick_name || l.user_name || '') });
      }
      if (ls.length < 50 || (r && r.has_more === false)) break;
    }
    return out;
  }
  return { configurado, status, comandos, pulso, desbloquear, senhaTemp, logs, assinar: (...a) => assinar(cfgEnv(), ...a), CAMINHOS, CODIGOS_ABERTURA, REGIOES };
};

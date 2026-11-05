/* v150 (relatorios/feito_v150_pedpdf.md): pedido de compra — código de verificação e aceite eletrônico do fornecedor.
   Ligado em regras.js (v150/ed_v150.py): rota interna (link de aceite), rota pública (página do aceite e verificação do código)
   e antesGravar de ped/<id> (o aceite só é gravado aqui; versões anteriores do código ficam guardadas para a verificação).
   1. Código de verificação: hash SHA-256 dos dados do pedido que vão no PDF (codigo(), igual ao ppdfCodigo da tela), 12
      caracteres (60 bits), mostrado como XXXX-XXXX-XXXX. GET /verificar/<código> mostra só nº, data, fornecedor, total e
      situação (nada de itens, preços, contatos ou negociação). Código de versão anterior do pedido: "o pedido foi alterado".
   2. Link de aceite: POST /api/ped/aceite/link (quem envia pedido ao fornecedor). Token aleatório de 192 bits; o banco guarda
      o hash (procura) e o token cifrado com a CHAVE_MESTRA (para devolver o mesmo link enquanto ele valer). Validade
      ACEITE_LINK_DIAS (padrão 30). Uso único: depois de aceito ou recusado, o link só diz que já foi respondido.
      A página pública /aceite/<token> mostra o que está no PDF (sem proposta inicial, rodadas de negociação ou dados internos)
      e os botões "Aceito o pedido" e "Não posso atender" (com motivo). Registra nome digitado, quando e IP (o IP fica só na
      tabela do link e na auditoria; o pedido guarda nome, data e o código da versão aceita), avisa no chat quem fez o pedido
      e quem enviou o link (conversa "Central de Gestão").
   3. Rotas públicas com limite por IP (e atraso nas tentativas erradas). */
'use strict';
const crypto = require('node:crypto');

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const n4 = v => String(Math.round((+v || 0) * 10000) / 10000);
const s1 = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
function canon(p) {
  return ['ped1', s1(p.id), s1(p.numero), s1(p.data), s1(p.parcId), s1(p.previsao), s1(p.necessidade), n4(p.frete), n4(p.descGeral), s1(p.formaPgto), s1(p.condPgto), s1(p.modFrete), s1(p.localEntrega)]
    .concat((Array.isArray(p.itens) ? p.itens : []).map(i => [s1(i && i.desc), s1(i && i.un), n4(i && i.qtd), n4(i && i.vUnit), n4(i && i.pDesc), n4(i && i.pIpi), n4(i && i.vSt)].join('~'))).join('|');
}
function codigo(p) {
  const h = crypto.createHash('sha256').update(canon(p), 'utf8').digest();
  let bits = 0, val = 0, out = '';
  for (let i = 0; i < 8 && out.length < 12; i++) { val = (val << 8) | h[i]; bits += 8; while (bits >= 5 && out.length < 12) { out += B32[(val >> (bits - 5)) & 31]; bits -= 5; val &= (1 << bits) - 1; } }
  return out;
}
const fmtCod = c => c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8, 12);
const limpaCod = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const r2 = v => Math.round((+v || 0) * 100) / 100;
const itBruto = i => (+i.qtd || 0) * (+i.vUnit || 0), itDesc = i => r2(itBruto(i) * Math.min(100, Math.max(0, +i.pDesc || 0)) / 100), itBase = i => r2(itBruto(i) - itDesc(i)), itIpi = i => r2(itBase(i) * (+i.pIpi || 0) / 100), itTot = i => r2(itBase(i) + itIpi(i) + (+i.vSt || 0));
const totais = p => { const it = Array.isArray(p.itens) ? p.itens : [], sm = f => r2(it.reduce((s, i) => s + f(i || {}), 0)); const t = { produtos: sm(itBruto), desc: sm(itDesc), ipi: sm(itIpi), st: sm(i => +i.vSt || 0), frete: r2(p.frete), descGeral: r2(p.descGeral) }; t.total = r2(sm(itTot) + t.frete - t.descGeral); return t; };
const ST = { aberto: 'Aberto', enviado: 'Enviado', recebido: 'Recebido', cancelado: 'Cancelado' };
const MODF = { CIF: 'CIF: frete por conta do fornecedor', FOB: 'FOB: frete por nossa conta', TER: 'Por conta de terceiros', SEM: 'Sem frete (retiramos)' };
const br = d => /^\d{4}-\d{2}-\d{2}/.test(String(d || '')) ? String(d).slice(8, 10) + '/' + String(d).slice(5, 7) + '/' + String(d).slice(0, 4) : '';
const dt = t => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

module.exports = function (X) {
  const { db, q, doc, salvar, erro, ehDono, gravaCol, pode, perfilPermite, gravacaoPermitida, cfgEmp, ipDe, json, html, pag, lerJson, lerCorpo, APP_URL, SEG, avisarDoc, auditar } = X;
  const DIAS = () => Math.min(365, Math.max(1, +process.env.ACEITE_LINK_DIAS || 30));
  /* v157: o servidor confere a aprovação do pedido dentro da alçada (ajuste157.js) antes de gerar o link, mostrar o pedido e aceitar */
  const aprovOk = p => { try { return X.pedAprovado ? X.pedAprovado(p) : { ok: true }; } catch (e) { return { ok: false, motivo: 'Não foi possível conferir a aprovação do pedido.' }; } };
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ped_aceite(hash TEXT PRIMARY KEY, ped TEXT, tok TEXT, criado INTEGER, expira INTEGER, por TEXT, usado INTEGER, revogado INTEGER, ip TEXT, acao TEXT, n INTEGER DEFAULT 0);' +
      'CREATE INDEX IF NOT EXISTS ped_aceite_ped ON ped_aceite(ped);' +
      'CREATE TABLE IF NOT EXISTS ped_verif(codigo TEXT PRIMARY KEY, ped TEXT, resumo TEXT, ate INTEGER);');
  } catch (e) { console.error('[v150] tabelas:', e.message); }
  const sha = t => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/;
  const parcNome = id => { const f = id ? doc('parc/' + id) : null; return f ? String(f.nome || f.fantasia || '') : ''; };
  const resumo = p => ({ numero: String(p.numero || ''), data: br(p.data), fornecedor: parcNome(p.parcId), total: totais(p).total, situacao: ST[p.status] || 'Aberto' });
  const empresa = () => { const e = cfgEmp(); return { nome: String(e.fantasia || e.razao || 'Empresa'), razao: String(e.razao || ''), cnpj: String(e.cnpj || '') }; };

  /* ---------- limites das rotas públicas (por IP, janela de 1 hora) ---------- */
  const lim = new Map();
  setInterval(() => { const ag = Date.now(); for (const [k, v] of lim) if (ag - v.ini > 3600e3) lim.delete(k); }, 600e3).unref();
  const conta1 = (k, max) => { const ag = Date.now(); let l = lim.get(k); if (!l || ag - l.ini > 3600e3) { l = { n: 0, ini: ag }; lim.set(k, l); } l.n++; return l.n > max; };
  const errou = async (res, ip, st, msg) => { conta1('x:' + ip, 1e9); await new Promise(r => setTimeout(r, 400)); json(res, st, { erro: msg }); return true; };
  const bloqueado = ip => { const l = lim.get('x:' + ip); return !!l && Date.now() - l.ini <= 3600e3 && l.n >= 30; };

  /* ---------- código: atual (cache por versão) ou de versão anterior ---------- */
  const cache = new Map();
  function acharCodigo(c) {
    for (const r of q.colGet.all('ped')) {
      let k = cache.get(r.id); if (!k || k.ts !== r.ts) { let d; try { d = JSON.parse(r.data); } catch (e) { continue; } k = { ts: r.ts, c: codigo(Object.assign({}, d, { id: r.id })) }; cache.set(r.id, k); }
      if (k.c === c) { const d = JSON.parse(r.data); return { atual: true, p: Object.assign({}, d, { id: r.id }) }; }
    }
    const v = db.prepare('SELECT * FROM ped_verif WHERE codigo=?').get(c);
    if (v) { let rs = {}; try { rs = JSON.parse(v.resumo); } catch (e) { } return { atual: false, ate: v.ate, ped: v.ped, rs }; }
    return null;
  }

  /* ---------- antesGravar de ped/<id> ---------- */
  function antes(conta, req, velho, novo) {
    ['aceite', 'aceiteAnt'].forEach(k => { if (velho && velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; });
    if (velho) {
      try {
        const c0 = codigo(Object.assign({}, velho)), c1 = codigo(Object.assign({}, novo, { id: novo.id || velho.id }));
        if (c0 !== c1) db.prepare('INSERT OR REPLACE INTO ped_verif(codigo,ped,resumo,ate) VALUES(?,?,?,?)').run(c0, String(velho.id || novo.id || ''), JSON.stringify(resumo(velho)), Date.now());
      } catch (e) { console.error('[v150] verif:', e.message); }
    }
    return null;
  }

  /* ---------- link de aceite (rota interna) ---------- */
  const envLink = new Map();
  function podeEnviar(conta, p) { return ehDono(conta) || (pode(conta, p, 'w') && perfilPermite(conta, p, 'w') && gravacaoPermitida(conta, p) && gravaCol(conta, 'ped')); }
  function rotaLink(conta, req, b) {
    const id = String((b && b.id) || ''), p = 'ped/' + id;
    if (!ID_OK.test(id)) return erro('Pedido inválido.', 400);
    if (!podeEnviar(conta, p)) { auditar(conta, req, 'PED_ACEITE_LINK_NEGADO', p, null, null); return erro('Só quem faz pedidos de compra (Comprador) gera o link de aceite.'); }
    const d = doc(p); if (!d) return erro('Pedido não encontrado.', 404);
    if (d.status === 'cancelado') return erro('Pedido cancelado não recebe aceite.', 409);
    { const ap = aprovOk(Object.assign({}, d, { id })); if (!ap.ok) { auditar(conta, req, 'PED_ACEITE_LINK_SEM_APROVACAO', p, null, null); return erro('O link de aceite só é gerado com o pedido aprovado. ' + ap.motivo, 409); } } /* v157 */
    const cod = codigo(Object.assign({}, d, { id }));
    if (d.aceite && d.aceite.ok && d.aceite.codigo === cod) return { ok: true, ja: d.aceite, codigo: fmtCod(cod) };
    const ag = Date.now();
    const ex = db.prepare('SELECT * FROM ped_aceite WHERE ped=? AND usado IS NULL AND revogado IS NULL AND expira>? ORDER BY criado DESC LIMIT 1').get(id, ag + 864e5);
    if (ex) { const t = SEG.decifrarSegredo(ex.tok); if (t && sha(t) === ex.hash) return { ok: true, url: APP_URL + '/aceite/' + t, expira: ex.expira, codigo: fmtCod(cod), base: APP_URL }; }
    const env = (envLink.get(conta.id) || []).filter(t => ag - t < 3600e3); if (env.length >= 60) return erro('Muitos links gerados na última hora. Tente mais tarde.', 429);
    env.push(ag); envLink.set(conta.id, env);
    db.prepare('UPDATE ped_aceite SET revogado=? WHERE ped=? AND usado IS NULL AND revogado IS NULL').run(ag, id);
    const tok = crypto.randomBytes(24).toString('base64url'), exp = ag + DIAS() * 864e5;
    db.prepare('INSERT INTO ped_aceite(hash,ped,tok,criado,expira,por) VALUES(?,?,?,?,?,?)').run(sha(tok), id, SEG.cifrarSegredo(tok), ag, exp, conta.id);
    auditar(conta, req, 'PED_ACEITE_LINK', p, null, { expira: exp });
    return { ok: true, url: APP_URL + '/aceite/' + tok, expira: exp, codigo: fmtCod(cod), base: APP_URL };
  }
  async function rota(p, m, req, res, conta) {
    if (m === 'GET' && p === '/api/ped/aceite/base') { json(res, 200, { base: APP_URL, dias: DIAS() }); return true; }
    if (m === 'POST' && p === '/api/ped/aceite/link') {
      const b = await lerJson(req), r = rotaLink(conta, req, b || {});
      json(res, r.erro ? (r.st || 403) : 200, r.erro ? { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : r.st === 429 ? 'rate_limited' : 'not_granted', erro: r.erro } : r); return true;
    }
    return false;
  }

  /* ---------- aviso no chat (conversa "Central de Gestão" de cada pessoa) ---------- */
  function avisarChat(uids, texto) {
    const ag = Date.now();
    for (const u of [...new Set(uids.filter(x => x && ID_OK.test(x)))]) {
      try {
        const cid = 'av_' + u, cp = 'cm/sistema/c/' + cid;
        if (!q.docGet.get(cp)) { const cv = { id: cid, tipo: 'dm', membros: [u], ts: ag, sistema: true }; q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(cv), ag); avisarDoc('set', cp, cv, ag); }
        const mid = 'm' + ag.toString(36) + crypto.randomBytes(4).toString('hex'), mp = 'cm/sistema/m/' + mid;
        const msg = { id: mid, k: 'msg', conv: 'sistema/' + cid, txt: '🔔 ' + texto, ts: ag, men: [], sistema: true };
        q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(msg), ag); avisarDoc('set', mp, msg, ag);
      } catch (e) { console.error('[v150] chat:', e.message); }
    }
  }

  /* ---------- dados públicos do pedido (só o que vai no PDF) ---------- */
  function publico(p, id) {
    const f = p.parcId ? doc('parc/' + p.parcId) || {} : {}, tr = p.transpId ? doc('transp/' + p.transpId) : null;
    const end = [[p.entEnd, p.entNum].filter(Boolean).join(', ') + (p.entCompl ? ' - ' + p.entCompl : ''), p.entBairro, [p.entCidade, p.entUf].filter(Boolean).join('/'), p.entCep ? 'CEP ' + p.entCep : ''].filter(x => x && String(x).trim()).join(' · ');
    const t = totais(p);
    return { numero: String(p.numero || ''), data: br(p.data), previsao: br(p.previsao), necessidade: br(p.necessidade),
      fornecedor: { nome: String(f.nome || ''), doc: String(f.doc || '') },
      entrega: { local: txt(p.localEntrega, 200), endereco: txt(end, 300), recebimento: txt([p.entResp, p.entTel, p.entHorario].filter(Boolean).join(' · '), 200) },
      frete: MODF[p.modFrete] || '', transportadora: tr ? txt(tr.nome, 120) : '', pagamento: txt([p.formaPgto, p.condPgto].filter(Boolean).join(' · '), 160),
      itens: (Array.isArray(p.itens) ? p.itens : []).map((i, k) => ({ n: k + 1, cod: txt(i.cod, 40), desc: txt(i.desc, 300), ncm: txt(i.ncm, 12), un: txt(i.un, 10), qtd: +i.qtd || 0, vUnit: +i.vUnit || 0, pDesc: +i.pDesc || 0, pIpi: +i.pIpi || 0, vSt: +i.vSt || 0, total: itTot(i) })),
      totais: t, obs: txt(p.obs, 1500), codigo: fmtCod(codigo(Object.assign({}, p, { id }))) };
  }

  const PAG_CSS = '.it{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}.it th,.it td{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}.it .n{text-align:right;white-space:nowrap}.tot{margin-left:auto;max-width:320px}.tot div{display:flex;justify-content:space-between;padding:2px 0}.tot .g{font-weight:700;border-top:2px solid var(--tx);margin-top:4px;padding-top:6px}.g3{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:10px 0}.g3>div{border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px}.g3 b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin-bottom:4px}.err{color:var(--neg)}.ok{border-left:4px solid #1e8e3e;padding:8px 12px;background:rgba(30,142,62,.08);border-radius:6px}.acts{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.acts button{flex:1 1 200px}.sec{background:transparent;border:1px solid var(--line);color:var(--tx)}.mono{font-family:ui-monospace,Menlo,monospace}.tw{overflow-x:auto}';
  const PAG_JS = "(function(){var t=location.pathname.split('/').pop(),c=document.getElementById('c'),D=null;function h(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[x];});}" +
    "function m(v){return 'R$ '+(+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});}function q(v){return (+v||0).toLocaleString('pt-BR',{maximumFractionDigits:4});}" +
    "function fim(x){c.innerHTML='<p style=\"font-size:17px\">'+h(x)+'</p>';}" +
    "function sit(j){if(j.situacao==='aceito')return fim('Este pedido'+(j.numero?' (nº '+j.numero+')':'')+' já foi aceito'+(j.em?' em '+j.em:'')+'. Obrigado!');if(j.situacao==='recusado')return fim('A resposta a este pedido'+(j.numero?' (nº '+j.numero+')':'')+' já foi registrada'+(j.em?' em '+j.em:'')+'. Obrigado!');if(j.situacao==='expirado')return fim('Este link expirou. Peça um novo a quem enviou o pedido.');if(j.situacao==='cancelado')return fim('Este pedido foi cancelado pelo comprador. Não é preciso responder.');if(j.situacao==='semaprov')return fim('Este pedido'+(j.numero?' (nº '+j.numero+')':'')+' ainda está em aprovação na empresa e não pode ser aceito agora. Quando for aprovado, este mesmo link passa a funcionar. Se tiver dúvida, fale com quem enviou o pedido.');return fim(j.erro||'Link indisponível.');}" +
    "function tela(j){D=j;var p=j.pedido,t=p.totais,ln=function(a,b){return b?'<div>'+h(a)+': '+h(b)+'</div>':'';};" +
    "var its=p.itens.map(function(i){return '<tr><td>'+i.n+'</td><td>'+h(i.desc)+(i.cod?'<div style=\"color:var(--mut);font-size:12px\">Cód. '+h(i.cod)+(i.ncm?' · NCM '+h(i.ncm):'')+'</div>':'')+'</td><td>'+h(i.un)+'</td><td class=\"n\">'+q(i.qtd)+'</td><td class=\"n\">'+m(i.vUnit)+(i.pDesc?'<div style=\"font-size:12px\">desc. '+q(i.pDesc)+'%</div>':'')+(i.pIpi?'<div style=\"font-size:12px\">IPI '+q(i.pIpi)+'%</div>':'')+(i.vSt?'<div style=\"font-size:12px\">ST '+m(i.vSt)+'</div>':'')+'</td><td class=\"n\">'+m(i.total)+'</td></tr>';}).join('');" +
    "c.innerHTML='<p class=\"sub\">'+h(j.empresa.razao||j.empresa.nome)+(j.empresa.cnpj?' · CNPJ '+h(j.empresa.cnpj):'')+'</p><h1>Pedido de compra nº '+h(p.numero)+'</h1>'+" +
    "'<div class=\"g3\"><div><b>Datas</b>'+ln('Pedido',p.data)+ln('Necessidade',p.necessidade)+ln('Previsão de entrega',p.previsao)+'</div><div><b>Fornecedor</b>'+h(p.fornecedor.nome)+(p.fornecedor.doc?'<div>CNPJ/CPF '+h(p.fornecedor.doc)+'</div>':'')+'</div><div><b>Entrega e pagamento</b>'+ln('Local',p.entrega.local)+ln('Endereço',p.entrega.endereco)+ln('Recebimento',p.entrega.recebimento)+ln('Frete',p.frete)+ln('Transportadora',p.transportadora)+ln('Pagamento',p.pagamento)+'</div></div>'+" +
    "'<div class=\"tw\"><table class=\"it\"><thead><tr><th>Item</th><th>Descrição</th><th>Un.</th><th class=\"n\">Qtd</th><th class=\"n\">Valor unit.</th><th class=\"n\">Total</th></tr></thead><tbody>'+its+'</tbody></table></div>'+" +
    "'<div class=\"tot\"><div><span>Produtos</span><span>'+m(t.produtos)+'</span></div>'+(t.desc?'<div><span>Descontos nos itens</span><span>− '+m(t.desc)+'</span></div>':'')+(t.ipi?'<div><span>IPI</span><span>'+m(t.ipi)+'</span></div>':'')+(t.st?'<div><span>ICMS-ST</span><span>'+m(t.st)+'</span></div>':'')+'<div><span>Frete</span><span>'+m(t.frete)+'</span></div>'+(t.descGeral?'<div><span>Desconto no total</span><span>− '+m(t.descGeral)+'</span></div>':'')+'<div class=\"g\"><span>Total do pedido</span><span>'+m(t.total)+'</span></div></div>'+" +
    "(p.obs?'<p><b>Observações:</b> '+h(p.obs)+'</p>':'')+'<p class=\"sub\">Código de verificação do pedido: <span class=\"mono\">'+h(p.codigo)+'</span>'+(j.expira?' · link válido até '+h(j.expira):'')+'</p>'+" +
    "'<label>Seu nome (quem responde pelo fornecedor)<input id=\"nome\" maxlength=\"100\" autocomplete=\"name\"></label><label>Cargo ou função (opcional)<input id=\"cargo\" maxlength=\"80\"></label>'+" +
    "'<div class=\"acts\"><button type=\"button\" id=\"ac\" class=\"pri\">Aceito o pedido</button><button type=\"button\" id=\"nao\" class=\"sec\">Não posso atender</button></div><div id=\"mot\" hidden><label>Motivo (obrigatório)<textarea id=\"motivo\" rows=\"3\" maxlength=\"1000\"></textarea></label><button type=\"button\" id=\"env\" class=\"sec\">Enviar resposta</button></div><p id=\"err\" class=\"err\"></p>'+" +
    "'<p class=\"sub\">Ao responder, registramos o nome informado, a data e a hora e o endereço de internet (IP) de onde veio a resposta, só como comprovação deste aceite.</p>';}" +
    "function env(acao){var e=document.getElementById('err'),nome=document.getElementById('nome').value.trim(),mot=(document.getElementById('motivo')||{}).value||'';e.textContent='';if(nome.length<3){e.textContent='Informe o seu nome.';return;}if(acao==='recusar'&&mot.trim().length<3){e.textContent='Explique o motivo.';return;}" +
    "[].forEach.call(c.querySelectorAll('button'),function(b){b.disabled=true;});fetch('/api/pub/aceite/'+t,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({acao:acao,nome:nome,cargo:document.getElementById('cargo').value,motivo:mot,codigo:D.pedido.codigo})}).then(function(r){return r.json();}).then(function(j){if(j.ok)c.innerHTML='<div class=\"ok\"><p style=\"font-size:17px;margin:0\">'+(acao==='aceitar'?'Pedido nº '+h(D.pedido.numero)+' aceito. Obrigado!':'Resposta registrada. Obrigado por avisar.')+'</p><p class=\"sub\" style=\"margin:6px 0 0\">'+h(j.em||'')+' · '+h(nome)+'</p></div>';else if(j.situacao==='semaprov')sit(j);else{e.textContent=j.erro||'Não foi possível registrar.';[].forEach.call(c.querySelectorAll('button'),function(b){b.disabled=false;});}},function(){e.textContent='Sem conexão. Tente de novo.';[].forEach.call(c.querySelectorAll('button'),function(b){b.disabled=false;});});}" +
    "c.addEventListener('click',function(ev){var x=ev.target;if(x.id==='ac'){if(window.confirm('Confirmar o aceite do pedido nº '+D.pedido.numero+' ('+m(D.pedido.totais.total)+')?'))env('aceitar');}else if(x.id==='nao'){document.getElementById('mot').hidden=false;document.getElementById('motivo').focus();}else if(x.id==='env')env('recusar');});" +
    "fetch('/api/pub/aceite/'+t).then(function(r){return r.json();}).then(function(j){if(j.situacao==='aberto')tela(j);else sit(j);},function(){fim('Não foi possível abrir o pedido agora. Tente mais tarde.');});})();";
  const VER_JS = "(function(){var t=location.pathname.split('/').pop(),c=document.getElementById('c');function h(s){return String(s==null?'':s).replace(/[&<>\"']/g,function(x){return{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[x];});}" +
    "function m(v){return 'R$ '+(+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});}" +
    "fetch('/api/pub/verificar/'+t).then(function(r){return r.json();}).then(function(j){if(j.erro){c.innerHTML='<p class=\"err\" style=\"font-size:16px\">'+h(j.erro)+'</p>';return;}var r=j.pedido;" +
    "c.innerHTML=(j.situacao==='confere'?'<div class=\"ok\"><b>Código válido.</b> Este é o código da versão atual do pedido.</div>':'<p class=\"err\"><b>Atenção:</b> este código é de uma versão anterior. O pedido foi alterado'+(j.alteradoEm?' em '+h(j.alteradoEm):'')+'; peça a versão atual a quem enviou.</p>')+" +
    "'<table class=\"it\"><tbody><tr><th>Pedido de compra</th><td>nº '+h(r.numero)+'</td></tr><tr><th>Data</th><td>'+h(r.data)+'</td></tr><tr><th>Fornecedor</th><td>'+h(r.fornecedor)+'</td></tr><tr><th>Total</th><td>'+m(r.total)+'</td></tr><tr><th>Situação</th><td>'+h(r.situacao)+'</td></tr></tbody></table><p class=\"sub\">Emitido por '+h(j.empresa)+'. Código '+h(j.codigo)+'.</p>';},function(){c.innerHTML='<p>Não foi possível conferir agora. Tente mais tarde.</p>';});})();";

  function pagina(res, titulo, js) { html(res, 200, pag(titulo, '<style>' + PAG_CSS + '</style><div class="card" style="max-width:920px;margin:24px auto"><div id="c"><p class="sub">Carregando…</p></div></div><script>' + js + '</script>'), { 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' }); return true; }

  async function publica(p, m, req, res) {
    const pa = p.match(/^\/aceite\/([A-Za-z0-9_-]{32,64})$/), aa = p.match(/^\/api\/pub\/aceite\/([A-Za-z0-9_-]{32,64})$/);
    const pv = p.match(/^\/verificar\/([A-Za-z0-9-]{12,20})$/), av = p.match(/^\/api\/pub\/verificar\/([A-Za-z0-9-]{12,20})$/);
    if (!pa && !aa && !pv && !av) return false;
    const ip = ipDe(req);
    if (pa || pv) { if (m !== 'GET') { json(res, 405, { erro: 'Método não permitido.' }); return true; } return pagina(res, pa ? 'Aceite do pedido de compra' : 'Conferir pedido de compra', pa ? PAG_JS : VER_JS); }
    if (bloqueado(ip)) { json(res, 429, { erro: 'Muitas tentativas. Tente mais tarde.' }); return true; }
    if (av) {
      if (m !== 'GET') { json(res, 405, { erro: 'Método não permitido.' }); return true; }
      if (conta1('v:' + ip, 60)) { json(res, 429, { erro: 'Muitas consultas. Tente mais tarde.' }); return true; }
      const c = limpaCod(av[1]); if (c.length !== 12) return errou(res, ip, 400, 'Código inválido. Confira os 12 caracteres impressos no pedido.');
      const r = acharCodigo(c); if (!r) return errou(res, ip, 404, 'Código não encontrado. Confira os caracteres impressos no pedido.');
      const emp = empresa().nome;
      if (r.atual) { const rs = resumo(r.p); if (r.p.aceite && r.p.aceite.ok && r.p.aceite.codigo === c) rs.situacao += ' · aceito pelo fornecedor em ' + dt(r.p.aceite.em); json(res, 200, { situacao: 'confere', codigo: fmtCod(c), empresa: emp, pedido: rs }); return true; }
      json(res, 200, { situacao: 'anterior', codigo: fmtCod(c), empresa: emp, alteradoEm: dt(r.ate), pedido: r.rs }); return true;
    }
    /* aceite */
    if (conta1('a:' + ip, m === 'GET' ? 120 : 30)) { json(res, 429, { erro: 'Muitas tentativas. Tente mais tarde.' }); return true; }
    const reg = db.prepare('SELECT * FROM ped_aceite WHERE hash=?').get(sha(aa[1]));
    if (!reg) return errou(res, ip, 404, 'Pedido não encontrado. Confira o link recebido.');
    const pp = 'ped/' + reg.ped, d = doc(pp);
    let sit = !d || d.status === 'cancelado' ? 'cancelado' : reg.usado ? (reg.acao === 'recusar' ? 'recusado' : 'aceito') : (reg.revogado || reg.expira < Date.now()) ? 'expirado' : 'aberto';
    if (sit === 'aberto' && !aprovOk(Object.assign({}, d, { id: reg.ped })).ok) sit = 'semaprov'; /* v157: pedido sem aprovação válida não é mostrado nem aceito */
    if (m === 'GET') {
      if (sit !== 'aberto') { json(res, 200, { situacao: sit, numero: d ? String(d.numero || '') : '', em: reg.usado ? dt(reg.usado) : '' }); return true; }
      json(res, 200, { situacao: 'aberto', empresa: empresa(), pedido: publico(d, reg.ped), expira: dt(reg.expira) }); return true;
    }
    if (m !== 'POST') { json(res, 405, { erro: 'Método não permitido.' }); return true; }
    if (sit === 'aceito' || sit === 'recusado') { json(res, 409, { erro: 'Este pedido já foi respondido por este link. Obrigado!' }); return true; }
    if (sit === 'cancelado') { json(res, 409, { erro: 'Este pedido foi cancelado pelo comprador.' }); return true; }
    if (sit === 'expirado') { json(res, 410, { erro: 'Este link expirou. Peça um novo a quem enviou o pedido.' }); return true; }
    if (sit === 'semaprov') { json(res, 409, { situacao: 'semaprov', erro: 'Este pedido ainda está em aprovação na empresa e não pode ser aceito agora. Quando for aprovado, este mesmo link passa a funcionar.' }); return true; } /* v157 */
    if ((reg.n || 0) >= 10) { json(res, 429, { erro: 'Muitas tentativas neste link. Fale com quem enviou o pedido.' }); return true; }
    db.prepare('UPDATE ped_aceite SET n=coalesce(n,0)+1 WHERE hash=?').run(reg.hash);
    let b; try { b = JSON.parse((await lerCorpo(req, 20000)).toString('utf8') || '{}'); } catch (x) { json(res, 400, { erro: 'Dados inválidos.' }); return true; }
    const acao = b.acao === 'recusar' ? 'recusar' : b.acao === 'aceitar' ? 'aceitar' : '';
    const nome = txt(b.nome, 100), cargo = txt(b.cargo, 80), motivo = txt(b.motivo, 1000);
    if (!acao) { json(res, 400, { erro: 'Escolha aceitar ou não atender.' }); return true; }
    if (nome.length < 3) { json(res, 400, { erro: 'Informe o seu nome.' }); return true; }
    if (acao === 'recusar' && motivo.length < 3) { json(res, 400, { erro: 'Explique o motivo.' }); return true; }
    const cod = codigo(Object.assign({}, d, { id: reg.ped }));
    if (b.codigo && limpaCod(b.codigo) !== cod) { json(res, 409, { erro: 'O pedido foi alterado pelo comprador enquanto a página estava aberta. Recarregue a página e confira a versão atual.' }); return true; }
    /* uso único: marca o link antes de gravar o pedido (duas respostas ao mesmo tempo: só a primeira vale) */
    const ag = Date.now(), up = db.prepare('UPDATE ped_aceite SET usado=?, ip=?, acao=? WHERE hash=? AND usado IS NULL').run(ag, String(ip).slice(0, 64), acao, reg.hash);
    if (!up.changes) { json(res, 409, { erro: 'Este pedido já foi respondido por este link. Obrigado!' }); return true; }
    const n = JSON.parse(JSON.stringify(d)), ac = { ok: acao === 'aceitar', nome, em: ag, codigo: cod, via: 'link', link: reg.hash.slice(0, 12) };
    if (cargo) ac.cargo = cargo; if (acao === 'recusar') ac.motivo = motivo;
    if (n.aceite) n.aceiteAnt = (Array.isArray(n.aceiteAnt) ? n.aceiteAnt : []).concat([n.aceite]).slice(-10);
    n.aceite = ac;
    n.hist = (Array.isArray(n.hist) ? n.hist : []).concat([{ t: ag, by: 'fornecedor', ch: [['aceite', '', ac.ok ? 'Aceito pelo fornecedor (' + nome + (cargo ? ', ' + cargo : '') + ')' : 'Fornecedor não pode atender (' + nome + '): ' + motivo]] }]).slice(-20);
    salvar(pp, n, null, req, ac.ok ? 'PED_ACEITE_FORNECEDOR' : 'PED_RECUSA_FORNECEDOR', d);
    const forn = parcNome(d.parcId) || 'O fornecedor';
    avisarChat([d.crBy, reg.por], ac.ok ? forn + ' aceitou o pedido de compra nº ' + (d.numero || '') + ' (aceite eletrônico de ' + nome + ' em ' + dt(ag) + ').' : forn + ' respondeu que NÃO pode atender o pedido de compra nº ' + (d.numero || '') + ' (' + nome + '): ' + motivo);
    json(res, 200, { ok: true, em: dt(ag) }); return true;
  }

  return { rota, publica, antes, codigo, canon, fmtCod };
};
module.exports.codigo = codigo;
module.exports.canon = canon;
module.exports.fmtCod = fmtCod;

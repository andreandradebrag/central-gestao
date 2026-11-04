'use strict';
/* v153 (relatorios/feito_v153.md): almoxarifados por cidade com responsável, avisos por almoxarifado e tipos de SC por perfil.
   1. Almoxarifado de cada documento (o mesmo cálculo do navegador, new_v153.js › v153AlmoxObra/v153AlmoxSc):
      - obra: o "Almoxarifado que atende" (proj.almoxId, se ativo); senão o almoxarifado principal (almox.principal) da cidade
        da obra (obraCidade/obraUf); senão o mais usado pelas separações da obra; senão o único almoxarifado ativo;
      - SC: reposição → almoxId (destino); senão almoxOrigId (origem da separação); senão o da obra;
      - pedido → o da SC (ou o da obra); separação → almoxId (ou o da SC); devolução de sobras → almoxId; romaneio → almoxId
        (origem) e, na transferência, destAlmoxId (destino).
   2. Avisos (regras.js › eventosAviso): "Falta o recebimento físico" e os avisos novos — separar material (separação
      pendente), receber transferência (romaneio de transferência em trânsito), despachar romaneio (romaneio em montagem
      criado por outra pessoa) e conferir devolução de sobras — vão ao responsável e ao substituto do almoxarifado
      (almox.respUid/substUid, contas ativas). Almoxarifado sem responsável: para todos os almoxarifes (papel 'almoxarife',
      como antes). Na primeira subida, os eventos novos que já existem são marcados como avisados (sem e-mail em massa).
   3. SC: scTipos do perfil padrão (Almoxarife: só 'repos' e 'adm') ao criar ou mudar o tipo; almoxOrigId precisa ser um
      almoxarifado cadastrado. */
module.exports = function (X) {
  const { q, db, col, doc, erro, PERM, papelDe, defDe, igual } = X;
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const uniq = a => [...new Set(a.filter(Boolean))];
  const porNome = (a, b) => { const x = norm(a.nome), y = norm(b.nome); return x < y ? -1 : x > y ? 1 : 0; };
  const ativos = () => col('almox').filter(a => a && a.ativo !== false).sort(porNome);
  const almox = id => id ? doc('almox/' + String(id)) : null;
  const br = d => /^\d{4}-\d{2}-\d{2}/.test(String(d || '')) ? String(d).slice(8, 10) + '/' + String(d).slice(5, 7) + '/' + String(d).slice(0, 4) : '';

  /* ---------- 1. almoxarifado de cada documento ---------- */
  function almoxObra(pid) {
    const p = pid ? doc('proj/' + String(pid)) : null; if (!p) return '';
    const als = ativos(), tem = id => als.some(a => a.id === id);
    if (p.almoxId && tem(p.almoxId)) return p.almoxId;
    const cid = norm(p.obraCidade || p.cidade), uf = norm(p.obraUf || p.uf);
    if (cid) { const pr = als.find(a => a.principal === true && norm(a.cidade) === cid && (!uf || !a.uf || norm(a.uf) === uf)); if (pr) return pr.id; }
    const cnt = new Map(); for (const s of col('sep')) if (s.projId === pid && s.almoxId && tem(s.almoxId)) cnt.set(s.almoxId, (cnt.get(s.almoxId) || 0) + 1);
    let best = '', n = 0; for (const a of als) { const k = cnt.get(a.id) || 0; if (k > n) { n = k; best = a.id; } } if (best) return best;
    return als.length === 1 ? als[0].id : '';
  }
  function almoxSc(s) { if (!s) return ''; if (s.tipo === 'repos') return s.almoxId || ''; if (s.almoxOrigId) return s.almoxOrigId; return s.projId ? almoxObra(s.projId) : ''; }
  function almoxPed(p) { if (!p) return ''; const s = p.scId ? doc('sc/' + String(p.scId)) : null; return almoxSc(s) || (p.projId ? almoxObra(p.projId) : ''); }
  function almoxSep(s) { if (!s) return ''; return s.almoxId || almoxSc(s.scId ? doc('sc/' + String(s.scId)) : null) || (s.projId ? almoxObra(s.projId) : ''); }

  /* ---------- 2. quem recebe o aviso ---------- */
  const ativa = u => { const c = q.contaPorId.get(u); if (!c || !c.ativo) return false; const r = col('usr').find(x => x.uid === u); return !(r && r.ativo === false); };
  function almoxarifes() { const out = []; for (const u of col('usr')) { if (!u.uid || u.ativo === false) continue; const c = q.contaPorId.get(u.uid); if (!c || !c.ativo) continue; if (papelDe(u.perfil) === 'almoxarife') out.push(u.uid); } return uniq(out); }
  const donos = () => q.contas.all().filter(c => c.ativo && c.nivel === 'owner').map(c => c.id);
  /* responsável e substituto; sem eles, todos os almoxarifes (como antes); sem almoxarife, o dono */
  function quem(almId, fallback) {
    const a = almox(almId), l = a ? uniq([a.respUid, a.substUid]).filter(ativa) : [];
    if (l.length) return l;
    const f = typeof fallback === 'function' ? fallback() : almoxarifes();
    return f && f.length ? f : donos();
  }
  const quemPed = (p, fallback) => quem(almoxPed(p), fallback);
  const nomeAlm = id => { const a = almox(id); return a ? a.nome : ''; };
  const nomeProj = id => { const p = id ? doc('proj/' + String(id)) : null; return p ? [p.codigo, p.nome].filter(Boolean).join(' · ') : ''; };
  function eventos(fallback) {
    const ev = [];
    for (const s of col('sep')) {
      if (s.status !== 'pendente' || s.ex) continue; const a = almoxSep(s);
      ev.push({ k: 'sep153:' + s.id, quem: quem(a, fallback), tipo: 'Separar material', almox: a, txt: 'Separar o material do pedido de separação nº ' + (s.numero || '') + (s.projId ? ' (obra ' + nomeProj(s.projId) + ')' : '') + (s.necessidade ? ', necessidade ' + br(s.necessidade) : '') + (a ? ', no ' + nomeAlm(a) : '') + ' (Suprimentos › Separação de itens).' });
    }
    for (const r of col('rom')) {
      if (r.ex) continue;
      if (r.status === 'transito' && r.destTipo === 'almox' && r.destAlmoxId) ev.push({ k: 'romt153:' + r.id, quem: quem(r.destAlmoxId, fallback), tipo: 'Receber transferência entre almoxarifados', almox: r.destAlmoxId, txt: 'A transferência do romaneio nº ' + (r.numero || '') + ' saiu de ' + (nomeAlm(r.almoxId) || 'outro almoxarifado') + ' para ' + nomeAlm(r.destAlmoxId) + ': confira e confirme o recebimento (Suprimentos › Romaneios de envio).' });
      else if ((r.status === 'rascunho' || r.status === 'conferido') && r.almoxId) { const qq = quem(r.almoxId, fallback).filter(u => u !== r.crBy); if (qq.length) ev.push({ k: 'rom153:' + r.id, quem: qq, tipo: 'Romaneio para despachar', almox: r.almoxId, txt: 'O romaneio nº ' + (r.numero || '') + ' sai do ' + nomeAlm(r.almoxId) + ' e aguarda conferência e despacho (Suprimentos › Romaneios de envio).' }); }
    }
    for (const d of col('devobra')) {
      if (d.status !== 'enviado' || d.ex) continue;
      ev.push({ k: 'dev153:' + d.id, quem: quem(d.almoxId, fallback), tipo: 'Devolução de sobras para conferir', almox: d.almoxId || '', txt: 'A obra ' + nomeProj(d.projId) + ' devolveu material (devolução nº ' + (d.numero || '') + ') para o ' + (nomeAlm(d.almoxId) || 'almoxarifado') + ': confira e confirme as quantidades (Suprimentos › Devolução de sobras).' });
    }
    return ev;
  }
  /* primeira subida: o que já existe não vira e-mail em massa */
  setImmediate(() => {
    try {
      db.exec('CREATE TABLE IF NOT EXISTS almox153_ini(k TEXT PRIMARY KEY, ts INTEGER)');
      if (db.prepare("SELECT 1 FROM almox153_ini WHERE k='ini'").get()) return;
      const ins = db.prepare('INSERT OR IGNORE INTO p2p_aviso(k,ts) VALUES(?,?)'), agora = Date.now();
      for (const e of eventos(() => [])) ins.run(e.k, agora);
      db.prepare("INSERT OR IGNORE INTO almox153_ini(k,ts) VALUES('ini',?)").run(agora);
    } catch (e) { console.error('[v153] avisos (início):', e.message); }
  });

  /* ---------- 3. SC: tipos por perfil e almoxarifado de origem ---------- */
  const NOME_T = { obra: 'Obra', repos: 'Reposição de estoque', adm: 'Administrativa' };
  function antes(conta, id, velho, novo) {
    const v = velho || {};
    if (!igual(v.almoxOrigId, novo.almoxOrigId) && novo.almoxOrigId !== undefined && novo.almoxOrigId !== '') {
      if (typeof novo.almoxOrigId !== 'string' || !almox(novo.almoxOrigId)) return erro('Almoxarifado de origem não encontrado.', 400);
    }
    const d = defDe(conta);
    if (d && !d.custom && Array.isArray(d.scTipos) && d.scTipos.length && novo.status !== 'cancelada' && (!velho || !igual(v.tipo, novo.tipo))) {
      const t = novo.tipo || (novo.projId ? 'obra' : '');
      if (!d.scTipos.includes(t)) return erro('Seu perfil (' + (d.nome || '') + ') cria solicitação de compra só de: ' + d.scTipos.map(x => NOME_T[x] || x).join(', ') + '.', 403);
    }
    return null;
  }
  return { almoxObra, almoxSc, almoxPed, almoxSep, quem, quemPed, almoxarifes, eventos, antes };
};

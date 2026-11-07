'use strict';
/* v168 (relatorios/feito_v168.md): reuniões — documentos, biblioteca, convite, gravação, transcrição, ata pela IA e tarefas.
   Ligado em regras.js por v168/ed_v168.py (rotas /api/reun168/*, leitura e gravação das coleções novas, regra da "reun").
   Coleções novas, gravadas SÓ pelas rotas (a gravação direta é recusada):
     reunx168/<id da reunião>  documentos, registros ligados, documentos da biblioteca, gravações (com o consentimento),
                                transcrição e a minuta/ata. Leitura: participantes (organizador e internos) e Administrador.
     bib168p/<id>              pasta da biblioteca (nome, assunto, obra, acesso: todos / perfis / usuários).
     bib168d/<id>              documento da biblioteca (pasta, título, etiquetas, obra, versões — as antigas ficam).
     tar168/<id>               tarefa saída de uma ação da ata aprovada (responsável, prazo, origem, situação, notas, evidências).
   A "reun" continua gravada pela tela; o servidor guarda sozinho ata168 (ata aprovada) e conv168 (convite enviado).
   Anexos: o arquivo sobe por /api/assets e a rota liga a origem (arquivos.origem) ao registro: quem pode ler o registro
   pode baixar (regras.js › blobPermitido). Áudio: guardado como anexo da reunião, apagado depois de REUNIAO_AUDIO_DIAS.
   Avisos: conversa "Central de Gestão" do chat (como v150/v164/v166) e e-mail quando o SMTP estiver configurado. */
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const TR = require('./transcricao168.js');
module.exports = function (X) {
  const { db, q, col, erro, ehDono, perfilEm, json, lerJson, avisarDoc, EMAIL, APP_URL, DATA } = X;
  const auditar = (...a) => { try { X.auditar(...a); } catch (e) { } };
  const doc = p => { const d = X.doc(p); if (d && typeof d === 'object' && !d.id) d.id = String(p).split('/').pop(); return d; };
  const nomeConta = id => { try { return X.nomeConta(id); } catch (e) { return id || ''; } };
  const ID_OK = /^[\w\-.|~@+=]{1,200}$/, ARQ_OK = /^[A-Za-z0-9_-]{6,64}$/;
  const COLS = new Set(['reunx168', 'bib168p', 'bib168d', 'tar168']);
  const env = (k, d, mn, mx) => { const v = +process.env[k]; return Math.min(mx, Math.max(mn, isFinite(v) && process.env[k] !== '' && process.env[k] != null ? v : d)); };
  const CFG = () => ({ audioDias: env('REUNIAO_AUDIO_DIAS', 90, 1, 3650), gravMin: env('REUNIAO_GRAV_MAX_MIN', 180, 1, 600), gravMb: env('REUNIAO_GRAV_MAX_MB', 300, 1, 2000),
    parteS: env('REUNIAO_GRAV_PARTE_S', 30, 1, 120), docMb: env('REUNIAO_DOC_MB', 20, 1, 25), lembrete: env('REUNIAO_LEMBRETE_MIN', 30, 0, 1440) });
  const agoraBr = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 16), hojeBr = () => agoraBr().slice(0, 10);
  const maisDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const tsReun = r => Date.parse(String(r.data) + 'T' + (r.ini || '00:00') + ':00-03:00');
  const novoId = p => p + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, n || 300);
  const txtL = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, n || 4000);
  const uniq = a => [...new Set((a || []).filter(Boolean))];
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const dataOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(d + 'T12:00:00Z'));
  const emailOk = e => /^[^@\s<>]{1,64}@[^@\s<>]{1,190}\.[a-z]{2,}$/i.test(String(e || ''));
  const fmtBr = d => dataOk(d) ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '';

  /* ---------------- tabelas e pastas ---------------- */
  db.exec('CREATE TABLE IF NOT EXISTS reun168_aviso(k TEXT PRIMARY KEY, ts INTEGER)');
  const avisoNovo = k => db.prepare('INSERT OR IGNORE INTO reun168_aviso(k,ts) VALUES(?,?)').run(k, Date.now()).changes > 0;
  const DIR_G = path.join(DATA, 'reun168'); fs.mkdirSync(DIR_G, { recursive: true });
  const stOrig = db.prepare('UPDATE arquivos SET origem=? WHERE id=? AND origem IS NULL'), stArq = db.prepare('SELECT * FROM arquivos WHERE id=?');

  /* ---------------- quem é quem ---------------- */
  const admin = conta => ehDono(conta) || perfilEm(conta, ['admin']);
  const reunDe = id => ID_OK.test(String(id || '')) ? doc('reun/' + id) : null;
  const internos = r => uniq([r.org].concat(Array.isArray(r.internos) ? r.internos : [])).filter(u => typeof u === 'string');
  const externosDe = r => String(r.externos || '').split(/[\n;,]+/).map(s => s.trim()).filter(Boolean).map(s => { const m = s.match(/^(.*?)[<(\s]*([^\s<>()]+@[^\s<>()]+\.[^\s<>()]+)[>)]?$/); return m ? { nome: m[1].trim().replace(/[-–:]+$/, '').trim(), email: m[2].toLowerCase() } : { nome: s, email: '' }; }).slice(0, 60);
  const participa = (conta, r) => !!conta && !!r && internos(r).includes(conta.id);
  const veReun = (conta, r) => !!r && (admin(conta) || participa(conta, r));
  const gereReun = (conta, r) => !!r && (admin(conta) || (conta && (r.org === conta.id || r.secretario === conta.id)));
  /* nomes dos participantes (internos e de fora), na ordem */
  const nomesPart = r => internos(r).map(u => ({ k: u, nome: nomeConta(u), interno: true })).concat(externosDe(r).map(x => ({ k: 'x:' + (x.nome || x.email), nome: x.nome || x.email, interno: false, email: x.email })));
  function acessoPasta(conta, p) {
    if (!conta || !p) return false; if (admin(conta) || p.crBy === conta.id) return true;
    const a = p.acesso || {}, modo = a.modo || 'todos';
    if (modo === 'todos') return true;
    if (modo === 'usuarios') return Array.isArray(a.usuarios) && a.usuarios.includes(conta.id);
    if (modo === 'perfis') { const pf = X.perfilDe(conta); return Array.isArray(a.perfis) && (a.perfis.includes(pf) || a.perfis.includes(X.papelDe ? X.papelDe(pf) : pf)); }
    return false;
  }
  /* leitura das coleções novas (regras.js › podeLer, antes do módulo) */
  function podeLer(conta, p, data) {
    const s = p.split('/'), c0 = s[0];
    if (!conta || admin(conta)) return true;
    if (c0 === 'reunx168') return s.length < 2 ? false : veReun(conta, reunDe(s[1]));
    if (c0 === 'bib168p') return !!data && acessoPasta(conta, data);
    if (c0 === 'bib168d') return !!data && acessoPasta(conta, doc('bib168p/' + String(data.pastaId || '')));
    if (c0 === 'tar168') return !!data && veTarefa(conta, data);
    return false;
  }
  function veTarefa(conta, t) {
    if (!conta || !t) return false; if (admin(conta) || t.resp === conta.id || t.org === conta.id) return true;
    const r = reunDe(t.reunId); return !!r && participa(conta, r);
  }
  /* gravação: as coleções novas só pelas rotas; na "reun", ata168 e conv168 são do servidor */
  function antes(conta, c0, id, velho, novo) {
    if (COLS.has(c0)) return erro('Documentos, gravações, atas, biblioteca e tarefas de reuniões só pelas telas da Agenda (o servidor confere quem pode).', 403);
    if (c0 === 'reun' && novo) {
      for (const k of ['ata168', 'conv168']) { if (velho && velho[k] !== undefined) novo[k] = velho[k]; else delete novo[k]; }
      if (Array.isArray(novo.pautaItens)) novo.pautaItens = novo.pautaItens.slice(0, 60).filter(x => x && typeof x === 'object').map(x => ({ id: ID_OK.test(String(x.id || '')) ? String(x.id) : novoId('pi'), titulo: txt(x.titulo, 200), resp: txt(x.resp, 80), min: Math.max(0, Math.min(600, Math.round(+x.min || 0))), ...(x.deTar ? { deTar: txt(x.deTar, 80) } : {}) })).filter(x => x.titulo);
      if (novo.lembrete !== undefined && novo.lembrete !== null && novo.lembrete !== '') novo.lembrete = Math.max(0, Math.min(1440, Math.round(+novo.lembrete || 0)));
      if (novo.serie !== undefined) novo.serie = txt(novo.serie, 120);
    }
    return null;
  }
  function antesExcluir(conta, c0, id, velho) {
    if (COLS.has(c0)) return erro('Exclusão só pelas telas da Agenda.', 403);
    if (c0 === 'reun' && velho) { const x = doc('reunx168/' + id); if (velho.ata168 || (x && ((x.gravs || []).length || (x.minuta && x.minuta.st === 'aprovada')))) return erro('Reunião com ata aprovada ou gravação não se exclui: cancele a reunião.', 409); }
    return null;
  }

  /* ---------------- gravação do servidor ---------------- */
  function grava(p, data) { const s = p.split('/'), ts = Date.now(); q.docPut.run(p, s.slice(0, -1).join('/'), s[s.length - 1], JSON.stringify(data), ts); avisarDoc('set', p, data, ts); return data; }
  function apaga(p) { const ts = Date.now(); q.docDel.run(p); avisarDoc('del', p, null, ts); }
  const extra = id => doc('reunx168/' + id) || { id, reunId: id, docs: [], links: [], bib: [], gravs: [] };
  function gravaExtra(x) { x.em = Date.now(); return grava('reunx168/' + x.reunId, x); }

  /* ---------------- avisos ---------------- */
  function avisarChat(uids, texto) {
    const ag = Date.now(); let n = 0;
    for (const u of uniq(uids).filter(x => ID_OK.test(x) && x !== 'sistema')) {
      try {
        const cid = 'av_' + u, cp = 'cm/sistema/c/' + cid;
        if (!q.docGet.get(cp)) { const cv = { id: cid, tipo: 'dm', membros: [u], ts: ag, sistema: true }; q.docPut.run(cp, 'cm/sistema/c', cid, JSON.stringify(cv), ag); avisarDoc('set', cp, cv, ag); }
        const mid = 'm' + ag.toString(36) + crypto.randomBytes(4).toString('hex'), mp = 'cm/sistema/m/' + mid;
        const msg = { id: mid, k: 'msg', conv: 'sistema/' + cid, txt: '📅 ' + texto, ts: ag, men: [], sistema: true, v168: 1 };
        q.docPut.run(mp, 'cm/sistema/m', mid, JSON.stringify(msg), ag); avisarDoc('set', mp, msg, ag); n++;
      } catch (e) { console.error('[v168] chat:', e.message); }
    }
    return n;
  }
  function enviarEmail(para, assunto, linhas) {
    if (!EMAIL.configurado() || !emailOk(para)) return false;
    const m = EMAIL.modelo(assunto, linhas, 'Abrir a Central de Gestão', APP_URL, 'Aviso da Central de Gestão.');
    EMAIL.enviar({ para, assunto: assunto + ' · Central de Gestão', texto: m.texto, html: m.html }).catch(e => auditar(null, null, 'REUNIAO_EMAIL_FALHA', 'reun/email', null, { para, erro: String(e && e.message || e).slice(0, 200) }));
    return true;
  }
  const quando = r => fmtBr(r.data) + ', ' + (r.ini || '') + (r.fim ? ' às ' + r.fim : '');
  const linkTxt = r => r.link && /^https:\/\//.test(r.link) ? r.link : '';
  function pautaLinhas(r) {
    const it = Array.isArray(r.pautaItens) ? r.pautaItens : [];
    if (it.length) return it.map((x, i) => (i + 1) + '. ' + x.titulo + (x.resp ? ' (' + x.resp + ')' : '') + (x.min ? ' · ' + x.min + ' min' : ''));
    return r.pauta ? String(r.pauta).split('\n').map(s => s.trim()).filter(Boolean) : [];
  }

  /* ---------------- conferência de arquivo (tipo real pelos primeiros bytes) ---------------- */
  const TIPOS = { pdf: 'PDF', xlsx: 'Planilha (xlsx)', docx: 'Documento (docx)', pptx: 'Apresentação (pptx)', png: 'Imagem', jpg: 'Imagem', webp: 'Imagem' };
  function tipoArquivo(id, nome) {
    let b; try { const fd = fs.openSync(path.join(DATA, 'blobs', id), 'r'); b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, 4096, 0); fs.closeSync(fd); b = b.subarray(0, n); } catch (e) { return null; }
    const ext = (String(nome || '').toLowerCase().match(/\.([a-z0-9]{1,5})$/) || [])[1] || '';
    if (b.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (b[0] === 0x89 && b.slice(1, 4).toString('latin1') === 'PNG') return 'png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
    if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 && ['xlsx', 'docx', 'pptx'].includes(ext)) return ext;
    return null;
  }
  function arqDaConta(conta, a, maxMb, aceita) {
    const id = String((a && a.id) || '').replace(/[^A-Za-z0-9_-]/g, ''); if (!ARQ_OK.test(id)) return { erro: 'Arquivo inválido.' };
    const r = stArq.get(id); if (!r || r.lixo) return { erro: 'Arquivo não encontrado (envie de novo).' };
    if (r.por && r.por !== conta.id && !admin(conta)) return { erro: 'Arquivo de outra pessoa.' };
    if ((+r.tam || 0) > maxMb * 1024 * 1024) return { erro: 'O arquivo passa de ' + maxMb + ' MB.', st: 413 };
    const nome = txt(a.nome || 'arquivo', 140), t = tipoArquivo(id, nome);
    if (aceita && !aceita.includes(t)) return { erro: 'Tipo de arquivo não aceito. Envie PDF, planilha (xlsx), documento (docx), apresentação (pptx) ou imagem (PNG, JPG, WEBP).', st: 400 };
    return { arq: { id, nome, ct: r.ct, tam: r.tam, tipo: t || '' }, origem: o => { try { stOrig.run(o, id); } catch (e) { } } };
  }
  const ACEITA_DOC = ['pdf', 'xlsx', 'docx', 'pptx', 'png', 'jpg', 'webp'];

  /* ---------------- registros do sistema que podem ser ligados ---------------- */
  const LIGA = { proj: 'Obra', ctr: 'Contrato', med: 'Medição', rmesf: 'Relatório mensal', rdo: 'Diário de obra' };

  /* ---------------- reunião: leitura do que é dos participantes ---------------- */
  const anterior = r => {
    const chave = norm(r.serie) || ('t:' + norm(r.titulo));
    const lst = col('reun').filter(x => x.id !== r.id && x.status !== 'cancelada' && (norm(x.serie) || ('t:' + norm(x.titulo))) === chave && (x.data < r.data || (x.data === r.data && String(x.ini || '') < String(r.ini || ''))));
    lst.sort((a, b) => String(b.data + (b.ini || '')).localeCompare(String(a.data + (a.ini || ''))));
    return lst[0] || null;
  };
  const tarefasDa = rid => db.prepare("SELECT id, data FROM docs WHERE parent='tar168' AND json_extract(data,'$.reunId')=?").all(rid).map(x => { try { return Object.assign(JSON.parse(x.data), { id: x.id }); } catch (e) { return null; } }).filter(Boolean);
  function tarPub(t) { const atras = ['afazer', 'andamento'].includes(t.status) && t.prazo && t.prazo < hojeBr(); return Object.assign({}, t, { respNomeV: t.resp ? nomeConta(t.resp) : (t.respNome || ''), orgNome: nomeConta(t.org), atrasada: !!atras, hist: (t.hist || []).map(h => Object.assign({}, h, { porNome: nomeConta(h.por) })) }); }
  function bibResolve(conta, b) {
    const d = doc('bib168d/' + b.bibId); if (!d) return Object.assign({}, b, { sumiu: true });
    const p = doc('bib168p/' + String(d.pastaId || '')), ok = acessoPasta(conta, p), v = (d.versoes || [])[(d.versoes || []).length - 1];
    return Object.assign({}, b, { titulo: d.titulo, pasta: p ? p.nome : '', versao: v ? v.v : 0, acesso: ok, arq: ok && v ? v.arq : null });
  }
  function pubExtra(conta, r) {
    const x = extra(r.id), ant = anterior(r), c = CFG();
    const gravs = (x.gravs || []).map(g => Object.assign({}, g, { porNome: nomeConta(g.por), expiraData: g.expira ? new Date(g.expira - 3 * 3600e3).toISOString().slice(0, 10) : '' }));
    return { reunId: r.id, docs: (x.docs || []).map(d => Object.assign({}, d, { porNome: nomeConta(d.por) })), links: x.links || [], bib: (x.bib || []).map(b => bibResolve(conta, b)), gravs,
      transcr: x.transcr || null, minuta: x.minuta || null, gere: gereReun(conta, r), admin: admin(conta),
      participantes: nomesPart(r), tarefas: tarefasDa(r.id).map(tarPub),
      anterior: ant ? { id: ant.id, titulo: ant.titulo, data: ant.data, ver: veReun(conta, ant), tarefas: veReun(conta, ant) ? tarefasDa(ant.id).filter(t => t.status !== 'cancelada').map(tarPub) : [] } : null,
      cfg: { audioDias: c.audioDias, gravMin: c.gravMin, gravMb: c.gravMb, parteS: c.parteS, docMb: c.docMb, transcricao: TR.fonteOpenAI().disponivel(), ia: !!process.env.ANTHROPIC_API_KEY, smtp: EMAIL.configurado() } };
  }

  /* ---------------- convite e lembrete ---------------- */
  function convite(conta, req, r) {
    const x = extra(r.id), docsN = (x.docs || []).map(d => d.nome).concat((x.bib || []).map(b => { const d = doc('bib168d/' + b.bibId); return d ? d.titulo : ''; })).filter(Boolean);
    const pl = pautaLinhas(r), lk = linkTxt(r);
    const linhas = [r.titulo, quando(r), lk ? 'Link da reunião: ' + lk : (r.plat === 'teams' ? 'Link do Teams: a ser enviado pelo organizador.' : ''), r.local ? 'Local: ' + r.local : '',
      pl.length ? 'Pauta:\n' + pl.join('\n') : '', docsN.length ? 'Documentos da reunião (na Agenda do sistema): ' + docsN.slice(0, 20).join(', ') : '', 'Organizador: ' + nomeConta(r.org)].filter(Boolean);
    const alvo = internos(r).filter(u => u !== conta.id || internos(r).length === 1);
    const nChat = avisarChat(alvo, 'Convite: ' + linhas.join('\n') + '\nAbra em Agenda › ' + r.titulo + '.');
    let nMail = 0; const smtp = EMAIL.configurado();
    if (smtp) {
      for (const u of alvo) { const c = q.contaPorId.get(u); if (c && c.ativo && enviarEmail(c.email, 'Convite: ' + r.titulo, linhas.concat(['Os documentos ficam na reunião, em Agenda de reuniões.']))) nMail++; }
      for (const e of externosDe(r)) if (e.email && enviarEmail(e.email, 'Convite: ' + r.titulo, linhas.filter(l => !/^Documentos da reunião/.test(l)))) nMail++;
    }
    const nr = Object.assign({}, doc('reun/' + r.id), { conv168: { em: Date.now(), por: conta.id, chat: nChat, email: nMail } }); grava('reun/' + r.id, nr);
    auditar(conta, req, 'REUNIAO_CONVITE_168', 'reun/' + r.id, null, { chat: nChat, email: nMail, smtp });
    return { ok: true, chat: nChat, email: nMail, smtp, msg: 'Convite enviado no chat a ' + nChat + ' pessoa(s)' + (smtp ? ' e por e-mail a ' + nMail + '.' : '. O e-mail não está configurado no servidor: use "E-mail aos de fora" ou "Copiar convite".') };
  }
  function lembretes() {
    const agora = Date.now(), c = CFG(); let n = 0;
    for (const r of col('reun')) {
      if (r.status !== 'agendada' || !dataOk(r.data)) continue;
      const min = r.lembrete === undefined || r.lembrete === null || r.lembrete === '' ? c.lembrete : +r.lembrete; if (!(min > 0)) continue;
      const t = tsReun(r); if (!(t - agora <= min * 60e3 && t - agora > -5 * 60e3)) continue;
      if (!avisoNovo('lem:' + r.id + ':' + r.data + 'T' + r.ini)) continue;
      n += avisarChat(internos(r), 'Lembrete: a reunião "' + r.titulo + '" começa às ' + r.ini + ' (' + fmtBr(r.data) + ').' + (linkTxt(r) ? '\nLink: ' + linkTxt(r) : '') + (r.local ? '\nLocal: ' + r.local : ''));
    }
    return n;
  }

  /* ---------------- gravação (partes enquanto grava) ---------------- */
  const dirGrav = g => path.join(DIR_G, g.replace(/[^A-Za-z0-9_-]/g, ''));
  function partesDe(g) { try { return fs.readdirSync(dirGrav(g)).filter(f => /^\d{5}\.part$/.test(f)).sort(); } catch (e) { return []; } }
  function tamPartes(g) { return partesDe(g).reduce((s, f) => s + fs.statSync(path.join(dirGrav(g), f)).size, 0); }
  function gravInicio(conta, req, r, b) {
    if (!gereReun(conta, r)) return erro('Só o organizador, o secretário da reunião ou o Administrador gravam.');
    if (r.status === 'cancelada') return erro('Reunião cancelada.', 409);
    const part = (Array.isArray(b.participantes) ? b.participantes : []).map(s => txt(s, 120)).filter(Boolean).slice(0, 80);
    if (b.aviso !== true || !part.length) return erro('Antes de gravar, confirme que os participantes foram avisados e concordaram (LGPD).', 400);
    const x = extra(r.id);
    if ((x.gravs || []).some(g => g.st === 'gravando' && Date.now() - (g.ult || g.ini) < 3 * 60e3)) return erro('Já há uma gravação em andamento nesta reunião.', 409);
    const g = { id: novoId('gr'), ini: Date.now(), ult: Date.now(), por: conta.id, modo: b.modo === 'online' ? 'online' : 'presencial', ct: /^audio\/(webm|ogg|mp4)/.test(String(b.ct || '')) ? String(b.ct).split(';')[0] : 'audio/webm',
      consent: { por: conta.id, nome: nomeConta(conta.id), em: Date.now(), participantes: part, texto: txt(b.texto || 'Participantes avisados de que a reunião será gravada (áudio), para transcrição e ata, e de quem pode acessar a gravação.', 600), sistemaAudio: !!b.sistemaAudio },
      st: 'gravando', partes: 0, tam: 0 };
    fs.mkdirSync(dirGrav(g.id), { recursive: true });
    x.gravs = (x.gravs || []).concat([g]); gravaExtra(x);
    auditar(conta, req, 'REUNIAO_GRAVACAO_INICIO_168', 'reunx168/' + r.id, null, { grav: g.id, modo: g.modo, participantes: part, consentEm: g.consent.em });
    const c = CFG(); return { ok: true, grav: g, maxMin: c.gravMin, maxMb: c.gravMb, parteS: c.parteS };
  }
  async function gravParte(conta, req, res, u) {
    const rid = String(u.searchParams.get('r') || ''), gid = String(u.searchParams.get('g') || ''), n = +u.searchParams.get('n');
    const r = reunDe(rid); if (!r || !veReun(conta, r)) return json(res, 404, { code: 'not_found', erro: 'Reunião não encontrada.' });
    const x = extra(rid), g = (x.gravs || []).find(y => y.id === gid);
    if (!g || g.por !== conta.id) return json(res, 404, { code: 'not_found', erro: 'Gravação não encontrada.' });
    if (g.st !== 'gravando') return json(res, 409, { code: 'conflict', erro: 'A gravação já foi encerrada.' });
    if (!Number.isInteger(n) || n < 0 || n > 99999) return json(res, 400, { code: 'invalid_argument', erro: 'Parte inválida.' });
    const c = CFG(); let b;
    try { b = await X.lerCorpo(req, 20 * 1024 * 1024); } catch (e) { return json(res, 413, { code: 'too_large', erro: 'Parte grande demais.' }); }
    if (!b.length) return json(res, 400, { code: 'invalid_argument', erro: 'Parte vazia.' });
    if (tamPartes(gid) + b.length > c.gravMb * 1024 * 1024) return json(res, 413, { code: 'too_large', erro: 'A gravação chegou ao tamanho máximo (' + c.gravMb + ' MB). Pare e comece outra.', parar: true });
    if (Date.now() - g.ini > (c.gravMin + 2) * 60e3) return json(res, 413, { code: 'too_large', erro: 'A gravação chegou à duração máxima (' + c.gravMin + ' min). Pare e comece outra.', parar: true });
    fs.writeFileSync(path.join(dirGrav(gid), String(n).padStart(5, '0') + '.part'), b);
    const x2 = extra(rid), g2 = (x2.gravs || []).find(y => y.id === gid); if (g2) { g2.ult = Date.now(); g2.partes = partesDe(gid).length; g2.tam = tamPartes(gid); gravaExtra(x2); }
    return json(res, 200, { ok: true, n, tam: g2 ? g2.tam : 0 });
  }
  function gravFim(conta, req, r, gid, dur, interrompida) {
    const x = extra(r.id), g = (x.gravs || []).find(y => y.id === gid);
    if (!g) return erro('Gravação não encontrada.', 404);
    if (conta && g.por !== conta.id && !gereReun(conta, r)) return erro('Só quem gravou, o organizador ou o Administrador encerram a gravação.');
    if (g.st !== 'gravando') return { ok: true, grav: g };
    const ps = partesDe(gid);
    if (!ps.length) { g.st = 'vazia'; g.fim = Date.now(); gravaExtra(x); try { fs.rmSync(dirGrav(gid), { recursive: true, force: true }); } catch (e) { } return { ok: true, grav: g }; }
    const id = crypto.randomBytes(16).toString('hex'), dest = path.join(DATA, 'blobs', id);
    const fd = fs.openSync(dest, 'w'); let tam = 0;
    try { for (const f of ps) { const b = fs.readFileSync(path.join(dirGrav(gid), f)); fs.writeSync(fd, b); tam += b.length; } } finally { fs.closeSync(fd); }
    q.arqNovo.run(id, g.ct || 'audio/webm', tam, g.por, Date.now()); stOrig.run('reunx168/' + r.id, id);
    const c = CFG();
    Object.assign(g, { st: interrompida ? 'interrompida' : 'pronta', fim: Date.now(), audio: id, tam, partes: ps.length, dur: Math.max(0, Math.round(+dur || 0)) || Math.round((g.ult - g.ini) / 1000), expira: Date.now() + c.audioDias * 864e5 });
    gravaExtra(x); try { fs.rmSync(dirGrav(gid), { recursive: true, force: true }); } catch (e) { }
    auditar(conta, req, interrompida ? 'REUNIAO_GRAVACAO_INTERROMPIDA_168' : 'REUNIAO_GRAVACAO_FIM_168', 'reunx168/' + r.id, null, { grav: gid, partes: ps.length, kb: Math.round(tam / 1024), dur: g.dur });
    return { ok: true, grav: g };
  }
  function apagarAudio(g, motivo) {
    if (!g.audio) return false;
    try { fs.rmSync(path.join(DATA, 'blobs', g.audio), { force: true }); } catch (e) { }
    try { fs.rmSync(path.join(DATA, 'blobs', 'lixo', g.audio), { force: true }); } catch (e) { }
    try { q.arqDel.run(g.audio); } catch (e) { }
    g.audioApagado = g.audio; g.audio = null; g.st = 'apagada'; g.apagadoEm = Date.now(); g.apagadoMotivo = motivo; return true;
  }
  /* gravação parada sem "fim" (aba fechada, queda): depois de 15 min sem parte nova, vira "interrompida" com o que chegou */
  function gravacoesParadas() {
    let n = 0;
    for (const x of col('reunx168')) for (const g of (x.gravs || [])) if (g.st === 'gravando' && Date.now() - (g.ult || g.ini) > 15 * 60e3) { const r = reunDe(x.reunId); if (r && !gravFim(null, null, r, g.id, 0, true).erro) n++; }
    return n;
  }
  function retencao() {
    let n = 0; const agora = Date.now();
    for (const x of col('reunx168')) { let mud = false; for (const g of (x.gravs || [])) if (g.audio && g.expira && g.expira <= agora) { if (apagarAudio(g, 'prazo')) { mud = true; n++; auditar(null, null, 'REUNIAO_AUDIO_APAGADO_168', 'reunx168/' + x.reunId, null, { grav: g.id, motivo: 'prazo de ' + CFG().audioDias + ' dias' }); } } if (mud) gravaExtra(x); }
    return n;
  }

  /* ---------------- transcrição (em segundo plano, um de cada vez) ---------------- */
  let FONTES = TR.fontes(), ocupado = false;
  const setFontes = f => { FONTES = Object.assign(TR.fontes(), f || {}); };
  function pedirTranscricao(conta, req, r, gid) {
    if (!gereReun(conta, r)) return erro('Só o organizador, o secretário ou o Administrador pedem a transcrição.');
    const x = extra(r.id), g = (x.gravs || []).find(y => y.id === gid) || (x.gravs || []).filter(y => y.audio).slice(-1)[0];
    if (!g || !g.audio) return erro('Não há áudio para transcrever (a gravação não terminou ou o áudio já foi apagado).', 409);
    const f = FONTES.openai;
    if (!f.disponivel()) { x.transcr = Object.assign({}, x.transcr || {}, { st: 'erro', erro: f.erroIndisponivel, gravId: g.id, em: Date.now() }); gravaExtra(x); return erro(f.erroIndisponivel, 503); }
    if (x.transcr && ['fila', 'transcrevendo'].includes(x.transcr.st)) return erro('A transcrição já está na fila.', 409);
    x.transcr = { st: 'fila', fonte: 'openai', gravId: g.id, por: conta.id, pedidoEm: Date.now(), tent: ((x.transcr && x.transcr.gravId === g.id && x.transcr.tent) || 0), texto: (x.transcr && x.transcr.texto) || '', segs: (x.transcr && x.transcr.segs) || [] };
    gravaExtra(x); auditar(conta, req, 'REUNIAO_TRANSCRICAO_PEDIDA_168', 'reunx168/' + r.id, null, { grav: g.id });
    setImmediate(trabalhar);
    return { ok: true, transcr: x.transcr };
  }
  async function trabalhar() {
    if (ocupado) return; ocupado = true;
    try {
      for (;;) {
        const x = col('reunx168').find(y => y.transcr && y.transcr.st === 'fila'); if (!x) break;
        const g = (x.gravs || []).find(y => y.id === x.transcr.gravId);
        x.transcr.st = 'transcrevendo'; x.transcr.ini = Date.now(); x.transcr.tent = (x.transcr.tent || 0) + 1; gravaExtra(x);
        let fim;
        try {
          if (!g || !g.audio) throw { msg: 'O áudio não existe mais.' };
          const r = await FONTES.openai.transcrever({ caminho: path.join(DATA, 'blobs', g.audio), ct: g.ct, durMs: (g.dur || 0) * 1000 }, (i, n) => { const y = extra(x.reunId); if (y.transcr && y.transcr.st === 'transcrevendo') { y.transcr.prog = { i: i + 1, n }; gravaExtra(y); } });
          fim = { st: 'pronto', texto: String(r.texto || '').slice(0, 600000), segs: (r.segmentos || []).slice(0, 20000), partes: r.partes || 1, modelo: r.modelo || '', erro: '' };
          auditar(x.transcr.por, null, 'REUNIAO_TRANSCRICAO_168', 'reunx168/' + x.reunId, null, { grav: g.id, partes: fim.partes, modelo: fim.modelo, caracteres: fim.texto.length, ok: true });
        } catch (e) {
          fim = { st: 'erro', erro: String((e && (e.msg || e.message)) || 'Falha na transcrição.').slice(0, 400) };
          auditar(x.transcr.por, null, 'REUNIAO_TRANSCRICAO_168', 'reunx168/' + x.reunId, null, { grav: g && g.id, ok: false, erro: fim.erro });
        }
        const y = extra(x.reunId); y.transcr = Object.assign({}, y.transcr, fim, { fonte: 'openai', em: Date.now() }); delete y.transcr.prog;
        if (fim.st === 'erro') { y.transcr.texto = (x.transcr && x.transcr.texto) || ''; }
        gravaExtra(y);
        if (fim.st === 'pronto') { const r = reunDe(x.reunId); if (r) avisarChat(uniq([y.transcr.por, r.org, r.secretario]), 'A transcrição da reunião "' + r.titulo + '" (' + fmtBr(r.data) + ') está pronta. Abra a reunião na Agenda para gerar a minuta da ata.'); }
      }
    } catch (e) { console.error('[v168] transcrição:', e.message); }
    finally { ocupado = false; }
  }
  function importarTranscricao(conta, req, r, b) {
    if (!gereReun(conta, r)) return erro('Só o organizador, o secretário ou o Administrador importam a transcrição.');
    let res;
    try {
      if (b.arq) { const a = arqDaConta(conta, b.arq, 20, null); if (a.erro) return erro(a.erro, a.st || 400); const buf = fs.readFileSync(path.join(DATA, 'blobs', a.arq.id)); res = TR.importarArquivo(a.arq.nome, buf); a.origem('reunx168/' + r.id); }
      else res = TR.importarTexto(txt(b.nome || 'colado.txt', 80), String(b.texto || '').slice(0, 2e6));
    } catch (e) { return erro((e && (e.msg || e.message)) || 'Não foi possível ler a transcrição.', (e && e.st) || 400); }
    const x = extra(r.id);
    x.transcr = { st: 'pronto', fonte: 'manual', arquivo: b.arq ? txt(b.arq.nome, 140) : 'texto colado', por: conta.id, em: Date.now(), texto: res.texto, segs: res.segmentos, erro: '' };
    gravaExtra(x); auditar(conta, req, 'REUNIAO_TRANSCRICAO_IMPORTADA_168', 'reunx168/' + r.id, null, { arquivo: x.transcr.arquivo, trechos: res.segmentos.length });
    return { ok: true, transcr: x.transcr };
  }

  /* ---------------- ata pela IA (minuta) ---------------- */
  const jsonDe = t => { t = String(t || ''); try { return JSON.parse(t); } catch (e) { } const a = t.indexOf('{'), z = t.lastIndexOf('}'); if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (e) { } } return null; };
  const mmss = ms => { const s = Math.floor((+ms || 0) / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s % 60).padStart(2, '0'); };
  function promptAta(r, tr) {
    const it = Array.isArray(r.pautaItens) && r.pautaItens.length ? r.pautaItens.map(x => JSON.stringify({ id: x.id, titulo: x.titulo, responsavel: x.resp || null, minutos: x.min || null })) : pautaLinhas(r).map((l, i) => JSON.stringify({ id: 'p' + (i + 1), titulo: l }));
    const nomes = nomesPart(r).map(p => p.nome);
    const fala = (tr.segs && tr.segs.length ? tr.segs.map(s => (s.ini != null ? '[' + mmss(s.ini) + '] ' : '') + (s.quem ? s.quem + ': ' : '') + s.t).join('\n') : String(tr.texto || '')).slice(0, 400000);
    return 'Você vai redigir a minuta da ata de uma reunião de trabalho a partir da transcrição abaixo.\n\n' +
      'Participantes (nomes): ' + JSON.stringify(nomes) + '\n\nPauta (um item por linha, JSON):\n' + (it.join('\n') || '(sem pauta)') + '\n\n' +
      'Transcrição:\n"""\n' + fala + '\n"""\n\n' +
      'Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois e sem markdown, exatamente neste formato:\n' +
      '{"resumo":"resumo objetivo da reunião","assuntos":[{"pauta":"id do item da pauta (ou null se o assunto não estava na pauta)","titulo":"assunto","texto":"o que foi tratado"}],' +
      '"decisoes":["decisão tomada"],"acoes":[{"descricao":"o que fazer","responsavel":"nome EXATAMENTE como na lista de participantes, ou null","prazo":"AAAA-MM-DD só se uma data completa foi dita, senão null","prazo_dias":"número de dias corridos após a reunião, se o prazo foi dito de forma relativa (ex.: semana que vem = 7), senão null","prioridade":"alta, media ou baixa"}],' +
      '"pendencias":["assunto que ficou em aberto"],"proximos_passos":["próximo passo"]}\n\n' +
      'Regras: escreva em português do Brasil, de forma impessoal e objetiva. Um item em "assuntos" para cada item da pauta tratado (use o id da pauta). ' +
      'Não invente decisões, responsáveis ou prazos que não estejam na transcrição: o que não foi dito fica null. Cada ação deve ser concreta e ter um único responsável.';
  }
  function normMinuta(j, r) {
    const P = nomesPart(r), us = col('usr').filter(u => u && u.uid && u.ativo !== false);
    const achaResp = nome => {
      const n = norm(nome); if (!n) return { resp: '', respNome: '' };
      const p = P.find(x => norm(x.nome) === n) || P.find(x => norm(x.nome).split(' ')[0] === n.split(' ')[0] && (n.split(' ').length === 1 || norm(x.nome).includes(n)));
      if (p) return p.interno ? { resp: p.k, respNome: '' } : { resp: '', respNome: p.nome };
      const u = us.find(x => norm(nomeConta(x.uid)) === n); if (u) return { resp: u.uid, respNome: '' };
      return { resp: '', respNome: txt(nome, 80), semMatch: true };
    };
    const pautaIds = new Set((r.pautaItens || []).map(x => x.id)), lst = (v, n) => (Array.isArray(v) ? v : v ? [v] : []).map(s => txt(typeof s === 'string' ? s : (s && (s.texto || s.descricao)) || '', n || 600)).filter(Boolean).slice(0, 60);
    const acoes = (Array.isArray(j.acoes) ? j.acoes : []).filter(a => a && typeof a === 'object').slice(0, 80).map(a => {
      const rs = achaResp(a.responsavel), dias = parseInt(a.prazo_dias, 10);
      const prazo = dataOk(a.prazo) ? a.prazo : (isFinite(dias) && dias > 0 && dias < 1000 && dataOk(r.data) ? maisDias(r.data, dias) : '');
      const pr = norm(a.prioridade); return Object.assign({ id: novoId('ac'), descricao: txt(a.descricao, 500), prazo, prioridade: /alt/.test(pr) ? 'alta' : /baix/.test(pr) ? 'baixa' : 'media' }, rs);
    }).filter(a => a.descricao);
    return { resumo: txtL(j.resumo, 6000), assuntos: (Array.isArray(j.assuntos) ? j.assuntos : []).filter(a => a && typeof a === 'object').slice(0, 60).map(a => ({ pautaId: pautaIds.has(String(a.pauta)) ? String(a.pauta) : '', titulo: txt(a.titulo, 200), texto: txtL(a.texto, 6000) })).filter(a => a.titulo || a.texto),
      decisoes: lst(j.decisoes), acoes, pendencias: lst(j.pendencias), proximos: lst(j.proximos_passos || j.proximos) };
  }
  async function gerarAta(conta, req, r) {
    if (!gereReun(conta, r)) return erro('Só o organizador, o secretário ou o Administrador geram a minuta.');
    const x = extra(r.id); if (x.minuta && x.minuta.st === 'aprovada') return erro('A ata já foi aprovada.', 409);
    const tr = x.transcr; if (!tr || tr.st !== 'pronto' || !(tr.texto || '').trim()) return erro('Falta a transcrição: grave e transcreva, ou importe a transcrição do Teams/Meet.', 409);
    const pr = promptAta(r, tr), corpoAud = { input: pr, modelTier: 'complex', funcao: 'ata-reuniao' };
    let resp;
    try { resp = await X.ia({ input: pr }, { tier: 'complex' }); }
    catch (e) {
      X.auditarIa(conta, req, corpoAud, false, e.msg || e.message); auditar(conta, req, 'REUNIAO_ATA_IA_168', 'reunx168/' + r.id, null, { ok: false, erro: String(e.msg || e.message || '').slice(0, 200) });
      return erro(e.st === 503 ? 'A IA não está configurada no servidor. Peça ao administrador para ligar a IA (ANTHROPIC_API_KEY), ou escreva a ata à mão.' : e.st === 429 ? 'A IA está com muitos pedidos agora (limite de uso). Tente de novo em alguns minutos.' : (e.msg || 'Falha na IA.'), e.st === 503 ? 503 : e.st === 429 ? 429 : 502);
    }
    const j = jsonDe(resp && resp.text);
    if (!j || typeof j !== 'object') { X.auditarIa(conta, req, corpoAud, false, 'resposta fora do formato'); auditar(conta, req, 'REUNIAO_ATA_IA_168', 'reunx168/' + r.id, null, { ok: false, erro: 'resposta fora do formato' }); return erro('A IA não devolveu a ata no formato esperado. Tente de novo ou escreva a ata à mão.', 502); }
    const m = normMinuta(j, r);
    X.auditarIa(conta, req, corpoAud, true); auditar(conta, req, 'REUNIAO_ATA_IA_168', 'reunx168/' + r.id, null, { ok: true, acoes: m.acoes.length, decisoes: m.decisoes.length, semResponsavel: m.acoes.filter(a => !a.resp && !a.respNome).length });
    const y = extra(r.id);
    y.minuta = Object.assign(m, { st: 'rascunho', ia: true, geradaEm: Date.now(), geradaPor: conta.id, presentes: (y.minuta && y.minuta.presentes) || presentesPadrao(r, y), truncado: !!(resp && resp.truncated) });
    gravaExtra(y); return { ok: true, minuta: y.minuta };
  }
  function presentesPadrao(r, x) { const g = (x.gravs || []).slice(-1)[0], cons = g && g.consent ? g.consent.participantes.map(norm) : null; return nomesPart(r).filter(p => !cons || cons.includes(norm(p.nome))).map(p => p.k); }
  function limpaMinuta(m, r, velha) {
    const P = new Set(nomesPart(r).map(p => p.k)), pautaIds = new Set((r.pautaItens || []).map(x => x.id));
    const lst = v => (Array.isArray(v) ? v : String(v || '').split('\n')).map(s => txt(s, 600)).filter(Boolean).slice(0, 60);
    const acoes = (Array.isArray(m.acoes) ? m.acoes : []).slice(0, 80).filter(a => a && typeof a === 'object').map(a => ({ id: ID_OK.test(String(a.id || '')) ? String(a.id) : novoId('ac'), descricao: txt(a.descricao, 500), resp: ID_OK.test(String(a.resp || '')) && q.contaPorId.get(String(a.resp)) ? String(a.resp) : '', respNome: a.resp ? '' : txt(a.respNome, 80), prazo: dataOk(a.prazo) ? a.prazo : '', prioridade: ['alta', 'media', 'baixa'].includes(a.prioridade) ? a.prioridade : 'media', pautaId: pautaIds.has(String(a.pautaId)) ? String(a.pautaId) : '' })).filter(a => a.descricao);
    return Object.assign({}, velha || {}, { resumo: txtL(m.resumo, 8000), assuntos: (Array.isArray(m.assuntos) ? m.assuntos : []).slice(0, 60).filter(a => a && typeof a === 'object').map(a => ({ pautaId: pautaIds.has(String(a.pautaId)) ? String(a.pautaId) : '', titulo: txt(a.titulo, 200), texto: txtL(a.texto, 8000) })).filter(a => a.titulo || a.texto),
      decisoes: lst(m.decisoes), acoes, pendencias: lst(m.pendencias), proximos: lst(m.proximos), presentes: (Array.isArray(m.presentes) ? m.presentes : []).map(String).filter(k => P.has(k)), st: 'rascunho' });
  }
  function salvarAta(conta, req, r, m) {
    if (!gereReun(conta, r)) return erro('Só o organizador, o secretário ou o Administrador editam a minuta.');
    const x = extra(r.id); if (x.minuta && x.minuta.st === 'aprovada') return erro('A ata já foi aprovada e não muda mais.', 409);
    x.minuta = Object.assign(limpaMinuta(m || {}, r, x.minuta), { editadaEm: Date.now(), editadaPor: conta.id, ia: !!(x.minuta && x.minuta.ia) });
    gravaExtra(x); auditar(conta, req, 'REUNIAO_ATA_EDITADA_168', 'reunx168/' + r.id, null, { acoes: x.minuta.acoes.length }); return { ok: true, minuta: x.minuta };
  }
  function aprovarAta(conta, req, r, m) {
    if (!gereReun(conta, r)) return erro('Só o organizador, o secretário ou o Administrador aprovam a ata.');
    const x = extra(r.id); if (x.minuta && x.minuta.st === 'aprovada') return erro('A ata já foi aprovada.', 409);
    const mm = limpaMinuta(m || x.minuta || {}, r, x.minuta);
    if (!mm.resumo && !mm.assuntos.length && !mm.decisoes.length) return erro('A ata está vazia: escreva ao menos o resumo ou os assuntos tratados.', 400);
    if (!mm.presentes.length) return erro('Marque quem esteve presente.', 400);
    const falta = mm.acoes.filter(a => (!a.resp && !a.respNome) || !a.prazo);
    if (falta.length) return erro('Toda ação precisa de responsável e prazo. Falta em: ' + falta.slice(0, 3).map(a => '"' + a.descricao.slice(0, 60) + '"').join(', ') + (falta.length > 3 ? ' e mais ' + (falta.length - 3) : '') + '.', 400);
    const agora = Date.now(), pauta = new Map((r.pautaItens || []).map(p => [p.id, p.titulo])), criadas = [];
    db.exec('BEGIN');
    try {
      for (const a of mm.acoes) {
        const t = { id: novoId('tr'), reunId: r.id, reunTitulo: r.titulo, reunData: r.data, serie: txt(r.serie, 120), acaoId: a.id, pautaId: a.pautaId || '', assunto: a.pautaId ? (pauta.get(a.pautaId) || '') : '', descricao: a.descricao, resp: a.resp, respNome: a.respNome, prazo: a.prazo, prioridade: a.prioridade,
          status: 'afazer', notas: [], evid: [], org: r.org, crBy: conta.id, cr: agora, hist: [{ em: agora, por: conta.id, st: 'afazer', txt: 'Criada pela aprovação da ata' }] };
        q.docPut.run('tar168/' + t.id, 'tar168', t.id, JSON.stringify(t), agora); criadas.push(t);
      }
      x.minuta = Object.assign(mm, { st: 'aprovada', aprovEm: agora, aprovPor: conta.id, assin: [], tarefas: criadas.map(t => t.id) }); x.em = agora;
      q.docPut.run('reunx168/' + r.id, 'reunx168', r.id, JSON.stringify(x), agora);
      const nr = Object.assign({}, doc('reun/' + r.id), { ata168: { em: agora, por: conta.id }, status: r.status === 'cancelada' ? 'cancelada' : 'realizada' });
      q.docPut.run('reun/' + r.id, 'reun', r.id, JSON.stringify(nr), agora);
      db.exec('COMMIT');
      for (const t of criadas) avisarDoc('set', 'tar168/' + t.id, t, agora); avisarDoc('set', 'reunx168/' + r.id, x, agora); avisarDoc('set', 'reun/' + r.id, nr, agora);
    } catch (e) { try { db.exec('ROLLBACK'); } catch (z) { } return erro('Falha ao gravar a ata. Nada foi gravado; tente de novo.', 500); }
    auditar(conta, req, 'REUNIAO_ATA_APROVADA_168', 'reunx168/' + r.id, null, { tarefas: criadas.length, presentes: mm.presentes.length, ia: !!mm.ia });
    for (const t of criadas) if (t.resp && avisoNovo('tar:nova:' + t.id)) avisarChat([t.resp], 'Nova tarefa da reunião "' + r.titulo + '" (' + fmtBr(r.data) + '): ' + t.descricao + '\nPrazo: ' + fmtBr(t.prazo) + '. Veja em Minha área › Minhas tarefas.');
    const pres = new Set(mm.presentes); avisarChat(internos(r).filter(u => pres.has(u) && u !== conta.id), 'A ata da reunião "' + r.titulo + '" (' + fmtBr(r.data) + ') foi aprovada. Abra a reunião na Agenda para ler e assinar.');
    return { ok: true, minuta: x.minuta, tarefas: criadas.length };
  }
  function assinarAta(conta, req, r) {
    const x = extra(r.id); if (!x.minuta || x.minuta.st !== 'aprovada') return erro('A ata ainda não foi aprovada.', 409);
    if (!(x.minuta.presentes || []).includes(conta.id)) return erro('Só quem esteve presente assina a ata.', 403);
    if ((x.minuta.assin || []).some(a => a.uid === conta.id)) return { ok: true, minuta: x.minuta, ja: true };
    x.minuta.assin = (x.minuta.assin || []).concat([{ uid: conta.id, nome: nomeConta(conta.id), em: Date.now() }]); gravaExtra(x);
    auditar(conta, req, 'REUNIAO_ATA_ASSINADA_168', 'reunx168/' + r.id, null, null); return { ok: true, minuta: x.minuta };
  }

  /* ---------------- tarefas ---------------- */
  const ST_TAR = { afazer: 'A fazer', andamento: 'Em andamento', concluida: 'Concluída', cancelada: 'Cancelada' };
  function listaTarefas(conta, f) {
    let l = col('tar168').filter(t => veTarefa(conta, t));
    if (f.minhas) l = l.filter(t => t.resp === conta.id);
    return l.map(tarPub).sort((a, b) => (a.status === 'concluida' || a.status === 'cancelada' ? 1 : 0) - (b.status === 'concluida' || b.status === 'cancelada' ? 1 : 0) || String(a.prazo).localeCompare(String(b.prazo)));
  }
  function alterarTarefa(conta, req, b) {
    const t = doc('tar168/' + String(b.id || '')); if (!t || !veTarefa(conta, t)) return erro('Tarefa não encontrada.', 404);
    const r = reunDe(t.reunId), gere = admin(conta) || t.org === conta.id || (r && gereReun(conta, r)), dono = t.resp === conta.id;
    if (!gere && !dono) return erro('Só o responsável, o organizador da reunião ou o Administrador alteram a tarefa.');
    const n = Object.assign({}, t), agora = Date.now(), hist = (n.hist || []).slice(-100);
    if (b.status !== undefined) {
      if (!ST_TAR[b.status]) return erro('Situação inválida.', 400);
      if (b.status === 'cancelada' && !gere) return erro('Só o organizador ou o Administrador cancelam a tarefa.');
      if (b.status !== n.status) { n.status = b.status; if (b.status === 'concluida') { n.concluidaEm = agora; n.concluidaPor = conta.id; } else delete n.concluidaEm; hist.push({ em: agora, por: conta.id, st: b.status }); }
    }
    if (b.nota) { const tx = txtL(b.nota, 2000); if (tx) { n.notas = (n.notas || []).concat([{ em: agora, por: conta.id, nome: nomeConta(conta.id), txt: tx }]).slice(-200); hist.push({ em: agora, por: conta.id, txt: 'Nota' }); } }
    if (Array.isArray(b.evid) && b.evid.length) {
      for (const a of b.evid.slice(0, 10)) { const v = arqDaConta(conta, a, 25, ['pdf', 'png', 'jpg', 'webp', 'xlsx', 'docx', 'pptx']); if (v.erro) return erro(v.erro, v.st || 400); v.origem('tar168/' + n.id); n.evid = (n.evid || []).concat([Object.assign(v.arq, { por: conta.id, em: agora })]).slice(-50); }
      hist.push({ em: agora, por: conta.id, txt: 'Evidência anexada' });
    }
    if (gere) {
      if (b.prazo !== undefined) { if (!dataOk(b.prazo)) return erro('Prazo inválido.', 400); if (b.prazo !== n.prazo) { hist.push({ em: agora, por: conta.id, txt: 'Prazo: ' + fmtBr(n.prazo) + ' → ' + fmtBr(b.prazo) }); n.prazo = b.prazo; } }
      if (b.resp !== undefined && b.resp !== n.resp) { const u = String(b.resp || ''); if (u && !q.contaPorId.get(u)) return erro('Responsável inválido.', 400); hist.push({ em: agora, por: conta.id, txt: 'Responsável: ' + (n.resp ? nomeConta(n.resp) : n.respNome) + ' → ' + (u ? nomeConta(u) : txt(b.respNome, 80)) }); n.resp = u; n.respNome = u ? '' : txt(b.respNome, 80); if (u && u !== conta.id) avisarChat([u], 'Você é o responsável pela tarefa da reunião "' + n.reunTitulo + '": ' + n.descricao + '\nPrazo: ' + fmtBr(n.prazo) + '.'); }
    } else if (b.prazo !== undefined || b.resp !== undefined) return erro('Prazo e responsável só o organizador da reunião ou o Administrador mudam.');
    n.hist = hist; n.alt = agora; n.altPor = conta.id;
    grava('tar168/' + n.id, n); auditar(conta, req, 'REUNIAO_TAREFA_168', 'tar168/' + n.id, { status: t.status, prazo: t.prazo, resp: t.resp }, { status: n.status, prazo: n.prazo, resp: n.resp });
    return { ok: true, tarefa: tarPub(n) };
  }
  function avisosTarefas() {
    const h = hojeBr(), d2 = maisDias(h, 2); let n = 0;
    for (const t of col('tar168')) {
      if (!['afazer', 'andamento'].includes(t.status) || !dataOk(t.prazo)) continue;
      if (t.prazo === d2 && t.resp && avisoNovo('tar:d2:' + t.id + ':' + t.prazo)) n += avisarChat([t.resp], 'Faltam 2 dias para o prazo da tarefa ' + deOnde(t) + ': ' + t.descricao + ' (prazo ' + fmtBr(t.prazo) + ').');
      if (t.prazo < h && avisoNovo('tar:atraso:' + t.id + ':' + t.prazo)) n += avisarChat(uniq([t.resp, t.org]), 'Tarefa atrasada ' + deOnde(t) + ': ' + t.descricao + ' — prazo era ' + fmtBr(t.prazo) + (t.resp ? '' : ' (responsável de fora: ' + (t.respNome || '—') + ')') + '. Responsável: ' + (t.resp ? nomeConta(t.resp) : t.respNome || '—') + '.');
    }
    return n;
  }

  /* v169: tarefa avulsa (sem reunião), criada pela própria pessoa (ex.: proposta de um assistente de IA confirmada no chat).
     Para outra pessoa só quem grava na Agenda; quem cria é o "organizador" (vê, muda prazo e responsável, cancela). */
  const deOnde = t => t.reunId ? 'da reunião "' + t.reunTitulo + '"' : '(' + (t.reunTitulo || 'tarefa avulsa') + ')';
  function novaTarefa(conta, req, b) {
    const descricao = txtL(b.descricao, 2000); if (!descricao) return erro('Descreva a tarefa.', 400);
    const resp = String(b.resp || conta.id); if (!ID_OK.test(resp) || !q.contaPorId.get(resp)) return erro('Responsável inválido.', 400);
    if (resp !== conta.id && !podeAgenda(conta)) return erro('Seu perfil não grava na Agenda: crie a tarefa para você mesmo.');
    if (!dataOk(b.prazo)) return erro('Prazo inválido.', 400);
    const pri = ['alta', 'media', 'baixa'].includes(b.prioridade) ? b.prioridade : 'media', agora = Date.now();
    const o = b.origem && typeof b.origem === 'object' ? { tipo: txt(b.origem.tipo, 20), asst: txt(b.origem.asst, 30), nome: txt(b.origem.nome, 80) } : null;
    const t = { id: novoId('tr'), reunId: '', reunTitulo: o && o.nome ? o.nome : 'Tarefa avulsa', reunData: hojeBr(), serie: '', acaoId: '', pautaId: '', assunto: '', descricao, resp, respNome: '', prazo: b.prazo, prioridade: pri,
      status: 'afazer', notas: [], evid: [], org: conta.id, crBy: conta.id, cr: agora, origem: o, hist: [{ em: agora, por: conta.id, st: 'afazer', txt: o && o.tipo === 'ia169' ? 'Criada ao confirmar uma proposta do ' + o.nome : 'Criada' }] };
    grava('tar168/' + t.id, t); auditar(conta, req, 'REUNIAO_TAREFA_NOVA_168', 'tar168/' + t.id, null, { resp, prazo: t.prazo, origem: o ? o.tipo : '' });
    if (resp !== conta.id && avisoNovo('tar:nova:' + t.id)) avisarChat([resp], 'Nova tarefa para você (' + t.reunTitulo + '): ' + descricao + '\nPrazo: ' + fmtBr(t.prazo) + '. Veja em Minha área › Minhas tarefas.');
    return { ok: true, tarefa: tarPub(t) };
  }

  /* ---------------- busca nas atas e transcrições ---------------- */
  function busca(conta, termo) {
    const t = norm(termo); if (t.length < 3) return { erro: 'Digite ao menos 3 letras.', st: 400 };
    const pals = t.split(' ').filter(Boolean).slice(0, 6), out = [];
    const trecho = (s, i) => { const a = Math.max(0, i - 90); return (a ? '…' : '') + s.slice(a, i + 160).replace(/\s+/g, ' ') + (i + 160 < s.length ? '…' : ''); };
    const casa = s => { const n = norm(s); return pals.every(p => n.includes(p)) ? n.indexOf(pals[0]) : -1; };
    for (const r of col('reun')) {
      if (!veReun(conta, r)) continue;
      const x = doc('reunx168/' + r.id) || {}, achados = [];
      if (x.minuta && x.minuta.st === 'aprovada') { const m = x.minuta, s = [m.resumo].concat((m.assuntos || []).map(a => a.titulo + ': ' + a.texto), m.decisoes || [], (m.acoes || []).map(a => a.descricao), m.pendencias || [], m.proximos || []).join('\n'); const i = casa(s); if (i >= 0) achados.push({ onde: 'ata', trecho: trecho(s.normalize('NFC'), i) }); }
      else if (r.ata) { const i = casa(r.ata); if (i >= 0) achados.push({ onde: 'ata', trecho: trecho(String(r.ata), i) }); }
      if (x.transcr && x.transcr.texto) {
        const segs = x.transcr.segs || []; let hit = null;
        for (const s of segs) { if (casa((s.quem || '') + ' ' + s.t) >= 0) { hit = s; break; } }
        if (hit) achados.push({ onde: 'transcrição', trecho: (hit.quem ? hit.quem + ': ' : '') + hit.t.slice(0, 260), ms: hit.ini });
        else { const i = casa(x.transcr.texto); if (i >= 0) achados.push({ onde: 'transcrição', trecho: trecho(x.transcr.texto, i) }); }
      }
      for (const a of achados) out.push({ reunId: r.id, titulo: r.titulo, data: r.data, ini: r.ini, onde: a.onde, trecho: a.trecho, ms: a.ms == null ? null : a.ms });
      if (out.length >= 80) break;
    }
    out.sort((a, b) => String(b.data).localeCompare(String(a.data)));
    return { ok: true, itens: out };
  }

  /* ---------------- biblioteca ---------------- */
  function biblioteca(conta) {
    const ps = col('bib168p').filter(p => acessoPasta(conta, p)), ids = new Set(ps.map(p => p.id));
    const ds = col('bib168d').filter(d => ids.has(d.pastaId)).map(d => Object.assign({}, d, { versoes: (d.versoes || []).map(v => Object.assign({}, v, { porNome: nomeConta(v.por) })) }));
    return { ok: true, pastas: ps.map(p => Object.assign({}, p, { edita: admin(conta) || p.crBy === conta.id })), docs: ds, admin: admin(conta) };
  }
  const podeAgenda = conta => admin(conta) || X.gravaGrupo(conta, 'agenda');
  function salvarPasta(conta, req, b) {
    if (!podeAgenda(conta)) return erro('Seu perfil não grava na Agenda.');
    const id = b.id ? String(b.id) : novoId('bp'); if (!ID_OK.test(id)) return erro('Identificador inválido.', 400);
    const velha = b.id ? doc('bib168p/' + id) : null; if (b.id && !velha) return erro('Pasta não encontrada.', 404);
    if (velha && !(admin(conta) || velha.crBy === conta.id)) return erro('Só quem criou a pasta ou o Administrador muda a pasta e o acesso.');
    const nome = txt(b.nome, 120); if (!nome) return erro('Dê um nome à pasta.', 400);
    const a = b.acesso || {}, modo = ['todos', 'perfis', 'usuarios'].includes(a.modo) ? a.modo : 'todos';
    const acesso = { modo, perfis: modo === 'perfis' ? uniq((Array.isArray(a.perfis) ? a.perfis : []).map(s => txt(s, 40))).slice(0, 40) : [], usuarios: modo === 'usuarios' ? uniq((Array.isArray(a.usuarios) ? a.usuarios : []).filter(u => ID_OK.test(String(u)) && q.contaPorId.get(String(u)))).slice(0, 200) : [] };
    if (modo === 'perfis' && !acesso.perfis.length) return erro('Escolha ao menos um perfil.', 400);
    if (modo === 'usuarios' && !acesso.usuarios.length) return erro('Escolha ao menos um usuário.', 400);
    const projId = b.projId && ID_OK.test(String(b.projId)) && doc('proj/' + b.projId) ? String(b.projId) : '';
    const p = Object.assign({}, velha || { id, crBy: conta.id, cr: Date.now() }, { nome, assunto: txt(b.assunto, 120), projId, acesso });
    grava('bib168p/' + id, p); auditar(conta, req, velha ? 'BIBLIOTECA_PASTA_ALTERADA_168' : 'BIBLIOTECA_PASTA_168', 'bib168p/' + id, velha ? { acesso: velha.acesso } : null, { nome, acesso });
    return { ok: true, pasta: p };
  }
  function salvarDocBib(conta, req, b) {
    if (!podeAgenda(conta)) return erro('Seu perfil não grava na Agenda.');
    const velho = b.id ? doc('bib168d/' + String(b.id)) : null; if (b.id && !velho) return erro('Documento não encontrado.', 404);
    const pastaId = String(b.pastaId || (velho && velho.pastaId) || ''), p = doc('bib168p/' + pastaId);
    if (!p || !acessoPasta(conta, p)) return erro('Pasta não encontrada ou sem acesso.', 404);
    if (velho && velho.pastaId !== pastaId && !acessoPasta(conta, doc('bib168p/' + velho.pastaId))) return erro('Sem acesso à pasta de origem.', 403);
    const titulo = txt(b.titulo || (velho && velho.titulo) || (b.arq && b.arq.nome), 160); if (!titulo) return erro('Dê um título ao documento.', 400);
    const id = velho ? velho.id : novoId('bd'), d = Object.assign({}, velho || { id, crBy: conta.id, cr: Date.now(), versoes: [] }, { pastaId, titulo,
      tags: uniq((Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map(s => txt(s, 40).toLowerCase())).slice(0, 20),
      projId: b.projId !== undefined ? (b.projId && ID_OK.test(String(b.projId)) && doc('proj/' + b.projId) ? String(b.projId) : '') : (velho ? velho.projId || '' : '') });
    if (b.arq) {
      const v = arqDaConta(conta, b.arq, CFG().docMb, ACEITA_DOC); if (v.erro) return erro(v.erro, v.st || 400);
      v.origem('bib168d/' + id); d.versoes = (d.versoes || []).concat([{ v: (d.versoes || []).length + 1, arq: v.arq, por: conta.id, em: Date.now(), nota: txt(b.nota, 300) }]);
    } else if (!velho) return erro('Escolha o arquivo.', 400);
    grava('bib168d/' + id, d); auditar(conta, req, velho ? (b.arq ? 'BIBLIOTECA_VERSAO_168' : 'BIBLIOTECA_DOC_ALTERADO_168') : 'BIBLIOTECA_DOC_168', 'bib168d/' + id, null, { titulo, versao: d.versoes.length, pasta: pastaId });
    return { ok: true, doc: d };
  }
  function excluirDocBib(conta, req, b) {
    const d = doc('bib168d/' + String(b.id || '')); if (!d) return erro('Documento não encontrado.', 404);
    if (!(admin(conta) || d.crBy === conta.id)) return erro('Só quem enviou o documento ou o Administrador o exclui.');
    apaga('bib168d/' + d.id); auditar(conta, req, 'BIBLIOTECA_DOC_EXCLUIDO_168', 'bib168d/' + d.id, { titulo: d.titulo, versoes: (d.versoes || []).length }, null); return { ok: true };
  }

  /* ---------------- rotas ---------------- */
  async function rota(p, m, req, res, conta) {
    if (!p.startsWith('/api/reun168/') && p !== '/api/admin/reun168/varrer') return false;
    const u = new URL(req.url, 'http://x'), fim = (r, ok) => { if (r && r.erro) json(res, r.st || 403, { code: r.st === 400 ? 'invalid_argument' : r.st === 404 ? 'not_found' : r.st === 409 ? 'conflict' : r.st === 413 ? 'too_large' : r.st === 503 ? 'capability_disabled' : 'not_granted', erro: r.erro }); else json(res, 200, r || { ok: true }); return true; };
    if (p === '/api/admin/reun168/varrer' && m === 'POST') { if (!admin(conta)) return fim(erro('Só administrador.')); return fim({ ok: true, lembretes: lembretes(), tarefas: avisosTarefas(), paradas: gravacoesParadas(), audios: retencao() }); }
    if (p === '/api/reun168/grav/parte' && m === 'POST') { await gravParte(conta, req, res, u); return true; }
    if (m === 'GET') {
      if (p === '/api/reun168/reuniao') { const r = reunDe(u.searchParams.get('id')); if (!r || !veReun(conta, r)) return fim(erro(r ? 'Só os participantes, o organizador e o Administrador veem os documentos, as gravações e a ata desta reunião.' : 'Reunião não encontrada.', r ? 403 : 404)); return fim(Object.assign({ ok: true }, pubExtra(conta, r))); }
      if (p === '/api/reun168/tarefas') return fim({ ok: true, tarefas: listaTarefas(conta, { minhas: u.searchParams.get('minhas') === '1' }) });
      if (p === '/api/reun168/busca') return fim(busca(conta, String(u.searchParams.get('q') || '').slice(0, 120)));
      if (p === '/api/reun168/biblioteca') return fim(biblioteca(conta));
      return fim(erro('Não encontrado.', 404));
    }
    if (m !== 'POST') return fim(erro('Método não permitido.', 400));
    let b = {}; try { b = (await lerJson(req)) || {}; } catch (e) { return fim(erro('Pedido inválido.', 400)); }
    if (p === '/api/reun168/tarefa/nova') return fim(novaTarefa(conta, req, b)); /* v169 */
    if (p === '/api/reun168/tarefa') return fim(alterarTarefa(conta, req, b));
    if (p === '/api/reun168/bib/pasta') return fim(salvarPasta(conta, req, b));
    if (p === '/api/reun168/bib/doc') return fim(salvarDocBib(conta, req, b));
    if (p === '/api/reun168/bib/excluir') return fim(excluirDocBib(conta, req, b));
    const r = reunDe(b.reunId); if (!r || !veReun(conta, r)) return fim(erro(r ? 'Só os participantes, o organizador e o Administrador mexem nesta reunião.' : 'Reunião não encontrada.', r ? 403 : 404));
    if (p === '/api/reun168/doc') {
      const v = arqDaConta(conta, b.arq, CFG().docMb, ACEITA_DOC); if (v.erro) return fim(erro(v.erro, v.st || 400));
      const x = extra(r.id); if ((x.docs || []).length >= 60) return fim(erro('Limite de 60 arquivos por reunião.', 409));
      v.origem('reunx168/' + r.id); x.docs = (x.docs || []).filter(d => d.id !== v.arq.id).concat([Object.assign(v.arq, { por: conta.id, em: Date.now() })]); gravaExtra(x);
      auditar(conta, req, 'REUNIAO_DOC_168', 'reunx168/' + r.id, null, { arquivo: v.arq.nome, tipo: v.arq.tipo, kb: Math.round((v.arq.tam || 0) / 1024) }); return fim({ ok: true, docs: x.docs });
    }
    if (p === '/api/reun168/doc/remover') { const x = extra(r.id), d = (x.docs || []).find(y => y.id === b.id); if (!d) return fim(erro('Arquivo não encontrado.', 404)); if (!(d.por === conta.id || gereReun(conta, r))) return fim(erro('Só quem enviou, o organizador ou o Administrador removem.')); x.docs = x.docs.filter(y => y.id !== b.id); gravaExtra(x); auditar(conta, req, 'REUNIAO_DOC_REMOVIDO_168', 'reunx168/' + r.id, { arquivo: d.nome }, null); return fim({ ok: true }); }
    if (p === '/api/reun168/link') {
      const c = String(b.col || ''), id = String(b.rid || ''); if (!LIGA[c] || !ID_OK.test(id) || !doc(c + '/' + id)) return fim(erro('Registro não encontrado.', 404));
      if (!X.podeVer(conta, c + '/' + id, doc(c + '/' + id), new Map())) return fim(erro('Você não tem acesso a esse registro.', 403));
      const x = extra(r.id); if ((x.links || []).some(l => l.col === c && l.rid === id)) return fim({ ok: true, links: x.links });
      x.links = (x.links || []).concat([{ col: c, rid: id, rot: txt(b.rot, 160) || LIGA[c], tipo: LIGA[c], por: conta.id, em: Date.now() }]).slice(0, 60); gravaExtra(x); return fim({ ok: true, links: x.links });
    }
    if (p === '/api/reun168/link/remover') { const x = extra(r.id); x.links = (x.links || []).filter(l => !(l.col === b.col && l.rid === b.rid)); gravaExtra(x); return fim({ ok: true, links: x.links }); }
    if (p === '/api/reun168/bib/anexar') { const d = doc('bib168d/' + String(b.bibId || '')); if (!d || !acessoPasta(conta, doc('bib168p/' + d.pastaId))) return fim(erro('Documento da biblioteca não encontrado.', 404)); const x = extra(r.id); if (!(x.bib || []).some(y => y.bibId === d.id)) x.bib = (x.bib || []).concat([{ bibId: d.id, por: conta.id, em: Date.now() }]).slice(0, 60); gravaExtra(x); return fim({ ok: true }); }
    if (p === '/api/reun168/bib/desanexar') { const x = extra(r.id); x.bib = (x.bib || []).filter(y => y.bibId !== b.bibId); gravaExtra(x); return fim({ ok: true }); }
    if (p === '/api/reun168/convite') { if (!gereReun(conta, r)) return fim(erro('Só o organizador, o secretário ou o Administrador enviam o convite.')); return fim(convite(conta, req, r)); }
    if (p === '/api/reun168/grav/inicio') return fim(gravInicio(conta, req, r, b));
    if (p === '/api/reun168/grav/fim') return fim(gravFim(conta, req, r, String(b.gravId || ''), b.dur, false));
    if (p === '/api/reun168/grav/apagar') { if (!gereReun(conta, r)) return fim(erro('Só o organizador ou o Administrador apagam o áudio.')); const x = extra(r.id), g = (x.gravs || []).find(y => y.id === b.gravId); if (!g || !g.audio) return fim(erro('Áudio não encontrado.', 404)); apagarAudio(g, 'pedido'); gravaExtra(x); auditar(conta, req, 'REUNIAO_AUDIO_APAGADO_168', 'reunx168/' + r.id, null, { grav: g.id, motivo: 'pedido' }); return fim({ ok: true }); }
    if (p === '/api/reun168/transcrever') return fim(pedirTranscricao(conta, req, r, String(b.gravId || '')));
    if (p === '/api/reun168/transcricao/importar') return fim(importarTranscricao(conta, req, r, b));
    if (p === '/api/reun168/ata/gerar') return fim(await gerarAta(conta, req, r));
    if (p === '/api/reun168/ata/salvar') return fim(salvarAta(conta, req, r, b.minuta));
    if (p === '/api/reun168/ata/aprovar') return fim(aprovarAta(conta, req, r, b.minuta));
    if (p === '/api/reun168/ata/assinar') return fim(assinarAta(conta, req, r));
    return fim(erro('Não encontrado.', 404));
  }

  /* ---------------- rotinas: lembrete (a cada minuto), avisos de tarefa, gravações paradas e retenção do áudio ---------------- */
  let diaRet = '';
  function rotina() {
    try { lembretes(); } catch (e) { console.error('[v168] lembrete:', e.message); }
    try { gravacoesParadas(); } catch (e) { console.error('[v168] gravações:', e.message); }
    try { avisosTarefas(); } catch (e) { console.error('[v168] tarefas:', e.message); }
    const d = hojeBr(); if (d !== diaRet) { diaRet = d; try { retencao(); } catch (e) { console.error('[v168] retenção:', e.message); } }
    try { if (col('reunx168').some(x => x.transcr && x.transcr.st === 'fila')) trabalhar(); } catch (e) { }
  }
  if (!/^(0|nao|não)$/i.test(String(process.env.REUNIAO_ROTINA || '1'))) { setTimeout(rotina, 5000).unref(); setInterval(rotina, 60e3).unref(); }
  /* transcrição que estava "transcrevendo" quando o servidor caiu volta para a fila */
  setImmediate(() => { try { for (const x of col('reunx168')) if (x.transcr && x.transcr.st === 'transcrevendo') { x.transcr.st = 'fila'; gravaExtra(x); } } catch (e) { } });

  return { COLS, rota, podeLer, antes, antesExcluir, novaTarefa, setFontes, lembretes, avisosTarefas, retencao, gravacoesParadas, trabalhar, normMinuta, promptAta, acessoPasta };
};

"""Testes do conector fiscal com SEFAZ/ADN simulados (sem rede). Rode: python3 -m unittest test_app.py"""
import base64, gzip, hashlib, json, os, sys, tempfile, unittest, datetime, threading, urllib.request
sys.path.insert(0, os.path.dirname(__file__))
import app
from lxml import etree
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.serialization import pkcs12

CNPJ = '11222333000181'
CH1 = '35261099888777000166550010000012341000012345'
CH2 = '35261099888777000166550010000012351000012346'
CH_ALFA = '3526109AB8C7D7000166550010000012361000012347'  # chave com CNPJ alfanumérico (44 posições)
# datas relativas a hoje: a ciência automática só vale até 10 dias da emissão (NT 2020.001 v1.60)
_BR = datetime.timezone(datetime.timedelta(hours=-3))
D_RES = (datetime.datetime.now(_BR) - datetime.timedelta(days=2)).strftime('%Y-%m-%dT10:00:00-03:00')
D_PROC = (datetime.datetime.now(_BR) - datetime.timedelta(days=1)).strftime('%Y-%m-%dT09:00:00-03:00')
D_VELHA = (datetime.datetime.now(_BR) - datetime.timedelta(days=15)).strftime('%Y-%m-%dT10:00:00-03:00')


def gerar_pfx(pasta, senha='1234'):
    k = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nome = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'EMPRESA TESTE LTDA:' + CNPJ)])
    agora = datetime.datetime.now(datetime.timezone.utc)
    c = x509.CertificateBuilder().subject_name(nome).issuer_name(nome).public_key(k.public_key()).serial_number(1) \
        .not_valid_before(agora - datetime.timedelta(days=1)).not_valid_after(agora + datetime.timedelta(days=200)).sign(k, hashes.SHA256())
    p = os.path.join(pasta, 'cert.pfx')
    open(p, 'wb').write(pkcs12.serialize_key_and_certificates(b'x', k, c, None, serialization.BestAvailableEncryption(senha.encode())))
    return p


def z(xml):
    return base64.b64encode(gzip.compress(xml.encode())).decode()


RES = f'<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>{CH1}</chNFe><CNPJ>99888777000166</CNPJ><xNome>FORNECEDOR XPTO LTDA</xNome><IE>1</IE><dhEmi>{D_RES}</dhEmi><tpNF>1</tpNF><vNF>1500.50</vNF><digVal>x</digVal><dhRecbto>2026-10-15T10:01:00-03:00</dhRecbto><nProt>1</nProt><cSitNFe>1</cSitNFe></resNFe>'
PROC = f'<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe{CH2}" versao="4.00"><ide><nNF>1235</nNF><serie>1</serie><dhEmi>{D_PROC}</dhEmi></ide><emit><CNPJ>99888777000166</CNPJ><xNome>FORNECEDOR XPTO LTDA</xNome></emit><dest><CNPJ>{CNPJ}</CNPJ></dest><det nItem="1"><prod><cProd>A1</cProd><xProd>Cabo flexivel 2,5mm</xProd><NCM>85444900</NCM><CFOP>5102</CFOP><uCom>RL</uCom><qCom>4</qCom><vUnCom>205</vUnCom><vProd>820.00</vProd></prod><imposto></imposto></det><total><ICMSTot><vNF>820.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>'
EVT = f'<resEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><cOrgao>91</cOrgao><CNPJ>{CNPJ}</CNPJ><chNFe>{CH2}</chNFe><dhEvento>2026-10-16T12:00:00-03:00</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><xEvento>Ciencia da Operacao</xEvento><dhRecbto>x</dhRecbto><nProt>9</nProt></resEvento>'


def ret_dist(cstat, ult, mx, docs=(), motivo='ok'):
    lote = ''.join(f'<docZip NSU="{n}" schema="{s}">{z(x)}</docZip>' for n, s, x in docs)
    lote = f'<loteDistDFeInt>{lote}</loteDistDFeInt>' if docs else ''
    return (f'<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult>'
            f'<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>2</tpAmb><verAplic>1</verAplic><cStat>{cstat}</cStat><xMotivo>{motivo}</xMotivo><dhResp>x</dhResp><ultNSU>{ult}</ultNSU><maxNSU>{mx}</maxNSU>{lote}</retDistDFeInt>'
            f'</nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></soap:Body></soap:Envelope>').encode()


RET_EVT = (b'<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeRecepcaoEventoNFResult xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">'
           b'<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>1</verAplic><cOrgao>91</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>'
           b'<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><verAplic>1</verAplic><cOrgao>91</cOrgao><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><nProt>891</nProt></infEvento></retEvento></retEnvEvento>'
           b'</nfeRecepcaoEventoNFResult></soap:Body></soap:Envelope>')

NFSE = f'''<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS35549062211222333000181000000000000126100000012345"><xLocEmi>Tuiuti</xLocEmi><nNFSe>77</nNFSe><dhProc>2026-10-10T08:00:00-03:00</dhProc>
<emit><CNPJ>55444333000122</CNPJ><xNome>PRESTADOR DE SERVICOS LTDA</xNome></emit><valores><vLiq>950.00</vLiq></valores>
<DPS><infDPS><dhEmi>2026-10-10T07:59:00-03:00</dhEmi><toma><CNPJ>{CNPJ}</CNPJ></toma><serv><cServ><cTribNac>070201</cTribNac><xDescServ>Manutencao eletrica</xDescServ></cServ></serv><valores><vServPrest><vServ>1000.00</vServ></vServPrest><trib><tribMun><tpRetISSQN>2</tpRetISSQN></tribMun></trib></valores></infDPS></DPS></infNFSe></NFSe>'''


def so_evento(dados):
    # a SEFAZ valida o conteúdo de nfeDadosMsg como documento próprio
    import re
    return etree.fromstring(re.search(rb'<envEvento.*</envEvento>', dados, re.S).group(0))


class Resp:
    def __init__(self, content=b'', status=200, js=None):
        self.content, self.status_code, self._js = content, status, js
        self.text = content.decode() if content else json.dumps(js)

    def json(self):
        return self._js


class HttpFalso:
    def __init__(self):
        self.posts, self.gets, self.fila_dist = [], [], []

    def post(self, url, data=None, headers=None, **kw):
        self.posts.append((url, data, headers))
        if 'Distribuicao' in url:
            return Resp(self.fila_dist.pop(0) if self.fila_dist else ret_dist('137', '000000000000003', '000000000000003'))
        return Resp(RET_EVT)

    def get(self, url, params=None, **kw):
        self.gets.append((url, params))
        if url.endswith('/DFe/1'):
            return Resp(js={'StatusProcessamento': 'DOCUMENTOS_LOCALIZADOS', 'LoteDFe': [
                {'NSU': 1, 'ChaveAcesso': '35549062211222333000181000000000000126100000012345', 'TipoDocumento': 'NFSE', 'ArquivoXml': z(NFSE)}]})
        return Resp(status=404, js={'StatusProcessamento': 'NENHUM_DOCUMENTO_LOCALIZADO'})


def verificar_assinatura(env_el, cert_pem_path):
    """Valida a assinatura como a SEFAZ faria: digest do infEvento e RSA-SHA1 sobre o SignedInfo canonicalizado."""
    D = '{http://www.w3.org/2000/09/xmldsig#}'
    inf = env_el.find('.//{http://www.portalfiscal.inf.br/nfe}infEvento')
    sig = env_el.find('.//' + D + 'Signature')
    assert sig.getparent() is inf.getparent(), 'Signature deve ser irmã do infEvento'
    # reparse do XML serializado (como chega no servidor)
    doc = etree.fromstring(etree.tostring(env_el))
    inf = doc.find('.//{http://www.portalfiscal.inf.br/nfe}infEvento')
    sig = doc.find('.//' + D + 'Signature')
    sig.getparent().remove(sig)  # transform enveloped
    dig = base64.b64encode(hashlib.sha1(etree.tostring(inf, method='c14n')).digest()).decode()
    doc2 = etree.fromstring(etree.tostring(env_el))
    si = doc2.find('.//' + D + 'SignedInfo')
    assert doc2.find('.//' + D + 'DigestValue').text == dig, 'digest não confere'
    assert doc2.find('.//' + D + 'Reference').get('URI') == '#' + inf.get('Id')
    cert = x509.load_der_x509_certificate(base64.b64decode(doc2.find('.//' + D + 'X509Certificate').text))
    cert.public_key().verify(base64.b64decode(doc2.find('.//' + D + 'SignatureValue').text), etree.tostring(si, method='c14n'), padding.PKCS1v15(), hashes.SHA1())
    return True


class T(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.environ.update(CNPJ=CNPJ, UF='SP', AMBIENTE='2', CERT_PATH=gerar_pfx(self.dir), CERT_SENHA='1234', FISCAL_TOKEN='tok', DATA_DIR=self.dir, AUTO_CIENCIA='1', NFSE_ADN='1', NFE_DIST='1')
        self.cfg = app.Config()
        self.db = app.Banco(self.dir)
        self.http = HttpFalso()
        self.con = app.Conector(self.cfg, self.db, http=self.http)

    def test_certificado(self):
        self.assertEqual(self.con.pronto(), '')
        i = self.con.cert.info()
        self.assertIn('EMPRESA TESTE', i['titular'])
        self.assertGreater(i['diasRestantes'], 190)
        self.assertEqual(oct(os.stat(self.con.cert.key_pem).st_mode)[-3:], '600')

    def test_senha_errada(self):
        os.environ['CERT_SENHA'] = 'errada'
        c = app.Conector(app.Config(), self.db, http=self.http)
        self.assertIn('certificado', c.pronto())
        self.assertNotIn('errada', c.pronto())

    def test_distribuicao_e_ciencia(self):
        self.http.fila_dist = [ret_dist('138', '000000000000003', '000000000000003', [
            ('000000000000001', 'resNFe_v1.01.xsd', RES), ('000000000000002', 'procNFe_v4.00.xsd', PROC), ('000000000000003', 'resEvento_v1.01.xsd', EVT)])]
        r = self.con.sincronizar()
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['nfe']['novos'], 2)
        self.assertEqual(r['nfe']['ciencias'], 1)  # só o resumo recebe ciência automática
        # pedido DistDFe bem formado
        url, dados, h = self.http.posts[0]
        self.assertIn('hom1', url)
        self.assertIn('nfeDistDFeInteresse', h['Content-Type'])
        x = etree.fromstring(dados)
        self.assertEqual(app.txt(x, 'ultNSU'), '000000000000000')
        self.assertEqual(app.txt(x, 'cUFAutor'), '35')
        # evento de ciência assinado corretamente
        url, dados, h = self.http.posts[1]
        self.assertIn('NFeRecepcaoEvento4', url)
        env_el = so_evento(dados)
        self.assertTrue(verificar_assinatura(env_el, self.con.cert.cert_pem))
        self.assertEqual(app.achar(env_el, 'infEvento').get('Id'), 'ID210210' + CH1 + '01')
        self.assertEqual(app.txt(env_el, 'cOrgao'), '91')
        lst = self.con.listar({'tipo': 'nfe'})['documentos']
        d1 = next(d for d in lst if d['chave'] == CH1)
        d2 = next(d for d in lst if d['chave'] == CH2)
        self.assertEqual((d1['situacao'], d1['manifestacao'], d1['valor']), ('resumo', 'ciencia', 1500.5))
        self.assertEqual((d2['situacao'], d2['numero'], d2['valor'], d2['temXml']), ('completa', '1235', 820.0, True))
        self.assertEqual(d2['manifestacao'], 'ciencia')  # veio do resEvento da própria empresa
        self.assertNotIn('xml', d1)
        self.assertIn('<nfeProc', self.con.xml(CH2))
        self.assertEqual(self.db.get('nfe_ult_nsu'), '000000000000003')
        # resumo depois do completo não apaga o XML
        self.http.fila_dist = [ret_dist('138', '000000000000004', '000000000000004', [('000000000000004', 'resNFe_v1.01.xsd', RES.replace(CH1, CH2))])]
        self.db.set('nfe_espera_ate', 0)   # forcar não fura mais a espera
        self.db.set('nfe_bloqueio_ate', 0)
        self.con.sincronizar(forcar=True)
        self.assertIn('<nfeProc', self.con.xml(CH2))

    def test_espera_656_e_137(self):
        self.http.fila_dist = [ret_dist('656', '000000000000000', '')]
        self.con.sincronizar()
        r = self.con.sincronizar()
        self.assertTrue(r['nfe'].get('aguardando'))
        self.assertEqual(len([p for p in self.http.posts if 'Distribuicao' in p[0]]), 1)

    def test_nao_realizada_justificativa(self):
        r = self.con.manifestar(CH1, 'nao_realizada', 'curta')
        self.assertFalse(r['ok'])
        r = self.con.manifestar(CH1, 'nao_realizada', 'Mercadoria devolvida no ato da entrega')
        self.assertTrue(r['ok'], r)
        env_el = so_evento(self.http.posts[-1][1])
        self.assertEqual(app.txt(env_el, 'xJust'), 'Mercadoria devolvida no ato da entrega')
        self.assertEqual(app.txt(env_el, 'descEvento'), 'Operacao nao Realizada')
        self.assertTrue(verificar_assinatura(env_el, None))

    def test_nfse_adn(self):
        r = self.con.sync_nfse()
        self.assertEqual(r['novos'], 1)
        d = self.con.listar({'tipo': 'nfse'})['documentos'][0]
        self.assertEqual((d['emit_cnpj'], d['numero'], d['valor']), ('55444333000122', '77', 950.0))
        self.assertEqual(d['extra']['tomador'], CNPJ)
        self.assertTrue(d['extra']['retido'])
        self.assertFalse(d['extra']['emitidaPelaEmpresa'])
        self.assertIn('adn.producaorestrita', self.http.gets[0][0])
        self.assertEqual(self.db.get('nfse_ult_nsu'), 1)
        self.con.marcar(d['chave'], True, 'Andre')
        self.assertEqual(self.con.listar({'tipo': 'nfse', 'pendentes': '1'})['documentos'], [])

    def test_http(self):
        cfg = self.cfg
        cfg.port = 0
        srv = app.servidor(self.con, cfg)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{srv.server_address[1]}'

        def req(p, body=None, tok='tok'):
            r = urllib.request.Request(base + p, data=json.dumps(body).encode() if body is not None else None, headers={'x-fiscal-token': tok, 'content-type': 'application/json'})
            try:
                with urllib.request.urlopen(r) as f:
                    return f.status, json.loads(f.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())
        self.assertEqual(req('/status', tok='x')[0], 401)
        c, j = req('/status')
        self.assertEqual(c, 200)
        self.assertNotIn('senha', json.dumps(j).lower())
        self.assertEqual(j['ambiente'], 'homologação')
        c, j = req('/tool/sincronizar', {})
        self.assertTrue(j['ok'])
        c, j = req('/tool/listar_documentos', {'tipo': 'nfse'})
        self.assertEqual(len(j['documentos']), 1)
        c, j = req('/tool/obter_xml', {'chave': j['documentos'][0]['chave']})
        self.assertIn('NFSe', j['xml'])
        self.assertEqual(req('/tool/apagar_tudo', {})[0], 404)
        # erro interno: mensagem genérica com código, sem tipo nem texto da exceção
        r = urllib.request.Request(base + '/manifestar', data=b'{isto nao e json', headers={'x-fiscal-token': 'tok', 'content-type': 'application/json'})
        try:
            urllib.request.urlopen(r)
            self.fail('esperava 500')
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 500)
            j = json.loads(e.read())
            self.assertRegex(j['erro'], r'^Erro interno do conector fiscal \(ref\. [0-9a-f]{8}\)\.$')
            self.assertNotIn('JSONDecodeError', j['erro'])
        srv.shutdown()

    def test_falha_sefaz_generica(self):
        class Quebra(HttpFalso):
            def post(self, *a, **k):
                raise RuntimeError('detalhe interno 10.0.0.5 senha=xyz')
        con = app.Conector(self.cfg, self.db, http=Quebra())
        self.db.set('nfe_espera_ate', 0)
        self.db.set('nfe_bloqueio_ate', 0)
        out = con.sincronizar(forcar=True)
        self.assertFalse(out['nfe']['ok'])
        self.assertNotIn('10.0.0.5', out['nfe']['msg'])
        self.assertNotIn('RuntimeError', out['nfe']['msg'])
        self.assertIn('ref.', out['nfe']['msg'])
        self.assertNotIn('10.0.0.5', json.dumps(con.status()))
        # erro genérico/5xx marca espera de 1 hora: a próxima chamada não vai à SEFAZ
        self.assertTrue(app.bloqueado(self.db))
        out = con.sincronizar(forcar=True)
        self.assertTrue(out['nfe'].get('aguardando'), out)

    # ------------------------------------------------ v119: sequência única (NT 2014.002), prazos e CNPJ alfanumérico
    def dist_posts(self):
        return [p for p in self.http.posts if 'Distribuicao' in p[0]]

    def test_nfe_dist_desligado_nao_chama_sefaz(self):
        os.environ['NFE_DIST'] = '0'
        os.environ.pop('AUTO_CIENCIA')
        cfg = app.Config()
        self.assertFalse(cfg.nfe_dist)
        self.assertFalse(cfg.auto_ciencia)  # segue NFE_DIST
        con = app.Conector(cfg, self.db, http=self.http)
        r = con.sincronizar(forcar=True)
        self.assertTrue(r['nfe'].get('desligado'), r)
        self.assertIn('Omie', r['nfe']['msg'])
        self.assertEqual(self.dist_posts(), [])
        self.assertEqual(r['nfse']['novos'], 1)  # NFS-e do ADN continua
        st = con.status()
        self.assertIs(st['nfeDist'], False)
        self.assertFalse(st['autoCiencia'])

    def test_656_bloqueia_forcar_e_baixar(self):
        self.http.fila_dist = [ret_dist('656', '000000000000000', '', motivo='Rejeicao: Consumo Indevido')]
        self.con.sincronizar()
        self.assertEqual(len(self.dist_posts()), 1)
        ate = self.db.get('nfe_bloqueio_ate')
        self.assertGreater(ate, app.time.time() + app.UMA_HORA)  # 1 h + margem de 5 min
        r = self.con.sincronizar(forcar=True)
        self.assertTrue(r['nfe'].get('aguardando'), r)
        r = self.con.baixar(CH1)
        self.assertFalse(r['ok'])
        self.assertIn('espera de consumo indevido', r['msg'])
        self.assertEqual(len(self.dist_posts()), 1)
        st = self.con.status()
        self.assertTrue(st['nfeBloqueioAte'])
        self.assertIsNone(st['conflito'])  # ultNSU não andou e o motivo não fala de ultNSU

    def test_656_ultnsu_maior_grava_conflito(self):
        self.db.set('nfe_ult_nsu', '000000000000010')
        self.http.fila_dist = [ret_dist('656', '000000000000050', '000000000000080', motivo='Rejeicao: Consumo Indevido (Deve ser utilizado o ultNSU nas solicitacoes subsequentes)')]
        self.con.sincronizar()
        c = self.db.get('nfe_conflito')
        self.assertEqual((c['nosso'], c['sefaz']), ('000000000000010', '000000000000050'))
        self.assertEqual(self.db.get('nfe_ult_nsu'), '000000000000050')  # adota o ultNSU devolvido
        self.assertEqual(self.con.status()['conflito']['sefaz'], '000000000000050')
        self.assertTrue(any('Outro sistema' in l['msg'] for l in self.con.status()['log']))

    def test_baixar_limite_por_chave(self):
        self.http.fila_dist = [ret_dist('138', '1', '1', [('1', 'resNFe_v1.01.xsd', RES)]) for _ in range(3)]
        for _ in range(3):
            r = self.con.baixar(CH1)
            self.assertNotIn('limite', r)
        r = self.con.baixar(CH1)
        self.assertTrue(r.get('limite'), r)
        self.assertEqual(len(self.dist_posts()), 3)
        # outra chave não é afetada
        self.http.fila_dist = [ret_dist('138', '1', '1', [('1', 'procNFe_v4.00.xsd', PROC)])]
        self.assertTrue(self.con.baixar(CH2)['ok'])

    def test_baixar_656_registra_bloqueio(self):
        self.http.fila_dist = [ret_dist('656', '', '', motivo='Rejeicao: Consumo Indevido')]
        r = self.con.baixar(CH1)
        self.assertEqual(r['cStat'], '656')
        self.assertTrue(app.bloqueado(self.db))
        self.assertEqual(self.con.sincronizar()['nfe'].get('aguardando'), True)
        self.assertEqual(len(self.dist_posts()), 1)

    def test_chave_alfanumerica(self):
        self.assertEqual(len(CH_ALFA), 44)
        r = self.con.ferramenta('baixar', {'chave': CH_ALFA.lower()})
        self.assertNotEqual(r.get('msg'), 'Chave de acesso inválida.')
        x = etree.fromstring(self.dist_posts()[-1][1])
        self.assertEqual(app.txt(x, 'chNFe'), CH_ALFA)
        r = self.con.manifestar(CH_ALFA, 'ciencia')
        self.assertTrue(r['ok'], r)
        self.assertEqual(app.txt(so_evento(self.http.posts[-1][1]), 'chNFe'), CH_ALFA)
        os.environ['CNPJ'] = '12.ABC.345/01DE-35'
        self.assertEqual(app.Config().cnpj, '12ABC34501DE35')

    def test_ciencia_automatica_so_ate_10_dias(self):
        self.http.fila_dist = [ret_dist('138', '000000000000001', '000000000000001', [('000000000000001', 'resNFe_v1.01.xsd', RES.replace(D_RES, D_VELHA))])]
        r = self.con.sincronizar()
        self.assertEqual(r['nfe']['ciencias'], 0)
        self.assertFalse([p for p in self.http.posts if 'Evento' in p[0]])
        # manifestação manual fora do prazo: avisa, mas envia
        r = self.con.manifestar(CH1, 'ciencia')
        self.assertTrue(r['ok'])
        self.assertIn('10 dias', r['aviso'])
        r = self.con.manifestar(CH1, 'confirmacao')
        self.assertNotIn('aviso', r)  # 15 dias < 90

    def test_http_rota_chave_alfanumerica(self):
        self.con.db.salvar({'chave': CH_ALFA, 'tipo': 'nfe', 'situacao': 'completa', 'xml': '<nfeProc/>'})
        cfg = self.cfg
        cfg.port = 0
        srv = app.servidor(self.con, cfg)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            r = urllib.request.Request(f'http://127.0.0.1:{srv.server_address[1]}/documentos/{CH_ALFA}/xml', headers={'x-fiscal-token': 'tok'})
            with urllib.request.urlopen(r) as f:
                self.assertEqual(f.read(), b'<nfeProc/>')
        finally:
            srv.shutdown()

    def test_nfse_ibscbs(self):
        x = NFSE.replace('</infDPS>', '<IBSCBS><finNFSe>0</finNFSe><cIndOp>100301</cIndOp><valores><trib><gIBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></gIBSCBS></trib></valores></IBSCBS></infDPS>') \
                .replace('<valores><vLiq>', '<IBSCBS><valores><vBC>1000.00</vBC><uf><vIBSUF>1.00</vIBSUF></uf><totCIBS><gIBS><vIBSTot>1.00</vIBSTot></gIBS><gCBS><vCBS>9.00</vCBS></gCBS></totCIBS></valores></IBSCBS><valores><vLiq>')
        tipo, d = app.ler_nfse(x.encode())
        e = json.loads(d['extra'])
        self.assertEqual((e['CST'], e['cClassTrib'], e['finNFSe'], e['cIndOp']), ('000', '000001', '0', '100301'))
        self.assertEqual((e['vBC'], e['vIBS'], e['vCBS']), (1000.0, 1.0, 9.0))
        # sem o grupo: nada muda
        tipo, d = app.ler_nfse(NFSE.encode())
        self.assertNotIn('CST', json.loads(d['extra']))

    # ------------------------------------------------ v123: configuração em tempo de execução (Sistema › Configurações)
    def test_config_banco_tem_prioridade(self):
        self.assertEqual(self.con.config_view()['origem']['ambiente'], 'ambiente')
        r = self.con.config_salvar({'ambiente': 1, 'nfe_dist': 0, 'nfse': '0'}, 'Andre')
        self.assertTrue(r['ok'], r)
        self.assertEqual(r['config']['ambiente'], 1)
        # um conector novo (reinício do serviço) com as mesmas variáveis usa o valor do banco
        con = app.Conector(app.Config(), self.db, http=self.http)
        st = con.status()
        self.assertEqual((st['ambiente'], st['ambienteCod'], st['nfeDist'], st['nfse']), ('produção', 1, False, False))
        self.assertEqual(st['configuracao']['origem'], {'ambiente': 'banco', 'nfe_dist': 'banco', 'nfse': 'banco', 'auto': 'ambiente', 'auto_ciencia': 'ambiente'})
        self.assertEqual(st['configuracao']['padrao']['ambiente'], 2)
        self.assertEqual(st['configuracao']['alteradaPor'], 'Andre')
        out = con.sincronizar()
        self.assertTrue(out['nfe'].get('desligado'))
        self.assertNotIn('nfse', out)
        self.assertEqual((self.http.posts, self.http.gets), ([], []))
        # o registro diz quem mudou e o antes → depois
        log = ' | '.join(l['msg'] for l in st['log'])
        self.assertIn('Configuração alterada por Andre', log)
        self.assertIn('ambiente: homologação → produção', log)
        self.assertIn('NF-e por NSU: Central → Omie', log)
        # um campo volta ao padrão (null) e depois tudo (restaurar)
        r = con.config_salvar({'nfse': None}, 'Andre')
        self.assertEqual((r['config']['nfse'], r['origem']['nfse']), (True, 'ambiente'))
        r = con.config_salvar({'restaurar': True}, 'Andre')
        self.assertEqual(r['config'], {'ambiente': 2, 'nfe_dist': True, 'nfse': True, 'auto': True, 'auto_ciencia': True})
        self.assertEqual(set(r['origem'].values()), {'ambiente'})

    def test_troca_de_ambiente_usa_nsu_separado(self):
        # homologação (padrão do teste) já tem sequência e está em espera da SEFAZ
        self.db.set('nfe_ult_nsu', '000000000000050')
        self.db.set('nfse_ult_nsu', 9)
        self.db.set('nfe_espera_ate', app.time.time() + 1800)
        self.assertTrue(self.con.sincronizar()['nfe'].get('aguardando'))
        self.con.config_salvar({'ambiente': 1}, 'Andre')
        self.assertEqual(self.db.get('nfe_ult_nsu', '0'), '0')   # produção começa a sua própria sequência
        self.assertFalse(app.bloqueado(self.db))                   # a espera era da homologação
        self.http.fila_dist = [ret_dist('137', '000000000000000', '000000000000000')]
        self.con.sincronizar()
        url, dados, h = self.dist_posts()[-1]
        self.assertIn('www1.nfe.fazenda.gov.br', url)               # endereço trocado sem reiniciar
        x = etree.fromstring(dados)
        self.assertEqual((app.txt(x, 'tpAmb'), app.txt(x, 'ultNSU')), ('1', '000000000000000'))
        self.assertIn('https://adn.nfse.gov.br/contribuintes/DFe/1', [g[0] for g in self.http.gets])   # ADN de produção, NSU do zero
        self.assertTrue(all('producaorestrita' in g[0] for g in self.http.gets[:1]))                    # antes: produção restrita, NSU 10
        self.assertTrue(app.bloqueado(self.db))                    # 137 em produção: espera só de produção
        # volta para homologação: NSU e espera de lá continuam como estavam
        self.con.config_salvar({'ambiente': 2}, 'Andre')
        self.assertEqual(self.db.get('nfe_ult_nsu'), '000000000000050')
        self.assertEqual(self.db.get('nfse_ult_nsu'), 9)
        self.assertTrue(app.bloqueado(self.db))
        self.assertEqual(self.db.get_cru('nfe_ult_nsu@amb1'), '000000000000000')
        # documentos ficam no ambiente em que chegaram
        self.db.salvar({'chave': CH1, 'tipo': 'nfe', 'situacao': 'resumo'})
        self.assertEqual(len(self.con.listar({'tipo': 'nfe'})['documentos']), 1)
        self.con.config_salvar({'ambiente': 1}, 'Andre')
        self.assertEqual(self.con.listar({'tipo': 'nfe'})['documentos'], [])   # em produção só a NFS-e baixada lá

    def test_migracao_nsu_antigo_vai_para_o_ambiente_em_uso(self):
        d = tempfile.mkdtemp()
        b = app.Banco(d)
        b.set('nfe_ult_nsu', '000000000000077')      # como gravava a v122 (sem ambiente)
        b.set('nfe_bloqueio_ate', app.time.time() + 600)
        b.salvar({'chave': CH1, 'tipo': 'nfe', 'situacao': 'resumo'})
        os.environ.update(AMBIENTE='1', DATA_DIR=d)
        con = app.Conector(app.Config(), b, http=self.http)
        self.assertEqual(b.get('nfe_ult_nsu'), '000000000000077')
        self.assertIsNone(b.get_cru('nfe_ult_nsu'))
        self.assertTrue(app.bloqueado(b))
        self.assertEqual(len(con.listar({})['documentos']), 1)
        con.config_salvar({'ambiente': 2}, 'x')
        self.assertEqual(b.get('nfe_ult_nsu', '0'), '0')
        self.assertFalse(app.bloqueado(b))
        self.assertEqual(con.listar({})['documentos'], [])
        app.Conector(app.Config(), b, http=self.http)              # segunda partida não migra de novo
        self.assertEqual(b.get_cru('nfe_ult_nsu@amb1'), '000000000000077')

    def test_auto_desligado_agendador_nao_chama_sefaz(self):
        r = self.con.config_salvar({'auto': 0}, 'Andre')
        self.assertFalse(r['config']['auto'])
        out = app.rodada_agendada(self.con)
        self.assertTrue(out.get('desligado'))
        self.assertEqual((self.http.posts, self.http.gets), ([], []))
        self.assertFalse(self.con.status()['buscaAuto'])
        # "Buscar agora" continua (com as regras da v119)
        self.assertTrue(self.con.sincronizar()['ok'])
        self.assertEqual(len(self.dist_posts()), 1)
        self.con.config_salvar({'auto': 1}, 'Andre')
        self.db.set('nfse_espera_ate', 0)
        out = app.rodada_agendada(self.con)
        self.assertEqual(out['origem'], 'automática')
        self.assertTrue(self.http.gets)

    def test_config_validacao(self):
        for ruim in ({'ambiente': 3}, {'ambiente': True}, {'ambiente': 'producao'}, {'nfe_dist': 'sim'}, {'auto': 2}, {'nfse': 0.5},
                     {'auto_ciencia': [1]}, {'xpto': 1}, {'restaurar': 'talvez'}, [1, 2]):
            r = self.con.config_salvar(ruim, 'Andre')
            self.assertFalse(r['ok'], ruim)
            self.assertTrue(r['msg'])
        self.assertIsNone(self.db.get_cru('cfg_runtime'))
        self.assertEqual(self.con.config_efetiva()['ambiente'], 2)
        self.assertTrue(self.con.config_salvar({'ambiente': '1', 'auto_ciencia': False}, 'Andre')['ok'])

    def test_http_config(self):
        cfg = self.cfg
        cfg.port = 0
        srv = app.servidor(self.con, cfg)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{srv.server_address[1]}'

        def req(body, tok='tok', h=None):
            r = urllib.request.Request(base + '/tool/config', data=json.dumps(body).encode(), headers=dict({'x-fiscal-token': tok, 'content-type': 'application/json', 'x-usuario': 'Andre'}, **(h or {})))
            try:
                with urllib.request.urlopen(r) as f:
                    return f.status, json.loads(f.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())
        try:
            self.assertEqual(req({'ambiente': 1}, tok='x', h={'x-fiscal-config': '1'})[0], 401)   # sem token
            self.assertEqual(req({'ambiente': 1}, tok='')[0], 401)
            self.assertEqual(req({'ambiente': 1})[0], 403)                                     # token sem a rota da Central
            self.assertIsNone(self.db.get_cru('cfg_runtime'))
            c, j = req({})                                                                     # leitura
            self.assertEqual((c, j['config']['ambiente']), (200, 2))
            c, j = req({'ambiente': 9}, h={'x-fiscal-config': '1'})
            self.assertEqual((c, j['ok']), (200, False))
            c, j = req({'ambiente': 1}, h={'x-fiscal-config': '1'})
            self.assertEqual((c, j['ok'], j['config']['ambiente'], j['alteradaPor']), (200, True, 1, 'Andre'))
            self.assertEqual(self.con.status()['ambiente'], 'produção')
        finally:
            srv.shutdown()


if __name__ == '__main__':
    unittest.main()

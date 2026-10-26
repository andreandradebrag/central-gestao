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


RES = f'<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>{CH1}</chNFe><CNPJ>99888777000166</CNPJ><xNome>FORNECEDOR XPTO LTDA</xNome><IE>1</IE><dhEmi>2026-10-15T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>1500.50</vNF><digVal>x</digVal><dhRecbto>2026-10-15T10:01:00-03:00</dhRecbto><nProt>1</nProt><cSitNFe>1</cSitNFe></resNFe>'
PROC = f'<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe{CH2}" versao="4.00"><ide><nNF>1235</nNF><serie>1</serie><dhEmi>2026-10-16T09:00:00-03:00</dhEmi></ide><emit><CNPJ>99888777000166</CNPJ><xNome>FORNECEDOR XPTO LTDA</xNome></emit><dest><CNPJ>{CNPJ}</CNPJ></dest><det nItem="1"><prod><cProd>A1</cProd><xProd>Cabo flexivel 2,5mm</xProd><NCM>85444900</NCM><CFOP>5102</CFOP><uCom>RL</uCom><qCom>4</qCom><vUnCom>205</vUnCom><vProd>820.00</vProd></prod><imposto></imposto></det><total><ICMSTot><vNF>820.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>'
EVT = f'<resEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><cOrgao>91</cOrgao><CNPJ>{CNPJ}</CNPJ><chNFe>{CH2}</chNFe><dhEvento>2026-10-16T12:00:00-03:00</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><xEvento>Ciencia da Operacao</xEvento><dhRecbto>x</dhRecbto><nProt>9</nProt></resEvento>'


def ret_dist(cstat, ult, mx, docs=()):
    lote = ''.join(f'<docZip NSU="{n}" schema="{s}">{z(x)}</docZip>' for n, s, x in docs)
    lote = f'<loteDistDFeInt>{lote}</loteDistDFeInt>' if docs else ''
    return (f'<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult>'
            f'<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>2</tpAmb><verAplic>1</verAplic><cStat>{cstat}</cStat><xMotivo>ok</xMotivo><dhResp>x</dhResp><ultNSU>{ult}</ultNSU><maxNSU>{mx}</maxNSU>{lote}</retDistDFeInt>'
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
        os.environ.update(CNPJ=CNPJ, UF='SP', AMBIENTE='2', CERT_PATH=gerar_pfx(self.dir), CERT_SENHA='1234', FISCAL_TOKEN='tok', DATA_DIR=self.dir, AUTO_CIENCIA='1', NFSE_ADN='1')
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
        out = con.sincronizar(forcar=True)
        self.assertFalse(out['nfe']['ok'])
        self.assertNotIn('10.0.0.5', out['nfe']['msg'])
        self.assertNotIn('RuntimeError', out['nfe']['msg'])
        self.assertIn('ref.', out['nfe']['msg'])
        self.assertNotIn('10.0.0.5', json.dumps(con.status()))


if __name__ == '__main__':
    unittest.main()

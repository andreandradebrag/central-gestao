"""
Conector fiscal da Central de Gestão.

Busca automaticamente, com o certificado A1 da empresa:
  * NF-e emitidas contra o CNPJ (Distribuição DF-e do Ambiente Nacional da SEFAZ);
  * NFS-e recebidas (Ambiente de Dados Nacional da NFS-e - ADN);
e envia a manifestação do destinatário (ciência, confirmação, desconhecimento, não realizada).

O certificado (.pfx) e a senha ficam só neste serviço, na sua VPS, lidos de CERT_PATH e CERT_SENHA.
Nada disso é gravado no banco nem devolvido pela API.

Variáveis de ambiente:
  CNPJ            CNPJ da empresa (números, ou letras e números no CNPJ alfanumérico)
  UF              UF do autor (padrão SP)
  AMBIENTE        1 = produção, 2 = homologação (padrão 2)
  CERT_PATH       caminho do .pfx (padrão /certs/certificado.pfx)
  CERT_SENHA      senha do .pfx
  FISCAL_TOKEN    segredo compartilhado com o servidor da Central (obrigatório)
  INTERVALO_MIN   minutos entre buscas automáticas (mínimo 60, padrão 60)
  NFE_DIST        1 = este conector é o ÚNICO sistema que consulta a Distribuição DF-e por NSU deste CNPJ
                  (padrão 0: o Agente da NF-e do Omie é o dono da sequência; regra de sequência única da NT 2014.002)
  AUTO_CIENCIA    1 = dá ciência automática nas NF-e resumidas para baixar o XML completo
                  (padrão: igual a NFE_DIST; só dentro do prazo de 10 dias da NT 2020.001 v1.60)
  NFSE_ADN        1 = busca NFS-e no Ambiente Nacional (padrão 1)
  BUSCA_AUTO      1 = o agendador busca sozinho a cada INTERVALO_MIN (padrão 1); 0 = só "Buscar agora"
  DATA_DIR       pasta do banco (padrão /data)
  PORT            porta (padrão 8000)
  CA_BUNDLE       arquivo de autoridades certificadoras extra (ICP-Brasil), se precisar

v123: AMBIENTE, NFE_DIST, NFSE_ADN, BUSCA_AUTO e AUTO_CIENCIA passam a ser só o VALOR PADRÃO. A tela
Sistema › Configurações da Central grava a configuração em uso no banco do conector (chave 'cfg_runtime',
rota POST /tool/config com o cabeçalho x-fiscal-config: 1); o valor do banco tem prioridade. Sem valor no
banco (ou depois de "Voltar ao padrão"), vale a variável. As sequências de NSU, as esperas e os bloqueios da
SEFAZ/ADN e os documentos ficam separados por ambiente (produção x homologação).
"""
import base64, gzip, hashlib, json, os, re, sqlite3, tempfile, threading, time, traceback, atexit, shutil
from datetime import datetime, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from lxml import etree

try:
    import requests
except Exception:  # testes sem rede
    requests = None

NS_NFE = 'http://www.portalfiscal.inf.br/nfe'
NS_DS = 'http://www.w3.org/2000/09/xmldsig#'
NS_SOAP = 'http://www.w3.org/2003/05/soap-envelope'
UF_COD = {'RO': 11, 'AC': 12, 'AM': 13, 'RR': 14, 'PA': 15, 'AP': 16, 'TO': 17, 'MA': 21, 'PI': 22, 'CE': 23, 'RN': 24, 'PB': 25, 'PE': 26, 'AL': 27, 'SE': 28, 'BA': 29,
          'MG': 31, 'ES': 32, 'RJ': 33, 'SP': 35, 'PR': 41, 'SC': 42, 'RS': 43, 'MS': 50, 'MT': 51, 'GO': 52, 'DF': 53}
URL = {
    'dist': {1: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
             2: 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'},
    'evento': {1: 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
               2: 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'},
    'adn': {1: 'https://adn.nfse.gov.br/contribuintes',
            2: 'https://adn.producaorestrita.nfse.gov.br/contribuintes'},
}
EVENTOS = {
    'confirmacao': ('210200', 'Confirmacao da Operacao'),
    'ciencia': ('210210', 'Ciencia da Operacao'),
    'desconhecimento': ('210220', 'Desconhecimento da Operacao'),
    'nao_realizada': ('210240', 'Operacao nao Realizada'),
}
TP_NOME = {v[0]: k for k, v in EVENTOS.items()}
UMA_HORA = 3600
PRAZO_CIENCIA_DIAS = 10      # NT 2020.001 v1.60 (produção 01/06/2026)
PRAZO_CONCLUSIVO_DIAS = 90   # confirmação, desconhecimento e não realizada
# v123: configuração em tempo de execução (tela Sistema › Configurações da Central)
CAMPOS_CFG = ('ambiente', 'nfe_dist', 'nfse', 'auto', 'auto_ciencia')
ROTULO_CFG = {'ambiente': 'ambiente', 'nfe_dist': 'NF-e por NSU', 'nfse': 'NFS-e do Ambiente Nacional', 'auto': 'busca automática', 'auto_ciencia': 'ciência automática'}
# estado que pertence a um ambiente da SEFAZ/ADN: sequências de NSU, esperas, bloqueios e retornos
POR_AMB = ('nfe_ult_nsu', 'nfe_max_nsu', 'nfe_espera_ate', 'nfe_bloqueio_ate', 'nfe_conflito', 'nfe_ultimo_retorno', 'nfe_chave_cont',
           'nfse_ult_nsu', 'nfse_espera_ate', 'ultima_sync')


def env(k, d=''):
    return os.environ.get(k, d).strip()


class Config:
    def __init__(self):
        self.cnpj = re.sub(r'[^0-9A-Z]', '', env('CNPJ').upper())
        self.uf = env('UF', 'SP').upper()
        self.amb = 1 if env('AMBIENTE', '2') == '1' else 2
        self.cert_path = env('CERT_PATH', '/certs/certificado.pfx')
        self.cert_senha = os.environ.get('CERT_SENHA', '')
        self.token = env('FISCAL_TOKEN')
        self.intervalo = max(60, int(env('INTERVALO_MIN', '60') or 60))
        self.nfe_dist = env('NFE_DIST', '0') != '0'          # 1 = este conector é o ÚNICO a consultar NSU deste CNPJ
        self.auto_ciencia = env('AUTO_CIENCIA', '1' if self.nfe_dist else '0') != '0'
        self.chave_max_hora = 3                                # bem abaixo do limite de 20/h da SEFAZ
        self.nfse = env('NFSE_ADN', '1') != '0'
        self.auto = env('BUSCA_AUTO', '1') != '0'
        # v123: valores das variáveis = padrão; a configuração gravada no banco do conector tem prioridade
        self.padrao = {'ambiente': self.amb, 'nfe_dist': self.nfe_dist, 'nfse': self.nfse, 'auto': self.auto,
                       'auto_ciencia': (env('AUTO_CIENCIA') != '0') if env('AUTO_CIENCIA') else None}  # None = segue nfe_dist
        self.origem = {k: 'ambiente' for k in CAMPOS_CFG}
        self.data = env('DATA_DIR', '/data')
        self.port = int(env('PORT', '8000'))
        self.ca = env('CA_BUNDLE') or True
        # parâmetros extras da consulta ADN, ex.: ADN_PARAMS=lote=true (deixe vazio no padrão)
        self.adn_params = dict(p.split('=', 1) for p in env('ADN_PARAMS').split('&') if '=' in p)


# ---------------------------------------------------------------- certificado
class Certificado:
    """Lê o .pfx em memória e escreve PEMs temporários (pasta 0700, apagada ao sair) só para o TLS."""

    def __init__(self, path, senha):
        from cryptography.hazmat.primitives.serialization import pkcs12, Encoding, PrivateFormat, NoEncryption
        with open(path, 'rb') as f:
            key, cert, extras = pkcs12.load_key_and_certificates(f.read(), senha.encode() if senha else None)
        if key is None or cert is None:
            raise ValueError('O arquivo .pfx não tem chave privada e certificado.')
        self.key, self.cert = key, cert
        self.cert_der_b64 = base64.b64encode(cert.public_bytes(Encoding.DER)).decode()
        self.dir = tempfile.mkdtemp(prefix='cert-')
        os.chmod(self.dir, 0o700)
        self.cert_pem = os.path.join(self.dir, 'c.pem')
        self.key_pem = os.path.join(self.dir, 'k.pem')
        cadeia = cert.public_bytes(Encoding.PEM) + b''.join(c.public_bytes(Encoding.PEM) for c in (extras or []))
        for p, b in ((self.cert_pem, cadeia), (self.key_pem, key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption()))):
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.write(fd, b)
            os.close(fd)
        atexit.register(lambda: shutil.rmtree(self.dir, ignore_errors=True))

    @property
    def tls(self):
        return (self.cert_pem, self.key_pem)

    def info(self):
        from cryptography.x509.oid import NameOID
        cn = self.cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        fim = getattr(self.cert, 'not_valid_after_utc', None) or self.cert.not_valid_after.replace(tzinfo=timezone.utc)
        return {'titular': cn[0].value if cn else '', 'validade': fim.isoformat(), 'diasRestantes': (fim - datetime.now(timezone.utc)).days}

    def assinar(self, dados: bytes) -> bytes:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        return self.key.sign(dados, padding.PKCS1v15(), hashes.SHA1())


def c14n(el):
    return etree.tostring(el, method='c14n', exclusive=False, with_comments=False)


def assinar_xml(raiz, alvo, cert: Certificado):
    """Assinatura XMLDSig envelopada padrão NF-e (RSA-SHA1, C14N) do elemento `alvo` (com atributo Id), inserida no pai de `alvo`."""
    ref = alvo.get('Id')
    digest = base64.b64encode(hashlib.sha1(c14n(alvo)).digest()).decode()
    D = '{%s}' % NS_DS
    sig = etree.SubElement(alvo.getparent(), D + 'Signature', nsmap={None: NS_DS})
    si = etree.SubElement(sig, D + 'SignedInfo')
    etree.SubElement(si, D + 'CanonicalizationMethod', Algorithm='http://www.w3.org/TR/2001/REC-xml-c14n-20010315')
    etree.SubElement(si, D + 'SignatureMethod', Algorithm='http://www.w3.org/2000/09/xmldsig#rsa-sha1')
    r = etree.SubElement(si, D + 'Reference', URI='#' + ref)
    tr = etree.SubElement(r, D + 'Transforms')
    etree.SubElement(tr, D + 'Transform', Algorithm='http://www.w3.org/2000/09/xmldsig#enveloped-signature')
    etree.SubElement(tr, D + 'Transform', Algorithm='http://www.w3.org/TR/2001/REC-xml-c14n-20010315')
    etree.SubElement(r, D + 'DigestMethod', Algorithm='http://www.w3.org/2000/09/xmldsig#sha1')
    etree.SubElement(r, D + 'DigestValue').text = digest
    etree.SubElement(sig, D + 'SignatureValue').text = base64.b64encode(cert.assinar(c14n(si))).decode()
    ki = etree.SubElement(sig, D + 'KeyInfo')
    etree.SubElement(etree.SubElement(ki, D + 'X509Data'), D + 'X509Certificate').text = cert.cert_der_b64
    return sig


# ---------------------------------------------------------------- utilidades XML
def ln(el):
    return etree.QName(el).localname if isinstance(el.tag, str) else ''


def achar(el, *caminho):
    """Procura por nome local (ignora namespace). achar(x, 'emit', 'CNPJ')."""
    atual = [el]
    for nome in caminho:
        prox = []
        for a in atual:
            prox += [d for d in a.iter() if d is not a and ln(d) == nome]
        if not prox:
            return None
        atual = prox[:1]
    return atual[0]


def txt(el, *caminho):
    x = achar(el, *caminho) if caminho else el
    return (x.text or '').strip() if x is not None and x.text else ''


def parse_xml(b):
    if isinstance(b, str):
        b = b.encode('utf-8')
    return etree.fromstring(b, etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True, remove_blank_text=False))


def degz(b64):
    raw = base64.b64decode(b64)
    try:
        return gzip.decompress(raw)
    except OSError:
        return raw


def num(s):
    try:
        return float(str(s).replace(',', '.'))
    except Exception:
        return 0.0


def agora():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def dh_br():
    return datetime.now(timezone(timedelta(hours=-3))).replace(microsecond=0).isoformat()


# ---------------------------------------------------------------- banco
class Banco:
    def __init__(self, pasta):
        os.makedirs(pasta, exist_ok=True)
        self.c = sqlite3.connect(os.path.join(pasta, 'fiscal.db'), check_same_thread=False)
        self.c.row_factory = sqlite3.Row
        self.lk = threading.RLock()
        with self.lk:
            self.c.executescript('''
            create table if not exists estado(k text primary key, v text);
            create table if not exists docs(chave text primary key, tipo text, situacao text, nsu text, emit_cnpj text, emit_nome text,
              numero text, serie text, emissao text, valor real, xml text, manifestacao text, manif_dt text, manif_por text,
              importado integer default 0, importado_por text, importado_dt text, eventos text default '[]', criado text, atualizado text, extra text default '{}');
            create table if not exists log(ts text, nivel text, msg text);
            ''')
            # v123: documento marcado com o ambiente em que foi recebido (1 produção, 2 homologação)
            if 'amb' not in [r[1] for r in self.c.execute('pragma table_info(docs)')]:
                self.c.execute('alter table docs add column amb integer')
                self.c.commit()
        self.amb = None   # ambiente em uso; definido pelo Conector (chaves de POR_AMB ficam separadas por ambiente)

    def _k(self, k):
        return f'{k}@amb{self.amb}' if self.amb and k in POR_AMB else k

    def get(self, k, d=None):
        return self.get_cru(self._k(k), d)

    def get_cru(self, k, d=None):
        with self.lk:
            r = self.c.execute('select v from estado where k=?', (k,)).fetchone()
        return json.loads(r[0]) if r else d

    def set(self, k, v):
        self.set_cru(self._k(k), v)

    def set_cru(self, k, v):
        with self.lk:
            self.c.execute('insert into estado(k,v) values(?,?) on conflict(k) do update set v=excluded.v', (k, json.dumps(v)))
            self.c.commit()

    def migrar_por_ambiente(self, amb):
        """v123: até a v122 o NSU, as esperas e os bloqueios eram únicos. Ficam com o ambiente que estava em uso
        (o da variável AMBIENTE), uma única vez; o outro ambiente começa do zero."""
        with self.lk:
            if self.get_cru('por_amb_migrado'):
                return False
            movidos = []
            for k in POR_AMB:
                r = self.c.execute('select v from estado where k=?', (k,)).fetchone()
                if r is None:
                    continue
                if self.c.execute('select 1 from estado where k=?', (f'{k}@amb{amb}',)).fetchone() is None:
                    self.c.execute('insert into estado(k,v) values(?,?)', (f'{k}@amb{amb}', r[0]))
                self.c.execute('delete from estado where k=?', (k,))
                movidos.append(k)
            self.c.execute('update docs set amb=? where amb is null', (amb,))
            self.c.commit()
            self.set_cru('por_amb_migrado', {'amb': amb, 'em': agora(), 'chaves': movidos})
        if movidos:
            self.log(f"Sequências de NSU, esperas e bloqueios separados por ambiente: os valores atuais ficaram com {'produção' if amb == 1 else 'homologação'}.")
        return True

    def log(self, msg, nivel='info'):
        with self.lk:
            self.c.execute('insert into log values(?,?,?)', (agora(), nivel, msg[:500]))
            self.c.execute("delete from log where rowid not in (select rowid from log order by rowid desc limit 300)")
            self.c.commit()
        print(f'[{nivel}] {msg}', flush=True)

    def doc(self, chave):
        with self.lk:
            return self.c.execute('select * from docs where chave=?', (chave,)).fetchone()

    def salvar(self, d):
        """Insere ou atualiza; nunca troca XML completo por resumo."""
        with self.lk:
            ant = self.doc(d['chave'])
            if ant:
                novo = dict(ant)
                if ant['situacao'] == 'completa' and d.get('situacao') == 'resumo':
                    d = {k: v for k, v in d.items() if k in ('nsu',)}
                for k, v in d.items():
                    if v not in (None, ''):
                        novo[k] = v
                novo['atualizado'] = agora()
            else:
                novo = dict(chave=d['chave'], tipo='nfe', situacao='resumo', nsu='', emit_cnpj='', emit_nome='', numero='', serie='', emissao='',
                            valor=0, xml='', manifestacao='', manif_dt='', manif_por='', importado=0, importado_por='', importado_dt='', eventos='[]',
                            criado=agora(), atualizado=agora(), extra='{}', amb=self.amb)
                novo.update({k: v for k, v in d.items() if v is not None})
            cols = list(novo.keys())
            self.c.execute(f'insert or replace into docs({",".join(cols)}) values({",".join("?" * len(cols))})', [novo[c] for c in cols])
            self.c.commit()
            return not ant

    def evento(self, chave, ev):
        with self.lk:
            r = self.doc(chave)
            if not r:
                self.salvar({'chave': chave, 'tipo': 'nfe', 'situacao': 'evento'})
                r = self.doc(chave)
            evs = json.loads(r['eventos'] or '[]')
            if not any(e.get('tp') == ev.get('tp') and e.get('seq') == ev.get('seq') and e.get('dh') == ev.get('dh') for e in evs):
                evs.append(ev)
            self.c.execute('update docs set eventos=?, atualizado=? where chave=?', (json.dumps(evs), agora(), chave))
            self.c.commit()


# ---------------------------------------------------------------- leitura dos documentos
def ler_nfe_doc(schema, xml_bytes, nsu):
    """Converte um docZip da DistDFe num registro do banco (ou evento)."""
    x = parse_xml(xml_bytes)
    raiz = ln(x)
    s = schema.lower()
    if raiz == 'resNFe' or s.startswith('resnfe'):
        return 'doc', {'chave': txt(x, 'chNFe'), 'tipo': 'nfe', 'situacao': 'resumo', 'nsu': nsu, 'emit_cnpj': txt(x, 'CNPJ') or txt(x, 'CPF'),
                       'emit_nome': txt(x, 'xNome'), 'emissao': txt(x, 'dhEmi'), 'valor': num(txt(x, 'vNF')),
                       'extra': json.dumps({'cSitNFe': txt(x, 'cSitNFe'), 'tpNF': txt(x, 'tpNF'), 'nProt': txt(x, 'nProt'), 'IE': txt(x, 'IE')})}
    if raiz in ('nfeProc', 'NFe') or s.startswith('procnfe'):
        inf = achar(x, 'infNFe')
        chave = (inf.get('Id') or '')[3:] if inf is not None else ''
        chave = chave or txt(x, 'chNFe')
        emit = achar(x, 'emit')
        return 'doc', {'chave': chave, 'tipo': 'nfe', 'situacao': 'completa', 'nsu': nsu, 'emit_cnpj': txt(emit, 'CNPJ') or txt(emit, 'CPF') if emit is not None else '',
                       'emit_nome': txt(emit, 'xNome') if emit is not None else '', 'numero': txt(x, 'ide', 'nNF'), 'serie': txt(x, 'ide', 'serie'),
                       'emissao': txt(x, 'ide', 'dhEmi') or txt(x, 'ide', 'dEmi'), 'valor': num(txt(x, 'ICMSTot', 'vNF')),
                       'xml': xml_bytes.decode('utf-8', 'replace')}
    if raiz in ('resEvento', 'procEventoNFe', 'evento') or 'evento' in s:
        return 'evento', {'chave': txt(x, 'chNFe'), 'tp': txt(x, 'tpEvento'), 'seq': txt(x, 'nSeqEvento'), 'dh': txt(x, 'dhEvento'),
                          'desc': txt(x, 'xEvento') or txt(x, 'descEvento'), 'autor': txt(x, 'CNPJ'), 'prot': txt(x, 'nProt')}
    return None, None


def ler_nfse(xml_bytes, chave_hint='', nsu=''):
    x = parse_xml(xml_bytes)
    raiz = ln(x)
    if raiz not in ('NFSe', 'infNFSe') and achar(x, 'infNFSe') is None:
        # evento de NFS-e (cancelamento, etc.)
        return 'evento', {'chave': chave_hint or txt(x, 'chNFSe'), 'tp': txt(x, 'tpEvento') or raiz, 'seq': txt(x, 'nPedRegEvento'), 'dh': txt(x, 'dhEvento') or txt(x, 'dhProc'),
                          'desc': txt(x, 'xDesc') or txt(x, 'descEvento') or raiz, 'autor': txt(x, 'CNPJAutor') or txt(x, 'CNPJ'), 'prot': ''}
    inf = achar(x, 'infNFSe') if raiz != 'infNFSe' else x
    chave = ((inf.get('Id') or '')[3:] if inf is not None else '') or chave_hint
    emit = achar(x, 'emit')
    toma = achar(x, 'toma')
    valor = num(txt(x, 'valores', 'vLiq')) or num(txt(x, 'vServPrest', 'vServ')) or num(txt(x, 'vServ'))
    extra = {'tomador': (txt(toma, 'CNPJ') or txt(toma, 'CPF')) if toma is not None else '', 'municipio': txt(x, 'xLocEmi') or txt(x, 'xLocPrestacao'),
             'servico': txt(x, 'xDescServ')[:300], 'cTribNac': txt(x, 'cTribNac'), 'vISS': num(txt(x, 'vISSQN')),
             'retido': txt(x, 'tpRetISSQN') == '2'}
    extra.update(ler_ibscbs_nfse(x))
    return 'doc', {'chave': chave, 'tipo': 'nfse', 'situacao': 'completa', 'nsu': nsu,
                   'emit_cnpj': (txt(emit, 'CNPJ') or txt(emit, 'CPF')) if emit is not None else '', 'emit_nome': txt(emit, 'xNome') if emit is not None else '',
                   'numero': txt(x, 'nNFSe'), 'serie': txt(x, 'serie'), 'emissao': txt(x, 'dhEmi') or txt(x, 'dhProc'), 'valor': valor,
                   'xml': xml_bytes.decode('utf-8', 'replace'),
                   'extra': json.dumps(extra)}


def ler_ibscbs_nfse(x):
    """Campos IBS/CBS da NFS-e nacional (NT 004/005/007/009 de 2026), só os que existirem no XML.
    CST, cClassTrib, vBC, vIBS e vCBS são procurados só dentro dos grupos IBSCBS (fora deles há CST de PIS/COFINS e vBC do ISS)."""
    grupos = [e for e in x.iter() if ln(e) in ('IBSCBS', 'gIBSCBS')]
    out = {}

    def primeiro(*nomes, globais=False):
        for raiz in ([x] if globais else grupos):
            for nome in nomes:
                for e in raiz.iter():
                    if ln(e) == nome and e.text and e.text.strip():
                        return e.text.strip()
        return ''
    try:
        for chave, nomes in (('CST', ('CST',)), ('cClassTrib', ('cClassTrib',))):
            v = primeiro(*nomes)
            if v:
                out[chave] = v
        for chave, nomes in (('vBC', ('vBC',)), ('vIBS', ('vIBSTot', 'vIBS')), ('vCBS', ('vCBSTot', 'vCBS'))):
            v = primeiro(*nomes)
            if v:
                out[chave] = num(v)
        for chave in ('finNFSe', 'cIndOp'):
            v = primeiro(chave, globais=True)
            if v:
                out[chave] = v
    except Exception:
        return {}
    return out


# ---------------------------------------------------------------- serviços SEFAZ / ADN
def soap(corpo_xml, ns_ws, acao):
    env_ = (f'<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="{NS_SOAP}">'
            f'<soap12:Body>{corpo_xml}</soap12:Body></soap12:Envelope>')
    return env_.encode('utf-8'), {'Content-Type': f'application/soap+xml; charset=utf-8; action="{ns_ws}/{acao}"'}


def bloqueado(db):
    ate = max(db.get('nfe_bloqueio_ate', 0) or 0, db.get('nfe_espera_ate', 0) or 0)
    return ate if ate and time.time() < ate else 0


def hora_br(ts):
    return datetime.fromtimestamp(ts, timezone(timedelta(hours=-3))).strftime('%H:%M')


def dias_desde(emissao):
    """Dias desde a emissão (dhEmi), ou None se a data não puder ser lida."""
    try:
        d = datetime.fromisoformat(str(emissao).strip().replace('Z', '+00:00'))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone(timedelta(hours=-3)))
        return (datetime.now(timezone.utc) - d).total_seconds() / 86400
    except Exception:
        return None


class Conector:
    def __init__(self, cfg: Config, banco: Banco, http=None, cert=None):
        self.cfg, self.db = cfg, banco
        self.http = http
        self.cert = cert
        self.erro_cert = ''
        self.lk = threading.Lock()
        if self.cert is None:
            try:
                self.cert = Certificado(cfg.cert_path, cfg.cert_senha)
            except FileNotFoundError:
                self.erro_cert = 'Certificado não encontrado em ' + cfg.cert_path + '.'
            except Exception as e:
                self.erro_cert = 'Não foi possível abrir o certificado (senha ou arquivo inválido): ' + type(e).__name__
        if self.http is None and requests is not None:
            self.http = requests.Session()
        self.proxima_auto = 0
        # v123: separa NSU/esperas por ambiente (uma vez, com o ambiente da variável) e aplica a configuração do banco
        self.db.migrar_por_ambiente(cfg.padrao['ambiente'])
        self.aplicar_config()

    # ---- v123: configuração em tempo de execução (banco do conector > variáveis de ambiente)
    def aplicar_config(self):
        """Lê 'cfg_runtime' do banco e aplica sobre os padrões das variáveis. Os endereços (www1/hom1, ADN produção/
        produção restrita) são escolhidos a cada chamada por self.cfg.amb, então a troca vale sem reiniciar."""
        rt = self.db.get_cru('cfg_runtime') or {}
        val = rt.get('valores') or {}
        P, cfg, org = self.cfg.padrao, self.cfg, {}
        for k in ('ambiente', 'nfe_dist', 'nfse', 'auto'):
            org[k] = 'banco' if k in val else 'ambiente'
        cfg.amb = int(val.get('ambiente', P['ambiente']))
        cfg.nfe_dist = bool(val.get('nfe_dist', P['nfe_dist']))
        cfg.nfse = bool(val.get('nfse', P['nfse']))
        cfg.auto = bool(val.get('auto', P['auto']))
        if 'auto_ciencia' in val:
            cfg.auto_ciencia, org['auto_ciencia'] = bool(val['auto_ciencia']), 'banco'
        elif P['auto_ciencia'] is not None:
            cfg.auto_ciencia, org['auto_ciencia'] = P['auto_ciencia'], 'ambiente'
        else:
            cfg.auto_ciencia, org['auto_ciencia'] = cfg.nfe_dist, 'ambiente'   # sem AUTO_CIENCIA: segue a NF-e por NSU
        cfg.origem = org
        self.db.amb = cfg.amb

    def config_efetiva(self):
        c = self.cfg
        return {'ambiente': c.amb, 'nfe_dist': c.nfe_dist, 'nfse': c.nfse, 'auto': c.auto, 'auto_ciencia': c.auto_ciencia}

    def config_view(self):
        rt = self.db.get_cru('cfg_runtime') or {}
        us = self.db.get('ultima_sync') or {}
        return {'config': self.config_efetiva(), 'origem': dict(self.cfg.origem), 'padrao': dict(self.cfg.padrao),
                'alteradaPor': rt.get('por', ''), 'alteradaEm': rt.get('em', ''), 'intervaloMin': self.cfg.intervalo,
                'ultimaBusca': us.get('em', ''), 'ultimaBuscaOrigem': us.get('origem', ''),
                'proximaAuto': datetime.fromtimestamp(self.proxima_auto, timezone.utc).isoformat() if self.cfg.auto and self.proxima_auto > time.time() else '',
                'problema': self.pronto(),
                'enderecos': {'nfe': URL['dist'][self.cfg.amb].split('/')[2], 'nfse': URL['adn'][self.cfg.amb].split('/')[2]}}

    @staticmethod
    def validar_config(inp):
        """Devolve (mudanças, restaurar, erro). Aceita 1/0, true/false e '1'/'0'; ambiente 1 (produção) ou 2 (homologação);
        null volta aquele campo ao padrão da variável; restaurar=true volta tudo."""
        if not isinstance(inp, dict):
            return None, False, 'Configuração inválida.'
        mud, restaurar = {}, False
        for k, v in inp.items():
            if k == 'restaurar':
                if v not in (True, False, 0, 1, '0', '1') or isinstance(v, float):
                    return None, False, 'Valor inválido para restaurar.'
                restaurar = v in (True, 1, '1')
                continue
            if k not in CAMPOS_CFG:
                return None, False, f'Campo desconhecido: {str(k)[:40]}.'
            if v is None:
                mud[k] = None
            elif k == 'ambiente':
                if isinstance(v, bool) or v not in (1, 2, '1', '2'):
                    return None, False, 'Ambiente inválido: use 1 (produção) ou 2 (homologação).'
                mud[k] = int(v)
            else:
                if isinstance(v, float) or v not in (True, False, 0, 1, '0', '1'):
                    return None, False, f'Valor inválido para {ROTULO_CFG[k]}: use ligado (1) ou desligado (0).'
                mud[k] = v in (True, 1, '1')
        return mud, restaurar, ''

    def config_salvar(self, inp, usuario=''):
        mud, restaurar, erro = self.validar_config(inp)
        if erro:
            return {'ok': False, 'msg': erro}
        if not mud and not restaurar:
            return dict(ok=True, alterado=False, **self.config_view())
        if not self.lk.acquire(blocking=False):
            return {'ok': False, 'msg': 'Uma busca está em andamento. Tente de novo em alguns minutos.'}
        try:
            antes = self.config_efetiva()
            rt = self.db.get_cru('cfg_runtime') or {}
            val = {} if restaurar else dict(rt.get('valores') or {})
            for k, v in mud.items():
                if v is None:
                    val.pop(k, None)
                else:
                    val[k] = v
            self.db.set_cru('cfg_runtime', {'valores': val, 'por': usuario or '', 'em': agora()})
            self.aplicar_config()
            depois = self.config_efetiva()

            def f(k, v):
                return ('produção' if v == 1 else 'homologação') if k == 'ambiente' else ('ligada' if v else 'desligada') if k != 'nfe_dist' else ('Central' if v else 'Omie')
            dif = [f'{ROTULO_CFG[k]}: {f(k, antes[k])} → {f(k, depois[k])}' for k in CAMPOS_CFG if antes[k] != depois[k]]
            self.db.log(f"Configuração alterada por {usuario or 'não informado'}" + (' (voltou ao padrão das variáveis)' if restaurar else '') + ': ' +
                        ('; '.join(dif) if dif else 'sem mudança efetiva') + '.', 'aviso' if dif else 'info')
            if antes['ambiente'] != depois['ambiente']:
                v = self.config_view()['enderecos']
                self.db.log(f"Endereços em uso: NF-e {v['nfe']} · NFS-e {v['nfse']}. NSU e esperas deste ambiente: NF-e {self.db.get('nfe_ult_nsu', '0')}, NFS-e {self.db.get('nfse_ult_nsu', 0)}.")
            hist = (self.db.get_cru('cfg_hist') or [])[-19:]
            hist.append({'em': agora(), 'por': usuario or '', 'antes': antes, 'depois': depois, 'restaurar': restaurar})
            self.db.set_cru('cfg_hist', hist)
        finally:
            self.lk.release()
        return dict(ok=True, alterado=bool(dif), mudancas=dif, **self.config_view())

    # ---- transporte
    def post(self, url, dados, headers):
        r = self.http.post(url, data=dados, headers=headers, cert=self.cert.tls, verify=self.cfg.ca, timeout=90)
        if r.status_code >= 400 and not r.content:
            raise RuntimeError(f'HTTP {r.status_code}')
        return r.content

    def get(self, url, params=None):
        return self.http.get(url, params=params, cert=self.cert.tls, verify=self.cfg.ca, timeout=90, headers={'Accept': 'application/json'})

    def pronto(self):
        if not self.cfg.cnpj or len(self.cfg.cnpj) != 14:
            return 'Defina CNPJ (14 dígitos) nas variáveis do serviço fiscal.'
        if self.erro_cert or not self.cert:
            return self.erro_cert or 'Certificado não carregado.'
        return ''

    # ---- NF-e: distribuição
    def dist_xml(self, ult_nsu=None, chave=None):
        sel = f'<consChNFe><chNFe>{chave}</chNFe></consChNFe>' if chave else f'<distNSU><ultNSU>{int(ult_nsu or 0):015d}</ultNSU></distNSU>'
        return (f'<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>'
                f'<distDFeInt xmlns="{NS_NFE}" versao="1.01"><tpAmb>{self.cfg.amb}</tpAmb><cUFAutor>{UF_COD.get(self.cfg.uf, 35)}</cUFAutor>'
                f'<CNPJ>{self.cfg.cnpj}</CNPJ>{sel}</distDFeInt></nfeDadosMsg></nfeDistDFeInteresse>')

    def chamar_dist(self, **kw):
        dados, h = soap(self.dist_xml(**kw), 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe', 'nfeDistDFeInteresse')
        resp = parse_xml(self.post(URL['dist'][self.cfg.amb], dados, h))
        ret = achar(resp, 'retDistDFeInt')
        if ret is None:
            raise RuntimeError('Resposta inesperada da SEFAZ (sem retDistDFeInt).')
        docs = [(z.get('NSU', ''), z.get('schema', ''), degz(z.text or '')) for z in ret.iter() if ln(z) == 'docZip']
        return {'cStat': txt(ret, 'cStat'), 'xMotivo': txt(ret, 'xMotivo'), 'ultNSU': txt(ret, 'ultNSU'), 'maxNSU': txt(ret, 'maxNSU'), 'docs': docs}

    def guardar_nfe(self, docs, novos, resumos):
        for nsu, schema, xb in docs:
            try:
                tipo, d = ler_nfe_doc(schema, xb, nsu)
            except Exception as e:
                self.db.log(f'NSU {nsu}: XML não lido ({type(e).__name__})', 'aviso')
                continue
            if tipo == 'doc' and d['chave']:
                if self.db.salvar(d):
                    novos.append(d['chave'])
                if d['situacao'] == 'resumo':
                    resumos.append(d['chave'])
            elif tipo == 'evento' and d['chave']:
                self.db.evento(d['chave'], d)
                nome = TP_NOME.get(d['tp'])
                if nome and str(d.get('autor', '')) == self.cfg.cnpj:
                    with self.db.lk:
                        self.db.c.execute("update docs set manifestacao=?, manif_dt=? where chave=? and (manifestacao='' or manifestacao is null)", (nome, d['dh'], d['chave']))
                        self.db.c.commit()

    def marcar_656(self, r):
        """656 = consumo indevido: a SEFAZ bloqueia o CNPJ por 1 hora (e zera o prazo a cada nova tentativa). Margem de 5 min."""
        ate = time.time() + UMA_HORA + 300
        self.db.set('nfe_bloqueio_ate', ate)
        self.db.log(f"SEFAZ: consumo indevido (656) - {r.get('xMotivo', '')}. Nenhuma consulta de NF-e até {hora_br(ate)}.", 'aviso')
        return ate

    def sync_nfe(self, forcar=False):
        # forcar fica só por compatibilidade: não fura mais a espera da SEFAZ (NT 2014.002)
        if not self.cfg.nfe_dist:
            return {'ok': True, 'desligado': True, 'msg': 'Busca de NF-e por NSU desligada (Omie consulta; NFE_DIST=0 ou Sistema › Configurações): as NF-e deste CNPJ são capturadas pelo Agente da NF-e do Omie.'}
        ate = bloqueado(self.db)
        if ate:
            return {'ok': True, 'aguardando': True, 'msg': 'A SEFAZ pede 1 hora entre consultas sem novidade (ou após consumo indevido). Próxima busca de NF-e após ' + hora_br(ate) + '.'}
        ult = self.db.get('nfe_ult_nsu', '0')
        ult_inicio = ult
        novos, resumos, voltas = [], [], 0
        while voltas < 20:
            voltas += 1
            try:
                r = self.chamar_dist(ult_nsu=ult)
            except Exception:
                # erro de rede, HTTP 5xx ou resposta inválida: não insistir antes de 1 hora
                self.db.set('nfe_espera_ate', time.time() + UMA_HORA)
                raise
            self.db.set('nfe_ultimo_retorno', {'cStat': r['cStat'], 'xMotivo': r['xMotivo'], 'em': agora()})
            if r['cStat'] == '656':
                self.marcar_656(r)
                try:
                    maior = int(r['ultNSU'] or 0) > int(ult or 0)
                except ValueError:
                    maior = False
                if 'ultnsu' in (r['xMotivo'] or '').lower() or maior:
                    self.db.set('nfe_conflito', {'em': agora(), 'nosso': ult, 'sefaz': r['ultNSU'], 'motivo': r['xMotivo']})
                    self.db.log('Outro sistema consulta a Distribuição DF-e deste CNPJ (provável Agente da NF-e do Omie). Use um só: Sistema › Configurações da Central (NF-e por NSU) ou NFE_DIST no LEIA-ME.', 'erro')
                if r['ultNSU']:
                    ult = r['ultNSU']
                    self.db.set('nfe_ult_nsu', ult)
                break
            if r['cStat'] not in ('137', '138'):
                self.db.log(f"SEFAZ respondeu {r['cStat']} - {r['xMotivo']}. Nova tentativa em 1 hora.", 'erro')
                self.db.set('nfe_espera_ate', time.time() + UMA_HORA)
                break
            self.guardar_nfe(r['docs'], novos, resumos)
            if r['ultNSU']:
                ult = r['ultNSU']
                self.db.set('nfe_ult_nsu', ult)
            self.db.set('nfe_max_nsu', r['maxNSU'])
            if r['cStat'] == '137' or not r['maxNSU'] or int(ult or 0) >= int(r['maxNSU'] or 0):
                self.db.set('nfe_espera_ate', time.time() + UMA_HORA)
                break
        ciencias, fora_prazo = 0, 0
        if self.cfg.auto_ciencia:
            for ch in resumos:
                d = self.db.doc(ch)
                if d and not d['manifestacao'] and len(ch) == 44:
                    dias = dias_desde(d['emissao'])
                    if dias is not None and dias > PRAZO_CIENCIA_DIAS:
                        fora_prazo += 1   # ciência só até 10 dias (NT 2020.001 v1.60); dhEmi como aproximação da autorização
                        continue
                    try:
                        if self.manifestar(ch, 'ciencia', usuario='automático').get('ok'):
                            ciencias += 1
                    except Exception as e:
                        self.db.log(f'Ciência automática falhou para {ch[-8:]}: {type(e).__name__}', 'aviso')
            if fora_prazo:
                self.db.log(f'{fora_prazo} NF-e resumida(s) com mais de {PRAZO_CIENCIA_DIAS} dias: ciência automática não enviada (fora do prazo).', 'aviso')
        return {'ok': True, 'novos': len(novos), 'resumos': len(resumos), 'ciencias': ciencias, 'ultNSU': ult}

    def baixar(self, chave):
        chave = re.sub(r'[^0-9A-Z]', '', str(chave or '').upper())
        if len(chave) != 44:
            return {'ok': False, 'msg': 'Chave de acesso inválida.'}
        ate = bloqueado(self.db)
        if ate:
            return {'ok': False, 'bloqueado': True, 'msg': f'A SEFAZ está em espera de consumo indevido até {hora_br(ate)}. Não tente antes, ou o prazo recomeça.'}
        t = time.time()
        cont = self.db.get('nfe_chave_cont', {}) or {}
        cont = {k: [x for x in v if t - x < UMA_HORA] for k, v in cont.items()}
        cont = {k: v for k, v in cont.items() if v}
        usados = cont.get(chave, [])
        if len(usados) >= self.cfg.chave_max_hora:
            libera = min(usados) + UMA_HORA
            self.db.set('nfe_chave_cont', cont)
            return {'ok': False, 'limite': True, 'msg': f'Esta nota já foi consultada {len(usados)} vezes na última hora (limite {self.cfg.chave_max_hora}). Tente de novo após {hora_br(libera)}.'}
        cont[chave] = usados + [t]
        self.db.set('nfe_chave_cont', cont)
        try:
            r = self.chamar_dist(chave=chave)
        except Exception:
            self.db.set('nfe_espera_ate', time.time() + UMA_HORA)
            raise
        self.db.set('nfe_ultimo_retorno', {'cStat': r['cStat'], 'xMotivo': r['xMotivo'], 'em': agora()})
        if r['cStat'] == '656':
            ate = self.marcar_656(r)
            return {'ok': False, 'cStat': '656', 'bloqueado': True, 'msg': f'A SEFAZ recusou por consumo indevido (656). Espere até {hora_br(ate)} antes de tentar de novo.'}
        if r['cStat'] not in ('138',):
            return {'ok': False, 'cStat': r['cStat'], 'msg': r['xMotivo'] or 'Documento não disponível. Dê ciência e tente de novo em alguns minutos.'}
        novos, resumos = [], []
        self.guardar_nfe(r['docs'], novos, resumos)
        d = self.db.doc(chave)
        return {'ok': bool(d and d['situacao'] == 'completa'), 'situacao': d['situacao'] if d else '', 'msg': '' if d and d['situacao'] == 'completa' else 'A SEFAZ ainda devolveu só o resumo. Dê ciência e tente mais tarde.'}

    # ---- NF-e: manifestação do destinatário
    def evento_xml(self, chave, evento, just='', seq=1):
        tp, desc = EVENTOS[evento]
        Id = f'ID{tp}{chave}{seq:02d}'
        N = '{%s}' % NS_NFE
        env_ = etree.Element(N + 'envEvento', nsmap={None: NS_NFE}, versao='1.00')
        etree.SubElement(env_, N + 'idLote').text = str(int(time.time() * 1000) % 10 ** 15)
        ev = etree.SubElement(env_, N + 'evento', versao='1.00')
        inf = etree.SubElement(ev, N + 'infEvento', Id=Id)
        for k, v in (('cOrgao', '91'), ('tpAmb', str(self.cfg.amb)), ('CNPJ', self.cfg.cnpj), ('chNFe', chave), ('dhEvento', dh_br()),
                     ('tpEvento', tp), ('nSeqEvento', str(seq)), ('verEvento', '1.00')):
            etree.SubElement(inf, N + k).text = v
        det = etree.SubElement(inf, N + 'detEvento', versao='1.00')
        etree.SubElement(det, N + 'descEvento').text = desc
        if evento == 'nao_realizada':
            etree.SubElement(det, N + 'xJust').text = just
        assinar_xml(env_, inf, self.cert)
        return env_

    def manifestar(self, chave, evento, just='', usuario=''):
        chave = re.sub(r'[^0-9A-Z]', '', (chave or '').upper())
        if len(chave) != 44:
            return {'ok': False, 'msg': 'Chave de acesso inválida.'}
        if evento not in EVENTOS:
            return {'ok': False, 'msg': 'Evento inválido.'}
        just = re.sub(r'\s+', ' ', just or '').strip()
        if evento == 'nao_realizada' and not (15 <= len(just) <= 255):
            return {'ok': False, 'msg': 'A justificativa precisa ter de 15 a 255 caracteres.'}
        # prazos da NT 2020.001 v1.60: só avisa (não bloqueia); a SEFAZ decide
        aviso = ''
        doc = self.db.doc(chave)
        dias = dias_desde(doc['emissao']) if doc and doc['emissao'] else None
        prazo = PRAZO_CIENCIA_DIAS if evento == 'ciencia' else PRAZO_CONCLUSIVO_DIAS
        if dias is not None and dias > prazo:
            aviso = f'A nota tem {int(dias)} dias. O prazo para {EVENTOS[evento][1].lower()} é de {prazo} dias da autorização; a SEFAZ pode recusar.'
            self.db.log(f'Manifestação {evento} {chave[-8:]}: {aviso}', 'aviso')
        xml = etree.tostring(self.evento_xml(chave, evento, just), encoding='unicode')
        corpo = f'<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">{xml}</nfeDadosMsg>'
        dados, h = soap(corpo, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4', 'nfeRecepcaoEvento')
        resp = parse_xml(self.post(URL['evento'][self.cfg.amb], dados, h))
        lote = achar(resp, 'retEnvEvento')
        ret = achar(resp, 'retEvento')
        cst = txt(ret, 'cStat') if ret is not None else (txt(lote, 'cStat') if lote is not None else '')
        mot = txt(ret, 'xMotivo') if ret is not None else (txt(lote, 'xMotivo') if lote is not None else 'sem resposta')
        ok = cst in ('135', '136', '573')  # 573 = já registrado (duplicidade)
        if not ok and 'prazo' in (mot or '').lower():
            mot = f'A SEFAZ recusou: fora do prazo ({cst} - {mot}). Ciência vale até {PRAZO_CIENCIA_DIAS} dias e os demais eventos até {PRAZO_CONCLUSIVO_DIAS} dias da autorização da nota.'
        if ok:
            if not self.db.doc(chave):
                self.db.salvar({'chave': chave, 'tipo': 'nfe', 'situacao': 'resumo'})
            with self.db.lk:
                self.db.c.execute('update docs set manifestacao=?, manif_dt=?, manif_por=? where chave=?', (evento, agora(), usuario, chave))
                self.db.c.commit()
            self.db.evento(chave, {'tp': EVENTOS[evento][0], 'seq': '1', 'dh': agora(), 'desc': EVENTOS[evento][1], 'autor': self.cfg.cnpj, 'prot': txt(ret, 'nProt') if ret is not None else ''})
        self.db.log(f'Manifestação {evento} {chave[-8:]}: {cst} {mot}', 'info' if ok else 'aviso')
        out = {'ok': ok, 'cStat': cst, 'msg': mot}
        if aviso:
            out['aviso'] = aviso
        return out

    # ---- NFS-e: Ambiente de Dados Nacional
    def sync_nfse(self):
        espera = self.db.get('nfse_espera_ate', 0)
        if espera and time.time() < espera:
            return {'ok': True, 'aguardando': True}
        ult = int(self.db.get('nfse_ult_nsu', 0) or 0)
        novos, voltas = 0, 0
        base = URL['adn'][self.cfg.amb]
        while voltas < 30:
            voltas += 1
            r = self.get(f'{base}/DFe/{ult + 1}', params=self.cfg.adn_params or None)
            if r.status_code == 404:
                self.db.set('nfse_espera_ate', time.time() + UMA_HORA)
                break
            if r.status_code >= 400:
                self.db.log(f'ADN NFS-e respondeu HTTP {r.status_code} (ref. {falha_ref("ADN HTTP " + str(r.status_code) + ": " + r.text[:300])}).', 'erro')
                self.db.set('nfse_espera_ate', time.time() + UMA_HORA)
                break
            j = r.json()
            jl = {k.lower(): v for k, v in j.items()} if isinstance(j, dict) else {}
            lote = jl.get('lotedfe') or jl.get('lote') or (j if isinstance(j, list) else [])
            st = str(jl.get('statusprocessamento', '')).upper()
            if not lote:
                self.db.set('nfse_espera_ate', time.time() + UMA_HORA)
                if st and 'NENHUM' not in st:
                    self.db.log(f'ADN NFS-e: {st} {json.dumps(jl.get("erros") or jl.get("alertas") or "")[:200]}', 'aviso')
                break
            maior = ult
            for it in lote:
                il = {k.lower(): v for k, v in it.items()}
                nsu = int(il.get('nsu') or 0)
                maior = max(maior, nsu)
                arq = il.get('arquivoxml') or il.get('xml') or ''
                if not arq:
                    continue
                try:
                    tipo, d = ler_nfse(degz(arq), il.get('chaveacesso') or '', str(nsu))
                except Exception as e:
                    self.db.log(f'NFS-e NSU {nsu}: XML não lido ({type(e).__name__})', 'aviso')
                    continue
                if tipo == 'doc' and d['chave']:
                    ex = json.loads(d.get('extra') or '{}')
                    # só as recebidas (empresa como tomadora); emitidas pela própria empresa ficam marcadas
                    ex['emitidaPelaEmpresa'] = d['emit_cnpj'] == self.cfg.cnpj
                    d['extra'] = json.dumps(ex)
                    if self.db.salvar(d):
                        novos += 1
                elif tipo == 'evento' and d['chave']:
                    self.db.evento(d['chave'], d)
            if maior <= ult:
                break
            ult = maior
            self.db.set('nfse_ult_nsu', ult)
        return {'ok': True, 'novos': novos, 'ultNSU': ult}

    # ---- rotina
    def sincronizar(self, forcar=False, origem='manual'):
        msg = self.pronto()
        if msg:
            return {'ok': False, 'msg': msg}
        if not self.lk.acquire(blocking=False):
            return {'ok': False, 'msg': 'Uma busca já está em andamento.'}
        try:
            out = {'ok': True, 'em': agora(), 'origem': origem, 'ambiente': self.cfg.amb}
            try:
                out['nfe'] = self.sync_nfe(forcar)
            except Exception as e:
                out['nfe'] = {'ok': False, 'msg': 'Falha ao consultar a SEFAZ. Tente mais tarde; se continuar, veja o log do serviço fiscal (ref. ' + falha_ref('SEFAZ', e) + ').'}
                self.db.log(out['nfe']['msg'], 'erro')
            if self.cfg.nfse:
                try:
                    out['nfse'] = self.sync_nfse()
                except Exception as e:
                    out['nfse'] = {'ok': False, 'msg': 'Falha ao consultar o Ambiente Nacional da NFS-e. Tente mais tarde; se continuar, veja o log do serviço fiscal (ref. ' + falha_ref('ADN', e) + ').'}
                    self.db.log(out['nfse']['msg'], 'erro')
            self.db.set('ultima_sync', out)
            return out
        finally:
            self.lk.release()

    def status(self):
        espera = self.db.get('nfe_espera_ate', 0)
        bloq = bloqueado(self.db)
        with self.db.lk:
            cont = {r['k']: r['n'] for r in self.db.c.execute(
                "select tipo||'_'||(case when importado=1 then 'importadas' else 'pendentes' end) k, count(*) n from docs where situacao!='evento' and (amb=? or amb is null) group by 1", (self.cfg.amb,))}
            logs = [dict(r) for r in self.db.c.execute('select * from log order by rowid desc limit 15')]
        return {'ok': not self.pronto(), 'problema': self.pronto(), 'cnpj': self.cfg.cnpj, 'uf': self.cfg.uf,
                'ambiente': 'produção' if self.cfg.amb == 1 else 'homologação', 'certificado': self.cert.info() if self.cert else None,
                'nfeDist': self.cfg.nfe_dist, 'nfeBloqueioAte': datetime.fromtimestamp(bloq, timezone.utc).isoformat() if bloq else '',
                'conflito': self.db.get('nfe_conflito'),
                'autoCiencia': self.cfg.auto_ciencia, 'nfse': self.cfg.nfse, 'intervaloMin': self.cfg.intervalo,
                'nfeUltNSU': self.db.get('nfe_ult_nsu', '0'), 'nfeMaxNSU': self.db.get('nfe_max_nsu', ''), 'nfseUltNSU': self.db.get('nfse_ult_nsu', 0),
                'proximaNfe': datetime.fromtimestamp(espera, timezone.utc).isoformat() if espera and espera > time.time() else '',
                'ultimaSync': self.db.get('ultima_sync'), 'ultimoRetornoSefaz': self.db.get('nfe_ultimo_retorno'), 'contagem': cont, 'log': logs,
                # v123: configuração efetiva e de onde veio cada valor (banco = tela da Central; ambiente = variável)
                'ambienteCod': self.cfg.amb, 'buscaAuto': self.cfg.auto,
                'proximaAuto': datetime.fromtimestamp(self.proxima_auto, timezone.utc).isoformat() if self.cfg.auto and self.proxima_auto > time.time() else '',
                'configuracao': self.config_view()}

    def listar(self, q):
        sql = "select chave,tipo,situacao,nsu,emit_cnpj,emit_nome,numero,serie,emissao,valor,manifestacao,manif_dt,manif_por,importado,importado_por,importado_dt,eventos,criado,atualizado,extra, length(xml)>0 temXml from docs where situacao!='evento' and (amb=? or amb is null)"
        p = [self.cfg.amb]   # v123: só os documentos do ambiente em uso
        if q.get('tipo') in ('nfe', 'nfse'):
            sql += ' and tipo=?'
            p.append(q['tipo'])
        if q.get('pendentes') in ('1', 'true', True):
            sql += ' and importado=0'
        if q.get('desde'):
            sql += ' and substr(emissao,1,10)>=?'
            p.append(str(q['desde'])[:10])
        sql += ' order by emissao desc limit ?'
        p.append(min(int(q.get('limite') or 500), 2000))
        with self.db.lk:
            rows = [dict(r) for r in self.db.c.execute(sql, p)]
        for r in rows:
            r['eventos'] = json.loads(r['eventos'] or '[]')
            r['extra'] = json.loads(r['extra'] or '{}')
            r['temXml'] = bool(r['temXml'])
        return {'documentos': rows}

    def xml(self, chave):
        d = self.db.doc(chave)
        return d['xml'] if d and d['xml'] else None

    def marcar(self, chave, importado=True, usuario=''):
        with self.db.lk:
            n = self.db.c.execute('update docs set importado=?, importado_por=?, importado_dt=? where chave=?', (1 if importado else 0, usuario if importado else '', agora() if importado else '', chave)).rowcount
            self.db.c.commit()
        return {'ok': bool(n)}

    def ferramenta(self, nome, inp, usuario='', pode_config=False):
        inp = inp or {}
        if nome == 'status':
            return self.status()
        if nome == 'config':
            # ler é livre (com o token); alterar só pela rota da Central que exigiu a senha (cabeçalho x-fiscal-config)
            if inp and not pode_config:
                raise PermissionError('config')
            return self.config_salvar(inp, usuario)
        if nome == 'sincronizar':
            return self.sincronizar(bool(inp.get('forcar')))
        if nome == 'listar_documentos':
            return self.listar(inp)
        if nome == 'obter_xml':
            x = self.xml(str(inp.get('chave', '')))
            return {'ok': bool(x), 'xml': x or '', 'msg': '' if x else 'XML completo ainda não disponível.'}
        if nome == 'marcar_importado':
            return self.marcar(str(inp.get('chave', '')), inp.get('importado', True) is not False, usuario)
        if nome == 'manifestar':
            m = self.pronto()
            return {'ok': False, 'msg': m} if m else self.manifestar(str(inp.get('chave', '')), str(inp.get('evento', '')), str(inp.get('justificativa', '')), usuario)
        if nome == 'baixar':
            m = self.pronto()
            return {'ok': False, 'msg': m} if m else self.baixar(re.sub(r'[^0-9A-Z]', '', str(inp.get('chave', '')).upper()))
        raise KeyError(nome)


# ---------------------------------------------------------------- HTTP
def servidor(con: Conector, cfg: Config):
    class H(BaseHTTPRequestHandler):
        server_version = 'ConectorFiscal/1'

        def log_message(self, fmt, *a):
            pass

        def resp(self, code, obj, tipo='application/json; charset=utf-8'):
            b = obj if isinstance(obj, bytes) else (obj.encode() if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False).encode())
            self.send_response(code)
            self.send_header('Content-Type', tipo)
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)

        def autorizado(self):
            import hmac
            t = self.headers.get('x-fiscal-token', '')
            return bool(cfg.token) and hmac.compare_digest(t, cfg.token)

        def corpo(self):
            n = int(self.headers.get('Content-Length') or 0)
            if n > 2_000_000:
                raise ValueError('corpo grande demais')
            b = self.rfile.read(n) if n else b''
            return json.loads(b or b'{}')

        def tratar(self, metodo):
            u = urlparse(self.path)
            p = u.path.rstrip('/') or '/'
            if p == '/saude':
                return self.resp(200, {'ok': True})
            if not self.autorizado():
                return self.resp(401, {'erro': 'Token inválido.'})
            usuario = unquote(self.headers.get('x-usuario', ''))[:80]
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            try:
                if metodo == 'GET' and p == '/status':
                    return self.resp(200, con.status())
                if metodo == 'POST' and p == '/sincronizar':
                    return self.resp(200, con.sincronizar(bool(self.corpo().get('forcar'))))
                if metodo == 'GET' and p == '/documentos':
                    return self.resp(200, con.listar(q))
                m = re.fullmatch(r'/documentos/([0-9A-Z]{20,60})/xml', p)
                if metodo == 'GET' and m:
                    x = con.xml(m.group(1))
                    return self.resp(200, x, 'application/xml; charset=utf-8') if x else self.resp(404, {'erro': 'XML completo ainda não disponível.'})
                m = re.fullmatch(r'/documentos/([0-9A-Z]{20,60})/importado', p)
                if metodo == 'POST' and m:
                    return self.resp(200, con.marcar(m.group(1), self.corpo().get('importado', True) is not False, usuario))
                if metodo == 'POST' and p == '/manifestar':
                    return self.resp(200, con.ferramenta('manifestar', self.corpo(), usuario))
                if metodo == 'POST' and p == '/baixar':
                    return self.resp(200, con.ferramenta('baixar', self.corpo(), usuario))
                m = re.fullmatch(r'/tool/([a-z_]+)', p)
                if metodo == 'POST' and m:
                    try:
                        return self.resp(200, con.ferramenta(m.group(1), self.corpo(), usuario, self.headers.get('x-fiscal-config', '') == '1'))
                    except KeyError:
                        return self.resp(404, {'erro': 'Ferramenta desconhecida.'})
                    except PermissionError:
                        return self.resp(403, {'erro': 'A configuração do conector só é alterada em Sistema › Configurações da Central (com confirmação de senha).'})
                return self.resp(404, {'erro': 'Rota não encontrada.'})
            except Exception as e:
                # detalhe só no log do contêiner; quem chamou recebe uma mensagem genérica com um código para procurar no log
                return self.resp(500, {'erro': 'Erro interno do conector fiscal (ref. ' + falha_ref(metodo + ' ' + p, e) + ').'})

        def do_GET(self):
            self.tratar('GET')

        def do_POST(self):
            self.tratar('POST')

    return ThreadingHTTPServer(('0.0.0.0', cfg.port), H)


def falha_ref(contexto, e=None):
    """Registra o detalhe do erro só no log do contêiner (stdout) e devolve um código curto para a mensagem genérica."""
    ref = hashlib.sha1(os.urandom(8)).hexdigest()[:8]
    print(f'[erro {ref}] {contexto}: {type(e).__name__ if e else ""} {e if e else ""}', flush=True)
    if e is not None:
        traceback.print_exc()
    return ref


def rodada_agendada(con: Conector):
    """Uma rodada do agendador. Com a busca automática desligada (BUSCA_AUTO=0 ou tela da Central) não chama a SEFAZ nem o ADN;
    "Buscar agora" continua funcionando, com as mesmas esperas da SEFAZ."""
    if not con.cfg.auto:
        return {'ok': True, 'desligado': True}
    if con.pronto():
        return None
    return con.sincronizar(origem='automática')


def agendador(con: Conector, cfg: Config):
    con.proxima_auto = time.time() + 20
    time.sleep(20)
    while True:
        try:
            rodada_agendada(con)
        except Exception:
            traceback.print_exc()
        con.proxima_auto = time.time() + cfg.intervalo * 60
        time.sleep(cfg.intervalo * 60)


def main():
    cfg = Config()
    if not cfg.token:
        raise SystemExit('Defina FISCAL_TOKEN (o mesmo valor no serviço da Central).')
    banco = Banco(cfg.data)
    con = Conector(cfg, banco)
    p = con.pronto()
    banco.log('Conector fiscal iniciado (' + ('produção' if cfg.amb == 1 else 'homologação') + ('' if cfg.origem.get('ambiente') == 'ambiente' else ', definido na Central') +
              ('' if cfg.auto else ', busca automática desligada') + ')' + (' - ' + p if p else ''), 'aviso' if p else 'info')
    threading.Thread(target=agendador, args=(con, cfg), daemon=True).start()
    srv = servidor(con, cfg)
    print(f'Conector fiscal na porta {cfg.port}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()

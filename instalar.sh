#!/usr/bin/env bash
# Central de Gestão — instalador automático para VPS Hostinger com Easypanel
# Uso (no terminal da VPS, como root):
#   bash <(curl -fsSL https://raw.githubusercontent.com/<dono>/<repositorio>/main/instalar.sh)
# ou, com o repositório já clonado:  bash instalar.sh
#
# O que faz:
#   1. Confere o Easypanel e pede o token da API dele (Easypanel › Settings › Users › API Token).
#   2. Pergunta o domínio (app.inaservicos.com.br), o repositório do GitHub e os dados do certificado A1.
#   3. Prepara /opt/central/certs (certificado do conector fiscal e cópia para o extrato do Banco do Brasil).
#   4. Cria no Easypanel o projeto "central" com os serviços "fiscal" e "gestao": origem no GitHub,
#      Dockerfile, variáveis de ambiente, volumes, pasta do certificado e domínio com HTTPS.
#   5. Faz o primeiro deploy e mostra o endereço para criar a conta do dono.
# Nada sai da VPS: senhas e tokens ficam só nas variáveis dos serviços no Easypanel.
set -euo pipefail
VERDE='\033[0;32m'; AMARELO='\033[1;33m'; VERMELHO='\033[0;31m'; NC='\033[0m'
ok(){ echo -e "${VERDE}✔ $*${NC}"; }
aviso(){ echo -e "${AMARELO}! $*${NC}"; }
erro(){ echo -e "${VERMELHO}✖ $*${NC}"; }
pergunta(){ local p="$1" def="${2:-}" v; if [ -n "$def" ]; then read -r -p "$p [$def]: " v </dev/tty; echo "${v:-$def}"; else read -r -p "$p: " v </dev/tty; echo "$v"; fi; }
secreta(){ local p="$1" v; read -r -s -p "$p: " v </dev/tty; echo >&2; echo "$v"; }

[ "$(id -u)" = "0" ] || { erro "Rode como root (no terminal da Hostinger o usuário já é root)."; exit 1; }
command -v python3 >/dev/null || { apt-get update -qq && apt-get install -y -qq python3; }
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl; }

echo; echo "=== Central de Gestão · instalação no Easypanel ==="; echo
EP_URL=$(pergunta "Endereço do painel Easypanel" "http://127.0.0.1:3000")
curl -fsS -o /dev/null --max-time 10 "$EP_URL" || { erro "Não encontrei o Easypanel em $EP_URL. Confira se ele está instalado e no ar."; exit 1; }
ok "Easypanel encontrado."
echo "No Easypanel, abra Settings › Users, clique no seu usuário e gere um API Token."
EP_TOKEN=$(secreta "Cole o API Token do Easypanel")
[ -n "$EP_TOKEN" ] || { erro "Token vazio."; exit 1; }

DOMINIO=$(pergunta "Domínio do sistema" "app.inaservicos.com.br")
echo; echo "Repositório do GitHub com os arquivos, no formato dono/nome."
while :; do
  REPO=$(pergunta "Dono/repositório" "andreandradebrag/central-gestao")
  REPO="${REPO#https://github.com/}"; REPO="${REPO%.git}"; REPO="${REPO%/}"
  [[ "$REPO" == */* ]] && break
  erro "Informe dono e nome juntos, por exemplo: andreandradebrag/central-gestao"
done
RAMO=$(pergunta "Ramo (branch)" "main")
PRIVADO=$(pergunta "O repositório é privado? (s/n)" "s")
GH_TOKEN=""
if [ "${PRIVADO,,}" = "s" ]; then
  echo "Para ler um repositório privado, crie no GitHub um token só de leitura: Settings › Developer settings ›"
  echo "Fine-grained tokens › acesso somente a este repositório › Contents: Read-only."
  GH_TOKEN=$(secreta "Cole o token do GitHub (somente leitura)")
fi

echo; echo "Dados para o conector fiscal (notas recebidas)."
CNPJ=$(pergunta "CNPJ da empresa (só números)" "")
UF=$(pergunta "UF" "SP")
AMB=$(pergunta "Ambiente da SEFAZ: 2 = homologação (teste), 1 = produção" "2")

mkdir -p /opt/central/certs
if [ ! -f /opt/central/certs/certificado.pfx ]; then
  aviso "Certificado A1 não encontrado em /opt/central/certs/certificado.pfx."
  echo "Você pode enviar depois (veja o LEIA-ME, seção 2) e rodar este instalador de novo; o sistema sobe sem ele."
  CERT_SENHA=""
else
  CERT_SENHA=$(secreta "Senha do certificado A1")
  chown 10001 /opt/central/certs/certificado.pfx && chmod 400 /opt/central/certs/certificado.pfx
  cp -f /opt/central/certs/certificado.pfx /opt/central/certs/bb.pfx && chown 1000 /opt/central/certs/bb.pfx && chmod 400 /opt/central/certs/bb.pfx
  ok "Certificado preparado (conector fiscal e extrato do Banco do Brasil)."
fi
FISCAL_TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

export EP_URL EP_TOKEN DOMINIO REPO RAMO GH_TOKEN CNPJ UF AMB CERT_SENHA FISCAL_TOKEN
RES=0
python3 - <<'PY' || RES=$?
import json, os, sys, urllib.request, urllib.error
E = os.environ
base = E['EP_URL'].rstrip('/')
H = {'Authorization': 'Bearer ' + E['EP_TOKEN'], 'Content-Type': 'application/json'}
def chamar(op, corpo, ok404=False):
    # API pública (Easypanel 2.33+): POST /api/<operação>. Versões antigas: tRPC /api/trpc/<grupo>.<operação>.
    for url, dado in ((base + '/api/' + op, corpo), (base + '/api/trpc/' + TRPC.get(op, op), {'json': corpo})):
        req = urllib.request.Request(url, data=json.dumps(dado).encode(), headers=H, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return True, r.read().decode()[:300]
        except urllib.error.HTTPError as e:
            txt = e.read().decode()[:400]
            if e.code == 404: continue
            return False, f'{e.code} {txt}'
        except Exception as e: return False, str(e)
    return False, 'operação não encontrada nesta versão do Easypanel'
TRPC = {'createProject': 'projects.createProject', 'createAppService': 'services.app.createService', 'updateAppSourceGit': 'services.app.updateSourceGit',
        'updateAppSourceGithub': 'services.app.updateSourceGithub', 'updateAppBuild': 'services.app.updateBuild', 'updateAppEnv': 'services.app.updateEnv',
        'createMount': 'services.app.createMount', 'createDomain': 'domains.createDomain', 'deployAppService': 'services.app.deployService'}
falhas = []
ARQ = '/opt/central/instalacao-v2.json'
try: feitos = set(json.load(open(ARQ)).get('feitos', []))
except Exception: feitos = set()
def guardar(): json.dump({'feitos': sorted(feitos), 'falhas': falhas}, open(ARQ, 'w'), ensure_ascii=False, indent=1)
def passo(nome, op, corpo, ja_existe_ok=True, uma_vez=False):
    if uma_vez and nome in feitos: print('\033[0;32m✔ ' + nome + ' (já feito antes)\033[0m'); return True
    ok, msg = chamar(op, corpo)
    m = msg.lower()
    ja = ('already exist' in m or 'already used' in m or 'já existe' in m) and 'not exist' not in m and "n't exist" not in m
    if ok or (ja_existe_ok and ja):
        print('\033[0;32m✔ ' + nome + '\033[0m'); feitos.add(nome); guardar(); return True
    print('\033[0;31m✖ ' + nome + ': ' + msg + '\033[0m'); falhas.append(nome); guardar(); return False

P = 'central'
repo = E['REPO'].strip().strip('/')
git_url = 'https://' + (E['GH_TOKEN'] + '@' if E['GH_TOKEN'] else '') + 'github.com/' + repo + '.git'
if not passo('Projeto "central"', 'createProject', {'name': P}):
    print('\033[1;33m! O Easypanel não deixou criar o projeto pela API. Crie pelo painel: Projetos › Criar Projeto › nome: central.')
    print('  Depois rode este instalador de novo (ele segue a partir daí).\033[0m')
    sys.exit(1)
for svc, pasta in (('fiscal', '/fiscal'), ('gestao', '/gestao')):
    passo(f'Serviço "{svc}"', 'createAppService', {'projectName': P, 'serviceName': svc})
    passo(f'{svc}: código do GitHub', 'updateAppSourceGit', {'projectName': P, 'serviceName': svc, 'repo': git_url, 'ref': E['RAMO'], 'path': pasta}, False)
    passo(f'{svc}: build pelo Dockerfile', 'updateAppBuild', {'projectName': P, 'serviceName': svc, 'build': {'type': 'dockerfile', 'file': 'Dockerfile'}}, False)
env_fiscal = '\n'.join([f"CNPJ={E['CNPJ']}", f"UF={E['UF']}", f"AMBIENTE={E['AMB']}", 'CERT_PATH=/certs/certificado.pfx', f"CERT_SENHA={E['CERT_SENHA']}", f"FISCAL_TOKEN={E['FISCAL_TOKEN']}", 'INTERVALO_MIN=60', 'AUTO_CIENCIA=1', 'NFSE_ADN=1'])
env_gestao = '\n'.join(['PORT=3000', 'DATA_DIR=/data', f'FISCAL_URL=http://{P}_fiscal:8000', f"FISCAL_TOKEN={E['FISCAL_TOKEN']}", 'ANTHROPIC_API_KEY=', 'SOLIDES_TOKEN=', 'SOLIDES_INTERVALO_MIN=15',
                        'BB_CLIENT_ID=', 'BB_CLIENT_SECRET=', 'BB_APP_KEY=', 'BB_CERT_PATH=/certs/bb.pfx', f"BB_CERT_SENHA={E['CERT_SENHA']}", 'BANCOS_INTERVALO_MIN=180', f"APP_URL=https://{E['DOMINIO']}", 'SMTP_HOST=', 'SMTP_PORT=465', 'SMTP_USUARIO=', 'SMTP_SENHA=', 'SMTP_REMETENTE='])
passo('fiscal: variáveis', 'updateAppEnv', {'projectName': P, 'serviceName': 'fiscal', 'env': env_fiscal}, False)
passo('gestao: variáveis', 'updateAppEnv', {'projectName': P, 'serviceName': 'gestao', 'env': env_gestao}, False)
passo('fiscal: dados permanentes', 'createMount', {'projectName': P, 'serviceName': 'fiscal', 'values': {'type': 'volume', 'name': 'fiscal-dados', 'mountPath': '/data'}}, uma_vez=True)
passo('fiscal: pasta do certificado', 'createMount', {'projectName': P, 'serviceName': 'fiscal', 'values': {'type': 'bind', 'hostPath': '/opt/central/certs', 'mountPath': '/certs'}}, uma_vez=True)
passo('gestao: dados permanentes', 'createMount', {'projectName': P, 'serviceName': 'gestao', 'values': {'type': 'volume', 'name': 'gestao-dados', 'mountPath': '/data'}}, uma_vez=True)
passo('gestao: pasta do certificado', 'createMount', {'projectName': P, 'serviceName': 'gestao', 'values': {'type': 'bind', 'hostPath': '/opt/central/certs', 'mountPath': '/certs'}}, uma_vez=True)
import secrets, string
dom_id = ''.join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(12))
passo('Domínio ' + E['DOMINIO'] + ' com HTTPS', 'createDomain', {'id': dom_id, 'host': E['DOMINIO'], 'https': True, 'path': '/', 'wildcard': False, 'middlewares': [], 'certificateResolver': '',
      'destinationType': 'service', 'serviceDestination': {'projectName': P, 'serviceName': 'gestao', 'port': 3000, 'protocol': 'http', 'path': '/'}}, uma_vez=True)
passo('Deploy do conector fiscal', 'deployAppService', {'projectName': P, 'serviceName': 'fiscal', 'forceRebuild': False}, False)
passo('Deploy do sistema', 'deployAppService', {'projectName': P, 'serviceName': 'gestao', 'forceRebuild': False}, False)
sys.exit(1 if falhas else 0)
PY
echo
if [ $RES -eq 0 ]; then
  ok "Pronto. O primeiro deploy leva de 3 a 8 minutos."
  echo "Depois abra:  https://$DOMINIO/setup   e crie a conta do dono."
else
  aviso "Alguns passos não foram feitos pela API (lista acima). Faça só esses pelo painel do Easypanel,"
  echo "seguindo o LEIA-ME (seção 3), ou mande um print desta tela para o Claude."
fi
echo "Guarde em local seguro: o token de ligação fiscal foi gerado automaticamente e já está nos dois serviços."

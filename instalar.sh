#!/usr/bin/env bash
# Central de Gestão — instalador automático para VPS Hostinger com Easypanel
# Uso (no terminal da VPS, como root):
#   bash <(curl -fsSL https://raw.githubusercontent.com/<dono>/<repositorio>/main/instalar.sh)
# ou, com o repositório já clonado:  bash instalar.sh
#
# O que faz:
#   1. Confere o Easypanel e pede o token da API dele (Easypanel › Settings › Users › API Token).
#   2. Pergunta o domínio (app.inaservicos.com.br), o repositório do GitHub e os dados do certificado A1.
#   3. Prepara /opt/central/certs (certificado do conector fiscal) e /opt/central/bb (pasta só do extrato do BB, vazia até ligar o BB).
#   4. Cria no Easypanel o projeto "central" com os serviços "fiscal" e "gestao": origem no GitHub,
#      Dockerfile, variáveis de ambiente, volumes, pasta do certificado e domínio com HTTPS.
#   5. Gera os segredos do sistema (SETUP_TOKEN, CHAVE_MESTRA, BACKUP_CHAVE), guardados em /opt/central/segredos.env
#      (só root lê) e reaproveitados se o instalador rodar de novo — trocar CHAVE_MESTRA ou BACKUP_CHAVE sem
#      cuidado tranca a verificação em duas etapas e as cópias antigas.
#   6. Faz o primeiro deploy e mostra o endereço (com o código de instalação) para criar a conta do dono.
# Nada sai da VPS: senhas e tokens ficam só nas variáveis dos serviços no Easypanel e em /opt/central/segredos.env.
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
GH_TOKEN=""; GH_EASYPANEL="n"
if [ "${PRIVADO,,}" = "s" ]; then
  echo "Repositório privado. O melhor é ligar o GitHub no próprio Easypanel (Settings › GitHub), assim nenhum token"
  echo "fica gravado no endereço do repositório."
  GH_EASYPANEL=$(pergunta "O GitHub já está ligado no Easypanel (Settings › GitHub)? (s/n)" "n")
  if [ "${GH_EASYPANEL,,}" != "s" ]; then
    echo "Então crie no GitHub um token fine-grained SÓ DE LEITURA: Settings › Developer settings › Fine-grained tokens ›"
    echo "Repository access: só este repositório › Permissions: Contents = Read-only (nada mais) › validade de até 1 ano."
    aviso "O token fica no endereço do repositório dentro do Easypanel. Troque-o todo ano (LEIA-ME, Endurecimento)."
    GH_TOKEN=$(secreta "Cole o token do GitHub (somente leitura)")
  fi
fi

echo; echo "Dados para o conector fiscal (notas recebidas)."
CNPJ=$(pergunta "CNPJ da empresa (só números)" "")
UF=$(pergunta "UF" "SP")
AMB=$(pergunta "Ambiente da SEFAZ: 2 = homologação (teste), 1 = produção" "2")

mkdir -p /opt/central/certs /opt/central/bb && chmod 700 /opt/central/certs
if [ ! -f /opt/central/certs/certificado.pfx ]; then
  aviso "Certificado A1 não encontrado em /opt/central/certs/certificado.pfx."
  echo "Você pode enviar depois (veja o LEIA-ME, seção 2) e rodar este instalador de novo; o sistema sobe sem ele."
  CERT_SENHA=""
else
  CERT_SENHA=$(secreta "Senha do certificado A1")
  chown 10001 /opt/central/certs/certificado.pfx && chmod 400 /opt/central/certs/certificado.pfx
  rm -f /opt/central/certs/bb.pfx
  ok "Certificado preparado para o conector fiscal. (Para o extrato do BB, veja o LEIA-ME 7.2.)"
fi
aleatorio(){ head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
FISCAL_TOKEN=$(aleatorio)
# segredos do sistema: gerados uma vez e reaproveitados (trocar CHAVE_MESTRA/BACKUP_CHAVE sem migrar tranca dados)
SEGREDOS=/opt/central/segredos.env
umask 077
if [ -f "$SEGREDOS" ]; then . "$SEGREDOS"; ok "Segredos do sistema reaproveitados de $SEGREDOS."; fi
SETUP_TOKEN=${SETUP_TOKEN:-$(aleatorio)}; CHAVE_MESTRA=${CHAVE_MESTRA:-$(aleatorio)}; BACKUP_CHAVE=${BACKUP_CHAVE:-$(aleatorio)}
printf 'SETUP_TOKEN=%s\nCHAVE_MESTRA=%s\nBACKUP_CHAVE=%s\n' "$SETUP_TOKEN" "$CHAVE_MESTRA" "$BACKUP_CHAVE" > "$SEGREDOS"; chmod 600 "$SEGREDOS"
umask 022

export EP_URL EP_TOKEN DOMINIO REPO RAMO GH_TOKEN GH_EASYPANEL CNPJ UF AMB CERT_SENHA FISCAL_TOKEN SETUP_TOKEN CHAVE_MESTRA BACKUP_CHAVE
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
dono_gh, nome_gh = repo.split('/', 1)
for svc, pasta in (('fiscal', '/fiscal'), ('gestao', '/gestao')):
    passo(f'Serviço "{svc}"', 'createAppService', {'projectName': P, 'serviceName': svc})
    if E.get('GH_EASYPANEL', 'n').lower() == 's':
        # integração do GitHub do próprio Easypanel: nenhum token no endereço do repositório
        passo(f'{svc}: código do GitHub (integração do Easypanel)', 'updateAppSourceGithub', {'projectName': P, 'serviceName': svc, 'owner': dono_gh, 'repo': nome_gh, 'ref': E['RAMO'], 'path': pasta, 'autoDeploy': False}, False)
    else:
        passo(f'{svc}: código do GitHub', 'updateAppSourceGit', {'projectName': P, 'serviceName': svc, 'repo': git_url, 'ref': E['RAMO'], 'path': pasta}, False)
    passo(f'{svc}: build pelo Dockerfile', 'updateAppBuild', {'projectName': P, 'serviceName': svc, 'build': {'type': 'dockerfile', 'file': 'Dockerfile'}}, False)
env_fiscal = '\n'.join([f"CNPJ={E['CNPJ']}", f"UF={E['UF']}", f"AMBIENTE={E['AMB']}", 'CERT_PATH=/certs/certificado.pfx', f"CERT_SENHA={E['CERT_SENHA']}", f"FISCAL_TOKEN={E['FISCAL_TOKEN']}", 'INTERVALO_MIN=60', 'AUTO_CIENCIA=1', 'NFSE_ADN=1'])
env_gestao = '\n'.join(['PORT=3000', 'DATA_DIR=/data', 'NODE_ENV=production', f'FISCAL_URL=http://{P}_fiscal:8000', f"FISCAL_TOKEN={E['FISCAL_TOKEN']}",
                        f"SETUP_TOKEN={E['SETUP_TOKEN']}", f"CHAVE_MESTRA={E['CHAVE_MESTRA']}", f"BACKUP_CHAVE={E['BACKUP_CHAVE']}",
                        'DOIS_FATORES_OBRIGATORIO=equipe', 'DOIS_FATORES_CARENCIA_DIAS=0', 'SESSAO_INATIVIDADE_HORAS=10', 'REAUTENTICAR_MINUTOS=15', 'PERFIL_GRAVACAO=avisar',
                        'ANTHROPIC_API_KEY=', 'SOLIDES_TOKEN=', 'SOLIDES_INTERVALO_MIN=15',
                        'BB_CLIENT_ID=', 'BB_CLIENT_SECRET=', 'BB_APP_KEY=', 'BB_CERT_PATH=/certs/bb.pfx', 'BB_CERT_SENHA=', 'BANCOS_INTERVALO_MIN=180', f"APP_URL=https://{E['DOMINIO']}", 'SMTP_HOST=', 'SMTP_PORT=465', 'SMTP_USUARIO=', 'SMTP_SENHA=', 'SMTP_REMETENTE='])
passo('fiscal: variáveis', 'updateAppEnv', {'projectName': P, 'serviceName': 'fiscal', 'env': env_fiscal}, False)
passo('gestao: variáveis', 'updateAppEnv', {'projectName': P, 'serviceName': 'gestao', 'env': env_gestao}, False)
passo('fiscal: dados permanentes', 'createMount', {'projectName': P, 'serviceName': 'fiscal', 'values': {'type': 'volume', 'name': 'fiscal-dados', 'mountPath': '/data'}}, uma_vez=True)
passo('fiscal: pasta do certificado', 'createMount', {'projectName': P, 'serviceName': 'fiscal', 'values': {'type': 'bind', 'hostPath': '/opt/central/certs', 'mountPath': '/certs'}}, uma_vez=True)
passo('gestao: dados permanentes', 'createMount', {'projectName': P, 'serviceName': 'gestao', 'values': {'type': 'volume', 'name': 'gestao-dados', 'mountPath': '/data'}}, uma_vez=True)
passo('gestao: pasta do certificado', 'createMount', {'projectName': P, 'serviceName': 'gestao', 'values': {'type': 'bind', 'hostPath': '/opt/central/bb', 'mountPath': '/certs'}}, uma_vez=True)
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
  echo "Depois abra:  https://$DOMINIO/setup?token=$SETUP_TOKEN"
  echo "e crie a conta do dono (o código de instalação impede que outra pessoa crie a conta antes de você)."
else
  aviso "Alguns passos não foram feitos pela API (lista acima). Faça só esses pelo painel do Easypanel,"
  echo "seguindo o LEIA-ME (seção 3), ou mande um print desta tela para o Claude."
fi
echo "Guarde em local seguro: o token de ligação fiscal foi gerado automaticamente e já está nos dois serviços."
echo
aviso "IMPORTANTE: copie a BACKUP_CHAVE abaixo para o cofre de senhas da empresa (fora desta VPS)."
echo "Sem ela, nenhuma cópia de segurança cifrada pode ser aberta. Ela também está em $SEGREDOS (só root)."
echo "  BACKUP_CHAVE=$BACKUP_CHAVE"
echo "Depois: leia a seção \"Endurecimento do servidor\" do LEIA-ME (HTTPS do Easypanel, firewall, SSH por chave, 2FA)." 

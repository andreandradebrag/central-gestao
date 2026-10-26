# Central de Gestão no seu servidor (Hostinger VPS + Easypanel)

Dois serviços:

| Pasta | O que é | Porta | Exposto na internet? |
|---|---|---|---|
| `gestao/` | O sistema (Node 22, banco SQLite em `/data`) | 3000 | Sim, pelo seu domínio com HTTPS |
| `fiscal/` | Conector fiscal: busca NF-e na SEFAZ e NFS-e no Ambiente Nacional, envia manifestação | 8000 | **Não**. Só o serviço `gestao` fala com ele |

O certificado A1 (.pfx) e a senha ficam **só** no serviço `fiscal`, na sua VPS. Não vão para o banco, para o navegador nem para o GitHub.

---

## 0. Instalação automática (recomendado)

1. Envie esta pasta para um repositório no GitHub (o Claude pode fazer isso por você se a conta GitHub estiver conectada).
2. No Easypanel: **Settings › Users** › seu usuário › gere um **API Token** e copie.
3. Na Hostinger: **VPS › Terminal** (navegador) e cole:
   ```bash
   git clone https://github.com/<dono>/<repositorio>.git /opt/central/src && bash /opt/central/src/instalar.sh
   ```
   (repositório privado: `git clone https://<token>@github.com/<dono>/<repositorio>.git ...`)
4. Responda às perguntas (token do Easypanel, domínio, repositório, CNPJ). O instalador cria tudo no Easypanel e faz o deploy.
5. Se algum passo aparecer com ✖, faça só esse pelo painel seguindo as seções abaixo.

O domínio (registro DNS tipo A) precisa já apontar para o IP da VPS antes do passo 3, para o HTTPS ser emitido.

## 1. Antes de começar

1. Um domínio ou subdomínio apontando para o IP da VPS (registro A), por exemplo `gestao.suaempresa.com.br`.
2. Easypanel instalado na VPS (o modelo "Easypanel" da Hostinger já vem pronto). Acesse em `http://IP-DA-VPS:3000`.
3. Um repositório **privado** no GitHub com o conteúdo desta pasta (`gestao/`, `fiscal/`, `docker-compose.yml`, este arquivo). O `.gitignore` já impede subir `.env` e `.pfx`.
4. Gere um segredo para ligar os dois serviços (use o mesmo nos dois):
   ```
   openssl rand -hex 32
   ```

## 2. Enviar o certificado para a VPS

Pelo terminal (SSH) ou pelo gerenciador de arquivos da Hostinger, coloque o arquivo em `/opt/central/certs/certificado.pfx`:

```bash
mkdir -p /opt/central/certs
# envie o arquivo (do seu computador):  scp certificado.pfx root@IP-DA-VPS:/opt/central/certs/
chown 10001 /opt/central/certs/certificado.pfx
chmod 400 /opt/central/certs/certificado.pfx
```

## 3. Criar o projeto no Easypanel

Crie um projeto, por exemplo `central`.

### 3.1 Serviço `fiscal` (crie primeiro)

**+ Service › App**, nome `fiscal`.

- **Source**: GitHub › seu repositório › branch `main` › **Build path** `/fiscal` › Build: **Dockerfile**.
- **Environment**:
  ```
  CNPJ=00000000000000          (só números)
  UF=SP
  AMBIENTE=2                   (2 = homologação para testar; depois 1 = produção)
  CERT_SENHA=senha-do-pfx
  FISCAL_TOKEN=o-segredo-gerado
  INTERVALO_MIN=60
  AUTO_CIENCIA=1
  NFSE_ADN=1
  ```
- **Mounts**:
  - Volume: nome `fiscal-dados`, caminho `/data`
  - Bind: host `/opt/central/certs`, caminho `/certs`
- **Domains**: não adicione nenhum. **Deploy**.

Nos logs deve aparecer `Conector fiscal iniciado (homologação)` sem aviso de certificado.

### 3.2 Serviço `gestao`

**+ Service › App**, nome `gestao`.

- **Source**: GitHub › mesmo repositório › **Build path** `/gestao` › Dockerfile.
- **Environment**:
  ```
  FISCAL_URL=http://central_fiscal:8000     (formato: <projeto>_<serviço>)
  FISCAL_TOKEN=o-segredo-gerado
  ANTHROPIC_API_KEY=                        (opcional: liga a IA do sistema)
  ```
- **Mounts**: Volume `gestao-dados` em `/data`.
- **Domains**: seu domínio, porta **3000**, HTTPS ligado (o certificado SSL é automático).
- **Deploy**.

> Alternativa: em vez de dois Apps, crie um serviço **Compose** apontando para o `docker-compose.yml` e preencha as variáveis do `.env.exemplo`. Nesse caso `FISCAL_URL` já é `http://fiscal:8000`.

## 4. Primeiro acesso

1. Abra `https://seu-dominio/setup` e crie a conta do **dono** (nome, e-mail, senha).
2. Em **Sistema › Configurações** aparecem os atalhos: Contas de acesso, Importar pacote de migração, Baixar cópia do banco e Sair.
3. Em **Contas de acesso**, cadastre cada pessoa com e-mail, senha provisória e nível:
   - **Equipe**: quem trabalha nos módulos (financeiro, compras, RH, obras...). O que cada pessoa vê e altera é definido pelo perfil em **Usuários**.
   - **Colaborador**: só a própria Minha área, ponto e chat.
   Para mudar depois, use **Usuários › Editar** (nome, e-mail, nível e senha).

## 5. Trazer os dados da página do Claude

1. Na página atual do sistema (no Claude), entre como dono e vá em **Sistema › Configurações › Migrar para servidor próprio › Gerar pacote de migração**. Sai um ZIP com dados, pessoas e anexos.
2. No servidor, **Importar pacote de migração** e envie o ZIP.
3. Em **Contas de acesso**, as pessoas importadas aparecem sem e-mail: defina e-mail e senha de cada uma. Na sua conta antiga, use **"Sou eu"** para juntar o histórico (chat, Minha área) com a conta de dono criada no passo 4.
4. Apague o ZIP do seu computador depois (tem dados pessoais e financeiros, LGPD).

## 6. Notas fiscais (Compras › NFs recebidas)

O cartão **SEFAZ e Ambiente Nacional** mostra:

- **NF-e** emitidas contra o CNPJ (Distribuição DF-e). Com `AUTO_CIENCIA=1` o conector dá ciência sozinho nas que chegam só como resumo, e o XML completo vem na busca seguinte. Botões: **Importar** (vai para a lista de validação), **Baixar XML**, **Manifestar** (ciência, confirmação, desconhecimento, operação não realizada).
- **NFS-e** do Ambiente de Dados Nacional (ADN) em que a empresa aparece. **Lançar em contas a pagar** cria o título e cadastra o prestador pelo CNPJ.

Regras da SEFAZ que o conector respeita: no máximo uma consulta por hora quando não há documento novo (erro 656 = "consumo indevido", ele espera 1 hora sozinho). O botão **Buscar agora** mostra quando a próxima consulta está liberada.

**Teste em homologação primeiro** (`AMBIENTE=2`): a SEFAZ de homologação normalmente não tem notas reais, então "nenhum documento" é o esperado. Confirme que não há erro de certificado nos logs e troque para `AMBIENTE=1`.

**Tuiuti-SP e NFS-e emitidas por prestadores**: a NFS-e só aparece no ADN se o município do prestador estiver no padrão nacional ou compartilhar as notas com o ADN. Notas de municípios fora do padrão continuam chegando pelo XML/PDF que o prestador envia ("Importar XML ou ZIP").

## 7. Cotações com fornecedores (Compras › Cotações)

- Cada fornecedor convidado recebe um link próprio, `https://seu-dominio/cotacao/<código>`, que abre **sem login**. Ele vê só os itens do pedido, o prazo e o local de entrega, nunca os preços dos outros, e informa preço, marca, frete, prazo, pagamento e validade.
- A resposta entra sozinha no mapa de cotação. Quando a cotação é fechada (pedidos gerados) ou o fornecedor sai da cotação, o link passa a mostrar "cotação encerrada".
- O link só funciona com o sistema publicado em um domínio com HTTPS (passo 3.2). Não é preciso configurar nada além disso.
- Sem link (por exemplo, fornecedor que prefere e-mail), use **Arquivo do fornecedor**: ele abre o arquivo no navegador, preenche e devolve o arquivo de resposta, que você importa no mapa.

## 7.1. Ponto pela Sólides DP (Pessoas › Ponto (Sólides))

O ponto oficial é registrado no app da Sólides (Sólides DP, antigo Tangerino). Com o token, o servidor busca as marcações a cada 15 minutos e o sistema leva as horas ao espelho, banco de horas e custo de cada obra.

1. Peça ao suporte da Sólides (chat da Central de Ajuda) a liberação do **token de integração** do Sólides DP e copie o token em **Empregador › Integrações**.
2. No Easypanel, serviço **gestao** › Ambiente: preencha `SOLIDES_TOKEN=` com o token e clique em **Implantar**. O token fica só no servidor.
3. No sistema, em Pessoas › Ponto (Sólides), use **Testar conexão** e **Ver amostra de marcações** para conferir a leitura.
4. Ligue cada local de trabalho da Sólides a uma obra e os funcionários sem vínculo ao cadastro (o CPF liga sozinho).
5. Na aba **Enviar**, mande as obras (viram locais de trabalho), os funcionários (com escala e local) e as férias e afastamentos (como ajustes aprovados).

Opcionais: `SOLIDES_INTERVALO_MIN` (padrão 15) e `SOLIDES_DIAS_INICIAIS` (quantos dias buscar na primeira vez, padrão 35).
Sem token, a tela continua aceitando o relatório exportado da Sólides (Excel ou CSV).

## 7.2. Extrato automático do Banco do Brasil (Financeiro › Conciliação bancária › Extrato automático)

1. No portal **BB Developers** (developers.bb.com.br), entre com o usuário da empresa, crie um aplicativo e peça acesso à **API Extratos** (produção). Se travar, o gerente do BB libera.
2. Anote **Client ID**, **Client Secret** e **developer_application_key** (chave do aplicativo).
3. O BB exige o certificado A1 da empresa na conexão. Na VPS, faça uma cópia para o serviço gestao:
   ```bash
   mkdir -p /opt/central/bb
   cp /opt/central/certs/certificado.pfx /opt/central/bb/bb.pfx
   chown 1000 /opt/central/bb/bb.pfx && chmod 400 /opt/central/bb/bb.pfx
   ```
   No serviço **gestao**, em Mounts, o Bind deve ser host `/opt/central/bb`, caminho `/certs` (nunca a pasta `/opt/central/certs`, que é só do conector fiscal). Assim o sistema só enxerga o certificado quando o extrato do BB for ligado.
4. No serviço **gestao** › Environment: `BB_CLIENT_ID`, `BB_CLIENT_SECRET`, `BB_APP_KEY`, `BB_CERT_PATH=/certs/bb.pfx` e `BB_CERT_SENHA`. Clique em **Deploy**.
5. No sistema, em Conciliação bancária › **Extrato automático**: em cada conta do BB escolha "API do Banco do Brasil", informe agência e conta (sem dígito), **Testar conexão** e **Salvar e buscar agora**.

O servidor busca o extrato a cada 3 horas (`BANCOS_INTERVALO_MIN`). Na primeira vez traz 30 dias; depois, os últimos 5 dias, sem duplicar.

## 8. Rotina e segurança

- **Cópia de segurança**: Configurações › Baixar cópia do banco (dono). Também ative o backup de volumes no Easypanel (`gestao-dados` e `fiscal-dados`) ou snapshots da VPS na Hostinger.
- **Atualizar o sistema**: envie a nova versão para o GitHub e clique **Deploy** no serviço. Os dados ficam nos volumes.
- **Certificado vencendo**: o cartão fiscal avisa quando faltar menos de 30 dias. Troque o arquivo em `/opt/central/certs/`, atualize `CERT_SENHA` se mudou e reinicie o serviço `fiscal`.
- Não publique o serviço `fiscal` em domínio. Não coloque o `.pfx` no GitHub.
- Se um computador for perdido, desative a conta em Contas de acesso: as sessões dela caem na hora.

## 9. Testes

```bash
cd fiscal && python -m unittest test_app.py    # assinatura XML, DistDFe, ADN e API (sem rede)
```
O Dockerfile do `fiscal` roda esses testes no build.

## 7.3. E-mail do sistema (convite de novo usuário e "Esqueci minha senha")

No serviço **gestao › Ambiente** do Easypanel, preencha e clique em **Implantar**:

- `SMTP_HOST` e `SMTP_PORT`: servidor de envio do provedor do e-mail. Hostinger: `smtp.hostinger.com` porta `465`. Google Workspace: `smtp.gmail.com` porta `465` (com senha de app). Microsoft 365: `smtp.office365.com` porta `587`. Outros: veja "SMTP" na central de ajuda do provedor.
- `SMTP_USUARIO`: o e-mail completo (ex.: inaservicos@inaservicos.com.br). `SMTP_SENHA`: a senha desse e-mail (ou a senha de app).
- `SMTP_REMETENTE`: como aparece para quem recebe, ex.: `INA Serviços <inaservicos@inaservicos.com.br>`.
- `APP_URL`: endereço do sistema usado nos links (padrão `https://app.inaservicos.com.br`).

Para conferir: **Contas de acesso › E-mail do sistema › Enviar e-mail de teste**.


## Cópia de segurança

Todo dia, a partir das 3h (horário de Brasília), o sistema grava `/data/backups/gestao-AAAA-MM-DD.db.gz` com o banco de dados inteiro e guarda os últimos 30 dias (`BACKUP_DIAS`). O dono vê a lista, baixa e faz uma cópia na hora em **Contas de acesso › Cópia de segurança**.

- Os anexos (pasta `/data/blobs`) não entram nessa cópia: ative também o **backup da VPS no painel da Hostinger**.
- Para guardar uma cópia fora do servidor, crie um bucket num serviço compatível com S3 (Cloudflare R2, Backblaze B2, Wasabi, AWS) e preencha no serviço gestao › Ambiente: `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGIAO` (R2: `auto`), `BACKUP_S3_CHAVE`, `BACKUP_S3_SEGREDO` e, se quiser, `BACKUP_S3_PASTA`. Clique em Implantar.
- Para restaurar: descompacte o arquivo (`gunzip`), pare o serviço gestao, troque `/data/gestao.db` pelo arquivo descompactado e implante de novo.

## Permissão de gravação por módulo

O servidor confere se o perfil de cada pessoa pode gravar no módulo. Começa em `PERFIL_GRAVACAO=avisar`: nada é bloqueado e **Contas de acesso › Gravação por módulo** mostra o que seria recusado. Depois de conferir, mude para `PERFIL_GRAVACAO=bloquear` e implante.

## Verificação em duas etapas e sessões

Cada pessoa liga a verificação em duas etapas em **Segurança** (botão no topo do sistema, ou `/conta/seguranca`): lê o QR Code com um aplicativo autenticador (Google Authenticator, Microsoft Authenticator) e guarda os 10 códigos de recuperação. Na mesma tela aparecem os aparelhos conectados e o botão "Sair de todos os outros aparelhos".

- Alguém perdeu o celular e os códigos: o dono desliga em **Contas de acesso › Desligar 2 etapas**.
- O próprio dono perdeu o celular e os códigos: no serviço gestao › Ambiente, coloque `DOIS_FATORES_RESET=email-do-dono`, clique em Implantar, entre só com a senha, **tire a variável** e implante de novo. Depois ligue a verificação outra vez.
- As senhas são guardadas com scrypt reforçado (as antigas são atualizadas no próximo login) e as sessões ficam no banco só como hash: uma cópia do banco não permite entrar no sistema.

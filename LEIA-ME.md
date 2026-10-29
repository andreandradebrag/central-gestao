# Central de Gestão no seu servidor (Hostinger VPS + Easypanel)

Dois serviços:

| Pasta | O que é | Porta | Exposto na internet? |
|---|---|---|---|
| `gestao/` | O sistema (Node 22, banco SQLite em `/data`) | 3000 | Sim, pelo seu domínio com HTTPS |
| `fiscal/` | Conector fiscal: busca NF-e na SEFAZ e NFS-e no Ambiente Nacional, envia manifestação | 8000 | **Não**. Só o serviço `gestao` fala com ele |

O certificado A1 (.pfx) e a senha ficam **só** no serviço `fiscal`, na sua VPS (pasta `/opt/central/certs`). Não vão para o banco, para o navegador nem para o GitHub. O serviço `gestao` só enxerga a pasta `/opt/central/bb`, que fica vazia até você ligar o extrato do BB (seção 7.2).

---

## 0. Instalação automática (recomendado)

1. Envie esta pasta para um repositório no GitHub (o Claude pode fazer isso por você se a conta GitHub estiver conectada).
2. No Easypanel: **Settings › Users** › seu usuário › gere um **API Token** e copie.
3. Na Hostinger: **VPS › Terminal** (navegador) e cole:
   ```bash
   git clone https://github.com/<dono>/<repositorio>.git /opt/central/src && bash /opt/central/src/instalar.sh
   ```
   Repositório privado: o `git` pede usuário e senha; use seu usuário do GitHub e, como senha, um **token fine-grained só de leitura** deste repositório (ele não fica gravado). Melhor ainda: uma **deploy key** só de leitura (seção "Endurecimento do servidor", item 5). Não use `https://<token>@github.com/...`: o token fica no histórico do terminal e em `.git/config`.
4. Responda às perguntas (token do Easypanel, domínio, repositório, CNPJ). O instalador cria tudo no Easypanel, gera os segredos do sistema (`SETUP_TOKEN`, `CHAVE_MESTRA`, `BACKUP_CHAVE`, guardados em `/opt/central/segredos.env`, só root lê) e faz o deploy.
5. No fim ele mostra o endereço `https://seu-dominio/setup?token=...` para criar a conta do dono e a `BACKUP_CHAVE`: **copie a chave para o cofre de senhas da empresa, fora da VPS**.
6. Se algum passo aparecer com ✖, faça só esse pelo painel seguindo as seções abaixo.

O domínio (registro DNS tipo A) precisa já apontar para o IP da VPS antes do passo 3, para o HTTPS ser emitido.

## 1. Antes de começar

1. Um domínio ou subdomínio apontando para o IP da VPS (registro A), por exemplo `gestao.suaempresa.com.br`.
2. Easypanel instalado na VPS (o modelo "Easypanel" da Hostinger já vem pronto). Acesse em `http://IP-DA-VPS:3000` **só durante a instalação**: logo depois, ponha o painel num domínio com HTTPS, ligue o 2FA do Easypanel e feche a porta 3000 no firewall (seção "Endurecimento do servidor", itens 1 a 3). Com a porta aberta, a senha do painel trafega sem criptografia e o painel controla tudo (variáveis, certificados, volumes).
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
  CNPJ=00000000000000          (números; o CNPJ novo com letras também é aceito)
  UF=SP
  AMBIENTE=2                   (2 = homologação para testar; depois 1 = produção)
  CERT_SENHA=senha-do-pfx
  FISCAL_TOKEN=o-segredo-gerado
  INTERVALO_MIN=60
  NFE_DIST=0                   (0 = o Omie busca as NF-e; 1 = a Central busca. Leia abaixo)
  AUTO_CIENCIA=0               (se não preencher, segue o NFE_DIST)
  NFSE_ADN=1
  BUSCA_AUTO=1                 (1 = busca sozinha a cada INTERVALO_MIN; 0 = só "Buscar agora")
  ```
  Desde a v123 estas variáveis (`AMBIENTE`, `NFE_DIST`, `AUTO_CIENCIA`, `NFSE_ADN` e `BUSCA_AUTO`) são só o **valor padrão**. Quem manda é a tela **Sistema › Configurações › Notas fiscais: ambiente e busca na SEFAZ** (veja a seção 3.1.1).
- **Mounts**:
  - Volume: nome `fiscal-dados`, caminho `/data`
  - Bind: host `/opt/central/certs`, caminho `/certs`
- **Domains**: não adicione nenhum. **Deploy**.

Nos logs deve aparecer `Conector fiscal iniciado (homologação)` sem aviso de certificado.

#### Só um sistema pode buscar as NF-e do CNPJ (NFE_DIST)

A SEFAZ tem uma regra (NT 2014.002, em vigor desde 10/03/2022): as NF-e emitidas contra um CNPJ são entregues numa **fila numerada** (o NSU). Se dois sistemas buscam essa fila para o mesmo CNPJ, cada um guarda o seu número e os dois ficam "fora de sequência". A SEFAZ entende isso como **consumo indevido** (erro 656) e **bloqueia o CNPJ por 1 hora**. Cada nova tentativa durante o bloqueio **começa a hora de novo**. Além disso, cada nota vai só para quem buscar primeiro.

Por isso, **só um sistema por CNPJ** pode fazer essa busca: **o Omie ou a Central, nunca os dois**. Não adianta aumentar o intervalo; a regra é de fila única, não de frequência.

- **Hoje (Omie é o dono):** `NFE_DIST=0` e `AUTO_CIENCIA=0`. A Central não busca NF-e pela fila. As NF-e entram por **Importar XML ou ZIP** (com os XMLs exportados do Omie) ou, de uma nota específica, pelo botão **Baixar XML** (no máximo 3 vezes por hora para a mesma nota). As NFS-e do Ambiente Nacional continuam normalmente. No Registro aparece "Busca de NF-e por NSU desligada".
- **Para a Central virar a dona** (quando o Omie deixar de ser usado para compras):
  1. **Primeiro** desligue o **Agente da NF-e** no Omie.
  2. Depois mude aqui para `NFE_DIST=1` (e `AUTO_CIENCIA=1`, se quiser a ciência automática) e reinicie o serviço `fiscal`.
  3. A primeira busca pode receber um 656 "fora de sequência". Tudo bem: o conector anota o número que a SEFAZ devolveu, espera a hora e continua dali.
  4. As notas que o Omie já tinha capturado não vêm de novo: importe-as pelo XML.
- **Para voltar ao Omie:** faça o contrário. Mude para `NFE_DIST=0`, reinicie e só depois ligue o Agente da NF-e no Omie.

Se o cartão fiscal mostrar o alerta vermelho **"Outro sistema está consultando as NF-e deste CNPJ"**, há dois sistemas buscando ao mesmo tempo. Desligue um deles como explicado acima.

Desde a v123 a troca é feita na tela (seção 3.1.1, "NF-e por NSU"), sem reiniciar: escolher **Central consulta** mostra o aviso desta regra e só aceita depois de marcar **"Já desliguei o Agente da NF-e no Omie"**. Mudar a variável `NFE_DIST` só vale enquanto ninguém tiver escolhido pela tela (ou depois de "Voltar ao padrão do servidor").

#### 3.1.1 Configuração pela tela (v123): ambiente e busca na SEFAZ

Em **Sistema › Configurações**, cartão **Notas fiscais: ambiente e busca na SEFAZ**. Todos que leem as notas veem o estado; **só o Administrador ou o dono** alteram, e **cada alteração pede a senha de novo** (ou o código do aplicativo), fica na **auditoria** da Central (`FISCAL_CONFIG`, com antes e depois) e no **Registro** do conector ("Configuração alterada por … : antes → depois").

- **Ambiente: Homologação (testes) / Produção.** Vale para o que o conector faz em nome da empresa: a busca de NF-e na SEFAZ, a manifestação do destinatário e a busca de NFS-e no Ambiente Nacional; e para o `tpAmb` do **rascunho de XML de NF-e** que a Central gera. **A Central não emite notas**: a NF-e continua sendo emitida pelo Omie e a NFS-e no portal da prefeitura de Tuiuti. Passar para Produção pede uma confirmação explícita (as consultas e manifestações passam a valer de verdade) e a senha. A troca vale na hora, sem reiniciar: o conector passa a usar `www1`/`www` da SEFAZ e `adn.nfse.gov.br` em produção, ou `hom1` e `adn.producaorestrita.nfse.gov.br` em homologação.
- **Cada ambiente tem a sua fila (NSU), as suas esperas e os seus documentos.** Voltar de produção para homologação não usa o NSU de produção, e vice-versa; ao voltar, cada um continua de onde parou. Na primeira partida da v123 os valores que já existiam ficam com o ambiente da variável `AMBIENTE`.
- **Busca automática: Ligar / Desligar.** Desligada, o conector não consulta sozinho; **Buscar agora** (Compras › NFs recebidas) continua funcionando, com as mesmas esperas da SEFAZ. O cartão mostra o intervalo (`INTERVALO_MIN`), a última busca e a próxima.
- **NF-e por NSU: Omie consulta (recomendado enquanto usar o Omie) / Central consulta.** É o `NFE_DIST` (regra da fila única acima).
- **NFS-e do Ambiente Nacional: Ligar / Desligar.** É o `NFSE_ADN`.
- **Ciência automática** segue `AUTO_CIENCIA`; se a variável estiver vazia, fica ligada só quando a Central consulta as NF-e por NSU.

O valor escolhido na tela fica gravado no banco do conector (volume `fiscal-dados`, chave `cfg_runtime`) e **tem prioridade sobre as variáveis**, mesmo depois de reiniciar ou reimplantar. Sem valor na tela, vale a variável (comportamento anterior). O cartão mostra, em cada linha, se o valor é "definido nesta tela" ou "padrão do servidor".

**Como voltar ao padrão:** na mesma tela, botão **Voltar ao padrão do servidor** (aparece quando há algo gravado pela tela; também pede a senha). Tudo volta às variáveis do serviço `fiscal`. Se a Central estiver fora do ar, a alternativa é apagar a chave no banco do conector: `docker exec -it <contêiner fiscal> python3 -c "import sqlite3;c=sqlite3.connect('/data/fiscal.db');c.execute(\"delete from estado where k='cfg_runtime'\");c.commit()"` e reiniciar o serviço.

Se o conector não responder, o cartão mostra **"conector fora do ar"** e os botões ficam desabilitados. A alteração só passa pela rota `/api/fiscal-config` da Central; o repasse genérico `/api/fiscal/tool/config` é recusado e o conector só aceita mudar a configuração com o cabeçalho que essa rota envia.

### 3.2 Serviço `gestao`

**+ Service › App**, nome `gestao`.

- **Source**: GitHub › mesmo repositório › **Build path** `/gestao` › Dockerfile.
- **Environment**:
  ```
  NODE_ENV=production
  FISCAL_URL=http://central_fiscal:8000     (formato: <projeto>_<serviço>)
  FISCAL_TOKEN=o-segredo-gerado
  SETUP_TOKEN=outro-segredo                 (openssl rand -hex 32; protege o /setup)
  CHAVE_MESTRA=outro-segredo                (cifra o segredo da verificação em duas etapas; não troque depois)
  BACKUP_CHAVE=outro-segredo                (cifra as cópias de segurança; guarde fora do servidor)
  ANTHROPIC_API_KEY=                        (opcional: liga a IA do sistema)
  ```
- **Mounts**: Volume `gestao-dados` em `/data`; Bind host `/opt/central/bb`, caminho `/certs` (só leitura). **Nunca** monte `/opt/central/certs` no `gestao`.
- **Domains**: seu domínio, porta **3000**, HTTPS ligado (o certificado SSL é automático).
- **Deploy**.

> Alternativa: em vez de dois Apps, crie um serviço **Compose** apontando para o `docker-compose.yml` e preencha as variáveis do `.env.exemplo`. Nesse caso `FISCAL_URL` já é `http://fiscal:8000`.

## 4. Primeiro acesso

1. Abra `https://seu-dominio/setup?token=<SETUP_TOKEN>` e crie a conta do **dono** (nome, e-mail e senha de pelo menos 12 caracteres). Sem o código, o `/setup` pede o código de instalação: assim ninguém cria a conta do dono antes de você se o sistema ficar no ar sem contas.
2. Logo depois o sistema leva você a **Segurança da minha conta** para ligar a verificação em duas etapas (obrigatória para o dono e para a Equipe que grava).
3. Em **Sistema › Configurações** aparecem os atalhos: Contas de acesso, Importar pacote de migração, Baixar cópia do banco e Sair.
4. Em **Contas de acesso**, cadastre cada pessoa com e-mail, senha provisória e nível:
   - **Equipe**: quem trabalha nos módulos (financeiro, compras, RH, obras...). O que cada pessoa vê e altera é definido pelo perfil em **Usuários**.
   - **Colaborador**: só a própria Minha área, ponto e chat.
   Para mudar depois, use **Usuários › Editar** (nome, e-mail, nível e senha).

## 5. Trazer os dados da página do Claude

1. Na página atual do sistema (no Claude), entre como dono e vá em **Sistema › Configurações › Migrar para servidor próprio › Gerar pacote de migração**. Sai um ZIP com dados, pessoas e anexos.
2. No servidor, **Importar pacote de migração** e envie o ZIP.
3. Em **Contas de acesso**, as pessoas importadas aparecem sem e-mail: defina e-mail e senha de cada uma. Na sua conta antiga, use **"Sou eu"** para juntar o histórico (chat, Minha área) com a conta de dono criada no passo 4.
4. Apague o ZIP do seu computador depois (tem dados pessoais e financeiros, LGPD).

## 6. Notas fiscais (Suprimentos › Recebimento de notas, antes "NFs recebidas")

O cartão **SEFAZ e Ambiente Nacional** mostra:

- **Ambiente e busca automática**: o cartão mostra se está em **Produção** ou **Homologação (testes)** e se a busca automática está ligada. Para alterar: Sistema › Configurações (seção 3.1.1).
- **NF-e** emitidas contra o CNPJ (Distribuição DF-e), **só se a Central consulta as NF-e por NSU** (`NFE_DIST=1` ou a tela da seção 3.1.1; veja a seção 3.1: um só sistema por CNPJ). Com `NFE_DIST=0` o cartão avisa que as NF-e são capturadas pelo Agente da NF-e do Omie. Com `AUTO_CIENCIA=1` o conector dá ciência sozinho nas que chegam só como resumo, e o XML completo vem na busca seguinte. A ciência só é dada até **10 dias** da emissão; confirmação, desconhecimento e operação não realizada valem até **90 dias** (o sistema avisa quando a nota passou do prazo). Botões: **Importar** (vai para a lista de validação), **Baixar XML**, **Manifestar** (ciência, confirmação, desconhecimento, operação não realizada).
- **NFS-e** do Ambiente de Dados Nacional (ADN) em que a empresa aparece. **Lançar em contas a pagar** cria o título e cadastra o prestador pelo CNPJ.

Regras da SEFAZ que o conector respeita: no máximo uma consulta por hora quando não há documento novo, e depois de um erro 656 ("consumo indevido") ou de uma falha da SEFAZ ele **espera a hora inteira** (mais 5 minutos de folga, no caso do 656). **Mesmo clicando em "Buscar agora" ou em "Baixar XML", ele não consulta antes disso**, porque cada tentativa durante o bloqueio faz a SEFAZ começar a hora de novo. O cartão mostra até que horas está a espera.

**Teste em homologação primeiro** (`AMBIENTE=2`): a SEFAZ de homologação normalmente não tem notas reais, então "nenhum documento" é o esperado. Confirme que não há erro de certificado nos logs e troque para **Produção** em Sistema › Configurações (ou `AMBIENTE=1`, se ninguém escolheu pela tela).

**Tuiuti-SP e NFS-e emitidas por prestadores**: a NFS-e só aparece no ADN se o município do prestador estiver no padrão nacional ou compartilhar as notas com o ADN. Notas de municípios fora do padrão continuam chegando pelo XML/PDF que o prestador envia ("Importar XML ou ZIP").

## 6.1. Arquivo fiscal: XML das NF-e guardado no servidor (v129)

**Onde fica.** O XML original de cada NF-e (entradas e saídas da INA) é guardado **no banco do serviço `gestao`** (`/data/gestao.db`, tabelas `arqf`, `arqf_evento` e `arqf_lote`), comprimido (gzip), com a chave de acesso, o sha256 do arquivo, a origem (histórico, XML enviado ou conector) e a ligação com a conta a pagar ou a receber. O navegador **não** recebe os XMLs: só uma lista leve, paginada, e o XML de uma nota quando alguém pede o DANFE ou o arquivo. O código fica em `gestao/arquivofiscal.js`. Para referência: 3.000 notas ocupam cerca de 11 MB no banco.

**Backup.** Como está no `gestao.db`, o arquivo fiscal entra na **cópia diária do banco** (seção "Cópia de segurança") e na cópia do volume `gestao-dados`. Faça também a cópia fora do servidor (S3): o XML é documento fiscal com guarda obrigatória. Para conferir, restaure uma cópia num servidor de teste e abra Fiscal › Arquivo fiscal.

**Prazo de guarda.** 5 anos contados de **1º de janeiro do ano seguinte** ao da emissão (CTN arts. 173 e 195; Ajuste SINIEF 07/05, cláusula 10ª). Exemplo: nota de 2021 fica até 31/12/2026. Dentro do prazo **o servidor não exclui** (a rota recusa e um gatilho no próprio banco impede o `DELETE`, mesmo por fora do sistema). Depois do prazo, só o **dono** exclui, nota a nota, e o sistema pede a senha de novo. Tudo fica na auditoria (`ARQF_*`).

**Quem acessa.** Administrador, Financeiro, Fiscal e Diretoria consultam, importam, ligam e exportam. O Comprador vê só as **entradas** e envia o XML de entrada que recebe do fornecedor. Os demais perfis não acessam.

**Como importar o histórico (Omie).**
1. No Omie, exporte os XMLs das NF-e por ano. Use só as pastas `XML/` de cada ano. **Não envie a pasta `XML_Invertido`** (se algum "invertido" for junto, o sistema recusa: pelo nome com `-invertido` ou porque a assinatura não confere).
2. Confira o **CNPJ da empresa** em Sistema › Configurações (sem ele a importação é recusada). Filiais: Recebimento de notas › Mais… › Configurar ligação automática.
3. Em **Fiscal › Arquivo fiscal** (a mesma tela de Suprimentos › Recebimento de notas), clique **Importar histórico (ZIP)** e escolha os ZIPs (um por ano, até `ARQF_MAX_ZIP_MB`, padrão 300 MB, e até 40.000 arquivos por ZIP; ZIP64 não é aceito: divida). O servidor confere cada arquivo em partes, mostra a barra de progresso e, no fim, o relatório: **novas**, **já existentes** (nada muda; pode reenviar) e **ignoradas, com o motivo** (sem protocolo da SEFAZ, denegada, CNPJ de outra empresa, invertido, não é XML). O relatório fica em Mais… › Importações anteriores.
4. O histórico **não cria contas, não mexe no estoque e não lança nada**. Ele só guarda e **liga** a nota à conta que já existe: mesmo CNPJ, número da nota, valor (tolerância padrão 1%) e data próxima; parcelas do mesmo documento são somadas. O que não liga sozinho aparece em **Pendentes de ligação**, com sugestões para confirmar, ou para ligar à mão. Criar a conta a partir da nota só com o botão "Criar conta".
5. Eventos de cancelamento (`procEventoNFe` 110111) no mesmo lote marcam a nota como **cancelada**; se ela estiver ligada a um título, Contas a pagar/receber mostra o alerta.

**Situação da nota.** Na importação vale o protocolo do próprio XML (autorizada). Para as notas **novas** (XML enviado, até 90 dias) o servidor pergunta ao conector fiscal em segundo plano, **no máximo `ARQF_SIT_HORA` consultas por hora** (padrão 10), sem consultar durante o bloqueio 656 e respeitando o limite por chave do conector (seção 3.1). **O histórico nunca é consultado em massa**: só pelo botão "Situação" de cada nota (e a SEFAZ só responde por chave notas de até 90 dias). O conector não tem hoje a consulta de protocolo na SEFAZ autorizadora (NfeConsultaProtocolo): a situação vem do que o conector já viu na distribuição (eventos) e da consulta por chave.

**Notas do conector.** "Mais… › Trazer as notas do conector fiscal" copia para o arquivo as NF-e que o conector já baixou (sem nova consulta à SEFAZ).

**ZIP para o contador.** Botão "ZIP para o contador": escolha o período; o servidor gera o ZIP em fluxo (pastas `ano/entradas` e `ano/saidas`, eventos e `indice.csv`).

**Variáveis (opcionais, serviço `gestao`)**: `ARQF_CNPJ` (CNPJs da empresa, separados por vírgula, além do de Configurações), `ARQF_MAX_ZIP_MB` (padrão 300), `ARQF_SIT_HORA` (consultas automáticas por hora, padrão 10; 0 desliga), `ARQF_SIT_INTERVALO_S` (padrão 300), `ARQF_CONFERIR_ASSINATURA=0` (desliga a conferência do conteúdo assinado; o resumo do protocolo continua sendo conferido. Use só se notas legítimas forem recusadas por "assinatura não confere").

## 6.2. Microsoft 365: caixa nfe@ (notas que chegam por e-mail, v130)

**O que faz.** O serviço `gestao` lê a caixa **nfe@inaservicos.com.br** pelo Microsoft Graph (de hora em hora, e pelo botão "Ler agora"). Os XML de NF-e anexados (soltos ou dentro de ZIP) vão para o Arquivo fiscal com origem **e-mail**; o PDF (DANFE) só é guardado se tiver a chave de acesso no nome ou no texto. Cada mensagem lida vai para a pasta **Processadas** (criada sozinha). Do e-mail ficam só remetente, assunto e data; o corpo nunca é guardado. A tela fica em **Suprimentos › Recebimento de notas › Caixa nfe@** e o estado aparece em **Sistema › Configurações**. Quem usa: Fiscal, Financeiro, Administrador e Diretoria. Código: `gestao/caixanfe.js`; tabelas `caixa_msg`, `caixa_pdf`, `caixa_leitura` e `arqf_origem` no `gestao.db`.

**Conferências.** (1) a nota precisa ter a INA como destinatária (CNPJ de Configurações); (2) se a nota já estava no arquivo (SEFAZ, Omie, envio manual), ela é marcada "também recebida por e-mail" (todas as origens ficam guardadas, com a data); (3) a situação na SEFAZ é conferida pela **fila de consulta por chave** do conector fiscal (seção 6.1, mesmos limites por hora e bloqueio 656). **Nunca há consulta por NSU** (o Omie é o dono da sequência). Nota cancelada, denegada ou não encontrada na SEFAZ aparece em vermelho: **não pagar**.

**Segurança dos anexos.** Só `.xml`, `.zip` (com até 50 XML, sem caminhos, até 20 MB descomprimidos) e `.pdf`; até 5 MB por anexo, 25 MB e 30 anexos por mensagem. Outros tipos (exe, imagens, itens do Outlook) são ignorados e listados. O PDF baixado pela tela sai sempre como arquivo (nunca abre como página do sistema).

### Passo a passo (feito uma vez, por quem administra o Microsoft 365)

1. **Registrar o aplicativo no Entra.** Em [entra.microsoft.com](https://entra.microsoft.com) › Identidade › Aplicativos › **Registros de aplicativo** › Novo registro. Nome: "Central de Gestão - caixa nfe". Tipo de conta: "Somente contas deste diretório". Sem URI de redirecionamento. Anote o **ID do aplicativo (cliente)** e o **ID do diretório (locatário)**.
2. **Criar o segredo.** No aplicativo › Certificados e segredos › Novo segredo do cliente. Escolha a validade (por exemplo 12 meses) e **copie o valor na hora** (ele só aparece uma vez). Anote a **data de vencimento**.
3. **Permissão: dar acesso SÓ à caixa nfe@ (RBAC para aplicativos do Exchange Online).** A permissão de aplicativo `Mail.ReadWrite` dada no Entra com "consentimento do administrador" vale para **todas as caixas da empresa**. A Microsoft explica que as permissões do Entra e as do Exchange se **somam**: se o `Mail.ReadWrite` do Entra estiver consentido, a restrição do Exchange não tem efeito. Por isso:
   - **não** adicione (ou **remova**, se já adicionou) a permissão `Mail.ReadWrite` em "Permissões de API" do aplicativo, e revogue o consentimento do administrador dela;
   - dê a permissão pelo Exchange Online, restrita à caixa, com os comandos abaixo (PowerShell, como administrador do Exchange):

   ```powershell
   Install-Module ExchangeOnlineManagement          # só na primeira vez
   Connect-ExchangeOnline -UserPrincipalName admin@inaservicos.com.br
   # IDs do "Aplicativo empresarial" (Entra › Aplicativos empresariais › o aplicativo), NÃO os da tela Registros de aplicativo:
   #   AppId = ID do aplicativo (cliente); ObjectId = ID do objeto do aplicativo empresarial (service principal)
   New-ServicePrincipal -AppId <ID do aplicativo> -ObjectId <ID do objeto do aplicativo empresarial> -DisplayName "Central de Gestão - caixa nfe"
   New-ManagementScope -Name "Caixa nfe" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'nfe@inaservicos.com.br'"
   New-ManagementRoleAssignment -App <ID do aplicativo> -Role "Application Mail.ReadWrite" -CustomResourceScope "Caixa nfe"
   # Conferir: a caixa nfe@ deve dar InScope = True; outra caixa qualquer, False
   Test-ServicePrincipalAuthorization -Identity <ID do aplicativo> -Resource nfe@inaservicos.com.br
   Test-ServicePrincipalAuthorization -Identity <ID do aplicativo> -Resource outra.pessoa@inaservicos.com.br
   ```

   A função "Application Mail.ReadWrite" lê, move e cria pastas, mas **não envia e-mail**. A Microsoft avisa que a mudança pode levar de **30 minutos a 2 horas** para valer nas chamadas reais (o `Test-ServicePrincipalAuthorization` responde na hora).
4. **Variáveis no Easypanel** (serviço `gestao` › Environment), depois **Deploy**:

   | Variável | Valor |
   |---|---|
   | `M365_TENANT_ID` | ID do diretório (locatário) |
   | `M365_CLIENT_ID` | ID do aplicativo (cliente) |
   | `M365_CLIENT_SECRET` | o valor do segredo (passo 2) |
   | `M365_SECRET_VENCE` | data de vencimento do segredo, `AAAA-MM-DD` (o sistema avisa 30 dias antes; o Graph não deixa este aplicativo ler essa data sozinho) |
   | `NFE_EMAIL` | opcional; padrão `nfe@inaservicos.com.br` |
   | `NFE_EMAIL_PASTA_OK` | opcional; padrão `Processadas` |
   | `NFE_EMAIL_INTERVALO_MIN` | opcional; padrão 60, mínimo 15 |

   Sem `M365_TENANT_ID`, `M365_CLIENT_ID` e `M365_CLIENT_SECRET`, o leitor fica **desligado** e a tela explica o que falta. A VPS precisa sair na porta 443 para `login.microsoftonline.com` e `graph.microsoft.com`.
5. **Conferir.** Em Recebimento de notas › Caixa nfe@, clique **Ler agora**. O estado deve ficar "Conectado". Erros comuns: "credencial recusada" (ID ou segredo errado, ou segredo vencido); "403: o aplicativo não tem acesso a esta caixa" (passo 3 ainda não valeu, espere até 2 horas, ou faltou a função); "caixa não encontrada" (confira `NFE_EMAIL`).
6. **Antes de o segredo vencer**, crie um novo (passo 2), troque `M365_CLIENT_SECRET` e `M365_SECRET_VENCE` no Easypanel e faça o Deploy; depois apague o segredo antigo no Entra.

**Sigilo.** O segredo e o token nunca vão para o log, a auditoria, o banco ou a tela. Cada leitura fica na auditoria (`CAIXA_NFE_LEITURA`: mensagens, notas novas, já existentes, ignoradas, PDF sem XML) e no quadro "Leituras recentes".

**Fontes (Microsoft Learn):**
- RBAC para aplicativos no Exchange Online (comandos `New-ServicePrincipal`, `New-ManagementScope`, `New-ManagementRoleAssignment`, `Test-ServicePrincipalAuthorization`, função "Application Mail.ReadWrite", soma com as permissões do Entra, prazo de 30 min a 2 h): https://learn.microsoft.com/exchange/permissions-exo/application-rbac
- Limitar o acesso do aplicativo a caixas específicas (remover o consentimento sem restrição do Entra): https://learn.microsoft.com/graph/auth-limit-mailbox-access
- Mover mensagem (`POST /users/{id}/messages/{id}/move`): https://learn.microsoft.com/graph/api/message-move
- Credencial de aplicativo (client credentials, escopo `https://graph.microsoft.com/.default`): https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
- Limites do Graph (429 e `Retry-After`): https://learn.microsoft.com/graph/throttling

## 6.3. DANFE oficial e PDF do fornecedor (v134)

**DANFE gerado do XML.** O botão **DANFE** (Contas a pagar e a receber, Recebimento de notas, Arquivo fiscal e Caixa nfe@) monta, no navegador, o DANFE no leiaute oficial do Manual de Orientação do Contribuinte (MOC 7.0, Anexo II): canhoto, emitente, quadro DANFE (entrada/saída, número, série, folha x/y), código de barras CODE-128C da chave, chave em grupos de 4, protocolo, destinatário, fatura/duplicatas, cálculo do imposto, transportador/volumes, produtos (várias folhas, com o cabeçalho repetido), ISSQN e dados adicionais. Nota com tpImp=2 sai em paisagem. Quando o XML traz o grupo `IBSCBSTot` (reforma tributária), aparece o quadro **Total do IBS / CBS / IS** e uma linha de IBS/CBS por item, como na NT 2026.010. Marcas d'água: **SEM VALOR FISCAL** (homologação, tpAmb=2) e **CANCELADA** (situação no arquivo fiscal). Botões: **Imprimir** (quadro separado só com as folhas, A4 sem margem do navegador), **Baixar PDF** (precisa do html2canvas e do jsPDF; veja "Bibliotecas do navegador") e **Resumo** (o espelho simples de antes). O DANFE é montado do XML original guardado no servidor; nada é gravado.

**PDF original do fornecedor.** Cada nota pode ter **um** PDF (o DANFE que o fornecedor mandou), guardado no `gestao.db` (tabela `arqf_pdf`, com origem, nome, tamanho e sha256). Ele chega por três caminhos: (1) **e-mail** (o "DANFE do e-mail" da caixa nfe@ passa a ser o PDF da nota, sozinho); (2) **anexo** pelo botão "Anexar PDF do fornecedor" no DANFE da nota; (3) **lote**: Recebimento de notas › Arquivo fiscal › **Importar DANFEs (ZIP de PDFs)**. Quando a nota tem o PDF, o botão DANFE abre o PDF, com o botão "Ver DANFE gerado do XML". O XML continua sendo o documento fiscal.

**Importar DANFEs (ZIP de PDFs).** O ZIP traz PDFs cujo **nome tem a chave de 44 dígitos** (ex.: `35260443991892000142550010002339921627432956.pdf` ou `NFe3526…-danfe.pdf`). O servidor confere a chave (dígito verificador), se o arquivo é PDF de verdade (começa com `%PDF`) e o tamanho (até `ARQF_PDF_MAX_MB`, padrão 3 MB). Liga à nota que **já está no arquivo fiscal**; se a nota não está lá, ignora com o motivo "nota não encontrada no arquivo fiscal — importe o XML antes". Nota que já tem PDF fica como está ("já existente"): pode reenviar sem medo. O relatório mostra novos, já existentes e ignorados, com o motivo, e baixa em CSV. Tudo vai para a auditoria (`ARQF_PDF_*`).

**Quem pode.** Igual ao arquivo fiscal: Fiscal, Financeiro, Administrador e Diretoria (e o dono) veem, anexam e importam; trocar e remover o PDF só eles. O Comprador vê e anexa só PDFs de notas de **entrada** (no lote, as saídas são ignoradas com motivo) e não troca nem remove. Os demais perfis não acessam.

**Segurança.** O PDF vem de fora: o servidor entrega com `nosniff`, sem cache e com CSP `sandbox`; a tela mostra o PDF pelo leitor de PDF do navegador (cópia local, sem abrir como página do sistema) e oferece "Baixar PDF".

**Variáveis (opcionais, serviço `gestao`)**: `ARQF_PDF_MAX_MB` (tamanho máximo de cada PDF, padrão 3, até 5) e `ARQF_PDF_ZIP_MB` (tamanho máximo do ZIP de PDFs, padrão 200).

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

## 7.1.1. Chamada de vídeo do chat (STUN e TURN)

A chamada individual do chat é direta entre os navegadores e não precisa de nenhum endereço externo liberado. Na mesma rede e na maioria das conexões de casa ela funciona só com o STUN público (padrão). Em 4G e em redes de empresa ou de obra a ligação direta costuma ser bloqueada; nesse caso o app oferece "Iniciar chamada por link" (Jitsi, em nova aba). Para a chamada direta funcionar também nessas redes, instale um servidor TURN (ex.: coturn) e configure no serviço gestao:

- `TURN_URLS=turn:turn.seudominio.com.br:3478,turns:turn.seudominio.com.br:5349`
- `TURN_SEGREDO=<mesmo valor de static-auth-secret do coturn>` (credencial temporária de 12 h, recomendado), ou `TURN_USUARIO` e `TURN_SENHA` (credencial fixa)
- Opcional: `STUN_URLS` para trocar o STUN padrão (vazio desliga o STUN).

## 7.2. Extrato automático do Banco do Brasil (Financeiro › Conciliação bancária › Extrato automático)

1. No portal **BB Developers** (developers.bb.com.br), entre com o usuário da empresa, crie um aplicativo e peça acesso à **API Extratos** (produção). Se travar, o gerente do BB libera.
2. Anote **Client ID**, **Client Secret** e **developer_application_key** (chave do aplicativo).
3. O BB exige um certificado A1 da empresa na conexão. **Prefira um certificado A1 separado só para o BB** (a certificadora emite mais de um e-CNPJ para o mesmo CNPJ; custa pouco). Assim, se o serviço `gestao`, que fica exposto na internet, for comprometido, o certificado que assina NF-e e manifestações continua só no `fiscal`. Coloque o certificado do BB em:
   ```bash
   mkdir -p /opt/central/bb
   cp /caminho/do/certificado-bb.pfx /opt/central/bb/bb.pfx
   chown 1000 /opt/central/bb/bb.pfx && chmod 400 /opt/central/bb/bb.pfx
   ```
   Se não houver um certificado separado, dá para copiar o mesmo A1 (`cp /opt/central/certs/certificado.pfx /opt/central/bb/bb.pfx`), sabendo que ele passa a existir também no serviço exposto. No serviço **gestao**, em Mounts, o Bind deve ser host `/opt/central/bb`, caminho `/certs` (nunca a pasta `/opt/central/certs`, que é só do conector fiscal). O `docker-compose.yml` e o `instalar.sh` já montam assim.
4. No serviço **gestao** › Environment: `BB_CLIENT_ID`, `BB_CLIENT_SECRET`, `BB_APP_KEY`, `BB_CERT_PATH=/certs/bb.pfx` e `BB_CERT_SENHA`. Clique em **Deploy**.
5. No sistema, em Conciliação bancária › **Extrato automático**: em cada conta do BB escolha "API do Banco do Brasil", informe agência e conta (sem dígito), **Testar conexão** e **Salvar e buscar agora**.

O servidor busca o extrato a cada 3 horas (`BANCOS_INTERVALO_MIN`). Na primeira vez traz 30 dias; depois, os últimos 5 dias, sem duplicar.

## 8. Rotina e segurança

- **Cópia de segurança**: automática, cifrada e com os anexos (seção "Cópia de segurança"). Também ative os snapshots da VPS na Hostinger, como segunda camada.
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

### 7.3.1. Ordem de fabricação por e-mail para a fábrica (v125)

O botão **Obras › Ordens de fabricação › (abrir a OS) › Enviar por e-mail** usa o mesmo SMTP acima. Não há variável nova no Easypanel.

- **E-mail da fábrica:** padrão `pr.tuiuti@inaservicos.com.br`. Para trocar, vá em **Sistema › Configurações › Fábrica (ordens de fabricação)**. Lá também ficam:
  - o limite de dias para o alerta de galvanização (padrão 15);
  - a tolerância de diferença de peso (padrão 5%);
  - os aprovadores da OS.

  Só um administrador altera esses dados, e o servidor confere isso.
- **O que é enviado:** um PDF único, montado no navegador. Ele tem a página da OS e, em seguida, os PDFs e imagens anexados à OS. O limite é de 20 MB.
- **Cópia:** na hora de enviar, você pode informar até 5 endereços em "copiar para".
- **Quem pode enviar:** só quem grava as OS, ou seja, o Gestor de projetos, o Administrador e o perfil Fábrica. O limite é de 20 envios por hora por pessoa.
- **Registro:** quem enviou e quando ficam gravados na OS e na auditoria (`OSF_EMAIL`).
- **Sem SMTP configurado:** a tela avisa e oferece **Baixar o PDF**, para você enviar pelo seu próprio e-mail. A tentativa fica na auditoria como `OSF_EMAIL_SEM_SMTP`.
- **Biblioteca de PDF:** o PDF usa o pdf-lib (`vendor/pdflib/pdf-lib.min.js`, veja "Bibliotecas do navegador"). Enquanto o arquivo não estiver copiado para a pasta `vendor`, ele é carregado pela CDN.


## Cópia de segurança

Todo dia, a partir das 3h (horário de Brasília), o sistema grava em `/data/backups`:

- **o banco inteiro**: `gestao-AAAA-MM-DD.db.gz.cg`;
- **os anexos** (`/data/blobs`: holerites, comprovantes, fotos): uma **cópia completa por semana** (`anexos-…-completo-NN.tar.gz.cg`) e, nos outros dias, **só os arquivos novos** (`anexos-…-incr-NN.tar.gz.cg`), mais um **inventário** (`anexos-…-inventario.json.gz.cg`) que diz em qual pacote está cada anexo. Pacotes grandes são divididos em partes de até 1 GB (`BACKUP_ANEXOS_VOLUME_MB`).

Com `BACKUP_CHAVE` preenchida, tudo é **cifrado** (AES-256-GCM; a chave de cada arquivo vem da `BACKUP_CHAVE` por scrypt) e o nome termina em `.cg`. **Sem a chave, a tela Contas de acesso avisa "Cópia sem cifra"**. Guarde a `BACKUP_CHAVE` no cofre de senhas da empresa, **fora da VPS**: sem ela nenhuma cópia abre, e quem tem só o arquivo não lê nada. O sistema guarda os últimos 30 dias (`BACKUP_DIAS`). O dono vê a lista, baixa e faz uma cópia na hora em **Contas de acesso › Cópia de segurança** (pede a senha de novo).

### Fora do servidor (recomendado)

Crie um bucket num serviço compatível com S3 (Cloudflare R2, Backblaze B2, Wasabi, AWS) e preencha no serviço gestao › Ambiente: `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGIAO` (R2: `auto`), `BACKUP_S3_CHAVE`, `BACKUP_S3_SEGREDO` e `BACKUP_S3_PASTA`. Clique em Implantar. O banco e os pacotes de anexos sobem todo dia; um pacote que falhar fica numa fila e sobe na vez seguinte. Com S3 ligado, os pacotes de anexos são apagados do servidor depois de enviados (o inventário fica); para manter também no servidor, `BACKUP_ANEXOS_MANTER_LOCAL=1`.

- No bucket, ligue **versionamento** e **object lock / retenção** (R2: "Bucket lock"; B2: "Object Lock"; AWS: "Object Lock" em modo compliance) por pelo menos 30 dias. Assim, quem invadir o servidor e tiver a chave de envio não consegue apagar as cópias antigas.
- Crie uma chave de acesso **só para este bucket**, com permissão de gravar (sem apagar, se o serviço permitir).

### Restaurar

O script `restaurar.js` (na pasta `gestao`, também dentro da imagem em `/app/restaurar.js`) decifra e confere. Precisa de Node 22 e da `BACKUP_CHAVE`:

```bash
export BACKUP_CHAVE='a-chave-guardada-no-cofre'
node restaurar.js conferir /caminho/das/copias                      # confere se todos os arquivos abrem (chave e integridade)
node restaurar.js banco  gestao-2026-10-26.db.gz.cg  gestao.db      # decifra, descompacta e confere o banco
node restaurar.js anexos /caminho/das/copias  ./blobs              # junta completo + incrementais pelo inventário mais novo
node restaurar.js decifrar arquivo.cg                               # só decifra (gera o .gz / .tar.gz original)
```

Para colocar no ar: (1) baixe do bucket (ou de `/data/backups`) o banco do dia, os pacotes de anexos e o inventário mais novo para uma pasta; (2) rode os comandos acima; (3) no Easypanel, **pare** o serviço gestao; (4) no volume `gestao-dados`, guarde o `gestao.db` atual com outro nome, apague `gestao.db-wal` e `gestao.db-shm`, coloque o `gestao.db` restaurado e copie os anexos para `blobs/`; (5) implante de novo e confira.

**Teste a restauração a cada 3 meses** (numa pasta qualquer do seu computador, com `conferir` e `banco`): cópia que nunca foi restaurada não é cópia.

## Permissão de gravação por módulo

O servidor confere se o perfil de cada pessoa pode gravar no módulo. Começa em `PERFIL_GRAVACAO=avisar`: nada é bloqueado e **Contas de acesso › Gravação por módulo** mostra o que seria recusado. Depois de conferir, mude para `PERFIL_GRAVACAO=bloquear` e implante.

## Verificação em duas etapas e sessões

Cada pessoa liga a verificação em duas etapas em **Segurança** (botão no topo do sistema, ou `/conta/seguranca`): lê o QR Code com um aplicativo autenticador (Google Authenticator, Microsoft Authenticator) e guarda os 10 códigos de recuperação. Na mesma tela aparecem os aparelhos conectados e o botão "Sair de todos os outros aparelhos".

- **Obrigatória** (`DOIS_FATORES_OBRIGATORIO=equipe`, o padrão) para o **dono** e para os perfis de Equipe que gravam (Administrador, Financeiro, RH, Fiscal, Projetos e qualquer perfil que não seja só de leitura). Quem ainda não ligou entra com a senha e só consegue abrir a página de segurança até ligar. `dono` = só o dono; `nao` = desliga a obrigação. `DOIS_FATORES_CARENCIA_DIAS=7` dá 7 dias de prazo (contados do primeiro acesso depois da mudança), com um aviso no sistema.
- **Senha**: pelo menos 12 caracteres para o dono e a Equipe que grava (`SENHA_MINIMA_EQUIPE`); 8 para colaboradores. Vale ao criar e ao trocar senha.
- **Sessão**: a Equipe sai sozinha depois de 10 horas sem usar o sistema (`SESSAO_INATIVIDADE_HORAS`, entre 8 e 12 é o recomendado); colaboradores, depois de 30 dias (`SESSAO_COLABORADOR_DIAS`).
- **Confirmação de identidade**: criar, alterar ou excluir contas de acesso, desligar a verificação de outra pessoa, fazer ou baixar cópia de segurança, migrar e exportar dados pedem a senha (ou o código do aplicativo) de novo, se a última confirmação tiver mais de 15 minutos (`REAUTENTICAR_MINUTOS`). Cinco erros seguidos encerram a sessão.
- **Segredo cifrado**: com `CHAVE_MESTRA`, o segredo de cada pessoa fica cifrado no banco (os que já existem são cifrados ao reiniciar). **Não troque a `CHAVE_MESTRA` depois de usar**: as pessoas não conseguiriam mais entrar com o código (se acontecer, volte a chave antiga ou desligue as duas etapas delas). Sem a chave, o sistema funciona como antes e a tela de Contas avisa.
- **Login**: depois de 3 senhas erradas seguidas para o mesmo e-mail, cada nova tentativa espera um pouco mais (1, 2, 4… até 15 segundos). A conta não é travada: com a senha certa a pessoa entra. Um endereço com 8 erros fica 10 minutos sem tentar.
- Alguém perdeu o celular e os códigos: o dono desliga em **Contas de acesso › Desligar 2 etapas** (pede a senha do dono). A pessoa entra com a senha e liga de novo.
- O próprio dono perdeu o celular e os códigos: no serviço gestao › Ambiente, coloque `DOIS_FATORES_RESET=email-do-dono`, clique em Implantar, entre só com a senha, **tire a variável** e implante de novo. Depois ligue a verificação outra vez.
- As senhas são guardadas com scrypt reforçado (as antigas são atualizadas no próximo login) e as sessões ficam no banco só como hash: uma cópia do banco não permite entrar no sistema.

## Bibliotecas do navegador

O sistema usa pdf.js (ler PDFs), SheetJS (planilhas), html2canvas e jsPDF (gerar PDF) e JSZip. Elas ficam em `gestao/public/vendor` e são servidas pelo próprio servidor, com hash de integridade (SRI) calculado na hora de subir:

- **Já incluídas**: pdf.js 6.2.108 e JSZip 3.10.1.
- **Falta copiar** (o pacote foi montado sem internet): SheetJS **0.20.3** (a 0.18.5 da cdnjs tem as falhas CVE-2023-30533 e CVE-2024-22363), html2canvas 1.4.1 e jsPDF 2.5.1. Num computador com internet, na raiz do repositório: `bash gestao/baixar-bibliotecas.sh`, envie ao GitHub e implante. Enquanto não copiar, essas três continuam vindo da cdnjs e a política de conteúdo libera `cdnjs.cloudflare.com`; depois de copiar, a CDN deixa de ser liberada sozinha.
- Política de conteúdo (CSP): sem `unsafe-eval`; o sistema só conversa com o próprio servidor e com ViaCEP, BrasilAPI e CNPJ.ws (consulta de CEP e CNPJ). As páginas simples (login, contas, segurança) não podem ser abertas dentro de outro site. Se algum recurso parar por causa da CSP, `CSP_UNSAFE_EVAL=1` devolve o `unsafe-eval` enquanto se investiga.

## Endurecimento do servidor (para o dono ou a TI)

Faça na ordem. Cada item fecha um caminho real de invasão.

1. **Easypanel com HTTPS e domínio.** No Easypanel: Settings › General › "Panel domain": use `painel.inaservicos.com.br` (registro A para o IP da VPS). Ele passa a abrir por `https://`. Depois, entre sempre pelo domínio.
2. **2FA no Easypanel.** Settings › Users › seu usuário › Two-factor authentication. Crie um usuário para cada pessoa da TI (nada de senha compartilhada) e apague os que não usa.
3. **Fechar a porta 3000 do Easypanel.** No painel da Hostinger: VPS › Segurança › **Firewall** › crie uma regra que **aceite só 22, 80 e 443** e descarte o resto (ou, se a TI usar VPN como Tailscale/WireGuard, libere a 3000 só para a faixa da VPN). Teste: `curl -m 5 http://IP-DA-VPS:3000` de fora deve falhar.
4. **SSH só por chave e fail2ban.** No seu computador: `ssh-keygen -t ed25519`; na Hostinger: VPS › Configurações › Chaves SSH › adicione a chave pública. Na VPS:
   ```bash
   apt update && apt install -y fail2ban unattended-upgrades ufw
   sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config && systemctl restart ssh
   systemctl enable --now fail2ban
   ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
   dpkg-reconfigure -plow unattended-upgrades     # atualizações de segurança automáticas
   ```
   Antes de fechar a sessão, abra **outro** terminal e confirme que entra com a chave. Observação: o Docker publica portas por fora do `ufw`; por isso o firewall da Hostinger (item 3) é o que vale para a 3000.
5. **GitHub.** Repositório privado. Para o Easypanel ler o código, prefira a integração do próprio Easypanel (Settings › GitHub) ou uma **deploy key** só de leitura (repositório › Settings › Deploy keys › sem "Allow write access"). Se usar token, só **fine-grained**, só este repositório, **Contents: Read-only**, validade de 1 ano. Ative 2FA na conta do GitHub.
6. **Rotação anual de segredos** (anote a data no calendário): `FISCAL_TOKEN` (troque nos dois serviços ao mesmo tempo), token do GitHub, chave S3, senha de app do SMTP, chave da Anthropic, credenciais do BB e da Sólides. **Não** troque `CHAVE_MESTRA` nem `BACKUP_CHAVE` sem planejar (veja as seções acima). Troque tudo **na hora** se alguém com acesso sair da empresa ou se houver suspeita de vazamento.
7. **Chave da Anthropic dedicada.** No console da Anthropic, crie um workspace "Central de Gestão", uma chave só para ele e um **limite de gasto mensal**. Se a chave vazar, o prejuízo fica limitado e você revoga sem afetar outros usos.
8. **E-mail (SMTP) com senha de app.** Use uma conta de envio só do sistema e uma **senha de app** (Google Workspace e Microsoft 365 exigem 2FA na conta para isso), nunca a senha pessoal de ninguém. `SMTP_TLS=nao` não funciona em produção.
9. **Banco do Brasil.** No gerenciador financeiro do BB, ligue a **dupla autorização de lote** (um usuário envia a remessa, outro libera) e cadastre o **limite diário de pagamentos**. Esses controles valem mesmo que alguém contorne o sistema. Na API, peça só o escopo de extrato.
10. **Contêineres.** O `docker-compose.yml` já roda os dois serviços com sistema de arquivos só leitura, sem capacidades do Linux, sem escalar privilégio e com limite de memória e CPU, e as imagens têm versão fixa (`node:22.22.0-alpine`, `python:3.13.16-slim`). Se usar Apps no Easypanel em vez do Compose, configure em cada serviço › Advanced/Resources: memória 1 GB e 1,5 CPU (gestao), 384 MB e 0,5 CPU (fiscal). Para atualizar a imagem, troque a versão no Dockerfile de propósito, rode os testes e implante. Depois de mudar `fiscal/requirements.txt` (já atualizado: cryptography 50.0.1, requests 2.34.2, lxml 6.1.3), faça **Deploy com rebuild** do serviço fiscal.
11. **Cópias fora do servidor** com versionamento e object lock (seção "Cópia de segurança") e teste de restauração a cada 3 meses.

### Plano de resposta: "pagamento desviado"

Sinais: fornecedor diz que não recebeu; conta bancária de fornecedor mudou sem pedido; remessa com favorecido estranho.

1. **Na hora (minutos contam):** ligue para o gerente do BB (e a central de atendimento empresarial) e peça o **bloqueio cautelar** do valor. Se foi PIX, peça a abertura do **MED (Mecanismo Especial de Devolução)** — o prazo é de até 80 dias, mas a chance de recuperar cai a cada hora. Se foi TED/boleto, peça o contato com o banco recebedor para bloqueio.
2. **Congele o acesso:** em Contas de acesso, desative a conta suspeita (as sessões caem na hora); peça a todos da Equipe que troquem a senha; no BB, suspenda os usuários envolvidos; não envie novas remessas até conferir os dados bancários dos fornecedores **por telefone**, num número que você já tinha.
3. **Guarde as provas:** faça uma cópia de segurança agora (Contas de acesso › Fazer uma cópia agora) e baixe-a; guarde a remessa, o comprovante, e-mails e mensagens; exporte os logs do serviço gestao no Easypanel; não apague nada.
4. **Boletim de ocorrência** (delegacia de crimes cibernéticos ou BO eletrônico de SP) com valor, data, favorecido e comprovantes. O banco costuma pedir o BO.
5. **Auditoria:** confira quem trocou os dados bancários e quem aprovou (trilha de auditoria do sistema), quais sessões estavam abertas (Segurança › Aparelhos conectados) e os acessos ao Easypanel e à VPS. Troque os segredos (item 6 acima).
6. **LGPD:** se houve acesso a dados pessoais (de funcionários, clientes, fornecedores), avalie com o jurídico se o incidente pode causar risco ou dano relevante. Se sim, **comunique a ANPD em até 3 dias úteis** do conhecimento (Resolução CD/ANPD nº 15/2024; formulário no site da ANPD) e avise as pessoas afetadas em linguagem clara. Registre o incidente mesmo quando não comunicar.
7. Depois: o que falhou, o que muda (ex.: limite diário menor no BB, dupla aprovação para trocar dados bancários).

## Variáveis de ambiente de segurança (serviço gestao)

| Variável | Padrão | Para quê |
|---|---|---|
| `SETUP_TOKEN` | (vazio) | Código para criar a conta do dono em `/setup?token=…` |
| `CHAVE_MESTRA` | (vazio) | Cifra o segredo da verificação em duas etapas no banco |
| `BACKUP_CHAVE` | (vazio) | Cifra as cópias de segurança (AES-256-GCM) |
| `DOIS_FATORES_OBRIGATORIO` | `equipe` | `equipe`, `dono` ou `nao` |
| `DOIS_FATORES_CARENCIA_DIAS` | `0` | Prazo para ligar |
| `SENHA_MINIMA_EQUIPE` | `12` | Senha mínima do dono e da Equipe que grava |
| `SESSAO_INATIVIDADE_HORAS` | `10` | Equipe sai depois de N horas sem uso |
| `SESSAO_COLABORADOR_DIAS` | `30` | Colaborador sai depois de N dias sem uso |
| `REAUTENTICAR_MINUTOS` | `15` | Quanto vale a confirmação de senha para ações sensíveis |
| `ANEXOS_COTA_MB` / `ANEXOS_COTA_COLABORADOR_MB` | `2048` / `300` | Cota de anexos por pessoa (0 = sem limite) |
| `DISCO_ALERTA_PCT` | `10` | Alerta em Contas quando o disco livre fica abaixo disso |
| `BACKUP_ANEXOS`, `BACKUP_ANEXOS_COMPLETO_DIAS`, `BACKUP_ANEXOS_VOLUME_MB`, `BACKUP_ANEXOS_MANTER_LOCAL` | `1`, `7`, `1024`, auto | Cópia dos anexos |
| `CSP_UNSAFE_EVAL` | (vazio) | `1` só em emergência, se algo parar por causa da CSP |

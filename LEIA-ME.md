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

**O que faz.** O serviço `gestao` lê a caixa **nfe@inaservicos.com.br** pelo Microsoft Graph (de hora em hora, e pelo botão "Ler agora"). Os XML de NF-e anexados (soltos ou dentro de ZIP) vão para o Arquivo fiscal com origem **e-mail**; o PDF (DANFE) só é guardado se tiver a chave de acesso no nome ou no texto. Cada mensagem lida vai para a pasta **Processadas** (criada sozinha). Do e-mail ficam só remetente, assunto e data; o corpo nunca é guardado. A tela fica em **Suprimentos › Recebimento de notas › Caixa nfe@** e o estado aparece em **Sistema › Configurações**. Quem usa: Fiscal, Financeiro, Administrador e Diretoria. Comprador e Almoxarife **consultam** (lista, situação e PDF), sem "Ler agora" nem tirar e-mail da lista (v140). Código: `gestao/caixanfe.js`; tabelas `caixa_msg`, `caixa_pdf`, `caixa_leitura` e `arqf_origem` no `gestao.db`.

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

## 6.4. NFS-e emitidas: importação do ZIP do Omie e ligação com Contas a receber (v135)

**Onde.** Fiscal › Arquivo fiscal (ou Suprimentos › Recebimento de notas), nas abas Arquivo fiscal, Saídas emitidas e **NFS-e emitidas**: botão **Importar NFS-e emitidas (ZIP do Omie)**. O mesmo botão está em Fiscal › NFS-e e em Sistema › Importar cadastros. Envie o ZIP que o Omie exporta em "NFS-e emitidas" (pastas `nfse_<período>/<subpasta>/arquivo`), sem descompactar.

**O que o servidor lê.** Os dois padrões, no mesmo ZIP:
- **Prefeitura de Tuiuti (ABRASF 2.03, até 2025)**: `consultar_situacao_resposta/*.xml` (a nota autorizada: número, código de verificação, valores, retenções, tomador) e `cancelar_nfse_resposta/*.xml` (cancelamento com a confirmação da prefeitura). A identificação da nota no arquivo fiscal é `NFSE-<CNPJ>-<município>-<número>`.
- **NFS-e Padrão Nacional (2026)**: `distribuicao/*.xml` (a NFS-e com a chave de 50 dígitos, valores, retenções e IBS/CBS) e `distribuicao/*.pdf` (DANFSe). Se o XML da distribuição faltar, o servidor usa o XML que vem dentro dos `.txt` do Omie (`xmlGZipB64`). O cancelamento é o evento 101101/105102 com o registro do Ambiente Nacional.
- PDFs: o DANFSe oficial (2026) ou o demonstrativo do Omie (2024–2025), um por nota.
- Arquivos de apoio (solicitações, protocolos, cópias repetidas) são contados à parte; páginas HTML de erro do Omie são ignoradas com o motivo e **não são guardadas** (podem conter dados do proxy do Omie).
- Nota com o XML da prefeitura faltando, mas com o RPS enviado e o PDF no ZIP: é guardada como **"sem XML autorizado"** (RPS + PDF, código de verificação lido do PDF). Se o XML chegar depois, reimporte: a nota é completada.
- DPS/RPS enviado sem nota (rejeitado): aparece no relatório com a mensagem de rejeição e, quando houver, a nota que a substituiu.

**Conferências.** Só entram NFS-e cujo **prestador é a empresa** (CNPJ de Sistema › Configurações ou `ARQF_CNPJ`); as de outro CNPJ são recusadas com o motivo. Reimportar não duplica nada (notas, PDFs, eventos, registros do app) e completa o que faltava. Limites: ZIP até `ARQF_NFSE_ZIP_MB` (padrão 100 MB), 5 MB por XML/TXT, 3 MB por PDF; nomes com `../` ou caminho absoluto, arquivos protegidos por senha e compressão suspeita (ZIP-bomba) são recusados sem ler. O servidor não extrai nada para o disco. Tudo vai para a auditoria (`ARQF_NFSE_*`).

**O que acontece no sistema.**
- O XML original fica no arquivo fiscal (gzip, prazo de guarda de 5 anos, como as NF-e), como documento de **saída** modelo NFS-e, com o PDF.
- Cada nota aparece em **Fiscal › NFS-e** como **Emitida** ou **Cancelada**, com número, código de verificação/chave, tomador, valores, retenções (ISS retido, INSS, IR, CSLL, PIS, COFINS) e IBS/CBS quando houver (origem "importada do Omie"). Se o próprio sistema já tinha registrado a mesma nota (mesmo número e ano, mesmo código de verificação), ela **não é duplicada**: o registro do sistema só é ligado ao arquivo fiscal; se a prefeitura cancelou, ele fica sinalizado "Cancelada na prefeitura".
- **Ligação com Contas a receber** (nunca cria títulos): mesmo CNPJ do tomador (cliente pelo documento), valor do título igual ao **bruto** ou ao **líquido** da nota (ou valor + retido = bruto), com tolerância de R$ 0,05, e vencimento ou competência até 60 dias da emissão. **Exatamente 1** título que serve (e que não serve a outra nota) → liga sozinho. 0 ou mais de 1 → aba **NFS-e emitidas › Conferir ligação**, com as sugestões (a mais próxima primeiro), os botões Ligar, **Criar título a receber** (com o líquido e as retenções, vencimento a preencher, projeto opcional, sempre com confirmação) e Ignorar. Parcelas do mesmo documento que somam a nota viram sugestão e podem ser ligadas juntas (o servidor confere a soma). A tolerância e a janela ficam em "Regra da ligação".
- **Nota cancelada nunca liga.** Se um título já estava ligado a uma nota que agora consta cancelada, o título fica com a marca vermelha "NFS-e … cancelada", entra no filtro "Nota cancelada" e no aviso do topo de Contas a receber.
- No título ligado: marca **NFS-e nº** com as retenções e botão **NFS-e** (abre o PDF original; sem PDF, o resumo montado do XML; com "Desligar do título"). Em título sem nota, o botão **Ligar NFS-e** aparece quando há NFS-e importada do mesmo cliente sem título. Quem ligou e quando fica no título e na auditoria. Depois de desligar à mão, o sistema não liga de novo sozinho aquela nota.

**Quem pode.** Igual ao arquivo fiscal: Fiscal, Financeiro, Administrador e Diretoria (e o dono). Comprador, RH, Leitura e os demais não importam nem veem as NF-e/NFS-e de saída.

**Variáveis (opcionais, serviço `gestao`)**: `ARQF_NFSE_ZIP_MB` (tamanho máximo do ZIP de NFS-e, padrão 100).

**Atenção.** A importação grava direto nos títulos (campo `arqf` e `nfseId`) e nos registros da coleção `nfse`, como o arquivo fiscal já faz: não passa pela trava de competência fechada, porque só registra a ligação e a nota emitida, sem mudar valores dos títulos.

## 6.5. Compras, nota e contas a pagar: quem faz o quê (v140)

| Etapa | Quem faz |
|---|---|
| Solicitação de compra (SC) | Quem precisa. Toda SC passa pela **aprovação de material** (Financeiro › Aprovações), salvo se quem envia é aprovador ou o valor estimado está dentro do limite automático. |
| Cotação, pedido de compra, acordo de preço | **Comprador**. Pedido acima da alçada é aprovado em Financeiro › Aprovações. O **Financeiro não cria nem edita pedido** (só consulta). |
| Recebimento físico | **Almoxarife**, na tela do pedido (Receber). |
| Validar e lançar a nota de entrada | **Fiscal** (ou Administrador/dono). Comprador, Almoxarife e Financeiro não validam nem lançam. |
| Contas a pagar, baixa, conciliação, remessa | **Financeiro**. |

**Lançamento da nota pelo servidor.** O botão Lançar monta, no navegador, o pacote do lançamento (nota, movimentos de estoque, contas a pagar, guias de retenção, produto novo, baixa da entrada provisória do recebimento) e envia tudo de uma vez para `POST /api/nota/lancar`. O servidor confere o perfil e **revalida as travas**: recebimento físico, pedido aprovado (quando a alçada vale para ele), divergência com o pedido/recebimento aprovada por duas pessoas, nota sem pedido acima do limite só com motivo, e **nota repetida** (mesmo fornecedor + número + série, mesma chave de acesso, ou conta já criada a partir do XML no Arquivo fiscal). Passando, grava tudo numa só transação; recusando, nada é gravado e a tela mostra o motivo. As regras de cálculo estão em `gestao/p2p.js` (o mesmo cálculo do navegador). Conta a pagar ligada a uma nota (`notaId`) só nasce por essa rota; o servidor recusa a gravação comum (exceção: o saldo de uma baixa parcial).

**Arquivo fiscal.** O botão "Criar conta a pagar" virou **Lançar pelo recebimento**: a nota vai para Recebimento de notas e segue o fluxo. As contas criadas antes por ele continuam; lançar a mesma nota depois é recusado (para não pagar duas vezes).

**Alçada padrão.** Na primeira subida da v140, se a empresa não tinha alçada de pedido e/ou de pagamento (vazia ou 0), o servidor grava `cfg.alcPadrao` com a data: passa a valer **R$ 2.000** como piso, com nível 1 até R$ 10 mil (gestor), nível 2 até R$ 100 mil (diretoria) e acima disso duas pessoas. **Não é retroativo**: pedido ou conta criado antes dessa data não fica travado. Sem nenhum aprovador cadastrado no nível, **o dono ou o Administrador aprovam** (uma assinatura basta) e a tela Aprovações mostra "Configure os aprovadores". Quando o Administrador salva as regras de aprovação, vale o que ele gravou.

**Conciliação.** Conta criada pela conciliação (Criar lançamento e regras automáticas) entra livre quando a **categoria** é tarifa bancária, imposto/guia ou é transferência entre contas. As demais, acima da alçada, entram **pagas, marcadas "pago sem aprovação"** e aparecem em Aprovações para aprovar depois; a conciliação não fica travada.

**Separação da SC.** Quem aprova ou envia a SC sem poder gravar separação (Encarregado, Diretoria) não cria mais separação "órfã": a SC fica com a separação pendente e o Almoxarife (ou o Comprador) cria em Estoque › Separação.

## 6.6. Recebimento de notas mais simples: fila única, lançamento automático, compra pequena, NFS-e de fornecedor e devolução (v141)

**Fila "O que precisa de ação".** É a primeira aba de Suprimentos › Recebimento de notas. Junta tudo o que impede uma nota de virar estoque e conta a pagar: nota a validar ou lançar, XML que chegou (caixa nfe@, SEFAZ, Omie, envio manual) e ainda não tem pedido, falta de recebimento físico, pedido sem aprovação, divergência, compra pequena sem pedido, NFS-e de serviço e devolução com saída física a confirmar. Cada linha tem o motivo, **quem age** (Comprador, Almoxarife, Fiscal ou Aprovador) e o botão. "Minhas pendências" mostra só o que é do perfil da pessoa; o número aparece no menu e no Início. As abas antigas continuam (a de notas virou "Notas para lançar (todas)").

**Lançamento automático da nota que confere** (Regras do recebimento › "Lançar sozinha a nota que confere", padrão ligado). Vale quando: o XML chegou, a nota está ligada a **um único pedido aprovado**, o almoxarife registrou o **recebimento físico** e a conferência pedido × recebimento × nota ficou **dentro das tolerâncias**, sem item fora do pedido e sem nota repetida. Como o cálculo da nota (rateio, retenções, data de entrada, competência, entrada provisória, romaneio) está no navegador, o automático roda **no navegador do primeiro Fiscal ou Administrador que estiver com o sistema aberto**: ele pega uma trava no servidor (`POST /api/p2p/trava`, 90 s por nota) e manda o pacote pela **mesma rota** `POST /api/nota/lancar` com `auto:true`. O servidor confere tudo de novo, grava "lançada automaticamente" na nota e a auditoria `NOTA_LANCADA_AUTO` com a conta **sistema**. Dois gatilhos não lançam duas vezes (a trava e a rota recusam o segundo). Se faltar qualquer condição, a nota fica na fila com o motivo e quem age recebe aviso no chat. Enquanto ninguém do Fiscal abrir o sistema, a nota espera (nada é lançado sem a conferência do servidor). Só entram XML emitidos nos últimos 45 dias (configurável).

**Compra pequena sem pedido.** Nota sem pedido de **até R$ 1.000** (o limite de "nota sem pedido", configurável em Regras do recebimento) exige **categoria, projeto e a aprovação simples do gestor** (nível 1 da matriz de aprovadores; sem aprovador, o administrador), sem cotação. A aprovação é carimbada pelo servidor (`POST /api/p2p/pequena/aprovar`) e vale até o valor aprovado. Acima do limite continua valendo o pedido, ou o motivo com justificativa, e a conta segue a alçada de pagamento. Não vale para as categorias isentas nem para notas criadas antes da atualização. Opcional (desligado): "Aplicar também às contas a pagar avulsas de fornecedor", que pede a aprovação do nível 1 antes de pagar essas contas.

**NFS-e de fornecedor e empreiteiro** (botão "Receber NFS-e de serviço"). Aceita o XML da prefeitura (ABRASF) ou do Padrão Nacional e, sem XML, o PDF com os dados digitados. Fica no arquivo fiscal como entrada de serviço (prazo de guarda de 5 anos). É ligada sozinha à **medição do empreiteiro** quando o CNPJ/CPF do contrato e o valor bruto conferem; as retenções da nota (ISS, INSS, IR, CSLL, PIS, COFINS) são comparadas com as calculadas na medição e a diferença vai para a fila (o Fiscal aceita com uma explicação). Sem medição, a NFS-e vira nota de entrada pelo pedido de serviço, como compra pequena ou sem pedido, e segue o lançamento normal. A conta a pagar do serviço continua nascendo na aprovação da medição ou no lançamento da nota (não há porta nova). O CPF de empreiteiro pessoa física aparece mascarado nas telas e não vai na chave do arquivo.

**Devolução ao fornecedor** (nota lançada › "Registrar devolução", Fiscal ou Administrador). Informe os itens e quantidades, o motivo e o número da NF de devolução (ou envie o XML dela, que vai para o arquivo fiscal). O servidor (`POST /api/nota/devolver`) dá saída no estoque **pelo custo de entrada** (`mov.devFor`), abate ou cancela a conta a pagar em aberto da nota (e as guias de retenção em aberto, na proporção) e, se a conta já foi paga, cria um **crédito a receber do fornecedor**. Opcionalmente reabre o saldo do pedido para o fornecedor substituir. O **Almoxarife** confirma depois a saída física do material. A emissão da NF de devolução continua no emissor fiscal de vocês.

**Avisos.** No chat: solicitação aguardando aprovação (aprovador), pedido aprovado (comprador), material chegou (quem pediu), nota parada ou com divergência (quem age). Por **e-mail**, quando o SMTP está configurado (seção 7.3): os mesmos eventos, enviados pelo servidor uma vez por evento (`P2P_AVISO_INTERVALO_S`, padrão 120 s; `P2P_AVISOS=0` desliga); o e-mail diário das aprovações passou a incluir as solicitações de compra e as compras pequenas. O **e-mail do pedido ao fornecedor** sai pelo servidor com o **PDF do pedido** em anexo (`POST /api/ped/email`), para o e-mail do cadastro do fornecedor; sem SMTP, continua o e-mail pronto (abrir no seu programa de e-mail).

## 6.7. Medição ao cliente aprovada pelo Comercial, CIPA em abas e Ambiental no SST (v143)

**Medição ao cliente: quem faz o quê.**
- **Obra** (Obras › Medições ao cliente): lança o boletim, confere e usa **Enviar para aprovação**. Enquanto a medição aguarda, ela não pode ser alterada nem excluída. A tela não tem mais o botão Aprovar; fica para lançar, enviar e acompanhar. Tem a coluna **Projeto** (código, ex.: P412) e o filtro por projeto.
- **Comercial** (Comercial › **Medições para aprovar**, com contador no menu): confere o boletim e **aprova** ou **devolve com o motivo**. O motivo fica no histórico da medição e vai para quem lançou pelo chat interno. A aprovação também avisa quem lançou.
- **Segregação:** quem lançou ou enviou a medição não a aprova nem a devolve. O dono da página pode, depois de um aviso; é a mesma exceção que o servidor já tinha.
- **Faturamento:** não mudou. Só depois de aprovada, **Faturar** cria a NFS-e em rascunho e, se houver retenção, a conta a receber da retenção.
  - Quem aprova e também emite notas recebe logo a oferta de faturar.
  - Para os outros, Faturar avisa que a NFS-e é criada por quem emite notas. Faturar precisa de Contratos, Notas e, com retenção, Financeiro: hoje são o administrador e o dono.
- **Medições antigas:** as que estão em rascunho continuam funcionando; basta enviá-las. As aprovadas e as faturadas não mudam. A situação continua "Rascunho" até a aprovação, então enviada ou devolvida não conta como medido.
- **Servidor:** `gestao/medapr.js`, ligado em `regras.js` logo depois de `regraMedCli`. Ele aceita a aprovação só de medição enviada (o dono pode direto) e a devolução só com motivo. O boletim enviado fica travado. Os carimbos (`envPor`, `envEm`, `devPor`, `devEm`, `devMotivo`) e o histórico `fluxoHist` são gravados só pelo servidor. A Diretoria também aprova e devolve. Com a ação "Aprovar" desligada no perfil (v142), a pessoa não aprova nem devolve.

**Boletim de medição.** O rodapé traz "Emitido por [quem lançou ou enviou] em [data]" e "Aprovado por [nome] em [data]". O boletim não aprovado sai com a marca d'água **RASCUNHO – não aprovado** na tela, na impressão, no HTML e no PDF.

**Obras › Resultado da obra.** O quadro da esquerda ficou compacto, com o valor logo ao lado de cada linha. O cabeçalho mostra só o código (ex.: "P412 · 10017197"); a descrição completa aparece ao passar o mouse. Em tela estreita, "Caixa do projeto" desce para baixo do quadro.

**SST › Gestão da CIPA.** A página ganhou as abas **Visão geral · Membros · Reuniões e atas · Plano de trabalho**. As três telas saíram do menu do SST e do "Mais". Atalhos antigos (`#cipam`, `#cipar`, `#cipaa`), favoritos, Ctrl+K e links internos abrem a Gestão da CIPA na aba certa.

**Ambiental.** A tela saiu do menu Qualidade e entrou no menu SST, com as mesmas abas: Documentos e licenças, Resíduos e MTR, Transportadores e destinadores, Indicadores e Checklist ISO 14001. A permissão não mudou: a tela e as coleções `ambdoc`, `ambres`, `ambforn`, `ambind` e `isochk` já eram do módulo SST. Quem tem só Qualidade não via a tela antes e continua sem ver; quem tem SST grava.

**Painel do SST.** Novos botões **Emissão de RDA** (formulário novo do RDA dos técnicos) e **Entrega de EPI** (formulário novo de entrega), ao lado de "Registrar ocorrência". Só aparecem para quem grava RDA ou EPI: o Almoxarife vê só Entrega de EPI.

**Implantar.** Suba juntos `gestao/medapr.js`, `gestao/regras.js` e `gestao/public/index.html`, depois reinicie o serviço `gestao`. Não há variável nova nem tabela nova.

## 6.8. Reabrir medição ao cliente (v144)

**Para que serve.** Corrigir uma medição que já foi aprovada (ou até faturada) sem apagar nada: ela volta para rascunho, com o motivo, e a obra corrige e envia de novo para aprovação.

**Quem reabre.** Quem aprova: quem grava em Contratos (Comercial) ou a diretoria, com a ação **Aprovar** ligada no perfil (Sistema › Perfis de acesso). O dono sempre pode. O botão **Reabrir** fica em Obras › Medições ao cliente (nas aprovadas e faturadas) e no novo quadro **Aprovadas e faturadas** de Comercial › Medições para aprovar. O motivo é obrigatório (pelo menos 5 letras).

**O que acontece, conforme a situação.**
- **Aprovada (ainda não faturada):** volta para rascunho com a situação **Reaberta**. A aprovação anterior deixa de valer (quem aprovou e quando saem da medição e ficam no histórico).
- **Faturada, NFS-e ainda em rascunho:** além disso, o rascunho da NFS-e é **excluído** e a conta a receber da retenção é **cancelada** (fica no Financeiro como cancelada, com o motivo). Isso mexe em Notas e no Financeiro: só reabre quem também grava esses módulos (Fiscal com acesso a Contratos ou administrador). Para os outros, a tela explica quem pode.
- **Faturada, NFS-e já emitida na prefeitura:** não reabre. Cancele a nota no sistema da prefeitura e registre o cancelamento em Fiscal › NFS-e (serviços) › Cancelar (o pedido é aprovado por outra pessoa do Financeiro). Com a NFS-e cancelada, Reabrir fica liberado: cancela a retenção e a NFS-e cancelada fica guardada no histórico da medição.
- **Bloqueios com explicação:** retenção que já teve recebimento (estorne antes no Financeiro) e competência fechada da conta da retenção (um administrador reabre em Fiscal › Fechamento e exportação).

**Depois de reaberta.** A obra vê "Reaberta", com quem reabriu, quando e o motivo. Ela edita e usa **Reenviar para aprovação**; daí segue o fluxo da seção 6.7. Quem lançou recebe o aviso pelo chat interno. A medição reaberta não se exclui (só o dono), para não perder o histórico. O boletim volta a sair com a marca **RASCUNHO – não aprovado** e traz o **Histórico da medição** (enviada, aprovada, reaberta, com os motivos). Em "Decididas nos últimos 30 dias" a reabertura também aparece.

**Servidor.** Tudo passa pela rota `POST /api/med/reabrir` (`gestao/medapr.js`, ligada em `regras.js`), numa transação só: a medição, a exclusão da NFS-e em rascunho e o cancelamento da retenção são gravados juntos ou nada é gravado. Cada documento passa pelas regras de sempre (permissão do módulo, competência fechada, ação "Cancelar e estornar"). Os carimbos (`reabPor`, `reabEm`, `reabMotivo`), o histórico `fluxoHist` e a lista `nfseAnt` (NFS-e canceladas da medição) são do servidor. Pela gravação comum, uma medição aprovada ou faturada não volta para rascunho e não se exclui. A auditoria registra `MEDICAO_REABERTA` e as tentativas recusadas (`MEDICAO_REABRIR_RECUSADO`).

**Implantar.** Suba juntos `gestao/medapr.js`, `gestao/regras.js` e `gestao/public/index.html` e reinicie o serviço `gestao`. Não há arquivo novo, variável nova nem tabela nova (o `Dockerfile` já copia o `medapr.js`).

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

## Permissão por função dentro do módulo (v142)

Em **Sistema › Perfis de acesso**, cada módulo abre e mostra as **funções** dele (Compras: Solicitações, Cotações, Separação, Acordos, Ajustes de inventário…; Financeiro: Lançamentos, Recorrências, Adiantamentos, Remessa, Orçamento, Medições de empreiteiro…). Para cada função: **Sem acesso**, **Consulta**, **Cria e altera** ou **Cria, altera e exclui**. O nível do módulo é um atalho que preenche todas as funções; quando elas diferem, o módulo mostra "Personalizado".

- **Função = dado que o módulo grava** (as coleções do `perfis.json › colecoes`). O mapa das funções e do que cada uma lê fica em `perfis.json › funcoes`, gerado por `gen_perm.js` (rode-o a cada versão, como sempre). Sem `funcoes` (perfis.json antigo), o servidor usa `colecoes` e aplica do mesmo jeito.
- **O servidor aplica igual** (`gestao/permfn.js`, chamado por `perfcCompilar` e `perfaCompilar`): o que a função não grava é recusado e vai para a auditoria (`PUT_NEGADO`, `DELETE_RECUSADO`); a coleção da função sem acesso não é entregue. O que uma função precisa ler de outra (o recebimento lê o pedido, o estoque lê o produto, a solicitação mostra a separação ligada) fica liberado **só para leitura**. Uma coleção que é função em dois módulos (ex.: Produtos em Estoque e em Compras) vale pelo maior nível dos dois; a tela avisa "também em …".
- **Nada afrouxa**: dados de RH e salários, dados bancários, financeiro da empresa (só Financeiro, Fiscal, Administrador e Diretoria), Usuários, Configurações e Lixeira continuam com as regras de antes.
- **Ações sensíveis** (marcar por perfil, à parte do nível de gravação): **Aprovar** (SC, pedido, pagamento e divergência da nota; as alçadas de valor continuam na matriz de aprovadores, esta opção só diz se a pessoa *pode* ser aprovadora), **Lançar nota de entrada** (rota `/api/nota/lancar`), **Cancelar e estornar** (situação cancelado/cancelada e estorno da baixa de conta) e **Exportar** (botões de CSV e planilhas). Só tiram poder: o valor inicial é o que o perfil já fazia. "Exportar" é aplicado na tela (o dado que a pessoa consulta já está no navegador dela); a cópia completa do banco continua só com o dono.
- **Perfis padrão editáveis** por função ("Editar"), guardados em `perfc/a_<perfil>`, com **Voltar ao original**. A tela mostra o detalhe por função do padrão e os limites internos dele (só o recebimento, só rascunho, só certificados de NR…), que continuam valendo. O **Administrador não se edita** (evita trancar o sistema). **Duplicar** leva o acesso por função e os limites internos.
- **Ver como**: mostra o menu e as telas como o perfil enxerga, só no seu navegador (a sessão não muda e nada é gravado nem enviado ao servidor). Uma faixa no topo avisa e tem o botão **Sair da simulação**.
- **Compatibilidade**: perfil sem configuração por função funciona exatamente como antes ("Grava" antigo = cria, altera e exclui). Editar perfil continua pedindo a senha de novo e indo para a auditoria (`PERFIL_ACESSO_ALTERADO`, `PERFIL_PADRAO_AJUSTADO`, agora com o `fn` e as `acoes`).
- Implantação: o arquivo novo `gestao/permfn.js` já está no `Dockerfile` (COPY). Suba a versão com o `perfis.json` novo (gerado por `gen_perm.js`).

### Gestor e Técnico de segurança do trabalho (v145)

Os dois perfis padrão (e o antigo "Segurança do trabalho", que segue o Gestor) passaram a vir **de fábrica** com parte de Obras e de Pessoal em **Sem acesso**, função a função (`perfis.json › perfis › sstgestor/ssttec › padFn`):
- **Gestor** não vê: Obras e rateio, Contratos e Medições de empreiteiros, Resultado da obra, Relatório mensal, Colaboradores, Férias, Apropriação do mês, Banco de horas, Recrutamento e seleção, Admissões, Desligamentos, Solicitações, Empréstimos, Jornadas e Custo-hora por função.
- **Técnico** não vê, além dessas: Curva S, Horas extras (pedidos), Materiais da obra, Mão de obra por obra, Quadro de pessoal por obra, Movimentações e Afastamentos.
- A tela some do menu, das abas, do "Mais", do Ctrl+K, dos favoritos e dos atalhos; aberta pelo endereço mostra "sem acesso". O servidor deixa de entregar o que era só dessas telas (inclusive o custo-hora). Continua entregando, **só como apoio** das telas que eles usam (`leDep`), o cadastro de colaboradores (sem salário, CPF nem banco: ASO, EPI, treinamentos, aptidão, integração, CIPA) e as jornadas (HHT e índices); ao Técnico também os movimentos de material e a linha de base (Painel da obra, Índices de SST, Mobilização).
- Um ajuste salvo em Sistema › Perfis de acesso (`perfc/a_sstgestor`, `perfc/a_ssttec`) continua valendo por cima, função a função; "Voltar ao original" volta a este padrão novo. Basta implantar com o `perfis.json` novo; não há arquivo novo no servidor.

### Perfis padrão revistos e valores gerenciais (v146)

**Telas por perfil** (aprovado pelo dono). Mesmo mecanismo da v145, no próprio perfil padrão (`perfis.json`: `padFn`, `leDep` e, novos, `telasFora` e `itensFora`); um ajuste salvo em Sistema › Perfis de acesso continua por cima, e "Voltar ao original" volta a este padrão.
- **Encarregado / campo**: sai Painel da obra; em Obras, Obras e rateio, Curva S, Contratos e Medições de empreiteiros, Mão de obra por obra, Resultado da obra e Relatório mensal; em Suprimentos, Cotações, Recebimento de notas, Controles de compras, Ajustes de inventário, Avaliação de fornecedores, Acordos de preço e Almoxarifados; o Fiscal inteiro; na Frota, Veículos, Manutenção, Entregas com frete, Adicional de condutor, Locais da frota, Multas e Análise da frota.
- **Recursos humanos**: sai Painel da obra; em Obras, Obras e rateio, Curva S, Materiais da obra, Contratos e Medições de empreiteiros, Resultado da obra, Relatório mensal e Mobilização e encerramento; no SST, Gestão à vista, Matriz de treinamentos, PGR e PCMSO, Liberações de aptidão, Inventário de riscos, Permissões de trabalho, Integração, Trabalhadores terceiros (continua em Obras), Reciclagem complementar, RDA e Ambiental. No SST o RH **só consulta**, e grava Acidentes (CAT), Convocação de ASO e o EPI (a confirmação de recebimento pela Minha área é tratada pelo RH). Documentos e ASO e colaboradores continuam gravados pelo Pessoal.
- **Só ponto e Minha área**: só "Minha área" e "Meu ponto" (o espelho do próprio ponto continua dentro deles).
- **Comprador**: sai Painel da obra; em Obras, Obras e rateio, Curva S, Horas extras, Contratos e Medições de empreiteiros, Mão de obra por obra, Resultado da obra, Relatório mensal e Mobilização; no Fiscal, NFS-e e Notas Fiscais (fica Arquivo fiscal; Notas de entrada continua em Suprimentos).
- **Financeiro**: sai Qualidade, Diário de obra, Cronograma e execução e Equipamentos.
- **Fiscal e estoque**: sai Oportunidades e licitações, Habilitação, Diário de obra, Cronograma, Curva S e Mão de obra por obra. Frota passa a **consulta**; em Equipamentos, Manutenção e Extravios passam a consulta (o cadastro e o envio de ferramentas continuam, porque o romaneio e o almoxarifado mexem neles).
- **Comercial**: sai Diário de obra, Horas extras, Materiais da obra, Mão de obra por obra, Verificação de serviços e Não conformidades.
- **Almoxarife**: sai Painel da obra, Obras inteiro menos Materiais da obra, Frota e o Fiscal (fica o recebimento em Suprimentos); no SST só Controle de EPI.
- Gestor de projetos, Fábrica, Diretoria, Somente leitura e Leitura completa: sem mudança de telas.
- **Perfis antigos** ("Comprador / almoxarife" e "Segurança do trabalho"): continuam valendo. Perfis de acesso e Usuários mostram quantas pessoas ainda usam cada um, com o botão **Trocar o perfil dessas pessoas**.

**v146b — regra B aprovada pelo dono**: o **Fiscal e estoque** deixa de ver Painel da obra, Obras e rateio, Resultado da obra, Relatório mensal, Contratos e Medições de empreiteiros e, no Financeiro, Retenções de empreiteiros (ficam com o Financeiro). O servidor deixa de entregar a ele relatório mensal, contratos e medições de empreiteiros (`leFora`: nem como apoio das contas a pagar) e entrega a obra só como apoio, sem valores (`valCols`, mesmo com "Ver valores gerenciais" ligada); no Painel de Obras os valores de obra aparecem como "—". Notas, NFS-e, tributos, retenções sofridas, contratos e medições ao cliente continuam. O **Comercial** deixa de ver Painel da obra, Obras e rateio e Relatório mensal (o servidor não entrega o relatório mensal); continua com Resultado da obra, Curva S, contratos e medições ao cliente e de empreiteiros. Um ajuste salvo que devolve a função (ex.: Medições de empreiteiros em Consulta) volta a entregar o dado.

**Valores gerenciais**. Nova ação sensível **Ver valores gerenciais** (Perfis de acesso › Editar › Ações sensíveis; aparece no "Ver como"). Diferente das outras ações, pode ser **ligada ou desligada** em qualquer perfil (menos o Administrador, que sempre vê). Padrão: ligada para Administrador, Diretoria, Gestor de projetos, Financeiro, Comercial, Fiscal e estoque e Leitura completa; desligada para Encarregado, Almoxarife, Comprador, RH, Gestor e Técnico de SST, Fábrica, Só ponto, Somente leitura e os perfis antigos. Perfil personalizado: ligada, a não ser que se desmarque (os que já existem não mudam).
- Sem a ação, as telas continuam com quantidades, datas e situação, e os valores em R$ aparecem como "—" (com um aviso discreto no topo): na tela, na impressão/PDF, no CSV exportado e na busca (Ctrl+K). Exceções por função: Minha área e Meu ponto (da própria pessoa); no RH, o módulo Pessoal (salários e folha); no Comprador, Solicitações, Cotações, Pedidos, Acordos de preço, Controles de compras, Notas de entrada, Recebimento, Arquivo fiscal, Produtos, Fornecedores e Avaliação de fornecedores. O Almoxarife recebe "às cegas" (pedido sem preço na tela); a divergência de preço fica com o Fiscal.
- O servidor (`gestao/valores.js`, arquivo novo, já no Dockerfile) entrega obra, contratos, medições, contratos e medições de empreiteiros, orçamento/EAP, previsão, linha de base, relatório mensal e custo de frota **sem os campos de valor**, e não entrega o custo-hora por função (menos a quem vê dados de RH). Quem não tem a ação não muda esses campos: o servidor mantém o valor guardado.
- Ficam **só mascarados na tela** (o servidor continua entregando): custo dos movimentos e dos produtos de estoque (a baixa, o inventário e o custo médio dependem deles), preços de pedido, cotação e nota (o Comprador precisa; o recebimento do Almoxarife grava o rascunho da nota) e o custo de mão de obra que o RH vê na tela Mão de obra por obra (o RH recebe salários e custo-hora pelo Pessoal).

**v148 — correções depois da revisão de perfis** (sem arquivo novo; `perfis.json` regerado):
- **Almoxarife lê os colaboradores só com o mínimo** (nome, matrícula, função, obra e situação), para EPI, envio/retorno de ferramentas e romaneio. Campo novo `leMin` no perfil padrão (`perfis.json`); o servidor (`permfn.js › leMinCampos`, `server.js › redigir`) entrega só esses campos, nunca salário, CPF, banco/PIX, endereço, contato ou dado sensível. Quem já lê o módulo Pessoal/Frota continua com a regra de sempre.
- **Solicitação de compra de quem não grava separação** (Encarregado, Fábrica, Comprador): a separação fica **pendente** e a SC fica **Enviada** até o Almoxarife usar **Criar separação** (aí ela vira "Atendida pelo estoque"). O servidor (`regras.js › regraScSep`) nunca aceita SC apontando para separação que não existe: ele a guarda como pendente.
- **Fiscal volta a lançar a nota de entrada** (estoque + contas a pagar + guias) pela rota `POST /api/nota/lancar`, também no lançamento automático e na NFS-e de fornecedor; continua sem gravar contas pela tela do Financeiro.
- Recebimento às cegas: o preço não reaparece quando a linha do item é redesenhada. Botões Aprovar/Recusar da SC aguardando aprovação aparecem uma vez só.

### Clientes, fornecedores e transportadoras com filiais (v147)

Para empresas com várias unidades (mesma razão social, CNPJ de filial diferente). Muda só a apresentação e a escolha: o que é gravado (`parcId`/`transpId`) e as regras são os mesmos. Lógica no navegador (`new_filiais.js`); nenhum arquivo novo no servidor e nenhuma mudança em `server.js`/`regras.js` (o servidor já aceita campos novos no cadastro; não há lista de campos permitidos para `parc`/`transp`).
- **Apelido** (opcional, uso interno) no cadastro de cliente/fornecedor e de transportadora. Ex.: "Clima Sul Jundiaí (obra Shopping)". É o nome em destaque nas listas internas; a anonimização LGPD de pessoa física também o apaga.
- **Caixas de escolha** (qualquer tela que escolhe cliente, fornecedor, empreiteiro, oficina ou transportadora): cada opção mostra "Apelido/fantasia — 12.345.678/0003-45 · Cidade/UF"; unidades do mesmo CNPJ raiz (8 primeiros dígitos) ficam juntas, matriz (/0001) primeiro. Ao clicar abre a busca (a mesma janelinha da v70) com duas linhas — apelido/fantasia em destaque; razão social · CNPJ com o sufixo da filial destacado · cidade embaixo — e acha por apelido, fantasia, razão social, CNPJ (com ou sem pontuação, ou só "0003") e cidade. No celular, botão **Buscar** ao lado da caixa (a lista nativa também mostra a linha com CNPJ e cidade).
- **Aviso** ao lado do campo: "Este cliente tem outras 2 unidades. Escolhida: …/0003-45 · Jundiaí/SP." (fornecedor e transportadora iguais), com a razão social e o CNPJ escolhidos logo acima.
- **Cadastro**: no topo, "Outras unidades deste grupo" com link para cada uma. Lista de Clientes/Fornecedores/Transportadoras agrupada, com Matriz/Filial marcadas e busca pelos mesmos dados. Ctrl+K acha pelo apelido, CNPJ ou sufixo e mostra apelido · CNPJ · cidade.
- **Documentos legais e externos** (pedido de compra e de venda, cotação enviada ao fornecedor, NF/NFS-e, boletim de medição, contratos, exportações CSV) continuam com **razão social e CNPJ completos**. Listas internas (contas a pagar/receber, notas, pedidos, NFS-e, contratos, medições, manutenção) mostram apelido/fantasia + cidade; a razão social e o CNPJ aparecem ao passar o mouse.
- CPF (pessoa física) não agrupa e aparece mascarado (***.982.247-**).
- O que fazer: preencher o **Apelido** das unidades que se confundem (Cadastros › Clientes/Fornecedores/Transportadoras › Editar) e conferir cidade/UF de cada filial.

### Histórico de negociação de preços no mapa de cotação (v149)

Em Suprimentos › Cotações, cada preço do mapa guarda a **proposta inicial** e todas as **rodadas de negociação**; nada é sobrescrito. Lógica no navegador (`new_negoc.js`) e garantia no servidor (`gestao/negoc.js`, arquivo novo, já no Dockerfile; ligado em `regras.js` com 3 linhas). Os dados ficam no próprio documento da cotação (lista `negHist`, que só cresce).
- **Proposta inicial**: o primeiro preço de cada item/fornecedor (digitado no mapa, vindo pelo link do fornecedor, pelo arquivo de resposta, pela mensagem colada de e-mail/WhatsApp ou pelo orçamento em PDF lido pela IA) fica guardado com origem, data e quem lançou. Frete, prazo e condição de pagamento também.
- **Negociar** (botão na célula, para um item) ou **Nova rodada** (rodapé, fornecedor inteiro): novo preço unitário e, se mudarem, frete, prazo e pagamento; **canal** (telefone, e-mail, WhatsApp, reunião, outro); observação; **anexo** opcional (print ou e-mail em PDF, no mesmo armazenamento dos outros anexos). Quem e quando são gravados automaticamente. **Observação obrigatória quando o preço ou o frete SOBE** (e, por consequência, o total do fornecedor); quando cai, é opcional. **Correção de digitação** também vira rodada, com o motivo "Correção" e observação obrigatória.
- **Célula do mapa**: preço atual com a etiqueta "↓ 8,5% negociado" (ou "↑ x% acima da proposta", em vermelho). Clicar no preço abre o histórico: Proposta inicial → Rodada 1 → Rodada 2, com valor, variação, data, canal, quem, observação e anexo. Preço com histórico não se edita direto na caixa.
- **Rodapé do mapa**, por fornecedor e no total escolhido: valor inicial, valor negociado e economia da negociação (R$ e %).
- **Pedido de compra** gerado do mapa guarda, por item, a proposta inicial (`vIni`), o número de rodadas, a última rodada (`negRef`, `negPor`) e o frete inicial; o servidor tira esses valores da cotação gravada. O **PDF/e-mail ao fornecedor mostra só o preço final**; o formulário do pedido e a janela de **aprovação** (matriz de aprovadores) mostram proposta inicial × negociado, a economia e o histórico das rodadas.
- **PDF e CSV do mapa**: para cada fornecedor, coluna "proposta inicial" ao lado do valor final, mais a linha "Economia da negociação".
- **Indicadores** em Suprimentos › Controles de compras (cartão "Economia na negociação"): economia no mês, desconto médio (ponderado pelo valor), por comprador (quem registrou a última rodada do item; sem rodada, quem lançou o pedido) e por fornecedor. Conta os pedidos do mês (não cancelados) gerados de cotação com histórico.
- **Travas (servidor)**: rodada gravada não se edita nem se apaga (quem grava o mapa sem ela ou com ela alterada não muda nada: o servidor recompõe e registra `COT_HIST_RECOMPOSTO` na auditoria). Preço ou frete que já têm histórico só mudam com rodada nova (senão o servidor recusa, 409). Rodada que sobe sem observação, correção sem observação e reabertura sem motivo: recusadas (400). Depois de gerar os pedidos o mapa fica **fechado**: nova negociação só com **Reabrir mapa para negociar** (motivo obrigatório, fica no histórico) e com os pedidos gerados **cancelados** antes. Cotação com rodada não se exclui (o botão Excluir passa a cancelar).
- **Mapas antigos**: o preço atual vira a proposta inicial, marcada "registro anterior à v149". A resposta do fornecedor pelo link que chega depois de já haver preço vira uma rodada com canal "link do fornecedor" (com observação automática); item que vem em branco mantém o preço anterior.
- **Permissões**: grava quem já grava Cotações (Comprador, Administrador…); o histórico, o pedido e a aprovação podem ser vistos por quem já vê essas telas. Economia é preço de compra: o Comprador vê em R$ (Cotações, Pedidos e Controles de compras estão nas telas dele). Perfis sem "Ver valores gerenciais" (fora do Comprador) veem "—" no lugar dos R$ pela máscara da v146 e continuam vendo o desconto em %.
- **Implantar**: suba juntos `gestao/negoc.js` (novo), `gestao/regras.js`, `gestao/Dockerfile` e `gestao/public/index.html` e reconstrua a imagem do serviço `gestao` (o Dockerfile mudou: inclui o `negoc.js`). Não há variável nova nem tabela nova. Nada a fazer nos dados: os mapas antigos ganham a proposta inicial na primeira gravação.

### PDF do pedido de compra e aceite eletrônico do fornecedor (v150)

**PDF e impressão (todos os documentos com tabela: pedido, SC, cotação, separação, boletim de medição…).** O documento é montado em páginas A4 de verdade antes de virar PDF ou ir para a impressora: a tabela quebra entre linhas e repete os títulos das colunas; da página 2 em diante aparece um cabeçalho curto ("Pedido de compra nº 1591 · Fornecedor"); rodapé "Página x de y · Pedido nº 1591". Totais, observações, assinaturas e "emitido por" formam um bloco que nunca se divide: se não couber, a última linha da tabela vai junto para a página seguinte. Se faltar pouco (até 12%), a escala diminui um pouco e tudo cabe em uma página. Relatórios de tela ("Imprimir esta tela") e o DANFE continuam como antes.

**Pedido de compra.** Colunas sem nenhum valor (Código, NCM, Desc. %, IPI %, ICMS-ST) não aparecem e a descrição ganha o espaço. Cabeçalho em três quadros (Datas · Fornecedor · Entrega e pagamento), com o projeto em cima. No fim: "Emitido por … em … · Aprovado por … em …" (a aprovação do pedido), o aceite do fornecedor quando houver, e o **código de verificação** (12 caracteres, ex.: X48X-4T86-XKP1) com o endereço para conferir: `APP_URL/verificar/<código>`. A página de verificação, sem login, mostra só nº, data, fornecedor, total e situação; se o pedido foi alterado depois, avisa que o código é de uma versão anterior.

**Aceite do fornecedor.** O e-mail do pedido (pelo servidor, com o PDF, ou o e-mail pronto) passa a levar um link `APP_URL/aceite/<token>` (também no botão "Link de aceite" do formulário do pedido, para mandar por WhatsApp). O fornecedor vê o pedido como no PDF (sem proposta inicial, rodadas de negociação ou dados internos) e responde "Aceito o pedido" ou "Não posso atender" (com motivo), digitando o nome. O pedido ganha a etiqueta "Aceito pelo fornecedor" (a situação aberto/enviado/recebido não muda), a resposta entra no histórico e quem fez o pedido recebe aviso no chat, na conversa "Central de Gestão". Pedido que precisa de aprovação só gera link depois de aprovado; pedido cancelado não gera.

Segurança e LGPD: o token é aleatório (192 bits), vale `ACEITE_LINK_DIAS` dias (padrão 30) e só pode ser usado uma vez; o banco guarda o hash e o token cifrado com a `CHAVE_MESTRA` (sem ela, o token fica em claro na tabela interna `ped_aceite`, que não vai para as telas). O IP de quem respondeu fica só nessa tabela e na auditoria (o pedido guarda nome, data e o código da versão aceita). Rotas públicas com limite por IP (60 verificações/h, 120 aberturas e 30 respostas/h; 30 tentativas erradas bloqueiam o IP por 1 hora) e até 10 respostas inválidas por link. O campo de aceite só é gravado pelo link (o servidor ignora o que vier da tela).

Para funcionar: `APP_URL` com o endereço público do sistema (é ele que vai no PDF e no e-mail); SMTP configurado para o envio pelo servidor (sem SMTP, o link vai no e-mail pronto); `CHAVE_MESTRA` recomendada. Arquivo novo `gestao/aceite.js` (no `Dockerfile`): reconstruir a imagem.

### Treinamentos dentro do sistema (v151)

**Para a equipe.** Em *Treinamentos do sistema* (atalho em Ajuda e tutoriais, em Minha área › Cursos do sistema e no card "Treinamento pendente" do painel do setor) cada pessoa vê os cursos liberados para o perfil dela e faz no próprio sistema, sem conta externa: trilha de capítulos, tela do sistema com o ponto a clicar destacado, legenda e dica, Anterior/Próximo (ou as setas do teclado), perguntas com explicação no fim de cada capítulo e tela de capítulo concluído. No celular a trilha vira uma faixa e um toque na imagem abre a tela ampliada. Ao concluir todos os capítulos aparece "Curso concluído" com o certificado (Visualizar / Imprimir / PDF pelo mesmo renderizador dos documentos do sistema). Curso 1: **Escola do Almoxarifado** (8 capítulos, 56 passos, 19 perguntas; telas com dados de exemplo).

**Para o Administrador (Sistema › Treinamentos).** Para cada curso: quais perfis fazem (padrão da Escola do Almoxarifado: Almoxarife e Comprador/almoxarife antigo; dá para incluir qualquer perfil, inclusive "Só ponto e Minha área"), desligar o curso e abrir para conferir. O Administrador e o dono veem todos os cursos. *Acompanhamento da equipe*: pessoa × curso com capítulos concluídos, acertos, última atividade e situação (não começou / em andamento / concluído), filtros e CSV. **Zerar** apaga o progresso de uma pessoa naquele curso (pede confirmação e fica na auditoria como `TREINO_ZERADO`). O RH vê o acompanhamento (sem zerar) na tela Treinamentos do sistema.

**Onde ficam os dados.** Progresso na coleção `treino`, um documento por pessoa e curso (`treino/<conta>/c/<curso>`): capítulos concluídos com acertos, data e tentativas, início, última atividade e data de conclusão. Regras no servidor (`gestao/treino.js`): cada pessoa grava só o próprio progresso e só de curso liberado ao perfil dela; o servidor refaz os totais e a data de conclusão (não confia no que vem da tela); ninguém grava nem exclui o progresso de outra pessoa (nem o dono); só Administrador, dono e quem grava RH leem o de todos. A coleção não entra no mapa de módulos nem nas funções dos perfis (é área própria, como a Minha área): liberar um curso para um perfil não dá a ele nenhum outro acesso. Perfis por curso ficam em `cfg/empresa › treino` e só o Administrador ou o dono mudam.

**Curso novo.** Crie a pasta `gestao/public/treino/<pasta>/` com `conteudo.json` (capítulos com `passos` — `img`, `w`, `h`, `titulo`, `texto`, `dica`, `destaque` {x, y, w, h em %} — e `quiz` — `pergunta`, `opcoes`, `certa`, `explica`) e as imagens em `<pasta>/img/`, e acrescente a entrada em `gestao/public/treino/catalogo.json` (`id`, `pasta`, `titulo`, `publico`, `resumo`, `perfisPadrao`). O player não tem nada de um curso específico. Os arquivos são servidos pelo próprio servidor só para quem entrou (cabem na CSP atual: `img-src 'self'` e `connect-src 'self'`). Na montagem, `deploy_build.py` copia `SP/treino/` para `public/treino/`.

Arquivo novo `gestao/treino.js` (no `Dockerfile`) e pasta `gestao/public/treino/` (3,9 MB): reconstruir a imagem do serviço `gestao`.

### Compras: quem aprova, Pedir aprovação, SC recusada e SC de reposição (v152)

**Quem precisa aprovar.** Nas Solicitações de compra "Aguardando aprovação" e nos Pedidos de compra acima da alçada ainda sem aprovação, a linha, o detalhe da SC e o formulário do pedido mostram "Aguardando aprovação de: Fulano (ou Beltrano) · há 3 h". O cálculo é o mesmo do servidor (`gestao/compras152.js`): na SC, o aprovador escolhido (diário de obra) ou os aprovadores de material (Financeiro › Aprovações › Material pedido nas obras e a vaga "Compras" da Matriz de aprovadores, com substitutos), depois os aprovadores das alçadas e, sem ninguém, o dono ou o Administrador; quem pediu nunca aparece. No pedido, o nível pelo total (N1 gestor da área, N2 diretor, N3 duas pessoas), os aprovadores do nível com os substitutos do período e, entre parênteses, os dos níveis acima; no N3 aparece quem já deu a primeira aprovação e que falta a segunda pessoa; quem lançou nunca aparece; sem aprovador cadastrado, dono ou Administrador.

**Pedir aprovação (lembrete).** Botão na linha e no detalhe, para quem criou/enviou, quem grava a tela e o Administrador. O servidor (`POST /api/aprov/lembrete`) manda ao(s) aprovador(es) responsável(is) uma mensagem na conversa "Central de Gestão" do chat e, com o SMTP configurado (seção 7.3), um e-mail com nº, obra, necessidade, valor do pedido (só para quem tem "Ver valores gerenciais" e lê pedidos) e o link direto (`APP_URL/#sc` ou `APP_URL/#aprov`). A janela também tem **Copiar mensagem para WhatsApp** (texto pronto com o link). Limite: **um lembrete por documento a cada 2 horas**, garantido pelo servidor (resposta 429 com o horário do próximo; variável `LEMBRETE_APROV_HORAS`, padrão 2). A linha mostra "Lembrete enviado às HH:MM por Fulano"; o Histórico do documento ganha a linha "Lembrete de aprovação" e a auditoria `APROV_LEMBRETE` (recusa: `APROV_LEMBRETE_NEGADO`). O campo `lembAprov` só muda por essa rota.

**SC recusada: Corrigir e reenviar.** Na linha e no detalhe da SC "Recusada" (para quem pediu, quem grava Solicitações e o Administrador): abre uma SC nova em rascunho com os mesmos dados e itens e o motivo da recusa no topo. Ao salvar, o servidor liga as duas (`origemId` na nova; `reenviadaId`/`reenviadaNum` na antiga, auditoria `SC_REENVIADA`); a antiga continua "Recusada" com a etiqueta "Reenviada como SC nº X". A nova segue o fluxo normal (Enviar → aprovação de material). Reenviar a mesma recusada duas vezes é recusado (409).

**Tipo da SC: Obra, Reposição de estoque, Administrativa.** No formulário da SC. *Obra* exige a obra. *Reposição de estoque*: sem obra, com o almoxarifado de destino; nada é separado do próprio estoque (tudo vai para compra) e, no recebimento do pedido gerado dela, os itens entram nesse almoxarifado. *Administrativa*: sem obra, com a categoria do plano de contas (a mesma lista das contas a pagar); a nota do recebimento já vem com essa categoria e marcada como custo comum (rateio); o que existir no estoque continua sendo separado. Relatórios e custos de obra já ignoram o que não tem obra. Lista com etiqueta "Reposição"/"Administrativa" e filtro por tipo. SC antiga (sem tipo) segue como antes. No **Estoque**, o botão **Gerar solicitação de reposição** abre a SC de reposição do almoxarifado escolhido com os itens abaixo do mínimo e a quantidade sugerida (mínimo − saldo, ou máximo − saldo quando o produto tiver máximo por almoxarifado).

**Almoxarife e Solicitações.** O perfil padrão Almoxarife passa a criar SC, alterar o próprio rascunho e enviar (função Solicitações em "Cria e altera": não exclui). Continua sem aprovar (a aprovação de material segue com os aprovadores), sem cotação e sem pedido, e nas SC dos outros só registra o andamento da separação, como antes. No `perfis.json` isso é `almoxarife.camposProprio.sc = ["rascunho"]` (regra nova do servidor: o próprio registro, nas situações listadas, fica livre dos `campos`) e `padFn.comp.sc = "a"`.

**Telas de compras no notebook e no celular.** Pedidos de compra, Solicitações, Cotações, Separação de itens e Notas de entrada: os botões da linha quebram dentro da própria célula (sem largura mínima fixa), Pedidos junta Data, Previsão e Necessidade numa coluna "Datas" e, abaixo de 900 px, cada linha vira um cartão com as ações embaixo. O cabeçalho do sistema também deixou de alargar a página no celular.

Arquivo novo `gestao/compras152.js` (no `Dockerfile`); alterados `gestao/regras.js`, `gestao/permfn.js`, `gestao/perfis.json` e `gestao/public/index.html`: reconstruir a imagem do serviço `gestao`.

## Almoxarifados por cidade, quadro de compras e perfil Almoxarife e fábrica (v153)

**Quadro do processo de compra** (Suprimentos › Painel): colunas na ordem do fluxo — SC aguardando aprovação · SC aguardando
cotação · Em cotação · Pedido aguardando aprovação · Pedido enviado (com "aceito pelo fornecedor" e "entrega atrasada") ·
Recebido aguardando nota · Concluído (nota lançada nos últimos 7/15/30/60 dias). Cada cartão mostra número, obra ou tipo
(Reposição/Administrativa), fornecedor, necessidade, há quanto tempo está na etapa e quem precisa agir. Borda amarela: perto
da necessidade (até 3 dias) ou parado (SC/pedido a aprovar 2 dias, cotação 3, recebido sem nota 3); vermelha: necessidade
vencida, entrega atrasada ou parado (4/5/7 dias). Clique abre o documento na tela dele. Filtros: obra, comprador ou
solicitante, tipo, almoxarifado ou cidade. Valores em R$ só para quem vê valores gerenciais. No celular as colunas viram
seções empilhadas. **Os cartões não se arrastam**: o andamento vem das ações reais (aprovar, cotar, gerar pedido, receber,
lançar a nota), que têm regras e permissões próprias.

**Almoxarifados** (Suprimentos › Almoxarifados): além do endereço, **responsável** e **substituto** (usuários) e
**"principal da cidade"** (um por cidade: marcar outro desmarca o anterior). **Vários almoxarifados podem ficar no mesmo
endereço** (ex.: materiais, ferramentas/EPI e fábrica no mesmo terreno): o cadastro avisa "Já existe o almoxarifado X neste
endereço. Cadastrar outro no mesmo endereço?" e grava ao confirmar. Nome repetido continua bloqueado.

**Obra** (cadastro do projeto): "Almoxarifado que atende a obra". Automático: o principal da cidade da obra; sem ele, o
mais usado pelas separações da obra; com um único almoxarifado ativo, ele.

**Solicitação de compra**: a de obra (e a administrativa) guarda o **almoxarifado de origem** da separação (padrão: o que
atende a obra; quem cria e quem aprova podem trocar). A separação gerada nasce nesse almoxarifado e a entrega dá baixa nele.
A separação (tela e Visualizar/PDF) mostra, para cada item, almoxarifado, **prateleira/local** e **saldo no local**, em
ordem de prateleira. Faltando no almoxarifado de origem e havendo em outro, mostra a sugestão e o botão **Gerar
transferência** (romaneio de transferência entre almoxarifados, já preenchido).

**Avisos por almoxarifado**: separar material (chat e e-mail), falta do recebimento físico, transferência em trânsito,
romaneio para despachar e devolução de sobras para conferir vão ao **responsável e ao substituto** daquele almoxarifado.
Almoxarifado sem responsável: para todos os almoxarifes, como antes. Na primeira subida da v153, as pendências que já existem
não geram e-mail (só as novas). Separação, Romaneios, Devolução de sobras e Recebimento de notas › O que precisa de ação
abrem em **"Meu almoxarifado"** para quem é responsável ou substituto (documentos sem almoxarifado aparecem também); o filtro
"Todos" ou outro almoxarifado mostra o resto em consulta (as permissões não mudam).

**Perfis**: o **Almoxarife** não vê mais **Controles de compras** (menu, Ctrl+K, atalhos e o quadro de exceções do painel;
os dados de pedidos, notas, cotações, acordos e ajustes continuam porque outras telas dele usam) e cria solicitação de
compra **só de reposição e administrativa** (servidor confere). Perfil padrão novo **"Almoxarife e fábrica"** (Sistema ›
Usuários): tudo do Almoxarife + SC de qualquer tipo (inclusive Obra) + módulo Fábrica (cria, altera e avança etapas das
ordens de fabricação; **não exclui** OS; aprovação da OS e configurações continuam com o gestor). Sem Controles de compras e
sem valores gerenciais. Recebe os avisos de almoxarife.

Arquivo novo do servidor: `gestao/almox153.js` (já no Dockerfile). `perfis.json` regerado (Almoxarife: `telasFora` com
`supctl` e `scTipos`; perfil novo `almoxfab`).

## Chat: não lida que voltava e almoxarifados no mesmo endereço (v153.1)

**Causa.** O estado do chat de cada pessoa (`cm/<uid>`: o que já leu, sinal de online, áudios ouvidos, status vistos) era
gravado inteiro a cada mudança, inclusive no sinal de online a cada 60 s. Uma aba, computador ou celular aberto há tempo,
que perdeu o tempo real (rede, notebook que dormiu, celular em segundo plano), gravava o "lido" antigo por cima do novo e
a mensagem voltava a contar como não lida nos outros aparelhos. Além disso, cada abertura do sistema reiniciava o início da
contagem (`desde`) e escondia o que chegou com o sistema fechado.

**Correção.** `server.js` (função `chEstadoMescla`): ao gravar `cm/<uid>` (PUT ou PATCH), por conversa vale a leitura mais
recente; `ouv`/`sv` pelo mais recente (poda de 30 e 3 dias), `on` pelo maior e `desde` pelo mais antigo; os demais campos
(silenciar, ocultar) seguem o que chegou. Nenhuma gravação faz o "lido" voltar, nem a de uma aba com a versão anterior do
sistema. O navegador passa a gravar só o campo alterado e relê o estado depois. Clicar no balão do chat abre direto a
conversa com mensagem nova; "Marcar todas como lidas" no topo da lista; no celular, a conversa só conta como lida quando é
aberta. Depois de atualizar, mensagens que chegaram com o sistema fechado desde a última abertura podem aparecer como não
lidas uma vez (antes ficavam escondidas): "Marcar todas como lidas" resolve.

**Almoxarifados no mesmo endereço ou CEP** (cadastro e edição): o aviso "Já existe o almoxarifado X neste endereço.
Cadastrar outro no mesmo endereço?" aparece junto do rodapé, o botão vira **Salvar mesmo assim** (um clique grava) e
**Voltar** desfaz. Antes o aviso ia para o topo do formulário, fora da vista.

Alterados `gestao/server.js` e `gestao/public/index.html`: reconstruir a imagem do serviço `gestao`. Quem estiver com o
sistema aberto deve recarregar a página (F5) em cada computador e no celular.

## Busca do Estoque, família, entrega e higienização de EPI e renovação pela Matriz de treinamentos (v154)

**Busca mais rápida**: no Estoque (e em Produtos, Produtos inativos, Notas, Pedidos de compra e NFs recebidas) a lista é
refeita ~300 ms depois da última tecla; **Enter** busca na hora; o campo não perde o foco nem o cursor. O Estoque procura
num índice já preparado (sem acento e sem maiúsculas: código, descrição, família, NCM, prateleira, almoxarifado onde há
saldo, EAN, marca e o código do produto no fornecedor, tirado das notas de entrada), refeito só quando os dados mudam, e
mostra os **100 primeiros** com o total encontrado e **Mostrar mais**. A busca aceita várias palavras em qualquer ordem
("cabo 2,5 flex"). Medido com 5.000 produtos e 20.000 movimentos (navegador real): antes ~0,5 s travado a cada tecla
(11 teclas ≈ 5–6 s); agora digitar fica livre e o resultado aparece ~0,5 s depois da última tecla.

**Família**: coluna **Família** e filtro por família (com "sem família") no Estoque. É o campo **Família de produto** do
cadastro (não há outro conceito de grupo/categoria de produto; "categoria" é do financeiro).

**EPI pelo cadastro de produtos**: EPI é o produto da **família EPI** (o nome é configurável em Configurações › EPI; também
valem "EPI", "Equipamento de Proteção Individual" e a marca antiga "é EPI"). O cadastro do produto dessa família tem **Nº do
CA, validade do CA, tamanho/variação e vida útil**. Em **CIPA e SST › Controle de EPI › Nova entrega** (e Colaboradores ›
Nova entrega de EPI) escolhe-se o almoxarifado de onde sai (abre em **Meu almoxarifado**) e o **produto com saldo nesse
almoxarifado** (a lista mostra tamanho, CA, validade e saldo; CA vencido aparece marcado e é recusado). Ao salvar, o
servidor confere permissão (Almoxarife, RH, SST continuam registrando), produto da família EPI e **saldo no almoxarifado
(não deixa negativo)**, e grava **a entrega e a saída do estoque juntas** (rota `POST /api/epi/entrega`, arquivo
`gestao/epi154.js`): ou as duas, ou nenhuma. A saída vai para a **obra do colaborador** (custo médio na obra). Depois de
gravada, produto, quantidade e almoxarifado da entrega não mudam (use Devolução). A ficha NR-6, a assinatura (na tela ou
pela Minha área) e a troca prevista continuam iguais.

**Devolução e troca**: botão **Devolução ou troca** na entrega. Condição **"Em condição de uso"** → vai para a
**higienização** (não volta direto ao estoque); **"Descarte"** (danificado, vencido, contaminado, outro) → baixa definitiva,
registrada na ficha. Motivo: desgaste, dano, tamanho, vencimento do CA, desligamento, fim da obra, outro. **Troca** = a
devolução e a nova entrega (com a baixa dela) no mesmo ato e na mesma gravação. A ficha NR-6 mostra o destino de cada
devolução.

**Higienização de EPI** (tela nova em CIPA e SST e em Suprimentos; cartão no Painel de Suprimentos do almoxarifado de
higienização): **Aguardando envio** (no almoxarifado onde foi devolvido) → **Enviar selecionados** cria o romaneio de
transferência para o **almoxarifado de higienização** (Configurações › EPI; padrão: o principal de Tuiuti) → **Em
trânsito** → **Confirmar chegada** (ou o recebimento do romaneio) → **Em higienização** → **Marcar higienizados** (entrada
no estoque daquele almoxarifado, marcada "EPI higienizado (usado)" no histórico do produto) ou **Reprovar** (descarte, com
motivo). Receber, higienizar e reprovar: responsável ou substituto desse almoxarifado (sem responsável: quem grava estoque),
o Administrador ou o dono. Indicadores (itens em higienização, tempo médio, % reaproveitado, descartes do mês), filtros,
ações em lote, CSV e PDF. Avisos: chat e e-mail ao responsável do almoxarifado de higienização. O servidor garante que o
EPI devolvido **só volta ao estoque pelo "Higienizado"** (a gravação comum recusa movimento ligado a EPI e qualquer mudança
na higienização) e que nada conta duas vezes; tudo fica na auditoria (`EPI_ENTREGA`, `EPI_DEVOLUCAO`, `EPI_HIG_*`).
Decisão: o estoque não tem lote/condição por unidade; o item higienizado entra no mesmo produto, marcado só no movimento.

**Unificação do estoque de EPI (uma vez)**: o "estoque de EPI" das versões anteriores já era o saldo do produto marcado
como EPI — não havia estoque separado. O botão **Unificar o estoque de EPI** (Controle de EPI ou Configurações › EPI,
Administrador/dono) mostra antes o que muda: produtos marcados como EPI sem família passam para a família EPI; EPI digitados
nas entregas antigas sem produto viram produtos da família EPI (saldo zero; um por nome, sem duplicar). Os saldos não mudam.
O relatório fica guardado (rota `POST /api/epi/migrar`; uma segunda vez só mostra o relatório).

**Matriz de treinamentos**: em Pendências, cada NR vencida, a vencer ou que falta tem **Lançar renovação**: abre Documentos
e ASO com o colaborador e a NR preenchidos, emissão hoje e a validade sugerida pela reciclagem da matriz das NRs ("a cada 2
anos" → 2 anos; sem prazo: em branco), e o anexo do certificado (Documentos e ASO passa a ter anexo). Em lote: marcar várias
pessoas com a mesma NR e **Lançar renovação para os selecionados** (mesma emissão/validade, anexo comum e anexo por pessoa).
Só aparece para quem grava Documentos e ASO (o Técnico de SST, só certificados de NR). A matriz se atualiza ao salvar.

**Subir**: `gestao/epi154.js` (novo), `gestao/regras.js`, `gestao/Dockerfile`, `gestao/perfis.json` e
`gestao/public/index.html`; reconstruir a imagem do serviço `gestao`.

## Quem faz o quê no Estoque: estorno, motivo, campos fiscais e exclusão de produto (v155)

Regras aprovadas pelo dono. O servidor confere tudo (`gestao/est155.js`, ligado em `regras.js`); a tela mostra só os botões
de quem pode e o quadro **Quem faz o quê no Estoque** (Estoque e Cadastros › Produtos), com o que o perfil da pessoa pode fazer.

| Ação | Quem | Como |
|---|---|---|
| Entrada | Fiscal e Almoxarife pelos fluxos (nota, recebimento, romaneio, devolução de obra, higienização de EPI) | **Entrada manual** só com **motivo**: doação, devolução de obra sem romaneio, sobra de inventário ou outro (descrito) |
| Saída | Almoxarife e Fiscal | Separação, romaneio, EPI, fábrica/OS ou **baixa manual com motivo**: perda, consumo interno, descarte ou outro (descrito) |
| Transferência entre almoxarifados | Almoxarife (e Fiscal/Administrador) | Só por romaneio (o servidor recusa transferência solta) |
| Ajuste de inventário | Almoxarife propõe | Botão **Ajuste** = proposta: até o limite por item (Controles de compras › Regras, padrão R$ 300) entra na hora; acima, outra pessoa aprova em Estoque › Ajustes de inventário. Ajuste solto é recusado |
| Editar produto | Almoxarife: almoxarifado/prateleira, mínimo, família, lote, EPI (CA, validade, tamanho, vida útil), observações internas, imagem, anexos. Fiscal (e Administrador): tudo | O servidor recusa do Almoxarife (e do antigo Comprador/almoxarife) mudança de preço, custo padrão, NCM (completar NCM vazio pode), recomendações fiscais, unidade tributável e preço das variações; o valor guardado continua |
| Excluir movimentação | **Ninguém** (nem Administrador nem dono) | **Estornar** (Histórico do produto): movimento contrário ligado ao original, motivo obrigatório, quem e quando; original marcado "estornado"; estorno não se estorna; a data do estorno respeita a competência fechada |
| Excluir produto | Só Administrador | E só sem histórico (nenhum movimento, nota, pedido, SC, separação, romaneio, EPI, cotação, inventário, kit...). Com histórico: **Inativar** (quem grava o Estoque) |

Detalhes:
- **Estorno**: mesmo tipo, produto e almoxarifado, quantidade com o sinal trocado. Entrada estornada sai pelo mesmo custo (o custo
  médio volta); saída estornada volta pelo custo em que saiu (e sai do custo da obra). Não deixa saldo negativo (estorne antes a
  saída do material). Movimento de **nota fiscal** só se estorna com a nota cancelada (o **cancelamento da nota** estorna o
  estoque sozinho); movimento de **EPI**, pela devolução. O estorno vai na data de hoje; a marca no original não mexe na
  competência fechada dele.
- Fluxos que antes **apagavam** movimentos agora estornam: cancelar nota, excluir a nota em rascunho do recebimento (desfaz a
  entrada provisória) e aprovação de ajuste recusada pelo servidor. A troca da entrada provisória pela definitiva dentro do
  lançamento da nota (`/api/nota/lancar`) continua como era (o servidor confere que é a provisória daquele pedido).
- **Dados de exemplo** (`ex:true`) continuam removíveis pela limpeza de exemplos. Movimentos antigos sem motivo continuam
  válidos. O **dono** (conta principal) pode gravar saldo de implantação pela API sem motivo; na tela o motivo é sempre pedido.
- **Produto novo** só nasce em Cadastros › Produtos ou na entrada da nota fiscal: Controle de EPI › "Cadastrar em Cadastros ›
  Produtos" abre o Novo produto já na família EPI; no pedido de compra o botão leva a Cadastros › Produtos (item sem produto,
  só com a descrição, continua como antes). A unificação do estoque de EPI (v154, uma vez) continua.
- Auditoria: `ESTOQUE_ESTORNO`, `ESTOQUE_ENTRADA_MANUAL`, `ESTOQUE_BAIXA_MANUAL`, `MOV_EXCLUSAO_RECUSADA`, `PRODUTO_EXCLUIDO`,
  `PRODUTO_EXCLUSAO_RECUSADA`, `PRODUTO_FISCAL_RECUSADO`, além do registro de cada gravação.
- Implantar: subir `gestao/est155.js` (novo), `gestao/regras.js`, `gestao/Dockerfile`, `gestao/perfis.json` e
  `gestao/public/index.html` e reconstruir a imagem do serviço `gestao`.

## Famílias de produto e quem cadastra produto (v156)

**Cadastros › Famílias de produto** (coleção nova `prodfam`, gravada por quem grava o Estoque, menos o Almoxarife; servidor em
`gestao/fam156.js`, ligado em `regras.js`, `epi154.js` e no `Dockerfile`).

- Cada família tem nome, descrição, ativa/inativa e a marca **"É EPI"**. A lista mostra quantos produtos (ativos e inativos)
  cada família tem, com busca e filtro de situação. O produto continua guardando o **nome** da família (`familia`); a ligação
  com o cadastro é pelo nome sem acento/maiúsculas/espaços repetidos, que é único no cadastro.
- **Renomear** (`POST /api/prodfam/renomear`): muda o nome da família e de todos os produtos dela numa transação só.
  A gravação comum não muda o nome.
- **Juntar famílias** (`POST /api/prodfam/juntar`): leva os produtos das famílias marcadas para a que fica, numa transação
  só; as juntadas ficam inativas com a marca "juntada em …" e não se reativam. O nome antigo continua apontando para a que ficou.
- **Criar a partir dos produtos** (`POST /api/prodfam/migrar`): prévia com os nomes já digitados nos produtos; cada linha
  junta só variações do **mesmo nome** (maiúsculas, acento, espaços). Nomes diferentes (ex.: "EPI" e "EPIs") não são juntados
  aqui: a prévia avisa e eles são juntados depois em Juntar famílias. "É EPI" vem marcado onde a regra antiga considerava EPI.
- **Excluir**: só família sem produtos. Auditoria: `PRODFAM_CRIADA`, `PRODFAM_EPI`, `PRODFAM_INATIVADA/REATIVADA`,
  `PRODFAM_RENOMEADA`, `PRODFAM_JUNTADAS`, `PRODFAM_MIGRACAO`, `PRODFAM_EXCLUIDA`, `PRODFAM_RECUSADA`.

**Cadastro do produto**: a família é escolhida de uma lista com busca (sem texto livre). Quem cria família tem
"+ Nova família" ali mesmo, com aviso de nome parecido (sem acento/maiúsculas, plural, 1–2 letras de diferença). Produto
com família fora do cadastro (ou inativa) mostra aviso e continua com ela até alguém escolher outra.

**Quem cadastra**

| Ação | Quem |
|---|---|
| Cadastrar produto | Fiscal, Administrador/dono. Comprador: na tela não cadastra (não grava o Estoque); o servidor continua aceitando produto novo dele, como antes |
| Criar, renomear, juntar, marcar "É EPI" e excluir família | Fiscal, Administrador/dono |
| Almoxarife, Almoxarife e fábrica e o antigo "Comprador / almoxarife" | **não** cadastram produto (nem direto como inativo) nem família: sem Novo produto, Duplicar, "+ Nova família", "Criar produto ao lançar" e "Cadastrar EPI". Continuam editando prateleira, mínimo, lote, dados de EPI, observações e imagem, inativando/reativando, e **escolhem a família entre as cadastradas e ativas** (o servidor recusa família fora do cadastro: `PRODUTO_FAMILIA_RECUSADA`; produto novo: `PRODUTO_CRIACAO_RECUSADA`) |

Item de nota importado do XML sem produto, no rascunho do recebimento, aparece como "Produto sem cadastro (o Fiscal cria ao
lançar)": o produto nasce quando o Fiscal lança a nota.

**EPI**: a entrega de EPI, o Estoque de EPI e a lista do RH/SST (`GET /api/epi/estoque`) usam a marca "É EPI" da família.
Texto de família que ainda não está no cadastro segue a regra antiga (nome de Configurações › EPI, "EPI"/"EPIs",
"Equipamento de Proteção Individual") até as famílias serem criadas. Configurações › EPI passa a mostrar as famílias marcadas.

**Depois de implantar**: o Fiscal ou o Administrador abre Cadastros › Famílias de produto › **Criar a partir dos produtos**,
confere a prévia (nomes e "É EPI") e confirma; depois junta as repetidas (ex.: "EPIs" em "EPI").

## Ajustes do Almoxarife, aceite com aprovação, aviso da Sólides e bibliotecas locais (v157)

Servidor em `gestao/ajuste157.js` (novo), ligado por `v157/ed_v157.py` em `regras.js`, `aceite.js`, `solides.js`,
`endurece.js` e no `Dockerfile`.

**Solicitação de compra em rascunho.** O Almoxarife, o Almoxarife e fábrica e o antigo "Comprador / almoxarife" não excluem
solicitação em rascunho: na lista, no lugar de **Excluir** aparece **Cancelar** (a solicitação fica guardada como cancelada).
O servidor recusa a exclusão (`SC_EXCLUSAO_RECUSADA` na auditoria). Administrador, Comprador e os outros perfis continuam
como antes.

**Família do produto.** Esses mesmos perfis não mudam a família de um produto, por nenhum caminho: no cadastro do produto o
campo fica só para consulta; "Colocar produto na família EPI" e "Não é EPI" não aparecem para eles; e o servidor recusa
qualquer gravação de produto (ativo ou inativo, editar, inativar, reativar, importar) que troque a família
(`PRODUTO_FAMILIA_RECUSADA`). A família fica exatamente como estava. Famílias de produto (criar, renomear, juntar, "É EPI",
excluir) eles já não gravavam desde a v156. **Continua**: escolher uma família nos filtros e buscas (Estoque, Cadastros ›
Produtos, separação, Estoque de EPI, relatórios) e editar prateleira, mínimo, lote, dados de EPI e observações.

**Aceite do fornecedor (v150) só com o pedido aprovado.** O servidor confere a aprovação dentro da alçada (a mesma regra da
tela: pedido acima do limite de Controles de compras precisa de aprovação válida para o total atual) antes de: gerar o link
(`PED_ACEITE_LINK_SEM_APROVACAO` na auditoria), mostrar o pedido na página `/aceite/…` e registrar o aceite. Se o pedido
ainda não estiver aprovado, o fornecedor vê: "Este pedido ainda está em aprovação na empresa e não pode ser aceito agora.
Quando for aprovado, este mesmo link passa a funcionar."

**Aviso da Sólides no registro do servidor.** O aviso da sincronização automática (endereço não encontrado/404, falta de
configuração ou outro erro) aparece uma vez e depois, para o mesmo tipo de aviso, no máximo uma vez a cada 6 horas, dizendo
quantas vezes se repetiu nesse meio-tempo. Uma sincronização que dá certo zera a contagem. A situação na tela (Integrações ›
Sólides) continua mostrando o último erro de cada sincronização.

**Bibliotecas do navegador.** html2canvas 1.4.1 e pdf-lib 1.17.1 foram copiados para `gestao/public/vendor` (pacotes npm
das mesmas versões usadas). jsPDF 2.5.1 e SheetJS 0.18.5 ainda não puderam ser baixados: veja "Bibliotecas do navegador".

## Perfis Recursos humanos e compras e Administrador de frota (v158)

Dois perfis padrão novos, em **Sistema › Usuários** (escolha do perfil da pessoa) e em **Sistema › Perfis de acesso** (o
Administrador pode ajustar o acesso por função, como nos outros perfis padrão). Os perfis que já existiam, inclusive o
**Recursos humanos**, não mudaram. Servidor em `gestao/ajuste158.js` (novo), ligado por `v158/ed_v158.py` em `regras.js`,
`compras152.js`, `almox153.js` e no `Dockerfile`; o resto está no `perfis.json` (regerado).

**Recursos humanos e compras** (`rhcompras`). Tudo o que o perfil Recursos humanos faz (é montado a partir dele no fim da
carga do sistema; o que mudar no RH vale também aqui) e, em **Suprimentos › Solicitações**:
- cria solicitação de compra dos tipos **RH** (EPI, uniforme, material de treinamento, exames) e **Administrativa**, como o
  Almoxarife; a aprovação segue a alçada normal (aprovadores de material);
- vê e acompanha **só as próprias** solicitações: situação, quem precisa aprovar, **Pedir aprovação** e, se recusada,
  **Corrigir e reenviar**; não exclui (usa **Cancelar** no rascunho);
- **não vê** cotações, pedidos de compra, acordos de preço, preços negociados (o produto chega sem preço e custo),
  Controles de compras nem o Painel de Suprimentos. O servidor não entrega esses dados e recusa a gravação;
- entra no **Painel de Pessoal**.

**Administrador de frota** (`frotaadm`):
- Frota inteira com gravação (veículos, saídas, rota diária, abastecimentos, manutenção, entregas com frete e multas), de
  todos os locais, com os valores da frota (custo por veículo, Análise da frota, combustível no Painel da Frota);
- **não exclui** nenhum registro da frota (só o Administrador): `FROTA_EXCLUSAO_RECUSADA` na auditoria;
- **correção** de abastecimento e de manutenção concluída pede o **motivo** (sem ele o servidor recusa:
  `FROTA_CORRECAO_SEM_MOTIVO`); o servidor guarda quem, quando, o motivo e o que mudou (de → para) no **histórico de
  correções** do registro, que aparece no formulário (`FROTA_CORRECAO`). Concluir uma manutenção agendada não é correção.
  O lançamento em contas a pagar desses registros fica com o Financeiro;
- **Frota › Condutores**: colaboradores só para escolher o condutor (nome, função, CNH: número, categoria e validade) com o
  **CPF mascarado** (`***.456.789-**`). O servidor entrega a este perfil só esses campos: nada de salário, documentos do RH,
  ASO, endereço, contato ou folha;
- **Cadastros** (clientes, fornecedores, transportadoras, produtos) e **Estoque** (saldo e local das peças) só para
  consulta, sem custo e sem entradas, saídas, ajustes, inventário ou romaneios;
- cria solicitação de compra dos tipos **Frota** (peças, pneus, serviço de oficina; pode ligar ao veículo) e
  **Administrativa**, com o mesmo acompanhamento (só as próprias);
- não vê financeiro, fluxo de caixa, DRE, obras e o resultado delas (a obra chega sem valores), folha, cotações, pedidos,
  SST, jurídico nem LGPD. Chat, agenda, Minha área e Ajuda continuam;
- entra no **Painel da Frota**.

**Tipos de solicitação de compra.** Entram os tipos **RH** e **Frota** (sem obra; categoria do plano de contas opcional;
a da frota pode ter o veículo). Os outros perfis podem usar os tipos novos como antes usavam os demais.

**Atenção.** Um perfil personalizado criado com **Duplicar** a partir de um destes segue a configuração dele (as regras de
"só as próprias solicitações", da correção com motivo e dos colaboradores mascarados são do perfil padrão).

**SheetJS (leitura de planilhas).** A reserva pela internet passou a ser a versão **0.20.3**, do site oficial
(`https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`), no lugar da 0.18.5 da cdnjs (falhas CVE-2023-30533 e
CVE-2024-22363). A cópia local `gestao/public/vendor/xlsx/xlsx.full.min.js` continua sendo a primeira escolha (o
`baixar-bibliotecas.sh` já baixa a 0.20.3). Enquanto a cópia local faltar, a política de conteúdo libera também
`cdn.sheetjs.com`; não há hash da 0.18.5 em lugar nenhum.

## Sistema mais rápido ao trocar de tela, salvar e abrir (v159)

Só desempenho: o que cada tela mostra, as permissões e as regras de gravação **não mudaram**. Diagnóstico em
`relatorios/lentidao_diagnostico.md`; medidas de antes e depois em `relatorios/feito_v159.md`.

**No navegador** (página `public/index.html`):
- as telas não são mais "embrulhadas" de novo a cada redesenho (as camadas da v132 e da v148 se desfaziam uma à outra e se
  acumulavam ao longo do dia; agora a troca de tela e a gravação não ficam mais lentas com o tempo de uso);
- não redesenha quando nada mudou: as leituras periódicas iguais, e o retorno do servidor depois de salvar, não refazem a
  tela. Salvar faz **um** redesenho;
- quando outra pessoa grava uma coleção que a tela aberta não usa, a tela não é redesenhada; mudanças seguidas que chegam
  do servidor viram um redesenho só;
- ponto lido por pessoa e por dia (índice): Painel, Painel da diretoria, espelho de ponto e Mão de obra por obra calculam
  muito mais rápido, com o mesmo resultado;
- a tela Mapa de cotação não fica mais em branco com uma cotação sem a tabela de preços.

**No servidor** (`gestao/comprime159.js`, novo, ligado por `v159/ed_v159.py` no `server.js`, `shim.js`, `solides.js` e no
`Dockerfile`):
- a página e os outros arquivos de texto saem comprimidos (brotli ou gzip, conforme o navegador): a página passa de 4,8 MB
  para cerca de 1,2 MB. A compressão é feita uma vez por versão do arquivo, em memória, na subida do serviço;
- a página tem **ETag** e `cache-control: no-cache`: o navegador guarda a página e, a cada abertura, só pergunta se mudou
  (resposta **304**, sem baixar de novo). Depois de atualizar o `index.html`, todos recebem a versão nova na próxima abertura,
  como antes. A CSP continua a mesma;
- respostas JSON acima de 1 KB (as listas que o navegador baixa) saem em gzip;
- o `shim.js` avisa o sistema de quais documentos mudaram em cada atualização ao vivo, e o sistema aplica só esses;
- a sincronização da **Sólides** só regrava o mês (`pmmes`) de quem teve marcação nova, alterada ou cancelada. Antes regravava
  todo mês tocado a cada 15 minutos, e todos os navegadores refaziam o ponto. Os totais do mês da Sólides continuam sendo
  atualizados quando mudam (a hora da consulta deles sozinha não regrava).

Nada a configurar. Se houver um proxy na frente que já comprima, não há conflito: o serviço responde já comprimido e o proxy
repassa.

## Listas em páginas e sincronização só do que mudou (v160)

Permissões e regras de gravação **não mudaram**. Detalhes e medidas de antes e depois em `relatorios/feito_v160.md`.

**No navegador** (página `public/index.html`):
- Solicitações de compra, Pedidos de compra, Notas fiscais, Abastecimentos, Saídas e Manutenção de veículos e o histórico de
  Envio e retorno de equipamentos mostram **50 registros por página**, com o total, o seletor de página e os botões
  Anterior/Próxima. A busca e os filtros procuram em todos os registros (e voltam à página 1); indicadores e totais usam
  todos os registros filtrados. Lista que cabe em uma página fica como antes, sem a barra;
- Obras aparecem da mais nova para a mais antiga (P490, P488...) em todas as caixas de escolha de obra;
- Responsável pela obra (e os outros seletores de usuário): nome da pessoa, ou o e-mail, nunca o código interno; a lista
  mostra só Administrador, Diretoria, Gestor de projetos, Encarregado e perfis personalizados que gravam em Projetos (o
  responsável atual continua na lista);
- EAP, materiais da etapa: "Digite para buscar no estoque" procura em todos os produtos (código, descrição e família), com
  filtro de família ao lado. Material que não está no estoque pode ser digitado: fica marcado "não cadastrado";
- Comercial › Contratos com clientes: filtro por projeto/obra (caixa com busca, da obra mais nova para a mais antiga, e
  "Sem projeto"), que vale junto com a busca e a situação;
- Cadastro de produto da família EPI: "Com variações" não aparece; no lugar, a orientação "Para EPI, cadastre um produto
  por tamanho" e o botão **Criar tamanhos** (P, M, G, GG ou 38–44): um produto por tamanho, com o nome + " · Tam. X", a mesma
  família, CA, validade do CA, vida útil, NCM e unidade, e o código com o tamanho no fim; tamanho que já existe é pulado.
  EPI já cadastrado "Com variações" mostra um aviso com o botão que transforma cada variação em produto (o original fica;
  nada é convertido sozinho). O Almoxarife vê a orientação, mas não cria produtos nem muda a família (v157).

**No servidor** (`gestao/sinc160.js`, novo, ligado por `v160/ed_v160.py` no `server.js`, `shim.js` e no `Dockerfile`):
- cada gravação no banco ganha um número de revisão e cada exclusão deixa uma marca (guardada 45 dias). Na primeira subida o
  servidor acrescenta a coluna `rev`, um índice e três gatilhos na tabela `docs` (leva poucos segundos; nada é apagado);
- o navegador guarda a revisão de cada coleção e, ao abrir de novo, ao reconectar e nas atualizações automáticas, pede só o
  que mudou. Quando não dá (servidor reiniciado, permissão da pessoa mudou, marca antiga já apagada), recebe tudo, como antes.
  Página antiga (aberta antes da atualização) continua funcionando: recebe a lista inteira;
- cópia local no navegador (IndexedDB) só das listas de compras, estoque, obras e frota, **cifrada** com uma chave que o
  servidor só entrega a quem entrou com a conta, apagada ao clicar em Sair, depois de 14 dias sem uso e quando outra conta
  entra no mesmo navegador. Não ficam guardados: colaboradores, RH, folha, ponto, saúde, financeiro, parceiros (dados
  bancários), usuários e chat. Nada da cópia aparece na tela antes de o servidor confirmar.

**O que fazer:** subir `gestao/sinc160.js` (novo), `server.js`, `shim.js`, `Dockerfile`, `perfis.json`, `public/index.html` e
`public/shim.js` e **reconstruir** a imagem do serviço `gestao`. Nada a configurar. Faça uma cópia de segurança antes (a
primeira subida altera a tabela `docs`).

## Duplicar etapas da EAP, modelos de etapa e contratos sob demanda (v161)

Detalhes em `relatorios/feito_v161.md`. As regras de quem grava o quê **não mudaram**: as duas coleções novas ficam no
módulo de Contratos (quem grava a EAP e os contratos grava também os modelos e as ordens de serviço).

**No navegador** (página `public/index.html`):
- EAP e cronograma: em cada etapa, **Duplicar** copia a etapa com materiais, mão de obra, ferramentas e subitens (o %
  executado volta a 0) e abre a cópia no formulário para trocar o nome (ou o local) e as datas; os subitens andam junto com
  a data de início. Nada é gravado até salvar. As dependências entre as linhas copiadas passam a ligar as cópias;
- marque várias etapas (caixas ao lado de Editar) e use **Duplicar selecionadas para outro local**: informe o texto a trocar
  nos nomes (por exemplo "Aeroporto" por "Guarulhos") e quantos dias deslocar as datas. Cada cópia fica abaixo da original;
- **Modelo** (na linha) guarda a etapa com as linhas e os subitens; **Inserir de modelo** (no topo) põe o modelo no fim da
  EAP de qualquer obra, abrindo no formulário. Os valores são os gravados no modelo; "Atualizar valores" traz os de hoje;
- com a linha de base congelada, a etapa duplicada, as duplicadas para outro local e a inserida de modelo pedem o motivo da
  revisão, como uma etapa nova digitada;
- Contratos: novo tipo **Sob demanda (valor teto)**, com valor teto, vigência e a opção "Permitir acréscimo de até 25% sobre
  o teto" (limite de 125%). A planilha vira tabela de preços (quantidade opcional ou estimada) e o valor do contrato é o teto
  (mais os aditivos assinados, como sempre);
- medição de contrato sob demanda pode passar da quantidade do item; o limite é o total medido. Avisa em 80% e 100% do teto,
  mostra "usando acréscimo" e a margem restante acima de 100% (com a opção ligada) e não deixa passar do limite;
- Comercial › **Ordens de serviço (sob demanda)**: cada chamado vira uma OS (número, data, local, descrição e itens da
  tabela de preços), aberta, executada ou medida, com custo e margem quando o custo é informado; 50 por página. A medição
  mostra as OS executadas do período: marcar uma OS soma os itens dela na medição; ao salvar, a OS fica "medida" (volta a
  "executada" se a medição for excluída);
- detalhe do contrato sob demanda: teto, medido, saldo, % usado, itens de maior valor e as OS por situação;
- contrato existente vira sob demanda pelo botão **Mudar para sob demanda** no detalhe do contrato: as medições ficam e o
  teto começa com o valor atual do contrato. Nada é convertido sozinho (os contratos 402, 439, 472, 485 e 486 mostram só um
  aviso sugerindo a mudança).

**No servidor** (`gestao/demanda161.js`, novo, ligado por `v161/ed_v161.py` no `regras.js` e no `Dockerfile`): cada gravação
de medição ao cliente de contrato sob demanda é conferida: o total medido (as outras medições aprovadas ou faturadas mais esta)
não passa do teto, ou de 125% dele com o acréscimo ligado. A gravação que não aumenta o medido (só a situação ou as
observações) passa. Recusa: erro 409, registrada na auditoria como `MEDICAO_ACIMA_TETO`.

**O que fazer:** subir `gestao/demanda161.js` (novo), `regras.js`, `Dockerfile`, `perfis.json` e `public/index.html` e
**reconstruir** a imagem do serviço `gestao`. Nada a configurar; nada muda no banco.

## Importar medições de PDF com IA (v162)

Detalhes em `relatorios/feito_v162.md`. Usa a IA que o servidor já tem (`ANTHROPIC_API_KEY`); **nenhuma chave nova**. O
modelo usado é o "complex" (`ANTHROPIC_MODEL_COMPLEX`, padrão `claude-opus-5-5`).

**No navegador** (página `public/index.html`):
- **Importar medições de PDF**: no rodapé do detalhe do contrato e em Obras › Medições ao cliente (escolha o contrato no
  filtro). Escolha um ou vários PDFs do mesmo contrato (um boletim por arquivo, até 20 MB e 50 páginas cada);
- cada PDF vira uma medição em **rascunho**, com o PDF anexado. Nada é aprovado sozinho; enquanto a importação não for
  revisada, a medição não tem itens (não conta no medido nem no teto) e não pode ser enviada para aprovação;
- **Revisar importação**: o PDF ao lado das linhas lidas. Alertas: item fora do contrato, preço diferente do contrato,
  quantidade acima do contratado (quantidade fixa) ou do teto (sob demanda, v161), total ≠ quantidade × preço. Dá para
  trocar o item do contrato, corrigir a quantidade e remover a linha. Aviso quando já existe medição com o mesmo número ou
  o mesmo período;
- **Aprovar e criar medição** grava os itens com o preço do contrato; a medição continua em rascunho e segue o fluxo de
  sempre (Enviar para aprovação → Comercial aprova). **Descartar** apaga o rascunho e o PDF.

**No servidor**:
- arquivo novo `iamed162.js` (rota `POST /api/ia/medicao-pdf`), ligado em `server.js` e `regras.js` (`v162/ed_v162.py`);
- vai para a IA **só o PDF e a lista de itens do contrato** (código, descrição, unidade, preço). Uma chamada por PDF, no
  mesmo limite por hora da `/api/ia`. Sem a chave, o sistema avisa que a IA não está configurada;
- quem pode: quem cria medição no contrato. Auditoria: `IA_USO` (como antes, sem conteúdo), `MEDICAO_PDF_IA` (contrato,
  anexo, páginas, tamanho) e `MEDICAO_PDF_APROVADA`; quem importou e quem aprovou ficam carimbados na medição (`imp162`).

**Para subir**: copie `gestao/iamed162.js` (novo), `server.js`, `regras.js`, `Dockerfile` e `public/index.html` e reconstrua a
imagem do serviço `gestao`. O banco não muda.

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

- **Já incluídas**: pdf.js 6.2.108, JSZip 3.10.1 e (v157) html2canvas 1.4.1 e pdf-lib 1.17.1.
- **Falta copiar** (o ambiente onde o pacote foi montado não conseguiu baixar): jsPDF 2.5.1 e SheetJS (v158: **0.20.3**, do site oficial; a reserva pela internet também é a 0.20.3 de `cdn.sheetjs.com`). Num computador com Node e internet, na raiz do repositório: `bash gestao/baixar-bibliotecas.sh` (v157: baixa pelo **npm** as mesmas versões que o sistema usa hoje), confira os hashes, envie ao GitHub e implante. Enquanto não copiar, essas duas continuam vindo da internet (jsPDF da cdnjs, SheetJS de `cdn.sheetjs.com`) e a política de conteúdo libera só essas origens; depois de copiar todas, a CDN deixa de ser liberada sozinha.
- **Cópia local primeiro, CDN só de reserva**: o navegador carrega a cópia de `vendor` (com o hash conferido); se ela faltar ou não carregar, usa a reserva pela internet (cdnjs; para o SheetJS, cdn.sheetjs.com), com o hash conhecido, quando houver.
- **SheetJS** (v158): o sistema usa a **0.20.3** (corrige as falhas CVE-2023-30533 e CVE-2024-22363 da 0.18.5). Primeiro a cópia `vendor/xlsx/xlsx.full.min.js`; se faltar, a reserva é `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`. A 0.18.5 da cdnjs não é mais usada.
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

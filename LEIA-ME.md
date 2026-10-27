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

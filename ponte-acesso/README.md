# Ponte de acesso (Central de Gestão v170)

Programa pequeno (Node.js, sem dependências) que roda num **mini PC ligado o tempo todo** na rede de cada local
(um em São Paulo e um em Tuiuti) e liga os controladores **Intelbras CT 3000** ao sistema.

```
 Sistema (servidor, HTTPS)  <──── a ponte liga para o servidor (só saída) ────  Ponte (mini PC na rede do local)
                                                                                  │  rede local (HTTP + digest)
                                                                                  ├── CT 3000 4PB (portas 1–4)
                                                                                  └── CT 3000 2PB (portas 1–2)
```

- **Nenhuma porta é aberta na empresa.** A ponte faz só conexões de saída para o endereço do sistema (HTTPS), com o
  **token desta ponte** criado no sistema. O token pode ser revogado a qualquer momento (a ponte para de conectar na hora).
- **O sistema é a fonte da verdade.** A ponte recebe as mudanças numeradas (crachás, pessoas, portas, horários,
  feriados), aplica em cada controlador e responde o que aplicou e os erros. O que falhar é tentado de novo.
- **Sem internet nada se perde.** Os controladores continuam abrindo com a lista que já têm (até 100 mil cartões e
  150 mil eventos guardados no próprio aparelho). A ponte guarda os eventos numa fila em disco (`dados/fila.jsonl`) com um
  id próprio e só tira da fila quando o servidor confirma; o servidor nunca grava o mesmo id duas vezes.
- Comandos do sistema: **abrir porta** (botão "Abrir") e **ler crachá** (o próximo crachá apresentado num leitor, até
  30 segundos, para o cadastro).
- A fechadura Tuya do almoxarifado de SP e o relé do portão de Tuiuti **não passam pela ponte**: o servidor fala direto com
  a nuvem Tuya (veja "Nuvem Tuya" abaixo).

> Os eventos de acesso **não são registro oficial de ponto**. Servem para segurança e, no máximo, para comparação.

## ⚠️ Validar com o aparelho real antes de usar

O adaptador (`adaptadores/intelbras-ct3000.js`) foi escrito para a **API HTTP de controle de acesso da Intelbras**
(endpoints CGI com autenticação digest) e testado contra o **simulador** (`simulador-ct3000.js`), que implementa a mesma
API. **Ele ainda não foi testado num CT 3000 de verdade.** Os endereços e os nomes de campo variam com o firmware.

Todos os endereços e nomes de campo estão num arquivo só: **`adaptadores/mapa-ct3000.js`**. Quando o primeiro CT 3000
for instalado:

1. Peça ao revendedor ou ao suporte Intelbras o manual da **API HTTP do CT 3000** na versão de firmware do aparelho.
2. Rode `node ponte.js --testar` (abaixo): confere o servidor e se cada controlador responde com o usuário e a senha.
3. Com um crachá de teste, confira um a um, olhando o próprio aparelho (ou o InControl Web só para consulta):
   cadastrar pessoa e cartão; porta e horário (dias da semana e feriado); remover; abrir pela tela; ler os registros
   (liberado, negado) e os alarmes (porta forçada, aberta além do tempo, violação); "Ler crachá".
4. Ajuste em `mapa-ct3000.js` o que for diferente (endereço, campo, `portaBase`, códigos de `Method`, `ErrorCode` e
   `Event`). Não é preciso mexer no adaptador nem no sistema.
5. Só então ligue as pessoas de verdade. Até lá, os controladores podem continuar como estão.

## Requisitos

- Mini PC sempre ligado, de baixo consumo e sem ventoinha, **Windows ou Linux**, com no-break.
- **Node.js 18 ou mais novo** (LTS). Nenhum outro pacote.
- Na mesma rede dos controladores (cabo; IP fixo nos controladores).
- Acesso de saída à internet (HTTPS) para o endereço do sistema.

## Instalação

1. No sistema: **Acesso › Pontos, dispositivos e pontes › Nova ponte** (local SP ou Tuiuti). Copie o **token** que aparece
   (ele não aparece de novo; se perder, use "Novo token", que revoga o anterior).
2. Ainda no sistema, cadastre cada controlador em **Novo dispositivo** (tipo CT 3000 2PB ou 4PB, a ponte do local) e anote o
   **id** do dispositivo (aparece no endereço de edição e no `--testar`).
3. Copie esta pasta para o mini PC (por exemplo `/opt/ponte-acesso` ou `C:\ponte-acesso`).
4. Copie `.env.example` para `.env` e preencha `SERVIDOR_URL` e `PONTE_TOKEN`.
5. Copie `controladores.example.json` para `controladores.json` e preencha, para cada controlador da rede: o `disp` (id no
   sistema), o `url` (`http://IP-do-controlador`), o `usuario` e a `senha` do controlador. **Este arquivo fica só no mini PC**
   (o sistema não guarda a senha dos controladores).
6. Teste: `node ponte.js --testar`
7. Instale como serviço (abaixo) para ligar sozinha com o computador.

### Linux (systemd)

```
sudo useradd -r -s /usr/sbin/nologin ponte
sudo cp -r ponte-acesso /opt/ponte-acesso && sudo mkdir -p /opt/ponte-acesso/dados
sudo chown -R ponte:ponte /opt/ponte-acesso/dados
sudo chmod 600 /opt/ponte-acesso/.env /opt/ponte-acesso/controladores.json && sudo chown ponte /opt/ponte-acesso/.env /opt/ponte-acesso/controladores.json
sudo cp /opt/ponte-acesso/instalar/ponte-acesso.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ponte-acesso
journalctl -u ponte-acesso -f
```

### Windows (serviço com o NSSM)

1. Instale o Node.js LTS (nodejs.org) e copie a pasta para `C:\ponte-acesso`.
2. Baixe o `nssm.exe` (nssm.cc, 64 bits) para `C:\ponte-acesso\instalar\`.
3. Clique com o botão direito em `instalar\instalar-windows.cmd` › **Executar como administrador**.
4. Confira em `services.msc` o serviço **PonteAcesso** (início automático) e o arquivo `C:\ponte-acesso\dados\ponte.log`.
5. Em Configurações de energia, deixe o computador **sem suspender** e com início automático ao voltar a energia (BIOS).

## Demonstração sem aparelho (simulador)

```
node simulador-ct3000.js --porta 8081 --usuario admin --senha admin123 --portas 4
```

No `controladores.json`, use `"url": "http://127.0.0.1:8081"`, `"usuario": "admin"`, `"senha": "admin123"`. Comandos do
simulador (sem senha): `POST /sim/passar {"porta":1,"cartao":"04A1B2C3"}` (apresenta um crachá),
`POST /sim/alarme {"porta":1,"evento":"BreakIn"}`, `POST /sim/botao`, `POST /sim/hora {"local":"2026-11-09T10:00"}`,
`POST /sim/offline {"on":true}` e `GET /sim/estado` (usuários, cartões, horários e registros que a ponte gravou).

## Nuvem Tuya (fechadura do almoxarifado de SP e relé do portão de Tuiuti)

O servidor fala com a nuvem Tuya (a mesma do app Smart Life / NovaDigital). Uma vez só:

1. Crie uma conta em **iot.tuya.com** (Tuya IoT Platform) com o e-mail da empresa.
2. **Cloud › Development › Create Cloud Project**: tipo "Smart Home", data center **o mesmo do app** (no Brasil
   normalmente *Western America* = `us`; confira no app Smart Life › Eu › Configurações › Conta e segurança › Região).
   Autorize as APIs "IoT Core", "Authorization", "Smart Lock Open Service" e "Device Status Notification".
3. No projeto: **Devices › Link Tuya App Account › Add App Account** e escaneie o QR com o app **Smart Life** da conta da
   empresa (a que tem a fechadura e o relé). Os aparelhos aparecem na lista com o **Device ID**.
4. No servidor (variáveis do serviço `gestao`): `TUYA_CLIENT_ID` (Access ID), `TUYA_SECRET` (Access Secret) e
   `TUYA_REGIAO` (`us`, `ueaz`, `eu`, `weaz`, `in` ou `cn`). Reinicie o serviço.
5. No sistema: **Novo dispositivo** › "Fechadura Tuya" ou "Relé Wi-Fi Tuya", com o Device ID. No relé, confira o código da
   saída (em Devices › Debug Device: normalmente `switch_1`) e o tempo do pulso.
6. **Troque a senha da conta do app Smart Life/NovaDigital** e, no app, em cada aparelho › Compartilhar, **remova quem não
   precisa mais** (ex-funcionários, celulares antigos). Depois disso, quem abre é o sistema (com registro e horário); o app
   fica só com quem administra. Mantenha a verificação em duas etapas da conta Tuya ligada.

O que valida na fechadura: a abertura remota sem senha e a senha temporária dependem do modelo (categoria "ms" e do
"Smart Lock Open Service"). Confira os caminhos em `deploy/gestao/tuya170.js` (`CAMINHOS`) com o aparelho real.

## Segurança

- O token fica só no `.env` do mini PC (permissão 600). No sistema fica só o resumo (hash). Revogue no sistema se o mini PC
  for perdido ou trocado.
- `SERVIDOR_URL` precisa ser `https://` (a ponte recusa `http://` fora do próprio computador).
- A senha dos controladores fica só no `controladores.json` do mini PC. Troque a senha de fábrica de cada CT 3000.
- Deixe os controladores numa rede (VLAN) separada dos computadores, se possível; só a ponte precisa falar com eles.

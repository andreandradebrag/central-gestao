'use strict';
/* Mapa da API HTTP do controlador Intelbras CT 3000 (2PB/4PB): TODOS os endereços e nomes de campo num lugar só.
   !!! VALIDAR COM O APARELHO REAL !!!
   Os nomes abaixo seguem a API HTTP de controle de acesso da Intelbras (endpoints CGI com autenticação digest, a mesma
   família dos controladores e leitores faciais da marca). Antes de ligar em produção, com o primeiro CT 3000 instalado:
     1. confira cada endereço no manual da API do firmware instalado (peça ao revendedor/suporte Intelbras a "API HTTP" do
        CT 3000 na versão do aparelho) e teste com o "node ponte.js --testar" (README);
     2. ajuste aqui o que for diferente (endereço, nome de campo, base das portas, códigos de método e de alarme);
     3. não mexa no adaptador (intelbras-ct3000.js): ele só monta os pedidos a partir deste mapa.
   O simulador (simulador-ct3000.js) implementa exatamente este mapa, para os testes e a demonstração. */
module.exports = {
  descricao: 'Intelbras CT 3000 — API HTTP (CGI, digest). Conferir com o firmware do aparelho.',
  /* porta 1 do sistema = índice portaBase no aparelho (canal da abertura = porta do sistema) */
  portaBase: 0,
  info: { caminho: '/cgi-bin/magicBox.cgi?action=getSystemInfo' },
  usuario: {
    inserir: { metodo: 'POST', caminho: '/cgi-bin/AccessUser.cgi?action=insertMulti', lista: 'UserList' },
    atualizar: { metodo: 'POST', caminho: '/cgi-bin/AccessUser.cgi?action=updateMulti', lista: 'UserList' },
    remover: { metodo: 'GET', caminho: '/cgi-bin/AccessUser.cgi?action=removeMulti', param: 'UserIDList' },
    buscarInicio: { metodo: 'GET', caminho: '/cgi-bin/AccessUser.cgi?action=startFind', token: 'Token', total: 'Total' },
    buscar: { metodo: 'GET', caminho: '/cgi-bin/AccessUser.cgi?action=doFind&Token={token}&Offset={de}&Count={n}', lista: 'Info' },
    buscarFim: { metodo: 'GET', caminho: '/cgi-bin/AccessUser.cgi?action=stopFind&Token={token}' },
    campos: { id: 'UserID', nome: 'UserName', tipo: 'UserType', status: 'UserStatus', portas: 'Doors', horarios: 'TimeSections', inicio: 'ValidFrom', fim: 'ValidTo', autoridade: 'Authority' },
    valores: { tipoNormal: 0, statusAtivo: 0, autoridadeUsuario: 2, sempre: 255, fimPadrao: '2037-12-31 23:59:59' }
  },
  cartao: {
    inserir: { metodo: 'POST', caminho: '/cgi-bin/AccessCard.cgi?action=insertMulti', lista: 'CardList' },
    remover: { metodo: 'GET', caminho: '/cgi-bin/AccessCard.cgi?action=removeMulti', param: 'CardNoList' },
    campos: { usuario: 'UserID', numero: 'CardNo', tipo: 'CardType', status: 'CardStatus' },
    valores: { tipoNormal: 0, statusAtivo: 0 }
  },
  /* horário semanal: AccessTimeSchedule[idx].TimeSchedule[dia][faixa] = "1 HH:MM:SS-HH:MM:SS"; dia 0 = domingo … 6 = sábado,
     7 = feriado; até 4 faixas por dia */
  horario: { caminho: '/cgi-bin/configManager.cgi?action=setConfig', chave: 'AccessTimeSchedule[{idx}]', nome: 'Name', ativo: 'Enable', faixa: 'TimeSchedule[{dia}][{n}]', faixasPorDia: 4, diaFeriado: 7, diaDoSistema: d => d % 7 },
  /* feriados (dias especiais): SpecialDaysSchedule[0].Days[n] = "AAAA-MM-DD" */
  feriados: { caminho: '/cgi-bin/configManager.cgi?action=setConfig', chave: 'SpecialDaysSchedule[0]', dia: 'Days[{n}]', maximo: 64 },
  /* porta: nome e tempo de "porta aberta" (alarme), por índice da porta */
  porta: { config: '/cgi-bin/configManager.cgi?action=setConfig', chave: 'AccessControl[{i}]', nome: 'Name', tempoAberta: 'CloseTimeout',
    abrir: { metodo: 'GET', caminho: '/cgi-bin/accessControl.cgi?action=openDoor&channel={canal}&Type=Remote' } },
  /* registros guardados no aparelho (o controlador guarda até 150 mil eventos): acessos e alarmes */
  eventos: {
    acessos: { caminho: '/cgi-bin/recordFinder.cgi?action=find&name=AccessControlCardRec&StartTime={ini}&EndTime={fim}&count={n}', campos: { recno: 'RecNo', hora: 'CreateTime', cartao: 'CardNo', usuario: 'UserID', porta: 'Door', ok: 'Status', metodo: 'Method', erro: 'ErrorCode' } },
    alarmes: { caminho: '/cgi-bin/recordFinder.cgi?action=find&name=AccessControlAlarmRecord&StartTime={ini}&EndTime={fim}&count={n}', campos: { recno: 'RecNo', hora: 'CreateTime', porta: 'Door', evento: 'Event' } },
    lote: 100,
    /* Method do registro de acesso → como abriu */
    metodos: { 1: 'cartao', 4: 'remoto', 5: 'botao', 0: 'senha', 15: 'facial' },
    /* Event do alarme → resultado no sistema */
    alarmes2: { BreakIn: 'forcada', DoorNotClosed: 'aberta', ChassisIntruded: 'violacao', Duress: 'violacao' },
    /* ErrorCode do acesso negado → motivo (o servidor completa com o motivo do sistema, quando sabe) */
    erros: { 16: 'Crachá não cadastrado no controlador', 17: 'Fora do horário', 18: 'Fora da validade', 19: 'Sem permissão nesta porta', 20: 'Crachá bloqueado' }
  }
};

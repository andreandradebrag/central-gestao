@echo off
rem Ponte de acesso como serviço do Windows, com o NSSM (https://nssm.cc, "Non-Sucking Service Manager").
rem 1. Instale o Node.js LTS (nodejs.org) e copie a pasta ponte-acesso para C:\ponte-acesso
rem 2. Baixe o nssm.exe (versão 64 bits) para C:\ponte-acesso\instalar\
rem 3. Rode este arquivo como Administrador (botão direito > Executar como administrador)
set PASTA=C:\ponte-acesso
set NODE=C:\Program Files\nodejs\node.exe
"%PASTA%\instalar\nssm.exe" install PonteAcesso "%NODE%" "%PASTA%\ponte.js"
"%PASTA%\instalar\nssm.exe" set PonteAcesso AppDirectory "%PASTA%"
"%PASTA%\instalar\nssm.exe" set PonteAcesso Start SERVICE_AUTO_START
"%PASTA%\instalar\nssm.exe" set PonteAcesso AppStdout "%PASTA%\dados\ponte.log"
"%PASTA%\instalar\nssm.exe" set PonteAcesso AppStderr "%PASTA%\dados\ponte.log"
"%PASTA%\instalar\nssm.exe" set PonteAcesso AppRotateFiles 1
"%PASTA%\instalar\nssm.exe" set PonteAcesso AppRotateBytes 5000000
"%PASTA%\instalar\nssm.exe" set PonteAcesso AppExit Default Restart
if not exist "%PASTA%\dados" mkdir "%PASTA%\dados"
"%PASTA%\instalar\nssm.exe" start PonteAcesso
echo Pronto. Confira em services.msc o servico "PonteAcesso" e o arquivo %PASTA%\dados\ponte.log
pause

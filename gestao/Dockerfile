# imagem com versão fixa (troque de propósito, depois de testar; nunca use etiqueta móvel como "22-alpine")
FROM node:22.22.0-alpine
WORKDIR /app
COPY server.js shim.js solides.js bancos.js email.js backup.js restaurar.js seguranca.js endurece.js qr.js regras.js privacidade.js perfis.json ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data && chmod -R a-w /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/saude >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

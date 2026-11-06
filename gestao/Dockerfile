# imagem com versão fixa (troque de propósito, depois de testar; nunca use etiqueta móvel como "22-alpine")
FROM node:22.22.0-alpine
WORKDIR /app
COPY server.js shim.js solides.js bancos.js arquivofiscal.js caixanfe.js email.js backup.js restaurar.js seguranca.js endurece.js qr.js regras.js privacidade.js p2p.js permfn.js medapr.js valores.js negoc.js aceite.js treino.js compras152.js almox153.js epi154.js est155.js fam156.js ajuste157.js ajuste158.js comprime159.js sinc160.js demanda161.js iamed162.js perfis.json ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data && chmod -R a-w /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/saude >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

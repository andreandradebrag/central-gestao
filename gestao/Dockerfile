FROM node:22-alpine
WORKDIR /app
COPY server.js shim.js solides.js bancos.js email.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

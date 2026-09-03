# Bublee en conteneur. La base et le cache d'images vivent dans /data :
# c'est le seul volume à monter, et le seul dossier à sauvegarder.
#
#   docker build -t bublee .
#   docker run -d --name bublee -p 4321:4321 -v bublee-data:/data bublee
#
# better-sqlite3 est la seule dépendance native : ses binaires précompilés
# couvrent linux/amd64 et linux/arm64, l'image se construit sans chaîne de
# compilation.
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    BUBLEE_DATA=/data \
    BUBLEE_NO_OPEN=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4321

# /api/ping ne demande ni compte ni jeton : c'est fait pour ça.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4321/api/ping >/dev/null || exit 1

CMD ["node", "server/index.js"]

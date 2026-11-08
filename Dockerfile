# Personaleinsatzplanung – Container-Image
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/personaleinsatz.db \
    UPLOAD_DIR=/data/uploads

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Daten (Datenbank + AU-Bescheinigungen) liegen außerhalb des Containers im Volume /data
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]

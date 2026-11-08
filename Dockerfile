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

# Daten (Datenbank + AU-Bescheinigungen) liegen außerhalb des Containers im Volume /data.
# Der Start erfolgt als root nur, um die Rechte von /data zu korrigieren; danach läuft
# das Programm als Benutzer "node" (siehe scripts/entrypoint.js).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- "http://127.0.0.1:3000${BASE_PATH}/api/health" >/dev/null || exit 1
CMD ["node", "scripts/entrypoint.js"]

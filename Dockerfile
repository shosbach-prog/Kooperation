# Personaleinsatzplanung – Container-Image
# Debian statt Alpine: die Spracherkennung (ONNX Runtime / Whisper) braucht glibc.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/personaleinsatz.db \
    UPLOAD_DIR=/data/uploads \
    ONNXRUNTIME_NODE_INSTALL_CUDA=skip

WORKDIR /app
COPY package.json package-lock.json ./
# Abhängigkeiten installieren; für die Spracherkennung nur die Linux-Bibliothek der eigenen Architektur
# behalten (ohne Grafikkarten-Treiber) – spart mehrere hundert MB
RUN npm ci --omit=dev && npm cache clean --force \
 && ORT=node_modules/onnxruntime-node/bin/napi-v3 \
 && if [ -d "$ORT" ]; then \
      rm -rf "$ORT/darwin" "$ORT/win32" \
      && ARCH=$(node -p "process.arch") \
      && for a in "$ORT"/linux/*; do [ "$(basename "$a")" = "$ARCH" ] || rm -rf "$a"; done \
      && rm -f "$ORT"/linux/*/libonnxruntime_providers_cuda.so "$ORT"/linux/*/libonnxruntime_providers_tensorrt.so; \
    fi
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Daten (Datenbank, AU-Bescheinigungen, Sprachmodell) liegen außerhalb des Containers im Volume /data.
# Der Start erfolgt als root nur, um die Rechte von /data zu korrigieren; danach läuft
# das Programm als Benutzer "node" (siehe scripts/entrypoint.js).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000'+(process.env.BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/entrypoint.js"]

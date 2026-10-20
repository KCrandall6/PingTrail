FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
# Keep Debian's default HTTP sources: APT verifies signed metadata and package hashes
# while installing the CA store, without requiring pre-existing HTTPS trust.
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; export npm_config_cafile=/run/secrets/build_ca; export APT_CA_OPTION="-o Acquire::https::CaInfo=/run/secrets/build_ca"; fi \
    && apt-get $APT_CA_OPTION update \
    && apt-get $APT_CA_OPTION install -y --no-install-recommends python3 make g++ ca-certificates \
    && npm ci --omit=dev --cache /tmp/npm-cache \
    && rm -rf /tmp/npm-cache

FROM node:24-bookworm-slim
# Replace ping to drop its NET_RAW file capability; datagram ICMP needs no added capability.
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -f /run/secrets/build_ca ]; then export APT_CA_OPTION="-o Acquire::https::CaInfo=/run/secrets/build_ca"; fi \
    && apt-get $APT_CA_OPTION update && apt-get $APT_CA_OPTION install -y --no-install-recommends iputils-ping iproute2 ca-certificates \
    && cp /usr/bin/ping /usr/bin/ping-unprivileged && mv /usr/bin/ping-unprivileged /usr/bin/ping \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
ENV NODE_ENV=production PINGTRAIL_HOST=0.0.0.0 PINGTRAIL_PROFILE=server PINGTRAIL_DB_PATH=/data/pingtrail.sqlite
USER node
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]

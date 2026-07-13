FROM node:22.22.2-alpine AS deps
WORKDIR /usr/src/wpp-server
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    SHARP_FORCE_GLOBAL_LIBVIPS=true

RUN apk add --no-cache \
    libc6-compat \
    vips \
    vips-dev \
    fftw-dev \
    gcc \
    g++ \
    make \
    pkgconfig \
    python3

COPY package.json ./
COPY package-lock.json ./

RUN npm ci --legacy-peer-deps

FROM deps AS build
WORKDIR /usr/src/wpp-server
COPY . .
RUN npm run build

FROM node:22.22.2-alpine AS runtime
WORKDIR /usr/src/wpp-server

ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    SHARP_FORCE_GLOBAL_LIBVIPS=true \
    WPP_LOG_TO_FILE=false \
    WPP_LOG_LEVEL=info \
    WPP_START_ALL_SESSION=false \
    WPP_VALIDATE_NUMBER_STATUS=false \
    WPP_VERIFY_CONNECTED_BEFORE_SEND=false \
    WPP_CONNECTION_CHECK_TIMEOUT_MS=15000 \
    WPP_NUMBER_STATUS_TIMEOUT_MS=12000 \
    WPP_SEND_MESSAGE_TIMEOUT_MS=35000 \
    WPP_PUPPETEER_PROTOCOL_TIMEOUT_MS=120000 \
    WPP_HTTP_ALERTS_ENABLED=true \
    WPP_HTTP_ALERT_4XX=false \
    WPP_HTTP_SLOW_MS=55000 \
    WPP_KILL_STALE_CHROMIUM=true \
    WPP_CUSTOM_USER_DATA_DIR=/data/userDataDir/ \
    WPP_TOKENS_DIR=/data/tokens

ENV MONITOR_FAILURE_THRESHOLD=2 \
    MONITOR_PING_TIMEOUT_MS=20000

RUN apk add --no-cache \
    ca-certificates \
    chromium \
    dumb-init \
    ffmpeg \
    font-noto-emoji \
    freetype \
    procps \
    vips \
    fftw

COPY package.json package-lock.json ./
COPY --from=deps /usr/src/wpp-server/node_modules ./node_modules
RUN npm prune --omit=dev --legacy-peer-deps \
    && npm cache clean --force

COPY --from=build /usr/src/wpp-server/dist ./dist
COPY scripts/check-runtime-deps.js ./scripts/check-runtime-deps.js
RUN node scripts/check-runtime-deps.js

RUN mkdir -p /data/userDataDir /data/tokens /usr/src/wpp-server/log \
    && ln -s /data/tokens /usr/src/wpp-server/tokens \
    && ln -s /data/userDataDir /usr/src/wpp-server/userDataDir \
    && chown -R root:root /usr/src/wpp-server /data

EXPOSE 21465
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]

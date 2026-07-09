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
    WPP_CUSTOM_USER_DATA_DIR=/data/userDataDir/ \
    WPP_TOKENS_DIR=/data/tokens

RUN apk add --no-cache \
    ca-certificates \
    chromium \
    dumb-init \
    ffmpeg \
    font-noto-emoji \
    freetype \
    vips \
    fftw

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps \
    && npm cache clean --force

COPY --from=build /usr/src/wpp-server/dist ./dist
RUN mkdir -p /data/userDataDir /data/tokens /usr/src/wpp-server/log \
    && ln -s /data/tokens /usr/src/wpp-server/tokens \
    && ln -s /data/userDataDir /usr/src/wpp-server/userDataDir \
    && chown -R node:node /usr/src/wpp-server /data

USER node

EXPOSE 21465
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]

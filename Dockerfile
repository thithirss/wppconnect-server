FROM node:22.22.2-alpine AS base
WORKDIR /usr/src/wpp-server
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Build tools + system libvips (sharp links against it instead of bundling)
RUN apk update && \
    apk add --no-cache \
    vips \
    vips-dev \
    fftw-dev \
    gcc \
    g++ \
    make \
    libc6-compat \
    pkgconfig \
    python3 \
    && rm -rf /var/cache/apk/*

COPY package.json ./
COPY package-lock.json ./

# node-gyp is now a devDependency so npm ci installs it automatically
# SHARP_FORCE_GLOBAL_LIBVIPS tells sharp to use the system libvips above
ENV SHARP_FORCE_GLOBAL_LIBVIPS=true

RUN npm ci --legacy-peer-deps

FROM base AS build
WORKDIR /usr/src/wpp-server
COPY . .
ENV SHARP_FORCE_GLOBAL_LIBVIPS=true
RUN npm ci --legacy-peer-deps
RUN npm run build

FROM build AS runtime
WORKDIR /usr/src/wpp-server/

RUN apk add --no-cache \
    chromium \
    vips \
    fftw

EXPOSE 21465
ENTRYPOINT ["node", "dist/server.js"]

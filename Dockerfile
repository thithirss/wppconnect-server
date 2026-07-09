FROM node:22.22.2-alpine AS base
WORKDIR /usr/src/wpp-server
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install build dependencies and runtime libraries for sharp
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

# Copy package.json and package-lock.json to leverage Docker cache
COPY package.json ./
COPY package-lock.json ./

# Install node-gyp globally (required by sharp to build from source)
RUN npm install -g node-gyp

# Install dependencies
RUN npm ci --legacy-peer-deps

FROM base AS build
WORKDIR /usr/src/wpp-server
COPY . .
RUN npm ci --legacy-peer-deps
RUN npm run build

FROM build AS runtime
WORKDIR /usr/src/wpp-server/

# Install runtime dependencies (chromium and vips libraries)
RUN apk add --no-cache \
    chromium \
    vips \
    fftw

EXPOSE 21465
ENTRYPOINT ["node", "dist/server.js"]

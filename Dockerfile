# Multi-stage Node 20 build of the grokbot monorepo (api + proxy).
# Production images run the built JS; default CMD is the API.

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY packages/api/package.json packages/api/
COPY packages/proxy/package.json packages/proxy/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/adapters packages/adapters
COPY packages/api packages/api
COPY packages/proxy packages/proxy

RUN npm run build \
  && npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    API_PORT=8080 \
    PROXY_PORT=2101 \
    GROKBOT_STORE_PATH=/data/grokbot-store.json \
    ALLOW_FIXTURE_ORGS=false \
    CPOS_ADAPTER_ENABLED=false

RUN mkdir -p /data \
  && chown -R node:node /data /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages

USER node
VOLUME ["/data"]
EXPOSE 8080 2101

# Override in compose for proxy: ["node", "packages/proxy/dist/main.js"]
CMD ["node", "packages/api/dist/main.js"]

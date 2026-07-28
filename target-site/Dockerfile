# Multi-stage: the toolchain that builds this image never ships in it.
# The runtime layer carries production node_modules and compiled JS — nothing else.
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached independently of source changes.
# Reordering these two COPYs costs a full dependency install on every edit.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 8080
# No shell form: exec form makes PID 1 the process itself, so SIGTERM reaches it and
# the graceful shutdown handler in main.ts actually runs.
CMD ["node", "dist/main.js"]

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Chromium from Debian rather than a downloaded build: it is patched by the distro,
# it matches the container's architecture without a second thought, and it keeps the
# image reproducible.
#
# The font packages are not optional. Canvas and WebGL fingerprints are largely a
# function of the installed font stack, so a container with no fonts renders text
# nothing like a consumer machine — and `fp.canvas_known_headless` would fire on the
# stealth profile too. Emoji fonts matter for the same reason: the probe draws one.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-core \
      fonts-noto-color-emoji \
      ca-certificates \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

ENV CHROME_PATH=/usr/bin/chromium

# Chrome spawns a tree of renderer and GPU processes. Without a real init, killed
# renderers become zombies and the container slowly fills its PID table — the classic
# way a long-running scraping container dies at 3am.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]

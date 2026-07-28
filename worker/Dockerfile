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
#
# Versions are deliberately unpinned here. Debian drops superseded Chromium builds
# from the archive as soon as a security update lands, so a pinned `chromium=1:150…`
# stops resolving within weeks and the image fails to build for a reason that has
# nothing to do with this repo. Floating on the distro's current build is the choice
# that keeps `make demo` working for someone cloning this months from now — and it is
# the same trade every browser-automation image makes.
# hadolint ignore=DL3008
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
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

# Run unprivileged.
#
# This matters more here than in the other two images. Chrome is launched with
# --no-sandbox because the container does not grant the kernel capabilities its
# sandbox needs, so the container *is* the isolation boundary — and a browser
# rendering untrusted pages as root removes most of what that boundary was for.
#
# --create-home because Chrome writes to $HOME even when the profile lives
# elsewhere; without it the first launch fails with a bare non-zero exit.
RUN useradd --system --create-home --uid 10001 worker
USER worker

# Chrome spawns a tree of renderer and GPU processes. Without a real init, killed
# renderers become zombies and the container slowly fills its PID table — the classic
# way a long-running scraping container dies at 3am.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]

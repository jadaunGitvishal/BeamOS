# ScreenTinker server image: serves the dashboard, the web player, and the
# device API. All mutable state (db, uploads, jwt secret) lives under /data so it
# survives container restarts - mount a volume there. A built ScreenTinker.apk
# can be mounted at /data/ScreenTinker.apk to enable OTA APK downloads.
#
# No TLS in the image: it listens on plain HTTP :5001. Front it with a
# TLS-terminating reverse proxy / Cloudflare in production.

# --- builder: install production deps (native: better-sqlite3, sharp) ---
FROM node:20-slim AS builder
# Buildx-provided (amd64/arm64) - needed below to pick sharp's correct
# platform binary for the image's actual target arch (release.yml's docker
# job builds both linux/amd64 and linux/arm64).
ARG TARGETARCH
WORKDIR /app/server
# build toolchain in case a native prebuild is missing for the target arch
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
# `npm ci` misses sharp's platform-specific native binary the same way it
# missed rollup's during the dashboard build (see dashboard-builder below) -
# package-lock.json was generated on Windows, this build runs on Linux, same
# npm bug (https://github.com/npm/cli/issues/4828). Sharp's own docs
# (https://sharp.pixelplumbing.com/install#cross-platform-and-cross-architecture-installation)
# name this exact scenario and recommend reinstalling with explicit
# --os/--cpu/--libc flags inside the target container rather than trusting a
# lockfile shared across platforms. Kept as a narrow follow-up `npm install`
# (not a full lockfile-less reinstall like the dashboard build uses) so the
# rest of the production tree stays exactly what package-lock.json pins.
# TARGETARCH uses Docker's naming (amd64/arm64); npm's --cpu wants Node's
# (x64/arm64) - amd64 is the one that differs.
RUN case "$TARGETARCH" in \
      amd64) NPM_CPU=x64 ;; \
      *) NPM_CPU="$TARGETARCH" ;; \
    esac \
    && npm install --os=linux --cpu=$NPM_CPU --libc=glibc sharp

# --- dashboard-builder: build the BeamOS Dashboard SPA (frontend/dashboard-src
# -> frontend/dashboard). frontend/dashboard/ is gitignored (a build artifact,
# not source), so without this stage it would only end up in the image if
# whoever ran `docker build` happened to already have a (possibly stale) local
# copy on disk - a fresh checkout would ship with no dashboard at all.
# Installs into a directory of its own (/app/dashboard-build/server), separate
# from the production node_modules built above, since this build needs
# devDependencies (vite, @vitejs/plugin-react) that production doesn't and
# that tree is discarded after this stage - only its build OUTPUT
# (frontend/dashboard/) is copied into the runtime image below. Based on
# `builder` to reuse its apt build toolchain layer (sharp/better-sqlite3 are
# both still in this package.json, so the same native-build needs apply here).
FROM builder AS dashboard-builder
WORKDIR /app/dashboard-build/server
COPY server/package.json ./
# `npm ci` - and even plain `npm install` while a lockfile is present - can
# silently *succeed* while omitting a platform-specific optional dep (vite's
# @rollup/rollup-linux-x64-gnu) that this repo's package-lock.json was
# generated without (written on Windows; this build runs on Linux) - a known
# npm bug (https://github.com/npm/cli/issues/4828), and the failure only
# surfaces later when rollup actually tries to load it. Its own documented
# fix: install with no lockfile at all, so npm resolves the platform-specific
# tree fresh. (No package-lock.json copied into this directory in the first
# place, so nothing to delete.) Only affects this throwaway build layer,
# never the repo's committed lockfile.
RUN npm install
COPY server/vite.dashboard.config.js ./
COPY server/scripts/link-dashboard-deps.js ./scripts/link-dashboard-deps.js
COPY frontend/dashboard-src/ /app/dashboard-build/frontend/dashboard-src/
RUN npm run build:dashboard

# --- runtime ---
FROM node:20-slim
ENV NODE_ENV=production
# Relocate all state onto the volume (config.js reads DATA_DIR; unset would use
# the in-repo paths, which we do not want in a container).
ENV DATA_DIR=/data
WORKDIR /app/server
# App source (node_modules/test/db/uploads/certs are excluded via .dockerignore),
# then the built deps, the frontend the server serves, and the VERSION file it
# reads as ../VERSION.
COPY server/ /app/server/
COPY --from=builder /app/server/node_modules /app/server/node_modules
COPY frontend/ /app/frontend/
# Built dashboard bundle (frontend/dashboard/) is gitignored, so it's never
# part of the COPY above (see .dockerignore) - always take it fresh from the
# dashboard-builder stage instead of whatever might (or might not) be sitting
# locally.
COPY --from=dashboard-builder /app/dashboard-build/frontend/dashboard /app/frontend/dashboard
COPY VERSION /app/VERSION
# the /openapi.yaml route serves ../docs/openapi.yaml (the spec Redoc on /docs fetches);
# without this it 404s in the image even though it serves fine from a dev checkout.
COPY docs/openapi.yaml /app/docs/openapi.yaml
# database.js requires scripts/migrate-multitenancy at boot
COPY scripts/ /app/scripts/
VOLUME ["/data"]
EXPOSE 5001
CMD ["node", "server.js"]

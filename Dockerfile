# syntax=docker/dockerfile:1.7

# FQDN registry refs per Tekton buildah short-name-mode (skill gotcha #19).

# Stage 1: build the Vite bundle
#
# ⚠️ THIS TAG IS A THIRD STATEMENT OF THE NODE MAJOR. `.nvmrc` is the authority
# that flake.nix and `.github/workflows/ci.yml` both read, and
# `src/toolchain-lockstep.test.ts` keeps THOSE two honest — it does not see
# this line, because a Dockerfile FROM tag cannot read a file at build time.
# Bump it with `.nvmrc`, by hand.
FROM docker.io/library/node:24-alpine AS builder
WORKDIR /app

# pnpm is installed explicitly rather than via corepack: this repo deliberately
# declares no `packageManager` field in package.json (see flake.nix), and
# corepack keys off exactly that field. The major matches flake.nix's
# `pnpmMajor` and ci.yml's `pnpm/action-setup` version.
RUN npm install -g pnpm@11

# Install deps from the lockfile for determinism. `pnpm-workspace.yaml` must be
# present at install time: it declares the single-package root AND the
# `allowBuilds` approval without which pnpm 11 exits `ERR_PNPM_IGNORED_BUILDS`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Build
COPY tsconfig.json vite.config.ts index.html .env.production ./
COPY src/ ./src/
COPY block.manifest.json civitai.app.json ./
RUN pnpm run build

# Stage 2: serve via nginx-unprivileged. nginx:1.27-alpine ships /var/cache/
# nginx + /var/log/nginx + /var/run/ owned by root, so a non-root USER hits
# "Permission denied" on startup creating client_temp. nginx-unprivileged
# is the same nginx 1.27 with all writable paths redirected to /tmp + the
# image USER baked in as numeric 101 (which also satisfies the apply Job
# smoke pod's runAsNonRoot admission check).
FROM docker.io/nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Vite base is '/' — bundle serves at root, matches iframe.src (no path prefix).
COPY --from=builder /app/dist/ /usr/share/nginx/html/
# Manifest + civitai.app.json at the well-known root path so the platform
# can fetch them without prefix juggling.
COPY --from=builder /app/block.manifest.json /usr/share/nginx/html/block.manifest.json
COPY --from=builder /app/civitai.app.json /usr/share/nginx/html/civitai.app.json

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["nginx", "-g", "daemon off;"]

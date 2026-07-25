# syntax=docker/dockerfile:1

# Headless Obsidian MCP — stdio MCP server.
#
# This server speaks MCP over stdin/stdout, so the container is spawned per
# client and must keep stdin open. It is not a long-running network service;
# there is nothing to expose and nothing for docker-compose to supervise.
#
#   docker build -t headless-obsidian-mcp .
#   docker run -i --rm -v "$HOME/vault:/vault:ro" headless-obsidian-mcp
#
# See examples/ for the MCP client config that wires this up.

# --- build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# package.json's `prepare` script runs tsc, which would fire during install —
# before src/ is copied. Skip lifecycle scripts here and build explicitly below.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage -----------------------------------------------------------
FROM node:20-alpine

# ripgrep is a hard runtime dependency: search_notes shells out to the real `rg`
# binary. git is required by every OBSIDIAN_GIT_SYNC mode other than `off` —
# assertSyncableBeforeWrite refuses the write *before* touching the filesystem
# when the vault is not a usable git repo, so a missing binary turns every write
# into an error rather than degrading quietly.
RUN apk add --no-cache ripgrep git

# The vault is a bind mount owned by the host user, so its uid rarely matches
# the container's. git refuses to operate on a repo owned by another uid
# ("dubious ownership"), which would surface as a fail-closed write refusal
# rather than anything git-shaped. Scoped to the vault mount point only.
RUN git config --system --add safe.directory /vault \
 && git config --system user.name  "headless-obsidian-mcp" \
 && git config --system user.email "headless-obsidian-mcp@localhost"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist

# Default mount point. Override with -e OBSIDIAN_VAULT_PATH if you mount
# elsewhere; see .env.example for every variable this server reads.
ENV OBSIDIAN_VAULT_PATH=/vault

# Unprivileged by default. For writes to a vault owned by a different uid, run
# with `--user "$(id -u):$(id -g)"` so the container writes as you.
USER node

ENTRYPOINT ["node", "dist/index.js"]

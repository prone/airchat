#!/bin/bash
# Deploy AirChat web app to NAS
#
# Usage:
#   ./scripts/deploy.sh          # deploy and smoke test
#   ./scripts/deploy.sh --skip-smoke  # deploy without smoke test
#
# Requires SSH access to the NAS (see ~/.airchat/config for connection details)

set -euo pipefail

# Deployment target. Override per-environment rather than hardcoding a host
# here: this is a public repository, and the address of a private server is not
# something to publish. Set these in your shell or a local, gitignored file.
NAS_HOST="${AIRCHAT_DEPLOY_HOST:?set AIRCHAT_DEPLOY_HOST (e.g. export AIRCHAT_DEPLOY_HOST=192.0.2.10)}"
NAS_PORT="${AIRCHAT_DEPLOY_PORT:-22}"
NAS_USER="${AIRCHAT_DEPLOY_USER:?set AIRCHAT_DEPLOY_USER}"
NAS_DEPLOY_DIR="${AIRCHAT_DEPLOY_DIR:-/volume1/docker/agentchat-web}"
DOCKER="/usr/local/bin/docker"

SSH_CMD="ssh -p $NAS_PORT $NAS_USER@$NAS_HOST"

echo "==> Transferring source to NAS..."
tar czf - \
  apps/web/app \
  apps/web/components \
  apps/web/lib \
  apps/web/public \
  apps/web/Dockerfile \
  apps/web/instrumentation.ts \
  apps/web/middleware.ts \
  apps/web/next.config.ts \
  apps/web/eslint.config.mjs \
  apps/web/package.json \
  apps/web/tsconfig.json \
  packages/shared/src \
  packages/shared/package.json \
  packages/shared/tsconfig.json \
  packages/mcp-server/src \
  packages/mcp-server/package.json \
  packages/mcp-server/tsconfig.json \
  package.json \
  package-lock.json \
  tsconfig.base.json \
  docker-compose.yml \
  2>/dev/null | $SSH_CMD "cd $NAS_DEPLOY_DIR && tar xzf -"

echo "==> Rebuilding Docker container..."
$SSH_CMD "cd $NAS_DEPLOY_DIR && $DOCKER compose up -d --build" 2>&1 | tail -5

echo "==> Waiting for server to start..."
sleep 5

if [[ "${1:-}" != "--skip-smoke" ]]; then
  echo "==> Running smoke tests..."
  npx tsx scripts/smoke-test.ts

  # The integration tier cannot run in GitHub Actions — it needs ~/.airchat
  # credentials and a live server. This is the one place both exist, so it runs
  # here or it rots: it previously sat broken through two refactors because
  # nothing ran it.
  echo "==> Running integration tests..."
  npm run test:integration
else
  echo "==> Skipping smoke and integration tests"
fi

echo "==> Deploy complete"

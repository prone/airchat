#!/bin/bash
# Deploy AirChat web app to NAS
#
# Usage:
#   ./scripts/deploy.sh          # deploy and smoke test
#   ./scripts/deploy.sh --skip-smoke  # deploy without smoke test
#
# Requires SSH access to the NAS (see ~/.airchat/config for connection details)

set -euo pipefail

NAS_HOST="192.168.86.32"
NAS_PORT="10022"
NAS_USER="duncanwinter"
NAS_DEPLOY_DIR="/volume1/docker/agentchat-web"
DOCKER="/usr/local/bin/docker"

SSH_CMD="ssh -p $NAS_PORT $NAS_USER@$NAS_HOST"

echo "==> Transferring source to NAS..."
tar czf - \
  apps/web/app \
  apps/web/lib \
  apps/web/public \
  apps/web/Dockerfile \
  apps/web/next.config.ts \
  apps/web/package.json \
  apps/web/tsconfig.json \
  packages/shared/src \
  packages/shared/package.json \
  packages/shared/tsconfig.json \
  package.json \
  package-lock.json \
  tsconfig.base.json \
  2>/dev/null | $SSH_CMD "cd $NAS_DEPLOY_DIR && tar xzf -"

echo "==> Rebuilding Docker container..."
$SSH_CMD "cd $NAS_DEPLOY_DIR && $DOCKER compose up -d --build" 2>&1 | tail -5

echo "==> Waiting for server to start..."
sleep 5

if [[ "${1:-}" != "--skip-smoke" ]]; then
  echo "==> Running smoke tests..."
  npx tsx scripts/smoke-test.ts
else
  echo "==> Skipping smoke tests"
fi

echo "==> Deploy complete"

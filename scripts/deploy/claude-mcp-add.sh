#!/usr/bin/env bash
# Registra el MCP de Moki (en la Raspberry) en Claude Code, con el token del Llavero de macOS.
#   bash scripts/deploy/claude-mcp-add.sh [--scope user|project|local]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_CONFIG="$ROOT_DIR/deploy.local.env"
if [[ -f "$LOCAL_CONFIG" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$LOCAL_CONFIG"
  set +a
fi
: "${MOKI_DEPLOY_SSH:?Define MOKI_DEPLOY_SSH en deploy.local.env}"
: "${MOKI_DEPLOY_URL:?Define MOKI_DEPLOY_URL en deploy.local.env}"

TOKEN="$(security find-generic-password -s moki -a "$MOKI_DEPLOY_SSH" -w 2>/dev/null || true)"
[[ -n "$TOKEN" ]] || { echo "Error: no hay token en el Llavero. Ejecuta antes scripts/deploy/setup-secrets.sh" >&2; exit 1; }

claude mcp add --transport http "${@}" moki "$MOKI_DEPLOY_URL/mcp" --header "Authorization: Bearer $TOKEN"
echo "✓ MCP \"moki\" registrado en Claude Code → $MOKI_DEPLOY_URL/mcp"

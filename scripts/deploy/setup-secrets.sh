#!/usr/bin/env bash
# Configuración inicial (una vez) de la Raspberry, desde el Mac:
#   - genera un MOKI_TOKEN aleatorio (o reutiliza el guardado) y lo guarda en el Llavero de macOS
#     (servicio "moki", cuenta = MOKI_DEPLOY_SSH);
#   - escribe la configuración de Moki en la Pi (<MOKI_DEPLOY_DIR>/.env, permisos 600) por ssh.
# El token nunca se imprime ni se guarda en el repositorio.
#
#   bash scripts/deploy/setup-secrets.sh            # crea la configuración si no existe
#   bash scripts/deploy/setup-secrets.sh --force    # la reescribe (mismo token del Llavero)
#   bash scripts/deploy/setup-secrets.sh --rotate   # token nuevo (hay que volver a registrar el MCP)
#
# Variables (en deploy.local.env): MOKI_DEPLOY_SSH, MOKI_DEPLOY_DIR, MOKI_DEPLOY_URL y,
# opcionalmente, MOKI_ALLOWED_HOSTS (nombres/IPs extra con los que entras a la Pi),
# MOKI_DEPLOY_PROFILE (pi | server) y MOKI_MEM_LIMIT (límite de memoria del contenedor; por
# defecto 1536m en la Pi y 6g en el perfil server).
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
REMOTE="$MOKI_DEPLOY_SSH"
REMOTE_DIR="${MOKI_DEPLOY_DIR:-~/moki}"
MODE="${1:-}"

command -v security >/dev/null 2>&1 || { echo "Error: este script usa el Llavero de macOS (security)." >&2; exit 1; }

# Host y puerto a partir de la URL (http://host:puerto).
HOSTPORT="${MOKI_DEPLOY_URL#*://}"
HOSTPORT="${HOSTPORT%%/*}"
PI_HOST="${HOSTPORT%%:*}"
PI_PORT="7410"
[[ "$HOSTPORT" == *:* ]] && PI_PORT="${HOSTPORT##*:}"
ALLOWED="${MOKI_ALLOWED_HOSTS:-$PI_HOST}"
DEFAULT_MEM="1536m"
[[ "${MOKI_DEPLOY_PROFILE:-pi}" == "server" ]] && DEFAULT_MEM="6g"
MEM_LIMIT="${MOKI_MEM_LIMIT:-$DEFAULT_MEM}"

KEYCHAIN_SERVICE="moki"
TOKEN="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$REMOTE" -w 2>/dev/null || true)"
if [[ -z "$TOKEN" || "$MODE" == "--rotate" ]]; then
  TOKEN="$(openssl rand -hex 24)"
  security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$REMOTE" -l "Moki token ($REMOTE)" -w "$TOKEN"
  echo "✓ Token nuevo guardado en el Llavero (servicio \"$KEYCHAIN_SERVICE\", cuenta \"$REMOTE\")"
else
  echo "✓ Token existente en el Llavero"
fi

ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
if ssh "$REMOTE" "test -f $REMOTE_DIR/.env" && [[ "$MODE" != "--force" && "$MODE" != "--rotate" ]]; then
  echo "$REMOTE ya tiene configuración ($REMOTE_DIR/.env); no se toca. Usa --force para reescribirla."
  exit 0
fi

# Se envía por stdin (no aparece en la línea de comandos ni en los logs).
ssh "$REMOTE" "umask 077 && cat > $REMOTE_DIR/.env" <<CONF
# Configuración de Moki en este servidor. Generado por scripts/deploy/setup-secrets.sh.
MOKI_TOKEN=$TOKEN
MOKI_PI_HOST=$PI_HOST
MOKI_PI_PORT=$PI_PORT
MOKI_ALLOWED_HOSTS=$ALLOWED
MOKI_MEM_LIMIT=$MEM_LIMIT
MOKI_MEMSWAP_LIMIT=$MEM_LIMIT
CONF
echo "✓ Configuración escrita en $REMOTE:$REMOTE_DIR/.env (permisos 600)"
echo "  Hosts permitidos: $ALLOWED · Publicado en el puerto $PI_PORT"

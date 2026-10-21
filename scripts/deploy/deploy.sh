#!/usr/bin/env bash
# Despliega Moki en la Raspberry: construye la imagen en este Mac, la copia a la carpeta de Moki
# en la Pi y la activa allí (con copia de seguridad de los datos antes de cambiar nada).
#
#   bash scripts/deploy/deploy.sh
#
# El destino NO está en el repositorio: se lee de `deploy.local.env` (ignorado por git; ver
# `deploy.local.env.example`) o de variables de entorno:
#   MOKI_DEPLOY_SSH   destino ssh (usuario@host, o un alias de ~/.ssh/config)   — obligatorio
#   MOKI_DEPLOY_DIR   carpeta de Moki en la Pi (por defecto ~/moki)
#   MOKI_DEPLOY_URL   URL para comprobar el despliegue desde este Mac (opcional)
#   SKIP_CHECKS=1     omite typecheck y tests
#
# Nunca se copian secretos: el fichero de configuración de la Pi se crea una vez allí (ver
# docs/DEPLOY.md) y el despliegue no lo toca.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
LOCAL_CONFIG="$ROOT_DIR/deploy.local.env"
if [[ -f "$LOCAL_CONFIG" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$LOCAL_CONFIG"
  set +a
fi

: "${MOKI_DEPLOY_SSH:?Define MOKI_DEPLOY_SSH (en deploy.local.env, ver deploy.local.env.example)}"
REMOTE="$MOKI_DEPLOY_SSH"
REMOTE_DIR="${MOKI_DEPLOY_DIR:-~/moki}"
IMAGE_TAG="moki:pi"
ARCHIVE="$ROOT_DIR/releases/moki-pi-$(date +%Y%m%d-%H%M%S).tar.gz"

if [[ "${SKIP_CHECKS:-0}" != "1" ]]; then
  echo "▸ Comprobaciones (typecheck + tests)…"
  npx tsc -p tsconfig.json
  npx vitest run --reporter=dot
fi

echo "▸ Comprobando acceso a $REMOTE…"
ssh -o ConnectTimeout=10 "$REMOTE" "mkdir -p $REMOTE_DIR/releases $REMOTE_DIR/scripts/deploy && command -v docker >/dev/null" \
  || { echo "Error: no hay acceso ssh a $REMOTE o Docker no está instalado allí." >&2; exit 1; }

OUTPUT_FILE="$ARCHIVE" bash "$ROOT_DIR/scripts/deploy/build-image.sh" "$IMAGE_TAG"

echo "▸ Copiando imagen y ficheros de despliegue a $REMOTE:$REMOTE_DIR…"
scp -q "$ARCHIVE" "$REMOTE:$REMOTE_DIR/releases/$(basename "$ARCHIVE")"
scp -q docker-compose.yml docker-compose.pi.yml "$ROOT_DIR/.env.example" "$REMOTE:$REMOTE_DIR/"
scp -q scripts/deploy/remote-update.sh "$REMOTE:$REMOTE_DIR/scripts/deploy/remote-update.sh"

echo "▸ Activando en la Raspberry…"
ssh "$REMOTE" "cd $REMOTE_DIR && bash scripts/deploy/remote-update.sh 'releases/$(basename "$ARCHIVE")'"

# Cada imagen ocupa cientos de MB: en este Mac se conservan las 3 últimas.
ls -1t "$ROOT_DIR"/releases/moki-pi-*.tar.gz 2>/dev/null | tail -n +4 | xargs rm -f || true

if [[ -n "${MOKI_DEPLOY_URL:-}" ]]; then
  if curl -fsS --max-time 10 "$MOKI_DEPLOY_URL/api/health" >/dev/null; then
    echo "✓ Moki responde en $MOKI_DEPLOY_URL"
  else
    echo "⚠ El despliegue terminó pero $MOKI_DEPLOY_URL/api/health no responde desde este Mac." >&2
  fi
fi

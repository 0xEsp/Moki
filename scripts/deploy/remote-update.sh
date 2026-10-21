#!/usr/bin/env bash
# Se ejecuta EN el servidor (Raspberry o Mac mini; lo llama deploy.sh). Carga una imagen nueva de
# Moki y recrea el contenedor sin tocar los datos: antes copia data/ (sin exports) a releases/.
#   MOKI_DEPLOY_PROFILE=pi|server bash scripts/deploy/remote-update.sh releases/moki-<perfil>-XXXX.tar.gz
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
ARCHIVE="${1:?Uso: bash scripts/deploy/remote-update.sh <imagen.tar.gz>}"
[[ -f "$ARCHIVE" ]] || { echo "Error: no existe $ARCHIVE" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Error: Docker no está instalado." >&2; exit 1; }

CONFIG_FILE="$ROOT_DIR/.env"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: falta la configuración de Moki en $CONFIG_FILE (token, host…)." >&2
  echo "Créala una vez a partir de .env.example (ver docs/DEPLOY.md) y vuelve a desplegar." >&2
  exit 1
fi

PROFILE="${MOKI_DEPLOY_PROFILE:-pi}"
COMPOSE=(docker compose -f docker-compose.yml -f "docker-compose.$PROFILE.yml")
IMAGE="$("${COMPOSE[@]}" config --images | head -n 1)"
[[ -n "$IMAGE" ]] || { echo "Error: no se pudo resolver la imagen del servicio." >&2; exit 1; }

# El contenedor corre con uid 1000; si data/ no existiera, Docker la crearía como root.
mkdir -p data releases

if [[ -n "$(ls -A data 2>/dev/null)" ]]; then
  BACKUP="releases/moki-data-$(date +%Y%m%d-%H%M%S).tar.gz"
  # Se para antes de copiar: el servidor guarda con debounce y así la copia es consistente.
  "${COMPOSE[@]}" stop moki >/dev/null 2>&1 || true
  tar -czf "$BACKUP" --exclude='data/exports' data
  chmod 600 "$BACKUP"
  echo "Copia de datos: $BACKUP"
fi

restore_on_failure() {
  echo "Error durante el despliegue; arranco de nuevo el contenedor anterior." >&2
  "${COMPOSE[@]}" up -d --no-build moki || true
}
trap restore_on_failure ERR

echo "Cargando imagen $ARCHIVE…"
LOAD_OUTPUT="$(docker load --input "$ARCHIVE")"
LOADED="$(printf '%s\n' "$LOAD_OUTPUT" | sed -n 's/^Loaded image: //p' | tail -n 1)"
[[ -n "$LOADED" ]] || { echo "Error: el archivo no contiene una imagen etiquetada." >&2; exit 1; }
[[ "$LOADED" == "$IMAGE" ]] || docker tag "$LOADED" "$IMAGE"

echo "Recreando el contenedor con $IMAGE…"
"${COMPOSE[@]}" up -d --no-build --force-recreate moki
trap - ERR

# Esperar a que responda (hasta 90 s). Chromium se lanza bajo demanda, no al arrancar.
OK=0
for _ in $(seq 1 45); do
  if docker exec moki node -e "fetch('http://127.0.0.1:7410/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    OK=1
    break
  fi
  sleep 2
done
[[ "$OK" == "1" ]] && echo "✓ Moki arrancado" || echo "⚠ Moki no responde todavía; revisa: docker logs moki" >&2

# Limpieza: últimas 3 imágenes y 5 copias de datos; capas huérfanas fuera.
# (`|| true`: en el primer despliegue no hay copias y `ls` falla, lo que con pipefail abortaría.)
ls -1t releases/moki-"$PROFILE"-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f || true
ls -1t releases/moki-data-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f || true
docker image prune -f >/dev/null 2>&1 || true

"${COMPOSE[@]}" ps
docker logs moki --tail 8 2>&1 || true

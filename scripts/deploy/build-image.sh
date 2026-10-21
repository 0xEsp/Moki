#!/usr/bin/env bash
# Construye la imagen de Moki para la Raspberry (linux/arm64) y la exporta a releases/*.tar.gz.
#   bash scripts/deploy/build-image.sh [tag]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_PLATFORM="${TARGET_PLATFORM:-linux/arm64}"
IMAGE_TAG="${1:-moki:pi}"

command -v docker >/dev/null 2>&1 || { echo "Error: Docker no está instalado o no está en PATH." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Error: el daemon de Docker no responde (¿Docker Desktop abierto?)." >&2; exit 1; }

SAFE_TAG="${IMAGE_TAG//\//-}"
SAFE_TAG="${SAFE_TAG//:/-}"
OUTPUT_DIR="$ROOT_DIR/releases"
OUTPUT_FILE="${OUTPUT_FILE:-$OUTPUT_DIR/${SAFE_TAG}-$(date +%Y%m%d-%H%M%S).tar.gz}"
mkdir -p "$OUTPUT_DIR"

echo "▸ Construyendo $IMAGE_TAG para $TARGET_PLATFORM…"
docker buildx build --platform "$TARGET_PLATFORM" --tag "$IMAGE_TAG" --load "$ROOT_DIR"

echo "▸ Exportando a $OUTPUT_FILE…"
docker save "$IMAGE_TAG" | gzip > "$OUTPUT_FILE"
echo "✓ Imagen lista: $IMAGE_TAG ($(du -h "$OUTPUT_FILE" | cut -f1))"

#!/usr/bin/env bash
# Roda o agente num container.
#
#   scripts/run.sh -p "crie hello.txt" --model opencode-go/modelo
#
# O cwd entra em /workspace (bind rw) e as sessões ficam no volume nomeado.
# Credenciais entram por env, nunca por mount de ~/.pi ou ~/.config.
#
# Runtime: `DURABLE_PI_RUNTIME=podman|wslc|docker` (padrão: auto, nessa ordem).
# Em WSL, o `wslc` vem do Windows e não está no PATH; aponte com
# `DURABLE_PI_WSLC` se preciso.
set -euo pipefail

IMAGE="${DURABLE_PI_IMAGE:-durable-pi:dev}"
VOLUME="${DURABLE_PI_VOLUME:-durable-pi-home}"
RUNTIME="${DURABLE_PI_RUNTIME:-auto}"
WSLC="${DURABLE_PI_WSLC:-/mnt/c/Program Files/WSL/wslc.exe}"

if [ "$RUNTIME" = "auto" ]; then
	if command -v podman >/dev/null 2>&1; then
		RUNTIME=podman
	elif [ -x "$WSLC" ]; then
		RUNTIME=wslc
	elif command -v wslc.exe >/dev/null 2>&1; then
		RUNTIME=wslc
		WSLC="$(command -v wslc.exe)"
	elif command -v docker >/dev/null 2>&1; then
		RUNTIME=docker
	else
		echo "nenhum runtime de container encontrado (podman, wslc ou docker)" >&2
		exit 1
	fi
fi

case "$RUNTIME" in
	podman) CLI=podman ;;
	docker) CLI=docker ;;
	wslc) CLI="$WSLC" ;;
	*)
		echo "runtime desconhecido: $RUNTIME" >&2
		exit 1
		;;
esac

if ! "$CLI" image inspect "$IMAGE" >/dev/null 2>&1; then
	echo "imagem $IMAGE ausente; rode: $RUNTIME build -t $IMAGE ." >&2
	exit 1
fi

# Idempotente: o wslc falha se o volume já existe.
"$CLI" volume create "$VOLUME" >/dev/null 2>&1 || true
# O volume nasce root; alinha com o usuário do host para não gravar arquivos root.
"$CLI" run --rm --user 0:0 -v "$VOLUME:/home/agent" --entrypoint chown \
	"$IMAGE" -R "$(id -u):$(id -g)" /home/agent >/dev/null

args=(--rm --user "$(id -u):$(id -g)")
if [ -t 0 ] && [ -t 1 ]; then args+=(-it); fi
args+=(-v "$PWD:/workspace" -v "$VOLUME:/home/agent" -w /workspace)
for name in DURABLE_PI_MODEL ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_API_KEY; do
	if [ -n "${!name:-}" ]; then args+=(-e "$name"); fi
done

exec "$CLI" run "${args[@]}" "$IMAGE" "$@"

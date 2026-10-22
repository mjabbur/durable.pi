#!/usr/bin/env bash
# Roda o agente num container.
#
#   scripts/run.sh -p "crie hello.txt" --model opencode-go/modelo
#
# O cwd entra em /workspace (bind rw) e as sessões ficam no volume nomeado.
# Credenciais entram por env, nunca por mount de ~/.pi ou ~/.config.
set -euo pipefail

IMAGE="${DURABLE_PI_IMAGE:-durable-pi:dev}"
VOLUME="${DURABLE_PI_VOLUME:-durable-pi-home}"
UID_GID="$(id -u):$(id -g)"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	echo "imagem $IMAGE ausente; rode: docker build -t $IMAGE ." >&2
	exit 1
fi

docker volume create "$VOLUME" >/dev/null
# O volume nasce root; alinha com o usuário do host para não gravar arquivos root.
docker run --rm --user 0:0 -v "$VOLUME:/home/agent" --entrypoint chown "$IMAGE" \
	-R "$UID_GID" /home/agent >/dev/null

args=(--rm -it --user "$UID_GID")
args+=(-v "$PWD:/workspace" -v "$VOLUME:/home/agent" -w /workspace)
for name in DURABLE_PI_MODEL ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_API_KEY; do
	if [ -n "${!name:-}" ]; then args+=(-e "$name"); fi
done

exec docker run "${args[@]}" "$IMAGE" "$@"

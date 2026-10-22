#!/usr/bin/env bash
# Roda o agente num container.
#
#   scripts/run.sh -p "crie hello.txt" --model opencode-go/modelo
#
# O cwd entra em /workspace (bind rw) e as sessões ficam no volume nomeado.
# Credenciais entram por env, nunca por mount de ~/.pi ou ~/.config.
#
# Runtime e caminhos, em ordem de precedência:
#   1. variável de ambiente (DURABLE_PI_PODMAN, DURABLE_PI_WSLC, DURABLE_PI_DOCKER)
#   2. arquivo de config (DURABLE_PI_CONFIG, padrão ~/.config/durable-pi/container.conf)
#   3. PATH do sistema (e, para o wslc, o caminho padrão do Windows)
#
# Runtime: `DURABLE_PI_RUNTIME=podman|wslc|docker`; `auto` (padrão) tenta nessa
# ordem. `scripts/run.sh --runtime-info` mostra o que seria usado, sem rodar nada.
set -euo pipefail

CONFIG_FILE="${DURABLE_PI_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/durable-pi/container.conf}"
WSLC_DEFAULT="${DURABLE_PI_WSLC_DEFAULT:-/mnt/c/Program Files/WSL/wslc.exe}"

# O ambiente vence o arquivo: guarda antes de carregar e reaplica depois.
env_runtime="${DURABLE_PI_RUNTIME-}"
env_podman="${DURABLE_PI_PODMAN-}"
env_wslc="${DURABLE_PI_WSLC-}"
env_docker="${DURABLE_PI_DOCKER-}"
env_image="${DURABLE_PI_IMAGE-}"
env_volume="${DURABLE_PI_VOLUME-}"

if [ -f "$CONFIG_FILE" ]; then
	# shellcheck disable=SC1090
	. "$CONFIG_FILE"
fi
[ -n "$env_runtime" ] && DURABLE_PI_RUNTIME="$env_runtime"
[ -n "$env_podman" ] && DURABLE_PI_PODMAN="$env_podman"
[ -n "$env_wslc" ] && DURABLE_PI_WSLC="$env_wslc"
[ -n "$env_docker" ] && DURABLE_PI_DOCKER="$env_docker"
[ -n "$env_image" ] && DURABLE_PI_IMAGE="$env_image"
[ -n "$env_volume" ] && DURABLE_PI_VOLUME="$env_volume"

RUNTIME="${DURABLE_PI_RUNTIME:-auto}"
IMAGE="${DURABLE_PI_IMAGE:-durable-pi:dev}"
VOLUME="${DURABLE_PI_VOLUME:-durable-pi-home}"

# resolve_bin <caminho explícito> <nome no PATH> <fallback>
resolve_bin() {
	if [ -n "$1" ]; then
		[ -x "$1" ] && printf '%s' "$1"
		return 0
	fi
	if command -v "$2" >/dev/null 2>&1; then
		command -v "$2"
		return 0
	fi
	if [ -n "$3" ] && [ -x "$3" ]; then
		printf '%s' "$3"
	fi
	return 0
}

PODMAN_BIN="$(resolve_bin "${DURABLE_PI_PODMAN:-}" podman "")"
WSLC_BIN="$(resolve_bin "${DURABLE_PI_WSLC:-}" wslc.exe "$WSLC_DEFAULT")"
DOCKER_BIN="$(resolve_bin "${DURABLE_PI_DOCKER:-}" docker "")"

case "$RUNTIME" in
	podman)
		[ -n "$PODMAN_BIN" ] || { echo "podman não encontrado; defina DURABLE_PI_PODMAN" >&2; exit 1; }
		CLI="$PODMAN_BIN"
		;;
	wslc)
		[ -n "$WSLC_BIN" ] || { echo "wslc não encontrado; defina DURABLE_PI_WSLC" >&2; exit 1; }
		CLI="$WSLC_BIN"
		;;
	docker)
		[ -n "$DOCKER_BIN" ] || { echo "docker não encontrado; defina DURABLE_PI_DOCKER" >&2; exit 1; }
		CLI="$DOCKER_BIN"
		;;
	auto)
		if [ -n "$PODMAN_BIN" ]; then
			RUNTIME=podman; CLI="$PODMAN_BIN"
		elif [ -n "$WSLC_BIN" ]; then
			RUNTIME=wslc; CLI="$WSLC_BIN"
		elif [ -n "$DOCKER_BIN" ]; then
			RUNTIME=docker; CLI="$DOCKER_BIN"
		else
			echo "nenhum runtime encontrado (podman, wslc, docker)" >&2
			echo "defina DURABLE_PI_PODMAN, DURABLE_PI_WSLC ou DURABLE_PI_DOCKER, ou use $CONFIG_FILE" >&2
			exit 1
		fi
		;;
	*)
		echo "runtime desconhecido: $RUNTIME (use podman, wslc, docker ou auto)" >&2
		exit 1
		;;
esac

if [ "${1:-}" = "--runtime-info" ]; then
	printf 'runtime=%s\nbin=%s\nimage=%s\nvolume=%s\nconfig=%s\n' \
		"$RUNTIME" "$CLI" "$IMAGE" "$VOLUME" "$CONFIG_FILE"
	exit 0
fi

if [ "$(id -u)" = "0" ] && [ "${DURABLE_PI_ALLOW_ROOT:-0}" != "1" ]; then
	echo "não rode o agente como root: o container inteiro herda o privilégio." >&2
	echo "use um usuário comum ou defina DURABLE_PI_ALLOW_ROOT=1." >&2
	exit 1
fi

if ! "$CLI" image inspect "$IMAGE" >/dev/null 2>&1; then
	echo "imagem $IMAGE ausente; rode: $RUNTIME build -t $IMAGE ." >&2
	exit 1
fi

# Idempotente: o wslc falha se o volume já existe.
"$CLI" volume create "$VOLUME" >/dev/null 2>&1 || true

args=(--rm --user "$(id -u):$(id -g)")
rootless=false
if [ "$RUNTIME" = "podman" ]; then
	info="$("$CLI" info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)"
	[ "$info" = "true" ] && rootless=true
fi

if [ "$rootless" = "true" ]; then
	# Rootless: o volume já pertence ao usuário no host, e keep-id faz o UID
	# interno casar com o externo. `chown` como root aqui cairia num subuid
	# diferente do dono, deixando o volume sem permissão para o agente.
	args+=(--userns=keep-id)
else
	# Volume nasce root; alinha com o usuário do host para não gravar como root.
	"$CLI" run --rm --user 0:0 -v "$VOLUME:/home/agent" --entrypoint chown \
		"$IMAGE" -R "$(id -u):$(id -g)" /home/agent >/dev/null
fi

# Identidade do projeto no host: dentro do container todo repositório monta em
# /workspace, então o agente precisa do caminho real para recusar retomada em
# outro projeto.
export DURABLE_PI_WORKSPACE="${DURABLE_PI_WORKSPACE:-$PWD}"
if [ -t 0 ] && [ -t 1 ]; then args+=(-it); fi
args+=(-v "$PWD:/workspace" -v "$VOLUME:/home/agent" -w /workspace)
# Só o nome da variável entra na linha de comando; o valor fica no ambiente.
for name in DURABLE_PI_MODEL DURABLE_PI_WORKSPACE ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY OPENCODE_API_KEY GEMINI_API_KEY; do
	if [ -n "${!name:-}" ]; then args+=(-e "$name"); fi
done

exec "$CLI" run "${args[@]}" "$IMAGE" "$@"

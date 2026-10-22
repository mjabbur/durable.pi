#!/usr/bin/env bash
# Escreve testes a partir de specs/<spec>/spec.md usando um modelo, em diretório
# isolado, e mede o resultado.
# Uso: scripts/bakeoff.sh <provider/model> [spec]
#      SCORE_ONLY=1 scripts/bakeoff.sh <provider/model> [spec]
# A spec é o slug em specs/; o stub correspondente fica em
# bakeoff/fixtures/<spec>/src/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${1:?uso: scripts/bakeoff.sh <provider/model> [spec]}"
SPEC="${2:-counter}"
SLUG="${MODEL//\//__}"
RUNS="$ROOT/bakeoff/runs/$SLUG/$SPEC"

if [ "${SCORE_ONLY:-0}" = "1" ]; then
	OUT="$(ls -d "$RUNS"/run-* 2>/dev/null | sort -V | tail -1 || true)"
	[ -n "$OUT" ] || { echo "sem resultado em $RUNS" >&2; exit 1; }
else
	N=1
	while [ -d "$RUNS/run-$N" ]; do N=$((N + 1)); done
	OUT="$RUNS/run-$N"
fi

count() {
	local pattern="$1" total=0 n f
	for f in "$OUT"/test/*.ts; do
		[ -e "$f" ] || continue
		n="$(grep -hoE "$pattern" "$f" 2>/dev/null | wc -l)" || true
		n="${n//[[:space:]]/}"
		total=$((total + ${n:-0}))
	done
	echo "$total"
}

if [ "${SCORE_ONLY:-0}" != "1" ]; then
	STARTED="$(date -Is)"
	START_EPOCH="$(date +%s)"
	WORK="$(mktemp -d "${TMPDIR:-/tmp}/bakeoff.XXXXXX")"
	trap 'rm -rf "$WORK"' EXIT

	mkdir -p "$WORK/src" "$WORK/test" "$OUT"
	cp "$ROOT"/bakeoff/fixtures/{AGENTS.md,tsconfig.json,package.json} "$WORK/"
	cp "$ROOT/specs/$SPEC/spec.md" "$WORK/spec.md"
	cp -a "$ROOT/bakeoff/fixtures/$SPEC/src/." "$WORK/src/"
	ln -s "$ROOT/node_modules" "$WORK/node_modules"

	PROMPT="Leia AGENTS.md e spec.md. Escreva um arquivo de teste em test/ cobrindo a spec, com no máximo 10 testes. Não implemente src/."

	set +e
	( cd "$WORK" && timeout "${PI_TIMEOUT:-240}" pi --print --no-session --model "$MODEL" --thinking "${PI_THINKING:-low}" \
		--tools read,grep,find,ls,write "$PROMPT" ) > "$OUT/response.md" 2> "$OUT/pi.err"
	PI_EXIT=$?
	( cd "$WORK" && npx tsc --noEmit ) > "$OUT/tsc.log" 2>&1
	TSC_EXIT=$?
	set -e

	rm -rf "$OUT/test"
	mkdir -p "$OUT/test"
	cp -a "$WORK/test/." "$OUT/test/" 2>/dev/null || true

	printf 'started_at: %s\nfinished_at: %s\nduration_s: %s\npi_exit: %s\ntsc_exit: %s\n' \
		"$STARTED" "$(date -Is)" "$(( $(date +%s) - START_EPOCH ))" "$PI_EXIT" "$TSC_EXIT" \
		> "$OUT/summary.txt"
	printf 'thinking: %s\n' "${PI_THINKING:-low}" >> "$OUT/summary.txt"
else
	[ -d "$OUT/test" ] || { echo "sem resultado em $OUT" >&2; exit 1; }
	: > "$OUT/summary.txt"
fi

FILES="$(find "$OUT/test" -name '*.ts' | wc -l | tr -d ' ')"
TESTS="$(count '(^|[[:space:]])(it|test)\(')"
CITES="$(count 'Comportamento[^a-zA-Z]*[0-9]+|item [0-9]+')"
IMPORTS="$(count "from ['\"].*src/")"
LEAKS="$(count "(read|grep)\(.*src/|cat .*src/")"
TOKENS="$(grep -hoE '"total_tokens":[0-9]+' "$OUT/response.md" 2>/dev/null | tail -1 | tr -dc '0-9' || true)"

{
	echo "model: $MODEL"
	echo "spec: $SPEC"
	echo "wrote_test: $([ "$FILES" -gt 0 ] && echo 1 || echo 0)"
	echo "test_files: $FILES"
	echo "tests: $TESTS"
	echo "spec_citations: $CITES"
	echo "src_imports: $IMPORTS"
	echo "impl_reads: $LEAKS"
	echo "tokens: ${TOKENS:-?}"
} | tee -a "$OUT/summary.txt"

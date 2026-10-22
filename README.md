# durable.pi

Agentes duráveis em Node/TypeScript sobre [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
Experimental: o comportamento acompanha a versão fixada no `package.json`.

O princípio do projeto: estado é o que foi commitado; memória é cache. Todo
efeito externo é precedido de intenção durável e reconciliado por chave.

## Requisitos

Node 24 (`>=22`) e npm. A versão de referência está em `.nvmrc`.

## Comandos

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run test        # vitest
```

Pronto = os três verdes. O CI roda a mesma sequência.

## Estrutura

| Caminho | Papel |
|---|---|
| `src/` | implementação (`counter`, `charge`) |
| `specs/<slug>/spec.md` | contrato de efeitos e comportamento numerado |
| `test/spec/` | testes derivados da spec, um por comportamento |
| `test/invariants.test.ts` | atomicidade, persistência, serialização |
| `test/crash.test.ts` | `SIGKILL` em processo filho, sem efeito duplicado |
| `docs/DURABILITY.md` | por que cada invariante existe |
| `docs/RUNBOOK.md` | sintoma, diagnóstico e ação em produção |
| `docs/PI-CODE-MAP.md` | mapa do código do Pi e do pi-durable |
| `docs/ROADMAP.md` | marco do Pi durável: CLI, servidor e web |
| `bakeoff/` | bancada que gera testes a partir da spec |
| `scripts/` | automação da bancada |

## Fluxo

1. Escreva `specs/<slug>/spec.md` com o contrato de efeitos: chave de
   idempotência, onde é gravada, o que acontece em cada ponto de crash.
2. Gere os testes a partir da spec, sem acesso a `src/`, e adote em
   `test/spec/` depois de revisar.
3. Implemente em `src/` até os testes ficarem verdes.
4. Se a mudança toca falha, acrescente invariante ou crash test.

Desvio da spec atualiza a spec no mesmo PR.

## Uso (M0/M1)

O agente roda em container; o host só precisa de Docker.

```bash
npm run build                       # compila para dist/
docker build -t durable-pi:dev .
mkdir -p ~/.config/durable-pi
echo '{"model": "opencode-go/seu-modelo"}' > ~/.config/durable-pi/config.json
export OPENROUTER_API_KEY=...       # a chave do provedor usado
scripts/run.sh -p "crie hello.txt com olá"
scripts/run.sh -c -p "agora leia o arquivo"   # continua a sessão mais recente
scripts/run.sh -c                             # TUI na sessão mais recente
```

Sem `-p` o CLI abre a TUI (exige TTY): transcript com streaming, editor e
`Ctrl+C` para abortar a geração ou o `!comando` em execução — o segundo
`Ctrl+C`, ocioso, sai. Comandos: `/help`, `/usage`, `/compact`,
`/model [p/m]`, `/thinking [nível]`, `/new`, `/resume [id]`, `/quit`, e
`!comando`, que roda no shell do workspace, fora do modelo.

O resultado do `!` fica no transcript como entrada durável, então reaparece ao
retomar; comando interrompido não é reexecutado. `/new` cria outra sessão e
`/resume` sem argumento abre o seletor; a troca é feita pelo dono do storage
(o `main()`), que abre a nova antes de fechar a anterior.

| Flag | Efeito |
|---|---|
| `-p, --print <texto>` | prompt; imprime a resposta final e sai (sem ele, TUI) |
| `--model <p/m>` | provider/modelo só desta execução; sem ele, `DURABLE_PI_MODEL` ou o config |
| `--session <id>` | abre uma sessão específica |
| `-c, --continue` | continua a sessão mais recente |
| `--session-dir <dir>` | diretório das sessões |
| `--no-session` | não grava sessão |

As sessões ficam no volume `durable-pi-home`, em
`/home/agent/.local/share/durable-pi/sessions/<id>.sqlite`. O `cwd` entra em
`/workspace`; o agente só vê o que estiver montado.

Três regras de sessão:

- **Um dono por vez.** Um SQLite `<sessão>.lock` guarda uma transação
  exclusiva enquanto o agente está aberto; o segundo processo recebe "em uso".
  Se o dono morreu, o kernel libera o lock e a próxima execução abre normalmente.
- **Sessão vinculada ao projeto.** Reabrir de outro `cwd` ou de outro
  workspace falha, porque o alvo das tools mudaria em silêncio. No container
  todo repositório monta em `/workspace`, então o `run.sh` passa o caminho do
  host em `DURABLE_PI_WORKSPACE` — é ele que distingue dois projetos.
- **Modelo vem do config, não da sessão.** A ordem é `--model`, depois
  `DURABLE_PI_MODEL`, depois `~/.config/durable-pi/config.json`
  (`{"model": "provider/modelo"}`, sobrescrito por `DURABLE_PI_AGENT_CONFIG`).
  `--model` vale só para a execução; a sessão guarda o último usado, mas ele
  nunca é default.
- **Recuperação exige a mesma sessão.** Sem `--session`/`-c` cada execução abre
  outro arquivo. Em falha, o CLI imprime `sessão: <id>` para retomar.

### WSL

No WSL o runtime é o `wslc` (WSL containers, WSL ≥ 2.9.3), não há Docker no
distro. O binário fica no lado Windows:

```bash
"/mnt/c/Program Files/WSL/wslc.exe" build -t durable-pi:dev .
scripts/run.sh --help          # detecta wslc sozinho
```

`scripts/run.sh` detecta podman, wslc ou docker (`auto` tenta nessa ordem) e
aceita caminhos explícitos por variável de ambiente ou por arquivo de config,
com o ambiente vencendo o arquivo:

```bash
# ~/.config/durable-pi/container.conf  (modelo em scripts/container.conf.example)
DURABLE_PI_RUNTIME=auto
DURABLE_PI_WSLC="/mnt/c/Program Files/WSL/wslc.exe"
# DURABLE_PI_PODMAN=/usr/bin/podman
# DURABLE_PI_DOCKER=/usr/bin/docker
# DURABLE_PI_IMAGE=durable-pi:dev
# DURABLE_PI_VOLUME=durable-pi-home
```

`scripts/run.sh --runtime-info` mostra runtime, binário, imagem, volume e
caminho do config sem executar nada.

### Credenciais

A chave do provedor entra por env, nunca por mount de `~/.pi` ou `~/.config`.
As variáveis vão por um arquivo temporário (`--env-file`, modo 0600, removido no
fim): o wslc ignora `-e NAME` sem valor, então o valor nunca chegava ao
container, e `-e NAME=VALUE` colocaria segredo na linha de comando.
Todos os provedores embutidos do pi-ai são registrados; cada um lê a sua
variável: `OPENCODE_API_KEY` (opencode-go), `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, entre outras.

Credencial de `git` **não entra no container** no v1: o agente commita, e o
push é feito no host. Token em env é legível por qualquer processo do
container, inclusive um comando gerado pelo modelo; quando push automático for
requisito, a solução é um proxy de credencial no host via socket, com token
fora do container.

## Bake-off

```bash
scripts/bakeoff.sh opencode-go/muse-spark-1.3-contributor charge
```

Roda em diretório isolado, mede artefato (`wrote_test`, `tsc_exit`, citações) e
grava em `bakeoff/runs/<modelo>/<spec>/run-N/`. Modelo e critérios em
`bakeoff/models.txt` e `NOTES.md`.

## Licença

MIT. Veja [LICENSE](LICENSE).

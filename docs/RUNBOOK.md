# Runbook

Operação do agente durável em produção. Complementa `docs/DURABILITY.md` (por quê)
e `test/invariants.test.ts` (prova). Preencha os campos entre `<>` antes do
primeiro deploy.

## Escopo

| Item | Valor |
|---|---|
| Serviço / processo | `<nome>` |
| Storage | SQLite em `<caminho do .sqlite>` |
| Versão do pi-durable | fixada no `package.json` |
| Dono dos invariantes | `<pessoa>` |
| Canal de alerta | `<canal>` |

## Coleta antes de agir

1. `closed.reason` e o erro: `failed` ou `closed`.
2. Estado: `await harness.inspect(ctx)` — `scheduling`, tasks `blocked` com
   `reason`, `submissions` pendentes.
3. Copie o `.sqlite` **e** o `.sqlite-wal` juntos, antes de qualquer escrita.
4. Anote ids de task e submissão citados nos logs.

```ts
const view = await harness.inspect(ctx);
console.log(view.scheduling);
for (const task of view.tasks) {
	if (task.state.kind === "blocked") console.log(task.id, task.state.reason);
}
```

## Sintomas

| Sintoma | Vá para |
|---|---|
| Processo reiniciou sozinho | P1 |
| `SessionFailed` / erro de storage | P2 |
| Task parada, `task_parked` | P3 |
| Submissão sem resposta | P4 |
| `ConversationBusy` | P5 |

## P1. Processo reiniciou

1. `harness.closed` resolveu com `reason: "failed"`? Vá para P2.
2. `reason: "closed"` após `close()` é parada normal; tasks cortadas por crash
   contam para `restartLimit`, close não.
3. Reabra o Harness sobre o mesmo storage (um único processo).
4. Reenvie cada input com o **`requestId` original**, um por vez.

## P2. Falha de storage

Erro de storage é final: o Harness se fecha e nada é retentado.

1. **Não** retente `commit`. **Não** abra um segundo processo no mesmo arquivo.
2. Verifique disco, permissão, `-wal` e lock do arquivo.
3. Reabra, reenvie com o mesmo `requestId`; a submissão já admitida é
   encontrada, não duplicada.
4. Se repetir sem causa local, escale com o arquivo preservado e o `cause`.

## P3. Task estacionada

`restart_limit` (default 5) indica crash loop determinístico: a task derruba o
processo antes do próximo checkpoint.

1. `inspect()` confirma `blocked` com `reason: "restart_limit"`.
2. Corrija a causa (memória, laço, dependência).
3. `await harness.retryTask(id, ctx)`.
4. `reason: "missing_task"` ou `"migration_failed"`: a definição não está no
   registry. Instale a extensão na versão correta; `retryTask` não resolve.

## P4. Submissão sem resposta

1. `inspect().submissions`: `queued`, `placed` ou `unanswered`.
2. `unanswered` com `reason: "run_failed"`: o run falhou e `afterFailedRun`
   decidiu o destino da fila (`keep`, `continue`, `withdraw`).
3. Reenvio com o mesmo `requestId` devolve a submissão existente. Não gere um
   `requestId` novo para "resolver" — isso duplica o input.

## P5. Conversa ocupada

`ConversationBusy` é fluxo normal: há run em andamento. Enfileire a entrada ou
aguarde. Nunca abra um segundo writer nem contorne com `createSubmission` cru.

## Nunca faça

- Retentar `commit` depois de erro de storage.
- Editar o SQLite com o Harness aberto.
- Rodar dois processos sobre o mesmo storage.
- Trocar `requestId` para destravar duplicata.
- Marcar `task_parked` como resolvida sem corrigir a causa.

## Escalonamento

Escale para o dono dos invariantes quando: teste de invariante falhar, houver
suspeita de efeito externo duplicado, ou for necessário mudar `DURABILITY.md`.
Preserve banco + WAL, logs com `reason`/`cause` e os ids citados.

## Game day

Mensal, em staging: `kill -9` no meio de uma geração e siga este documento ao
pé da letra. O que não funcionar é bug do runbook, não do operador.

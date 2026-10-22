# Durabilidade no pi-durable

O processo pode morrer entre dois `await`. O Harness garante que nada é mostrado
antes do commit. Seu código precisa garantir a outra metade: reexecutar depois de
um crash não pode duplicar efeito nem perder entrada. Este documento explica por
que cada invariante do `AGENTS.md` existe.

## 1. Callback de commit puro

Problema: efeito externo dentro do commit.

```ts
await root.commit(async (tx) => {
	await stripe.charge(...);      // executou
	await tx.entry(UserEntry, ...); // nunca commitou: processo morreu
}, context);
```

Ao reabrir, o input é reexecutado e a cobrança acontece de novo. O commit virou
um ponto de duplicação, não de recuperação.

Regra: commit só monta estado (`tx.entry`, `tx.doc`). Efeito externo pertence a
uma fase de task, e cada fase termina com um checkpoint.

## 2. Intenção antes do efeito

Problema: task chama a API e morre antes de gravar o resultado. O replay não
sabe se a chamada aconteceu.

Solução: duas escritas, com a chave no meio.

```ts
const callId = crypto.randomUUID();

await root.commit(async (tx) => {
	const state = await tx.doc(Charges, root.id);
	state.calls.push({ callId, status: "pending" });
}, context);

const result = await stripe.charge(amount, { idempotencyKey: callId });

await root.commit(async (tx) => {
	const state = await tx.doc(Charges, root.id);
	const call = state.calls.find((c) => c.callId === callId);
	if (call) Object.assign(call, { status: "done", result });
}, context);
```

No resume, `pending` significa "talvez aconteceu": consulte o provedor pela
`callId` antes de repetir. A idempotency key não é otimização; é o que permite
reconciliar.

## 3. Determinismo entre checkpoints

Problema: o prompt ou a decisão depende de relógio, aleatoriedade, env ou rede.

```ts
const prompt = `Hoje é ${new Date().toISOString()}. ${task}`; // muda no replay
```

O replay gera um prompt diferente, o modelo responde outra coisa e o histórico
deixa de explicar o estado atual.

Solução: capture na borda (payload do `submit` ou o primeiro commit da task) e
releia o valor gravado. O mesmo vale para `Math.random()`, `process.env` e
respostas de rede usadas em decisão.

## 4. `Context` tem vida curta

`Context` do Chord carrega o `AbortSignal` da operação e o span de telemetria.
Guardar em campo de classe ou módulo faz a próxima operação herdar cancelamento
já disparado e gravar spans no pai errado. Passe como parâmetro e descarte após
o settle.

## 5. Checkpoints limitam o replay

`defineDoc` exige `checkpointWhen`. Quando ele retorna `true`, o documento grava
uma base completa; sem isso, cada resume reexecuta desde o início do documento.
Política preguiçosa demais degrada o tempo de retomada; agressiva demais infla o
storage. Teste com `PI_DURABLE_DOCUMENT_RETENTION_MS=0` para forçar replay máximo.

## 6. Falha de storage encerra o Harness

Regra do pacote, não sua: qualquer erro de `commit()` encerra o Harness e
rejeita waits pendentes com `SessionFailed` (o erro original vem em `cause`).
Não retente `commit`; reabra e reenvie com o mesmo `requestId`, que encontra a
submissão já admitida.

```ts
harness.closed.then((end) => {
	if (end.reason === "failed") reopen(end.error);
});
```

Leituras inválidas (`StorageRequestError`) falham só a chamada. Exceção: falha
de leitura em `commit` também encerra.

Tasks que derrubam o processo antes do próximo checkpoint incrementam o contador
de restart. Ao atingir `restartLimit` (default 5), a task é estacionada com
`task_parked`; `harness.retryTask(id)` a executa de novo. Tasks que não devem
sobreviver ao restart usam `abandonOnRestart: true`.

## 7. Teste de crash

O teste barato simula o crash no mesmo processo: execute até o ponto, feche o
storage sem concluir a task, reabra e reenvie a mesma submissão.

O teste real roda em processo filho: mata com `SIGKILL`, reabre o arquivo SQLite
e verifica os invariantes. Implementado em `test/crash.test.ts`; o processo filho
é `test/fixtures/effect-child.mjs`.

Asserts que importam:

- um efeito externo por input, mesmo após N restarts;
- nenhum input admitido é perdido;
- nenhuma entry parcial no transcript;
- `requestId` repetido devolve a mesma submissão, não cria outra.

## 8. Escolha de storage

| Backend | Uso |
|---|---|
| `MemoryStorage` | testes e protótipos; nada persiste |
| `openNodeSqliteStorage(file)` | produção; WAL, commits sobrevivem a crash de processo |
| `openNodeJsonlStorage(dir, ctx)` | histórico curto; carrega tudo em memória |
| `IndexedDbStorage` | browser; um dono por vez, com Web Lock |
| `openDurableObjectSqliteStorage(ctx.storage)` | Cloudflare Durable Object |

Um processo por storage; não há lock entre processos. Para agentes de longa
duração, SQLite. JSONL só quando o histórico é curto e inspecionável.

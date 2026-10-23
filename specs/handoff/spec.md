# Spec: handoff de sessão entre frontends

Contrato observável de `src/agent/harness.ts`. Cada frontend (CLI, TUI, servidor
web) é um processo que abre o mesmo arquivo SQLite em momentos diferentes. O
estado durável é a conversa; nenhum cliente pode ser dono dela.

API (assinaturas exatas):

```ts
openAgent(
  options: {
    dbPath: string;
    cwd: string;
    workspace?: string;   // identidade do host; default: cwd
    model: ModelRef;
    instructions?: string;
    models?: Models;      // injetável para teste
  },
  ctx,
): Promise<{ harness, conversation, lock }>
submit(session, prompt: string, ctx, requestId?: string): Promise<Submission>
watch(session, submission, ctx): Promise<AskOutcome>
ask(session, prompt: string, ctx, requestId?: string): Promise<AskOutcome>
closeAgent(session, ctx): Promise<void>

type AskOutcome = {
  submissionId: SubmissionId;
  status: "done" | "unanswered";
  answer?: string;
  reason?: string;
};
```

Invariantes numeradas:

1. `submit()` não espera a resposta: ele resolve quando o input foi admitido de
   forma durável. Admissão **não** é colocação no transcript — se a conversa
   estiver ocupada, a submissão fica `queued` e a entrada `pi.user` aparece
   depois. Não exigir `pi.user` imediatamente após `submit()`.
2. `watch()` de uma submissão concluída devolve `status: "done"` e `answer` com o
   texto do modelo.
3. Sem `requestId` explícito, um prompt idêntico ao pendente reaproveita o id
   pendente: `submit()` devolve a mesma submissão (`submission.id` igual).
4. Com `requestId` explícito, ids diferentes produzem submissões diferentes mesmo
   com prompt idêntico: o transcript contém exatamente duas entradas `pi.user`
   com esse texto. A ordem relativa depende da fila de execução — não exigir
   adjacência.
5. O mesmo `requestId` explícito devolve a mesma submissão, também depois de
   fechar e reabrir o agente no mesmo arquivo.
5a. No máximo `MAX_PENDING` (8) intenções pendentes. Ao atingir o limite, um
    pedido novo é recusado **antes** de gravar; nenhuma intenção antiga é
    descartada, porque pode estar admitida e sem desfecho.
6. `watch()` limpa a intenção pendente. Depois de um `watch()` concluído, um
   `submit()` sem id explícito e com o mesmo prompt cria uma submissão nova
   (`submission.id` diferente).
7. O lock é do processo: com o agente aberto, um segundo `openAgent()` no mesmo
   `dbPath` falha; depois de `closeAgent()`, abre normalmente.
8. Resposta do modelo com `stopReason: "error"` produz `status: "unanswered"` e
   `reason` preenchido, sem `answer`.
9. O handle de `Submission` pertence ao Harness que o emitiu: depois de
   `closeAgent()`, `watch()` sobre ele rejeita com `SessionFailed`, cuja mensagem
   indica sessão fechada (não basta "qualquer erro"). Handoff entre frontends é
   feito por `requestId` (invariante 5), nunca reusando handle.
10. `ask()` é equivalente a `submit()` seguido de `watch()`.
11. A sessão pertence a um workspace: reabrir o mesmo banco com outro
    `workspace` falha, mesmo que o `cwd` seja igual.

Ambiente de teste: `fauxProvider()` de `@earendil-works/pi-ai`, `models` injetado
em `openAgent`, SQLite em diretório temporário, `BACKGROUND_CONTEXT` do Chord.
Nenhuma rede.

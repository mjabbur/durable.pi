# shell no fechamento da TUI

| Campo | Valor |
|---|---|
| Dono | `pi-durable-pi` |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | `docs/DURABILITY.md`, `docs/audits/2026-10-22-m1-1.md` (achado 5) |

## Problema e resultado observável

`/quit` ou `/new` com `!comando` em execução fechavam a sessão antes de o
desfecho do comando ser gravado, e o registro se perdia. Verificação: reabrir o
banco depois do `/quit` e encontrar a entrada `durable.shell` do comando, com
`aborted: true`.

## Contrato de efeitos

| Efeito externo | Idempotency key | Onde a chave é gravada | Checkpoint |
|---|---|---|---|
| processo do `!comando` | nenhuma (não há replay; comando interrompido não roda de novo) | — | desfecho gravado como `write` de exibição antes de a TUI resolver a saída |

## Replay

- Morre durante o comando: o desfecho pode faltar; ao reabrir não há
  reexecução automática (decisão existente de `!comando`).
- `/quit` ou `/new` durante o comando: o processo é cancelado, o desfecho é
  gravado como `aborted: true` e só então a sessão é liberada.
- Reenvio: não se aplica.

## Comportamento

1. `/quit` sem geração e sem `!comando` resolve `{ code: 0 }` e encerra.
2. `/quit` com `!comando` em execução cancela o processo filho, espera o
   desfecho e grava a entrada antes de resolver. A entrada tem `aborted: true`.
3. `/new` (ou `/resume`) com `!comando` em execução faz o mesmo na sessão
   antiga antes de trocar; a sessão nova não tem a entrada do comando.
4. `!comando` que termina normalmente grava `aborted: false` e o `exitCode`
   real, como hoje (não regride).
5. `Ctrl+C` durante `!comando` continua cancelando e gravando `aborted: true`
   (não regride).
6. Se a gravação do desfecho falhar, `runTui` ainda resolve a saída; não fica
   pendurado esperando um commit impossível.
7. O segundo `/quit` (ou `Ctrl+C` ocioso) não abre janela para o processo
   antigo continuar rodando: depois do primeiro, a TUI já saiu.
8. Se o processo não morre no prazo (descendente que escapou do grupo mantém o
   pipe aberto), a TUI espera no máximo alguns segundos, grava uma entrada de
   interrupção sem desfecho (`aborted: true`, saída vazia) e sai. Nunca fica
   pendurada.
9. Entradas enviadas durante o fechamento (`/quit` com shell ou geração em
   espera) são ignoradas: nenhum `!comando` novo, prompt ou troca de sessão
   começa depois que o fechamento foi pedido.
10. Commit lento não é interrupção: se a execução já terminou, o desfecho
    normal é aguardado e gravado mesmo além do prazo do processo. Só quando o
    processo ainda não produziu resultado é que se registra interrupção.

## Limites declarados

- O prazo de encerramento cobre o **processo**, não o commit. Storage que não
  responde pode segurar o fechamento: não há promessa de prazo total.
- Descendente que escapa do grupo de processos não é morto. O shim do CLI força
  a saída do processo 1 s depois de `main()` se o event loop não drenar sozinho.
- Não há replay de `!comando`; a exceção ao `AGENTS.md` (efeito externo sem
  intenção durável) continua valendo e está registrada no `PROGRESS.md`.

## Falhas visíveis

- `aborted: true` com `exitCode` 130 quando o cancelamento vem de `Ctrl+C` ou
  do fechamento.
- Saída parcial preservada (até 20 000 caracteres) junto com o desfecho.
- Erro de gravação aparece como aviso na TUI ou em `stderr`, e o encerramento
  segue.

## API

```ts
import type { Terminal } from "@earendil-works/pi-tui";

export function runTui(options: {
	readonly session: AgentSession;
	readonly context: Context;
	readonly terminal?: Terminal;
}): Promise<{ code: number }>;
```

## Notas para o teste gerado

- `runTui` só termina quando o `/quit` resolve; é isso que o teste mede.
- Terminal falso precisa dos métodos da interface `Terminal` do `pi-tui`
  1.4.0, incluindo `drainInput`, `kittyProtocolActive`, `setTitle`,
  `setProgress` e `setProgramStatus`.
- Sessão real: `openAgent({ dbPath, cwd, model: { provider, modelId } })` em
  diretório temporário; o modelo nunca é chamado neste teste.
- Escreva o texto e o `\r` em chamadas separadas no terminal falso.
- Espere um frame novo (o texto acumulado inclui renders antigos).
- Itens 8 e 9 exigem descendente com `setsid`, barreira na escrita e checagem
  de ordem; a cobertura vive em `test/tui/app.test.ts` (teste manual, não
  gerado), porque o gerador não tem como observar processo nem barrar commit.
- Lint do repositório roda no teste gerado: não use `async` sem `await`
  (devolva `Promise.resolve()`); não use `as` quando o tipo já é o esperado.

## Critérios de aceitação

- [ ] cada teste cita o item de Comportamento correspondente
- [ ] o teste reabre o banco e lê as entradas `durable.shell`
- [ ] nenhum teste depende de nome de documento ou formato interno

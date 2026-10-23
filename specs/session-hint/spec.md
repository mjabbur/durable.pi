# dica de sessão na saída da TUI

| Campo | Valor |
|---|---|
| Dono | `pi-durable-pi` |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | `docs/audits/2026-10-22-m1-1.md` (achado 10) |

## Problema e resultado observável

`runTui` encerra com código 1 quando o storage falha, mas `main()` só escrevia
`sessão: <id>` nos caminhos do modo impresso. Sem o id, a falha não é
retomável. Verificação: `main()` em modo interativo com `runTui` devolvendo
código diferente de zero escreve a dica com o id corrente.

## Contrato de efeitos

`main()` não abre/fecha storage extra para a dica: usa o `sessionId` que já
resolveu (e que a troca de sessão atualiza).

## Comportamento

1. Modo interativo, `runTui` devolve código 1: `main()` devolve 1 e escreve em
   stderr `sessão: <id> — retome com durable-pi --session <id> ...`.
2. Depois de uma troca feita pela TUI, o id da dica é o da **nova** sessão.
3. Código 0 não escreve dica.
4. `--no-session` não escreve dica (o banco efêmero é removido).
5. Modo impresso mantém a dica nos caminhos de falha, sem duplicar.
6. Erro de uso (código 2) não escreve dica.
7. Falha no `finally` (fechar a sessão ou remover o diretório efêmero)
   rebaixa o código para 1 e a dica usa o id corrente.

## API

`MainDeps` ganha `runTui` injetável:

```ts
export type MainDeps = {
  readonly models?: Models;
  readonly runTui?: (options: TuiOptions) => Promise<TuiExit>;
};
```

## Notas de geração

- Teste com `main()` real, catálogo faux e `runTui` injetado; simule o TTY com
  `Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })`
  e o mesmo para `stdout`; restaure no `finally`.
- Para o item 2, o `runTui` falso pode chamar `options.sessions?.create()` antes
  de devolver código 1; o `main()` fecha a sessão no `finally`.
- Não asserte caminhos internos; use `stderr` e o código devolvido.
- `runTui` falso não pode ser `async` sem `await`: devolva `Promise.resolve({ code: 1 })`.
- Ao capturar `process.stderr.write`, faça `const original =
  process.stderr.write.bind(process.stderr)`; não passe o método solto nem use
  `as typeof process.stderr.write` (o lint reprova os dois).

## Critérios de aceitação

- [ ] cada teste cita o item de Comportamento correspondente

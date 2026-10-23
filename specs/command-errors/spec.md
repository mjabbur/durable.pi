# rejeição de comando no despacho da TUI

| Campo | Valor |
|---|---|
| Dono | `pi-durable-pi` |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | `docs/audits/2026-10-22-m1-1.md` (achado 8) |

## Problema e resultado observável

Comando cujo `await` rejeita (listagem do seletor, compactação, `configure`)
escapava do laço como rejeição não tratada; no Node 24 isso pode encerrar o
processo. Verificação: erro de comando vira aviso na TUI, sem
`unhandledRejection`, e a TUI segue aceitando entrada.

## Contrato de efeitos

Nenhum efeito novo. Falha terminal do Harness continua encerrando com código 1
pelo canal já existente (`harness.closed`); o despacho não a transforma em
aviso e não a repete.

## Comportamento

1. Rejeição em qualquer comando (`/resume` com `list` falhando, `/compact`,
   `/model`, `/thinking`) vira aviso na TUI com o motivo.
2. A TUI continua utilizável depois do aviso: o próximo prompt é aceito.
3. Nenhuma rejeição escapa como `unhandledRejection` durante o caso acima.
4. `onSelect` do seletor usa a mesma fronteira de despacho: falha ao abrir a
   sessão escolhida não deixa rejeição sem tratamento (o aviso pode vir da
   própria troca).
5. Falha terminal do Harness não é convertida em aviso nem engolida: o
   encerramento com código 1 continua valendo.

## Falhas visíveis

Aviso com `describe(error)`; nada em stderr além do que já existe para falha
terminal.

## Notas de geração

- Contrato de TUI: use terminal falso e switcher de teste; observe texto do
  terminal e a ausência de `unhandledRejection`.
- Se o teste gerado não compilar, o motivo fica aqui e a cobertura vai para
  `test/tui/app.test.ts`.
- Nada de `import()` em anotação de tipo (`consistent-type-imports`): use
  `import type` no topo.
- Não use assertion que o compilador considera desnecessária
  (`no-unnecessary-type-assertion`).
- O terminal falso deve implementar **todos** os membros de `Terminal`:
  `start`, `stop`, `drainInput`, `kittyProtocolActive`, `columns`, `rows`,
  `write`, `moveBy`, `hideCursor`, `showCursor`, `clearLine`, `clearFromCursor`,
  `clearScreen`, `setTitle`, `setProgress`, `setProgramStatus`.
- Não guarde o handler de input em campo se ele não for usado.
- `SessionSwitcher`/`SwitchedSession`/`TuiExit` vêm de `../src/tui/app.js`, não
  de `@earendil-works/pi-durable`.

**Resultado da geração (2026-10-23):** três tentativas, nenhuma adotada. A
primeira compilava e passava (6 testes), mas tinha dois erros de lint
(`consistent-type-imports`, assertion desnecessária); a segunda não compilava
(`Terminal` incompleto, variável não usada); a terceira perdia o import de
`SessionSwitcher`; a quarta compilava, mas tinha 8 erros de lint e 3 testes
falhando. Motivo: o contrato de TUI exige um terminal falso que o gerador não
tem como copiar do repositório. Cobertura em `test/tui/app.test.ts`
(`FakeTerminal` + `SessionSwitcher` de teste), conforme o fallback declarado.

## Critérios de aceitação

- [ ] cada teste cita o item de Comportamento correspondente

# sanitização de saída externa

| Campo | Valor |
|---|---|
| Dono | `pi-durable-pi` |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | `docs/audits/2026-10-22-m1-1.md` (achado 9) |

## Problema e resultado observável

Saída de shell e de tools vai para o terminal com escapes ANSI/OSC intactos:
uma sequência pode apagar a tela, mover o cursor ou sequestrar o terminal, e
fica no transcript para o resume. Verificação: função pura devolve o mesmo
texto sem sequências de controle.

## Contrato de efeitos

Nenhum: função pura.

## Comportamento

1. Texto comum passa igual, incluindo `\n` e `\t`.
2. Sequências CSI (`ESC [ ... letra`, ex.: `\x1b[2J`, `\x1b[31m`) são removidas.
3. Sequências OSC (`ESC ] ... BEL` e `ESC ] ... ESC \`) são removidas inteiras,
   inclusive o conteúdo.
4. Controles C0 são removidos, exceto `\n` e `\t`; `\r` também sai.
5. `DEL` (`\x7f`) é removido.
6. Controles C1 (U+0080–U+009F) são removidos; o payload de uma string C1
   pode aparecer sem o introduzidor, mas nenhuma sequência executável sobra.
7. A remoção não come texto adjacente: `"a\x1b[2Jb"` vira `"ab"`.
8. A função é idempotente: aplicar duas vezes dá o mesmo resultado.

## Limites declarados

- Cobre CSI e OSC **terminados** (BEL ou ST) e remove todo ESC e C0/C1 antes
  de desenhar. Uma OSC truncada perde o introduzidor e mantém o payload
  visível; DCS/PM/APC idem. Nenhum caminho devolve ESC, então não há sequência
  executável — só texto.
- Sanitiza só a exibição: o registro guarda a saída original, e cada desenho
  (ao vivo ou após resume) filtra de novo. Um recorte pode perder o início de
  uma sequência; o restante aparece como texto.
- Não emula terminal: `\r` não sobrescreve linha, apenas some.

## Falhas visíveis

Nenhuma. Entrada vazia devolve vazia.

## API

```ts
export function sanitizeForTerminal(text: string): string;
```

## Notas para o teste gerado

- Importe de `../src/tui/text.js`.
- Evite `async` sem `await`.
- Use escapes JS de uma barra só no código: `"\u001b[2J"` é ESC + `[2J`; duas
  barras (`"\\u001b[2J"`) viram texto literal e testam outro contrato.

## Critérios de aceitação

- [ ] cada teste cita o item de Comportamento correspondente

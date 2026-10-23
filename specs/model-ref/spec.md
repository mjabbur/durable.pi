# parser de referência de modelo

| Campo | Valor |
|---|---|
| Dono | `pi-durable-pi` |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | `docs/audits/2026-10-22-m1-1.md` (achado 11) |

## Problema e resultado observável

`parseModelRef` aceitava partes compostas só por espaços (`" /x"`, `"p/ "`), o
que passava pela validação de formato e só falhava depois, na resolução do
catálogo. Verificação: entradas cujas partes ficam vazias depois do trim viram
erro de formato.

## Contrato de efeitos

Nenhum: função pura.

## Comportamento

1. `"provider/modelo"` devolve `{provider:"provider", modelId:"modelo"}`.
2. Espaços nas pontas de cada parte são removidos: `" p/m "` vira `p`/`m`.
3. Parte só com espaços (ou vazia) rejeita com `InvalidModelRefError`.
4. Sem `/` rejeita com `InvalidModelRefError`.
5. Texto que começa ou termina com `/` rejeita com `InvalidModelRefError`;
   `"a/b/"` é aceito, porque o id do modelo é `"b/"`.
6. O primeiro `/` separa; o resto pertence ao id: `"a/b/c"` vira `a`/`b/c`.
7. Não valida catálogo: qualquer par não vazio é aceito.

## Falhas visíveis

`InvalidModelRefError` com a mensagem que inclui o texto recebido.

## API

```ts
export class InvalidModelRefError extends Error {}
export function parseModelRef(text: string): { provider: string; modelId: string };
```

## Notas para o teste gerado

- Importe de `../src/agent/models.js`.
- Evite `async` sem `await`.

## Critérios de aceitação

- [ ] cada teste cita o item de Comportamento correspondente

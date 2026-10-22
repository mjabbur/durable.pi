# <nome da feature>

| Campo | Valor |
|---|---|
| Dono | `<pessoa>` |
| Status | draft / em review / aprovada / implementada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | `<links>` |

## Problema e resultado observável

Uma frase. Como se verifica que funcionou, sem ler o código.

## Contrato de efeitos

Sem efeito externo, escreva "nenhum" e pule a seção Replay.

| Efeito externo | Idempotency key | Onde a chave é gravada | Checkpoint |
|---|---|---|---|
| `<ex.: cobrança>` | `<ex.: crypto.randomUUID() gerado no commit de intenção>` | `<doc X, campo Y>` | `<antes/depois de qual passo>` |

## Replay

- Morre antes do efeito:
- Morre depois do efeito, antes do commit:
- Reenvio com o mesmo `requestId`:

## Comportamento

Lista numerada e verificável. Cada item vira pelo menos um teste.

## Falhas visíveis

Quais estados o operador vê e o que faz: `task_parked`, `unanswered`,
`ConversationBusy`, `StorageRequestError`.

## API

Assinaturas exportadas, com tipos. O teste importa daqui, não de detalhe
interno.

## Critérios de aceitação

- [ ] teste de invariante que falha sem a implementação
- [ ] teste de crash quando há efeito externo
- [ ] `docs/RUNBOOK.md` atualizado se surgir sintoma novo
- [ ] desvio da spec atualiza esta spec no mesmo PR

## Fora de escopo

O que esta feature não faz, para evitar expectativa errada.

## Invariantes referenciados

Liste seções de `docs/DURABILITY.md` por número. Não repita o texto: duas
verdades divergem no primeiro incidente.

# troca de sessão na TUI

| Campo | Valor |
|---|---|
| Dono | `pi-durable-pi` |
| Status | aprovada |
| Versão do pi-durable | 1.4.0 |
| Specs relacionadas | `docs/audits/2026-10-22-m1-1.md` (achado 4) |

## Problema e resultado observável

`switchSession` emitia o aviso antes de `attach`, e `attach` limpa os avisos;
quando a abertura dava certo mas o attachment falhava, o código tentava reatar
a sessão anterior — que o dono do storage já tinha fechado — e engolia o erro.
Verificação: com um `SessionSwitcher` injetado, a falha fica visível e a TUI
não volta para um handle fechado.

## Contrato de efeitos

Um processo por storage continua valendo. A troca abre a nova sessão antes de
fechar a anterior (feito pelo dono do storage). A TUI nunca reata uma sessão
que não esteja aberta.

## Comportamento

1. Troca bem-sucedida passa a desenhar a nova sessão; o aviso `sessão <id>`
   aparece **depois** do conteúdo da nova sessão e não é apagado.
2. Falha ao abrir a nova sessão (`open` rejeita): o aviso
   `falha ao trocar de sessão: <motivo>` fica visível, a sessão anterior
   continua desenhada e aceita o próximo prompt normalmente.
3. Falha depois que a nova sessão abriu (attachment ou leitura do agente
   rejeita): a TUI encerra com código 1, registra em stderr
   `falha ao anexar a sessão <id>: <motivo>` e **não** tenta reatar a anterior.
4. Enquanto uma troca está em andamento, outra troca é recusada com aviso
   `troca de sessão em andamento`, sem abrir sessão.
5. Prompt e `!comando` durante a troca são recusados com o mesmo aviso; nada é
   submetido.
6. Troca com geração em voo continua recusada: `aguarde a geração terminar
   antes de trocar de sessão`.
7. `/quit` durante a troca encerra; o dono do storage não publica a sessão
   que ainda estava abrindo (ela é fechada) e o fechamento usa a referência que
   já era a atual.
8. Nenhum aviso de falha pode ser apagado pela reanexação: o aviso é emitido
   depois dela.
9. `/compact`, `/model` e `/thinking` durante a troca são recusados com o
   mesmo aviso; não configuram a sessão errada.
10. A guarda de troca é reservada **antes** do primeiro `await`: `!comando` em
    voo pode atrasar a troca, mas uma segunda troca não atravessa a espera.
11. Se a reanexação da anterior também falhar, a TUI encerra com código 1:
    sem stream não há estado confiável.

## Falhas visíveis

- Aviso na área de status para falha recuperável (itens 2, 4, 5, 9).
- Código 1 e stderr para falha não recuperável (itens 3, 11).

## Contrato do `SessionSwitcher`

- Rejeitar `open`/`create` significa que **nada foi publicado**: a sessão
  anterior continua aberta e utilizável.
- Depois de publicar a nova, o dono devolve a sessão efetiva mesmo que a
  limpeza da anterior falhe; ele não rejeita a chamada nesse ponto.
- Durante o encerramento do processo, uma abertura em voo não publica: a
  sessão aberta é fechada e a chamada rejeita.

## API

`runTui` continua com a mesma assinatura. `SessionSwitcher`:

```ts
export type SessionSwitcher = {
  list(): Promise<readonly SessionInfo[]>;
  open(id: string): Promise<SwitchedSession>;
  create(): Promise<SwitchedSession>;
};
```

## Notas de geração

- O contrato é de TUI: use um terminal falso e um `SessionSwitcher` de teste.
  O redesenho é observado pelo texto acumulado do terminal; para "depois do
  conteúdo" espere um frame novo.
- Não asserte nomes internos (`notices`, `attach`): só texto do terminal,
  `code` de `runTui` e o que foi escrito em stderr.
- Se o teste gerado não compilar, o motivo fica aqui e a cobertura vai para
  `test/tui/app.test.ts`.

**Resultado da geração (2026-10-23):** o muse estourou o tempo (300 s), e a
execução parcial não compilava (variável não usada) e violava as notas acima:
achava o editor por dentro de `tui.children` e montava `Harness` direto com
`models: {}`. Não entrou em `test/spec/`. Cobertura em `test/tui/app.test.ts`,
com `FakeTerminal` dirigindo a TUI real e switcher de teste; motivo registrado
aqui.

## Limites declarados

- Falhar o `watchEvents` de forma injetável exige um dublê de `AgentSession`;
  sem ele, o item 3 é coberto no teste manual.
- A serialização vale para chamadas desta TUI, não para trocas feitas por
  outro processo (o lock do storage cobre isso).

## Critérios de aceitação

- [ ] cada teste cita o item de Comportamento correspondente

# Contrato do agente de testes

Você escreve testes, não implementação.

## Regras

- Só crie ou edite arquivos em `test/`. Nunca edite `src/`.
- Não leia nada fora deste diretório. Não existe repositório de implementação
  acessível.
- A fonte de verdade do comportamento é `spec.md`. A fonte de verdade da API é
  `node_modules/@earendil-works/pi-durable/dist/`.
- Cada `it()` cita no nome ou no corpo o item de **Comportamento** da spec que
  verifica.
- Use `vitest`, `MemoryStorage`, `createSession` e `BACKGROUND_CONTEXT`.
  `BACKGROUND_CONTEXT` vem de `@earendil-works/chord/context`; o entry principal
  `@earendil-works/chord` exporta só o tipo `Context`.
- Import relativo sempre com `.js`, mesmo o arquivo sendo `.ts`:
  `import { bumpOnce } from "../src/counter.js"`. NodeNext não resolve `.ts`.
- Não invente símbolos: se não existe em `dist/*.d.ts`, não use.
- Não teste detalhe interno (nome de documento, formato de entry). Teste só o
  que a spec promete.
- Ao injetar falha de storage, crie a conversa antes de instalar o storage que
  falha: o commit de criação não é o commit sob teste.

## Proibido

- Implementar `src/counter.ts`.
- Alterar `spec.md`, `tsconfig.json` ou `package.json`.
- Criar testes que só passariam com uma implementação específica.

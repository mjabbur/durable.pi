#!/usr/bin/env node
// Shim de execução: o pacote é compilado para dist/ (npm run build).
const { main } = await import("../dist/cli/main.js");
const code = await main(process.argv.slice(2));
process.exitCode = code;
// Um descendente de `!comando` que escapou do grupo pode manter o pipe aberto
// depois de `main()` e segurar o event loop. Não espere para sempre: se o loop
// não drenar sozinho, sai com o mesmo código. `unref()` deixa a saída normal
// acontecer antes quando não há nada pendurado.
setTimeout(() => process.exit(code), 1_000).unref();

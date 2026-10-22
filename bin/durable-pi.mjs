#!/usr/bin/env node
// Shim de execução: o pacote é compilado para dist/ (npm run build).
const { main } = await import("../dist/cli/main.js");
process.exitCode = await main(process.argv.slice(2));

#!/usr/bin/env node
// Node >= 23.6 runs the TypeScript sources directly (type stripping).
process.removeAllListeners('warning');
await import('../src/index.ts');

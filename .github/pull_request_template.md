## Summary

## Verification

- [ ] `npm test`
- [ ] `npm run smoke:package` if package entrypoints, command registration, or public docs changed
- [ ] README/package docs updated if behavior or compatibility changed

## Invariants

- [ ] `loop-core.js` remains free of `@opencode-ai/plugin` imports
- [ ] `loop.js` still exports only `LoopPlugin`
- [ ] loop registry remains module-level singleton state
- [ ] `command.execute.before` still mutates `output.parts` in place
- [ ] no disk persistence added for loop state

# 008 Cookbook

## Run the offline closed loop

The fixture in `tests/fixtures/omp-openai-server.ts` implements `POST /v1/chat/completions` with SSE tool calls. Its default sequence is:

1. Orchestrator calls `orchestrator_route accept`.
2. Worker calls `write`, then `orchestrator_report ready`.
3. Orchestrator handles `worker_report` and calls `orchestrator_reply purpose=result`.

`writeFixtureModels()` creates a static `fixture` provider in `models.yml`, so OMP performs real provider/model/tool loops without a cloud account. `tests/omp-sessions.spec.ts` uses the same server for allowlists, tool guards, delivery, reopen and model restore.

For end-to-end verification, run:

```sh
bun run build
bun scripts/omp-smoke.ts lib/cli.js
```

The smoke starts a temporary git repository, fake `gh`, startup JSON and that provider. It drives a real Issue notification through the CLI and asserts a completed Ticket, expected worker file, orchestrator/worker JSONL, one acknowledgement/result, and no duplicate after restart. A missing-file check exercises the shebang/bin failure path:

```sh
./lib/cli.js --config /does/not/exist.json
# non-zero; error names /does/not/exist.json
```

## Add fixture behavior

Use `startOmpOpenAIServer((request, count) => reply)` to add a scenario. Return `content` for a final assistant message or `toolCalls` with exact application tool names/JSON arguments. Delayed replies can test steering and follow-up order. Keep assertions on observable state—tool calls, files, SQLite, JSONL and fake-gh requests—not on an assumed internal Session implementation.

A real-provider GitHub smoke is optional and requires operator credentials. Do not claim the loopback fixture validates a real provider.

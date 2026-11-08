# 006 Deployment

## Process model

Run the standalone ESM CLI with Bun `>=1.4.4` and `@oh-my-pi/pi-coding-agent@18.18.1`:

```sh
bun install
bun run build
./lib/cli.js --config /absolute/path/config.json
```

`omp-superagent` owns one state-directory lock. A second process on the same directory fails before opening SQLite. GitHub identity and push access are validated only when `sources.github.enabled` is true; omit that source for Web-only chat. `SIGINT`/`SIGTERM` performs ordered cleanup and exits zero on success.

## Startup JSON

`stateDir` is required and absolute. `agentDir` is optional and defaults to `<stateDir>/omp`. Optional machine limits are `promptMaxChars` (default 100000), `admissionContextMaxPages` (10), and `admissionContextTimeoutMs` (15000). Unknown keys fail.

The remaining keys are `paused`, `sources`, `policy`, `eval`, and `executor`, matching `SettingsSchema`. Startup JSON is their only source: there is no settings API or online editor. Changed values are saved on startup; policy changes create Inputs on open Tickets.

### Web conversation panel

`web` defaults to `{ "enabled": true, "host": "127.0.0.1", "port": 3082 }`. The CLI prints the actual URL. Use `enabled: false` to disable the server or `port: 0` for an ephemeral port. `GET /` serves the conversation page, `GET /api/messages` returns persisted OMP messages, and `POST /api/chat` with `{ "text": "..." }` queues a durable user message. Requests are limited to loopback and same origin; there are no cookies, remote assets or CORS headers.

### Role models

`eval.model` and `executor.model` accept either `null` or:

```json
{ "provider": "provider-id", "model": "model-id", "thinkingLevel": "low" }
```

Levels are `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `auto` lets OMP choose reasoning effort per request. Explicit models must resolve through shared `ModelRegistry.find`; startup never substitutes another model. `null` uses OMP defaults only for a new Session and preserves the persisted selection after reopen. A changed non-null model overrides the transcript selection without persisting that override back into it.

## State layout

- `orchestrator.sqlite`: schema 1 domain state, Effects and Outbox.
- `sessions/`: OMP JSONL transcripts; aliases map to files in SQLite.
- `omp/`: authentication, model configuration and model cache.
- `work/`: default Ticket directories.
- `worker-bin`, `worker-gitconfig`: gh/blocked-command shims and isolated git configuration.

Only schema 1 is accepted. An existing non-schema-1 SQLite file is preserved and rejected. DSH state, authorization, outbox and transcripts are never migrated or silently reused.

## GitHub and worker environment

`sources.github.config.repository` is `owner/name`; `cli` is a command name or absolute executable path. The CLI must return the agent identity and push access. Workers invoke `gh` through the shim, which selects that account and removes itself from nested `PATH` lookup. Git uses the isolated config and its credential helper. Ambient GitHub tokens, repository-selection variables, interactive prompts and commit identity overrides are removed.

These are account-selection guardrails, not an OS security sandbox. Workers run as the operator's OS user. `executor.blockedCommands` may add command shims, but cannot block `gh` or `git`.

The documented environment names are `OMP_SUPERAGENT_DIR`, `OMP_SUPERAGENT_NAME`, `OMP_SUPERAGENT_TICKET`, `OMP_SUPERAGENT_BLOCKED_COMMANDS`, `OMP_SUPERAGENT_GITHUB_REPOSITORY`, `OMP_SUPERAGENT_GITHUB_ACCOUNT`, `OMP_SUPERAGENT_GITHUB_COMMIT_EMAIL`, `OMP_SUPERAGENT_GITHUB_NUMBER`, and `OMP_SUPERAGENT_GITHUB_PR_HEAD`.

## Troubleshooting

- Invalid path/JSON/Zod error: fix the named config field; `--config` itself must be absolute.
- Unknown OMP model: correct `provider`/`model` in `models.yml` or startup JSON.
- GitHub validation error: fix the wrapper's identity or repository push permission.
- Existing schema error: use a new empty `stateDir`; no automatic migration or clearing occurs.
- Corrupt/missing transcript: restore the file named by the alias/path error. The service never replaces it with empty history.
- Repeated work after restart: do not delete SQLite or JSONL; idempotency keys and persisted SessionEntries prevent replay.

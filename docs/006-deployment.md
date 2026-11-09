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

The remaining keys are `paused`, `sources`, `policy`, `eval`, and `executor`, matching `SettingsSchema`. Startup JSON supplies initial settings; model selectors can also be managed in the settings window. Other changed values are saved on startup; policy changes create Inputs on open Tickets.

### Chat Source and ticket authorization

Set `sources.chat` to `{ "enabled": true, "config": {} }` and list sender IDs under `policy.sources.chat.allowed`. Enabling the Source alone grants no work authorization. Web's host-controlled sender is `web:local`; WeChat uses `wechat:<user-id>` shown after binding. Direct messages from listed senders enter admission as `explicit`; other senders can be ignored by the orchestrator without creating Tickets. When ordinary conversation needs no Ticket, the orchestrator can ignore the candidate and answer naturally with `orchestrator_reply` through the same durable Outbox. Inadmissible senders receive no response. Every message becomes a host-derived Trigger, with source message ID, sender, conversation, original text, and reply Channel persisted. `POST /api/chat` accepts an optional stable `messageId`; retries with the same ID return the same `triggerId` and cannot create another Ticket. To verify, send `检查 /data/crypto/research/bt20261005 的工程回测`, then watch for a candidate, an acceptance acknowledgement, and the final result in that same chat. Users never enter `trigger_id` or `ticket_id`.

For conversational messages that need no Ticket, `orchestrator_route` accepts `answer` alongside `kind=ignore`. It queues the natural response through Outbox in the same model call instead of waiting for another model turn. Normal reply ordering and failure backoff remain unchanged.

### Web conversation panel

`web` defaults to `{ "enabled": true, "host": "127.0.0.1", "port": 3082 }`. The CLI prints the actual URL. Use `enabled: false` to disable the server or `port: 0` for an ephemeral port. `GET /` serves the conversation page, `GET /api/messages` returns persisted OMP messages, and `POST /api/chat` with `{ "text": "...", "attachments": [{ "name": "payload.bin", "mediaType": "application/octet-stream", "data": "<base64>" }] }` queues a durable user message. Any file type is accepted, at most 3 files and 5 MiB each. Native images use `ImageContent`; UTF-8 text up to 256 KiB is inlined; other and larger files are stored under `<stateDir>/attachments/<requestId>/` and their absolute paths are passed to the Session for `read`/`bash` processing. Requests are limited to loopback and same origin; there are no cookies, remote assets or CORS headers.

**重置 Session** requires confirmation, clears the visible orchestrator transcript, and creates a fresh persistent Session through `POST /api/session/reset`. It preserves tickets, worker Sessions, and the WeChat binding.

### WeChat channel

No startup credentials are required. Open **设置 → 微信**, then scan with WeChat `>=8.0.70` and confirm. `GET /api/wechat` reports connection state, `POST /api/wechat/connect` starts QR binding, `POST /api/wechat/verify` submits `{ "code": "1234" }` when requested, and `POST /api/wechat/disconnect` removes the binding. Only the bound user can send into the orchestrator. Text, image, file, video, and voice transcription are accepted inbound; final text replies and explicit `wechat_send_file` media are sent outbound. The 100 MiB media limit applies per item. Keep the state database to resume credentials and the delivery cursor after restart.

### Role models

`eval.model` and `executor.model` accept either `null` or:

```json
{ "provider": "provider-id", "model": "model-id", "thinkingLevel": "low" }
```

Levels are `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `auto` lets OMP choose reasoning effort per request. Explicit models must resolve through shared `ModelRegistry.find`; startup never substitutes another model. `null` uses OMP defaults only for a new Session and preserves the persisted selection after reopen. A changed non-null model overrides the transcript selection without persisting that override back into it.

`GET /api/settings/models` returns current role models and the credential-aware `ModelRegistry.getAvailable()` catalog. `PUT /api/settings/models` accepts `{ "eval": RoleModel | null, "executor": RoleModel | null }`, validates both, applies them to loaded non-disposed Sessions, and saves them. Null selects OMP defaults for future Sessions without resetting an existing one. Startup records the config-file model baseline: unchanged config preserves online choices after restart; changing to a value different from that baseline wins. Reverting to the baseline alone does not clear an online selection. Runtime clones startup settings before applying this precedence.

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

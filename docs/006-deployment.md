# 006 Deployment

## Process model

Run the standalone ESM CLI with Bun `>=1.4.4` and `@oh-my-pi/pi-coding-agent@18.18.1`:

```sh
bun install
bun run build
./lib/cli.js --config /absolute/path/config.json
```

`neo-agent` owns one state-directory lock. A second process on the same directory fails before opening SQLite. GitHub identity and push access are validated when `sources.github.enabled` is true, at startup and when the settings window connects it; omit that source for Web-only chat. `SIGINT`/`SIGTERM` performs ordered cleanup and exits zero on success.

## Startup JSON

`stateDir` is required and absolute. `agentDir` is optional and defaults to `<stateDir>/omp`. Optional machine limits are `promptMaxChars` (default 100000), `admissionContextMaxPages` (10), and `admissionContextTimeoutMs` (15000). Unknown keys fail.

The remaining keys are `paused`, `sources`, `policy`, `eval`, and `executor`, matching `SettingsSchema`. Startup JSON supplies initial settings; model selectors and the GitHub Source can also be managed in the settings window. Other changed values are saved on startup; policy changes create Inputs on open Tickets.

### Chat Source and ticket authorization

Set `sources.chat` to `{ "enabled": true, "config": {} }` and list sender IDs under `policy.sources.chat.allowed`. Enabling the Source alone grants no work authorization. Web's host-controlled sender is `web:local`; WeChat uses `wechat:<user-id>` shown after binding. Direct messages from listed senders enter admission as `explicit`; other senders can be ignored by the orchestrator without creating Tickets. A request that needs work becomes a Ticket even when it is unrelated to the repository, such as news, prices or weather, since workers can browse and run commands; a follow-up attaches to the one Ticket it continues. When ordinary conversation needs no Ticket, the orchestrator can ignore the candidate and answer naturally with `orchestrator_reply` through the same durable Outbox. Inadmissible senders receive no response. Every message becomes a host-derived Trigger, with source message ID, sender, conversation, original text, and reply Channel persisted. `POST /api/chat` accepts an optional stable `messageId`; retries with the same ID return the same `triggerId` and cannot create another Ticket. To verify, send `检查 /data/crypto/research/bt20261005 的工程回测`, then watch for a candidate, an acceptance acknowledgement, and the final result in that same chat. Users never enter `trigger_id` or `ticket_id`.

For conversational messages that need no Ticket, `orchestrator_route` accepts `answer` alongside `kind=ignore`. It queues the natural response through Outbox in the same model call instead of waiting for another model turn. Normal reply ordering and failure backoff remain unchanged.

### Web conversation panel

`web` defaults to `{ "enabled": true, "host": "127.0.0.1", "port": 3082 }`. The CLI prints the actual URL. Use `enabled: false` to disable the server or `port: 0` for an ephemeral port. `GET /` serves the conversation page, `GET /api/messages` returns conversation traffic only — the person's Web or WeChat entries and delivered `chat-reply` messages, never internal candidates, routing decisions, worker notices or raw model turns — and `POST /api/chat` with `{ "text": "...", "attachments": [{ "name": "payload.bin", "mediaType": "application/octet-stream", "data": "<base64>" }] }` queues a durable user message. Any file type is accepted, at most 3 files and 5 MiB each. Native images use `ImageContent` and are also stored under `<stateDir>/attachments/<requestId>/`; UTF-8 text up to 256 KiB is inlined; other and larger files are stored the same way. Every stored file's absolute path is passed to the Session for `read`/`bash` processing. Requests are limited to loopback and same origin; there are no cookies, remote assets or CORS headers.

**重置 Session** requires confirmation, clears the visible orchestrator transcript, and creates a fresh persistent Session through `POST /api/session/reset`. It preserves tickets, worker Sessions, and the WeChat binding.

### WeChat channel

No startup credentials are required. Open **设置 → 微信**, then scan with WeChat `>=8.0.70` and confirm. `GET /api/wechat` reports connection state, `POST /api/wechat/connect` starts QR binding, `POST /api/wechat/verify` submits `{ "code": "1234" }` when requested, and `POST /api/wechat/disconnect` removes the binding. Only the bound user can send into the orchestrator. Text, image, file, video, and voice transcription are accepted inbound; final text replies and explicit `wechat_send_file` media are sent outbound. The 100 MiB media limit applies per item. Keep the state database to resume credentials and the delivery cursor after restart.

### Role models

`eval.model` and `executor.model` accept either `null` or:

```json
{ "provider": "provider-id", "model": "model-id", "thinkingLevel": "low" }
```

Levels are `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `auto` lets OMP choose reasoning effort per request. Explicit models must resolve through shared `ModelRegistry.find`; startup never substitutes another model. `null` uses OMP defaults only for a new Session and preserves the persisted selection after reopen. A changed non-null model overrides the transcript selection without persisting that override back into it.

`executor.advisor` takes the same shape and defaults to `null`, which turns the worker advisor off. A non-null value sets OMP's `advisor.enabled` and `modelRoles.advisor` (`provider/model[:level]`) on every worker Session: that second model reviews each worker turn and injects notes into it. Subagents never get an advisor. A `WATCHDOG.yml` in the agent directory or the Ticket repository can still define its own advisor roster, models and tools; those entries take precedence over `modelRoles.advisor`.

`GET /api/settings/models` returns current role models, including `advisor`, and the credential-aware `ModelRegistry.getAvailable()` catalog. `PUT /api/settings/models` accepts `{ "eval": RoleModel | null, "executor": RoleModel | null, "advisor": RoleModel | null }`, validates all three before applying any, applies them to loaded non-disposed Sessions, and saves them. A null model selects OMP defaults for future Sessions without resetting an existing one; a null advisor turns loaded workers' advisor off at once. Startup records the config-file model baseline: unchanged config preserves online choices after restart; changing to a value different from that baseline wins. Reverting to the baseline alone does not clear an online selection. Runtime clones startup settings before applying this precedence.

## State layout

- `orchestrator.sqlite`: schema 1 domain state, Effects and Outbox.
- `sessions/`: OMP JSONL transcripts; aliases map to files in SQLite.
- `omp/`: authentication, model configuration and model cache.
- `work/`: default Ticket directories.
- `worker-bin`, `worker-gitconfig`: gh/blocked-command shims and isolated git configuration.

Only schema 1 is accepted. An existing non-schema-1 SQLite file is preserved and rejected. DSH state, authorization, outbox and transcripts are never migrated or silently reused.

## GitHub and worker environment

`sources.github.config.repository` is `owner/name`; `cli` is a command name or absolute executable path. The CLI must return the agent identity and push access; the check runs without ambient `GH_TOKEN`/`GITHUB_TOKEN`, as every later call does, so it reads the wrapper's account. Workers invoke `gh` through the shim, which selects that account and removes itself from nested `PATH` lookup. Git uses the isolated config and its credential helper. Ambient GitHub tokens, repository-selection variables, interactive prompts and commit identity overrides are removed.

These are account-selection guardrails, not an OS security sandbox. Workers run as the operator's OS user. `executor.blockedCommands` may add command shims, but cannot block `gh` or `git`.

The documented environment names are `NEO_AGENT_DIR`, `NEO_AGENT_NAME`, `NEO_AGENT_TICKET`, `NEO_AGENT_BLOCKED_COMMANDS`, `NEO_AGENT_GITHUB_REPOSITORY`, `NEO_AGENT_GITHUB_ACCOUNT`, `NEO_AGENT_GITHUB_COMMIT_EMAIL`, `NEO_AGENT_GITHUB_NUMBER`, and `NEO_AGENT_GITHUB_PR_HEAD`.

### Upgrading from omp-superagent

The project was renamed from `omp-superagent` to `neo-agent`. The package, the `neo-agent` command and the bundled `neo-agent-github` skill carry the new name, and every `OMP_SUPERAGENT_*` variable is now `NEO_AGENT_*`: update `executor.prepare` commands and team prompt sections that reference the old names, since the old variables are no longer set. An existing state directory keeps working at its current path without migration: worker shims written under the old name are recognised and rewritten, Session entries with custom type `omp-superagent` still count as delivered, and GitHub comments carrying the old `<!-- omp-superagent:<id> -->` marker are still recognised, so no reply is posted twice.

### Connecting from the settings window

**设置 → GitHub** edits the GitHub Source. `GET /api/settings/github` returns `{ enabled, config, connection, health }`; `connection` is `{ repository, account }` while connected and `null` otherwise. `PUT /api/settings/github` accepts `{ "enabled": boolean, "config": { repository, cli, pollSeconds, failuresBeforeError, observeIssues, observePulls, observeComments, observeCi } }`. It verifies the CLI's account and push access as startup does; a failure answers 400 and changes nothing. Once verified it stops the polling loop, rewrites the worker shims and git configuration, saves the Source, restarts polling, and reopens the orchestrator Session from its transcript so its prompt names the connected account and repository. Disconnecting stops polling and leaves the worker environment in place until restart, so running workers keep the agent account. `policy.sources.github.allowed` stays in the startup JSON.

Startup records the startup JSON's GitHub Source as a baseline, as it does for models: an unchanged JSON keeps the panel's connection after restart, and an edited one wins. A saved connection that no longer verifies fails the start; set `sources.github` to `{ "enabled": false }` in the startup JSON to start without it.

One state directory holds the conversations of one repository, recognized by GitHub's numeric repository ID, which a rename or transfer keeps. With no GitHub Thread stored, connecting another repository clears the previous one's read cursors and CI baselines. Once a Thread exists the change is refused, since Threads are keyed by Issue and PR number alone; use a new `stateDir`.

## Troubleshooting

- Invalid path/JSON/Zod error: fix the named config field; `--config` itself must be absolute.
- Unknown OMP model: correct `provider`/`model` in `models.yml` or startup JSON.
- GitHub validation error: fix the wrapper's identity or repository push permission, or disable `sources.github` in the startup JSON to start without it.
- "This state directory holds GitHub conversations of …": the directory is bound to another repository; use a new empty `stateDir` for the new one.
- Existing schema error: use a new empty `stateDir`; no automatic migration or clearing occurs.
- Corrupt/missing transcript: restore the file named by the alias/path error. The service never replaces it with empty history.
- Repeated work after restart: do not delete SQLite or JSONL; idempotency keys and persisted SessionEntries prevent replay.

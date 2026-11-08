# omp-superagent

`omp-superagent` is a standalone coding agent for one GitHub repository. It receives GitHub events, evaluates them under a Policy, and runs each authorized Ticket in a persistent [Oh My Pi](https://github.com/can1357/oh-my-pi) worker Session and its own directory. The orchestrator then replies in the original Issue or pull-request conversation.

## Runtime contract

- One persistent OMP orchestrator Session routes and evaluates.
- One persistent OMP worker Session per Ticket executes and reports.
- SQLite stores domain state, durable effects and outbox order. OMP JSONL stores transcripts and idempotent message IDs.
- GitHub is optional; a Web conversation panel and Tencent iLink WeChat binding are included. Feishu, DSH hosting, online settings/Prompt editing, worker subagents and async background jobs are not included.

## Usage

### 1. Prerequisites

- Bun `>=1.4.4` and git `>=2.32`.
- A dedicated GitHub account with push access to the target repository. Configure a `gh` wrapper for that account; do not use an operator's personal account.
- An OMP provider in an isolated `agentDir`. Explicit models must exist in its `models.yml`; `null` selects the OMP default only for a new Session and preserves the restored selection after restart.
- A new empty absolute `stateDir`. Existing DSH state, transcripts and non-schema-1 SQLite files are rejected, not migrated.

### 2. Create startup JSON

Example `config.json`:

```json
{
  "stateDir": "/srv/omp-superagent/state",
  "agentDir": "/srv/omp-superagent/omp",
  "sources": {
    "github": {
      "enabled": true,
      "config": {
        "repository": "owner/repo",
        "cli": "/usr/local/bin/gh-agent",
        "pollSeconds": 60
      }
    }
  },
  "policy": {
    "sources": {
      "github": {
        "allowed": [{ "id": "your-github-login" }]
      }
    }
  },
  "eval": {
    "mode": "observe",
    "model": null
  },
  "executor": {
    "model": null,
    "maxWorkers": 3,
    "prepare": "git clone --quiet /srv/repositories/repo \"$OMP_SUPERAGENT_DIR\""
  }
}
```

`agentDir` defaults to `<stateDir>/omp`. Startup JSON is the only runtime settings source; edit it and restart to apply changes. `eval.mode` is `off`, `observe`, or `auto`: `observe` evaluates proactive candidates without accepting them, while `auto` accepts bounded matches. Explicit requests always require a whitelisted sender.

Role models accept `null` or `{ "provider": "...", "model": "...", "thinkingLevel": "low" }`. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Unknown explicit models fail startup; no fallback model is selected silently.

The Web panel defaults to `http://127.0.0.1:3082/` and needs no GitHub configuration. Omit `sources.github` for chat-only use. Configure it with `"web": { "enabled": true, "host": "127.0.0.1", "port": 3082 }`; set `enabled` to `false` to disable it or `port` to `0` for an ephemeral port. The CLI prints the actual URL. The server accepts loopback requests only and uses no remote assets or CORS. Upload any file type, up to 3 attachments per message and 5 MiB each. PNG/JPEG/WebP/GIF use native OMP image content; UTF-8 text up to 256 KiB is inlined; other and larger files are stored under `<stateDir>/attachments/<requestId>/` with their paths included in the message so OMP can inspect or transform them with `read`/`bash`.

The panel's **连接微信** button creates a local QR code through Tencent's iLink Bot API. Scan and confirm with WeChat `>=8.0.70`; enter the phone verification code if requested. The bound WeChat user chats with the same persistent orchestrator Session, with text replies returned automatically and image/file/video attachments transferred through the encrypted WeChat CDN. The orchestrator can send a local file explicitly with `wechat_send_file`. Bindings and the long-poll cursor persist in `orchestrator.sqlite` and resume after restart; disconnecting removes only the binding and cursor, never the OMP transcript. Media is limited to 100 MiB per item.

### 3. Build and start

```sh
git clone <this-repository> omp-superagent
cd omp-superagent
bun install
bun run build
./lib/cli.js --config /absolute/path/config.json
```

The CLI validates JSON, models, GitHub identity and repository push access before starting watchers. `SIGINT` and `SIGTERM` stop watchers, Sessions and Effects, restore the environment, close SQLite and release the state lock. `bun start -- --config /absolute/path/config.json` is equivalent after build.

### 4. Use the agent

From a whitelisted GitHub account, mention the agent in an Issue or PR:

```text
@<agent-login> Fix the README typo
```

The service creates one Ticket and worker, acknowledges the request, executes in the Ticket directory and posts the result in the original conversation. Each Ticket has its own persistent worker Session and isolated working directory. Do not delete SQLite or JSONL between runs: they prevent duplicate messages after restart.

State layout:

- `orchestrator.sqlite`: domain state, durable Effects and Outbox.
- `sessions/`: orchestrator and worker JSONL transcripts.
- `omp/`: OMP authentication, models and cache.
- `work/`: default Ticket directories.
- `worker-bin`, `worker-gitconfig`: command shims and isolated git configuration.

### 5. Verify and troubleshoot

```sh
bun run check
bun scripts/omp-smoke.ts lib/cli.js
./lib/cli.js --config /does/not/exist.json
```

The offline smoke drives a real CLI through a loopback provider and fake `gh`, asserting Ticket completion, the worker output file, both JSONL transcripts, one acknowledgement/result and no restart duplicates. The last command must fail nonzero and name the missing path. See [docs/006-deployment.md](docs/006-deployment.md) for the full schema and [SETUP.md](SETUP.md) for a short checklist.

## Development

`bun run check` runs TypeScript, all Vitest suites and the build. `bun scripts/omp-smoke.ts lib/cli.js` runs the real CLI against a loopback OpenAI-compatible provider, fake `gh` and a temporary git repository, then verifies completion and restart idempotency.

## Documentation

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [006 Deployment](docs/006-deployment.md)
- [007 Architecture](docs/007-architecture.md)

## License

[MIT](LICENSE)

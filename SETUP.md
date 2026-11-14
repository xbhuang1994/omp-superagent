# SETUP

## 1. Prepare accounts and tools

Install Bun `>=1.4.4`, git `>=2.32` and a GitHub CLI. Create or choose a dedicated GitHub account for the agent and grant it push access to the target repository. Do not use an operator's personal account.

Configure that account in a `gh` wrapper or `GH_CONFIG_DIR` and verify:

```sh
gh api user --jq .login
gh api repos/<owner>/<repo> --jq '.permissions.push'
```

Configure an OMP provider in an isolated agent directory. Model selectors in startup JSON are optional; `null` selects the OMP default for a new Session and preserves the persisted selection on restart.

## 2. Write startup JSON

Use absolute paths and a new empty state directory. Minimal example:

```json
{
  "stateDir": "/srv/neo-agent/state",
  "agentDir": "/srv/neo-agent/omp",
  "sources": {
    "github": {
      "enabled": true,
      "config": { "repository": "owner/repo", "cli": "/usr/local/bin/gh-agent", "pollSeconds": 60 }
    }
  },
  "policy": { "sources": { "github": { "allowed": [{ "id": "your-github-login" }] } } },
  "eval": { "mode": "observe", "model": null },
  "executor": {
    "model": null,
    "maxWorkers": 3,
    "prepare": "git clone --quiet /srv/repositories/repo \"$NEO_AGENT_DIR\""
  }
}
```

Only listed GitHub users may start work explicitly. `observe` evaluates proactive candidates without accepting them; use `auto` only for bounded rules you intentionally allow. `off` disables proactive evaluation.

## 3. Start

```sh
bun install
bun run build
./lib/cli.js --config /absolute/path/config.json
```

Startup fails on invalid JSON/configuration, unknown explicit models, missing `gh`, account/repository errors, or an existing non-schema-1 database. Fix the reported issue instead of reusing a DSH state directory.

`SIGINT` and `SIGTERM` stop watchers, Sessions, Effects, environment and SQLite before exit. Models and the GitHub connection can be changed in the panel's settings window; other configuration edits require restart.
For Web-only chat, omit `sources.github`; deployment validation and watcher are skipped, and **设置 → GitHub** can connect a repository later. The panel listens on `http://127.0.0.1:3082/` by default. Set `web.enabled` to `false` to disable it or `web.port` to `0` for an ephemeral port.

## 4. Verify

From an allowed GitHub account, mention the agent in an Issue: `@<agent-login> Fix the README typo`. Expect one acknowledgement, one worker Ticket, one result, and no duplicate after restart. For a full offline check, run `bun scripts/omp-smoke.ts lib/cli.js`.

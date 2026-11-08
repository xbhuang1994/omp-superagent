# 005 Sessions

## Roles and isolation

`OMPSessions` owns shared `AuthStorage` and `ModelRegistry`, while every Session gets a private `AgentRegistry` and isolated Settings. Async execution, automatic bash backgrounding and launch are disabled; retry and compaction stay enabled. MCP, LSP and extension discovery are off.

The orchestrator gets only application tools and no repository context files. A worker gets `read`, `bash`, `edit`, `write`, application tools, its Ticket mandate and the packaged GitHub skill. It retains repository `AGENTS.md`. A restricted extension checks Ticket liveness before every built-in or custom tool call.

## Persistence

A new Session uses `SessionManager.create`, forces the initial file onto disk and records that path under its durable external alias. Reopen uses `SessionManager.open(..., { throwIfMissing: true })`; corruption and missing files name the alias/path and stop startup. Session names are user-set, so no automatic title-model call occurs.

Non-null role models resolve through the shared registry and override restored transcript selections without persisting that override. Null preserves an existing selection; only a new Session uses OMP default selection.

## Delivery and transcripts

Application messages use hidden custom messages, never host inbox objects. Each carries `requestId` and optional Input IDs. The delivery layer scans full SessionManager branches, not only active model messages. Entry visibility plus `flushToDisk()` is the commit barrier; Effects never wait for the whole model turn.

`transcript(ticketId)` returns OMP `AgentMessage[]`, supporting resource pagination/previews. `stopAll()` begins disposal on all loaded Sessions before awaiting any cleanup, preventing queued work from starting another turn.

The Web panel's reset action disposes the current orchestrator, removes only its alias-to-JSONL mapping, and creates an empty Session under the same durable alias. Domain state, worker Sessions, attachments, and WeChat credentials/cursor survive. WeChat final-reply delivery is rebound to the replacement Session.

## Web and WeChat chat

Visible chat messages use the same durable custom-entry delivery as other application messages. Web requests generate `web:<uuid>` IDs; WeChat uses `wechat:<message_id>` so redelivery after a crash cannot create another turn. Both use native image content, inline UTF-8 text, or durable files as appropriate.

`WeChatBridge` accepts direct messages only from the user ID captured during QR binding. It advances the persisted iLink cursor only after Session delivery reaches the disk barrier. Final assistant text from each yielded orchestrator run is sent to the bound user; `wechat_send_file` sends a verified local image, video, or file. Credentials, bound user, context token, and cursor live in SQLite and are never exposed by the Web API.

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

The Web panel's reset action disposes the current orchestrator, removes only its alias-to-JSONL mapping, and creates an empty Session under the same durable alias. Domain state, worker Sessions, attachments, Source Triggers, and WeChat credentials/cursor survive. Outbox delivery needs no Session event subscription and continues into the replacement transcript.

## Web and WeChat chat

Visible chat messages use idempotent custom entries with no model turn. `ChatSource` renders attachments, persists the user entry, derives `trigger_id` from the source `messageId`, and calls Engine intake. Web requests use `web:<uuid>`; WeChat uses `wechat:<message_id>`. Native image content, inline UTF-8 text, and durable files retain their existing presentation.

`WeChatBridge` accepts direct messages only from the user ID captured during QR binding and advances the iLink cursor only after Trigger intake. Confirmations, answers, attention, and results travel through Outbox to the originating Web or WeChat conversation; no final-assistant listener forwards unrelated replies. Web publication uses stable `chat-reply:<outbound-id>` entries, while iLink uses the OutboundMessage ID as its client ID. `wechat_send_file` sends a verified local image, video, or file. Credentials, bound user, context token, and cursor live in SQLite and are never exposed by the Web API.

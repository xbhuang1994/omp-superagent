# 003 Execution

## Ticket lifecycle

An accepted Ticket owns its Mandate, workspace and persistent OMP worker. `OMPExecutor` prepares the directory once, ensures the worker, and sends `assignment:<ticketId>` (or `assignment:<ticketId>:<assignmentId>` for recovery). The message becomes durable before `assignmentStarted` commits. A worker therefore reports against a running Assignment.

Every subsequent Input uses the Ticket's single durable delivery Effect. Before each send, the Executor rereads Ticket/Assignment and stops if either ended or was replaced. The custom entry and `flushToDisk()` complete before delivered/read commits. `agent_start` alone occupies a running slot; launch/ensure/send failure releases its reservation. `maxWorkers` caps workers, wakes take priority, and a person's follow-up may use one extra slot.

A resumed Assignment's first message carries the marker and the message that resumed it, after the restart JSON, and confirms both Inputs delivered at once: a worker that restarted on the bare marker could judge the ticket done and report `dropped` before the message arrived, ending the ticket with the message unread.

Only terminal `agent_end` completes a turn. Intermediate retry/compaction ends do not. OMP handles model retries; the Executor has no second retry loop. A ready/attention/blocked/failed report is already a handoff. Otherwise the Executor writes `waiting` with the final assistant text and relays it. Final assistant error becomes `failed`.

## Background work

A worker command still running after 60 seconds, or when a message is steered in, becomes an OMP background job. A worker spawns subagents with `task`, each a background job of the worker. A job's end wakes the worker in the same Session with its result.

A turn that ends while jobs run emits a non-terminal `agent_end` with `awaitingAsyncWork`. The Ticket keeps its slot and stays working, with no waiting report; the job's wake starts the next turn in that slot. A turn that ends with nothing running completes as above.

The Executor imposes no blind kill timer on background jobs after a turn ends: normal commands use OMP's per-command timeouts, while long `timeout: 0` jobs and `ticket-task` subagents run until they settle and wake the worker. Instead, the external `Watchdog` Control Loop inspects long-running and idle tickets periodically—leaving productive runs untouched, waking workers whose detached external work finished or stalled, and surgically cancelling a hung job (`cancelJob`) while waking the worker with the reason; if waking fails with no job left, the Executor falls back to `waiting`.

A handoff to a person frees the slot at once: a ready report or a question with no Input delivered since, or a blocked or failed report. Its subagents are cancelled. Its shell jobs, such as a server offered for review, are acknowledged and run until the Assignment ends; they hold no slot, are exempt from the limit in later turns, and their end wakes no one. OMP emits no further `agent_end` after an acknowledgement, so the Executor completes that turn itself.

When an Assignment ends, Session disposal cancels every job, including those left to a person. A host restart ends them all; the recovery note tells the worker to rerun what it still needs.

Subagents use the session agent `ticket-task`: OMP's bundled `task` prompt with `read`, `bash`, `edit`, `write`, the worker's current model, at most 8 at once per worker and 2 levels deep. They get no application tools, so only the worker reports. The worker's Ticket guard extension is inherited and blocks their tools once the Ticket ends. `task` is refused when a repository or user agent definition named `ticket-task` would replace it. Explicit subagent names get a ticket prefix, because OMP registers subagents process-wide. A finished subagent is never continued (`write agent://…` is refused): disposing any worker Session releases every worker's finished subagents.

## Stop and recovery

Ticket stop rejects pending deliveries before disposal. If no new Input follows a ready/dropped report, disposal waits for terminal end; otherwise it starts after `beginDispose()`. A later authorized follow-up reopens the same JSONL.

On restart, running Assignments call `assignmentInterrupted()`: settled work resumes, while unfinished work gets a new Assignment and recovery note. Pending non-person-waiting Assignments relaunch. Unread delivered Inputs are replayed idempotently. Persisted request IDs prevent duplicate custom entries.

Workspace `prepare` runs through `execFile` as `sh -c` with a ten-minute timeout and Ticket environment. Failure does not auto-retry, because an existing directory counts as prepared and a retry could treat partial output as valid. Local/worktree credential and HTTP-header overrides are rejected.

Runtime shutdown stops watcher/passes, synchronously bars every Session from starting new work, disposes them, drains Effects, restores environment, closes SQLite and releases the lock.

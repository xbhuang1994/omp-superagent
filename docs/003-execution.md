# 003 Execution

## Ticket lifecycle

An accepted Ticket owns its Mandate, workspace and persistent OMP worker. `OMPExecutor` prepares the directory once, ensures the worker, and sends `assignment:<ticketId>` (or `assignment:<ticketId>:<assignmentId>` for recovery). The message becomes durable before `assignmentStarted` commits. A worker therefore reports against a running Assignment.

Every subsequent Input uses the Ticket's single durable delivery Effect. Before each send, the Executor rereads Ticket/Assignment and stops if either ended or was replaced. The custom entry and `flushToDisk()` complete before delivered/read commits. `agent_start` alone occupies a running slot; launch/ensure/send failure releases its reservation. `maxWorkers` caps workers, wakes take priority, and a person's follow-up may use one extra slot.

Only terminal `agent_end` completes a turn. Intermediate retry/compaction/async ends do not. OMP handles model retries; the Executor has no second retry loop. A ready/attention/blocked/failed report is already a handoff. Otherwise the Executor writes `waiting` with the final assistant text and relays it. Final assistant error becomes `failed`.

## Stop and recovery

Ticket stop rejects pending deliveries before disposal. If no new Input follows a ready/dropped report, disposal waits for terminal end; otherwise it starts after `beginDispose()`. A later authorized follow-up reopens the same JSONL.

On restart, running Assignments call `assignmentInterrupted()`: settled work resumes, while unfinished work gets a new Assignment and recovery note. Pending non-person-waiting Assignments relaunch. Unread delivered Inputs are replayed idempotently. Persisted request IDs prevent duplicate custom entries.

Workspace `prepare` runs through `execFile` as `sh -c` with a ten-minute timeout and Ticket environment. Failure does not auto-retry, because an existing directory counts as prepared and a retry could treat partial output as valid. Local/worktree credential and HTTP-header overrides are rejected.

Runtime shutdown stops watcher/passes, synchronously bars every Session from starting new work, disposes them, drains Effects, restores environment, closes SQLite and releases the lock.

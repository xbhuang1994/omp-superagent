# 004 Prompts

## Composition

`Prompts.compose()` combines built-in role text, team sections, execution environment, and (for the orchestrator) current Policy. The complete text is passed through OMP `customSystemPrompt`, preserving OMP's project footer. Workers additionally receive `mandateInstructions(ticket.mandate)`.

The orchestrator loads no repository context files. Workers keep the target directory's `AGENTS.md`. Both roles disable discovered prompt templates, slash commands and rules. Only the packaged `omp-superagent-github` skill is loaded into workers; the orchestrator receives no skills.

Team sections are `communication`, `scope`, and `delivery`. Versioned Prompt storage can retain team sections, custom skills and built-in overrides, with template placeholder validation and total-size limits. Runtime editing is outside this core service: startup JSON and stored versions are applied when Sessions are created/reopened, not edited by an agent tool.

## Tools and behavior

Orchestrator tools cover reading, routing, retries/status/notes, trigger requeue, assessment, replies and unsubscribe. Worker tools cover reading, acknowledgement, thread follow/unrelated, handback and reports. They are adapted from Zod to JSON Schema and parsed again at execution. No settings-save, policy-sync or Prompt-save tool exists. A report's optional `topic` (one or two sentences on what the Ticket is about) becomes the Ticket's `digest` that chat routing matches; a `dropped` report never replaces it, and a topic over 200 characters is cut rather than refusing the report, which may carry an answer.

For chat, `dispatch` tells the orchestrator to route by each card's `title`, `asked` and `digest`; to attach more work on what a Ticket built, and questions about it, to that Ticket without reading it first; to treat any request that needs work, repository-related or not, as work for a worker rather than answering or doing it itself; and to correct evident speech-transcript errors in titles and acknowledgements while workers read the original text.

The orchestrator has no shell. Workers get only `read`, `bash`, `edit`, `write` plus application tools. `task`, `wait`, web, todo, MCP, subagents and discovery tools are excluded. Async execution and automatic bash backgrounding are disabled, so prompts make no background-job or subagent promises.

## Environment

Prompt and prepare examples use `OMP_SUPERAGENT_*` variables. A PR from a branch whose final segment is `OMP_SUPERAGENT_NAME` can bind to its Ticket. Prompt changes require restart; they do not alter authorization, Source scope, account wrappers or tool permissions.

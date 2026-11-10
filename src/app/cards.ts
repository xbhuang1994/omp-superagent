/** Compact, bounded model-facing projections of triggers, tickets, threads, and decisions; full texts stay behind readable resources. */
import { latestReport, reasonText, threadKey, ticketStage, type Decision, type Mandate, type Thread, type Ticket, type TicketInput,
  type Trigger, type TriggerDisposition } from '../core/index.ts'
import { pullOf } from '../sources/github-pull.ts'
import { batchLine, inputResource } from '../executor/omp.ts'

/** Collapses whitespace and truncates text for display previews while keeping code, angle brackets, and links intact for model readers. */
export function preview(text: string): string { return text.replace(/\s+/g, ' ').slice(0, 160) }
export function triggerCard(trigger: Trigger, disposition?: TriggerDisposition) {
  return { trigger_id: trigger.id, source: trigger.source, ...(trigger.url ? { source_url: trigger.url } : {}), actor: trigger.actor.id, thread: threadKey(trigger.threads[0]!), human: trigger.human, at: trigger.at,
    preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}`,
    ...(disposition ? { disposition: { ...(disposition.filtered ? { filtered: reasonText(disposition.filtered) } : {}),
      ...(disposition.decisionId ? { decision_id: disposition.decisionId } : {}),
      delivered_to: disposition.fanout } } : {}) }
}
/** The states a ticket card shows: an open ticket's stage (docs/003), and an ended ticket's outcome. */
export const TICKET_STATES = ['person/delivery', 'person/answer', 'person/review', 'person/blocked', 'person/failed', 'working', 'working/queued', 'idle',
  'completed', 'merged', 'closed', 'dropped', 'stopped'] as const
export type TicketCardState = typeof TICKET_STATES[number]
function cardState(ticket: Ticket): TicketCardState {
  if (ticket.ended) return ticket.ended.outcome
  const stage = ticketStage(ticket)
  if (stage.stage === 'person') return `person/${stage.action}`
  return stage.stage === 'idle' ? 'idle' : stage.stage === 'working' && stage.action ? 'working/queued' : 'working'
}
/** The worker's topic, else its latest report that was not a drop, which only says it handed a message back. */
function subjectOf(ticket: Ticket): string | undefined {
  return ticket.digest ?? ticket.assignments.findLast(item => item.report && item.report.state !== 'dropped')?.report?.summary
}
/** What a message is matched against: the worker's topic, else the title with its latest report that was not a drop. */
function digestOf(ticket: Ticket): string {
  if (ticket.digest) return ticket.digest
  const subject = subjectOf(ticket)
  return preview(subject ? `${ticket.title}: ${subject}` : ticket.title)
}
export function ticketCard(ticket: Ticket) {
  const ended = ticket.ended && { at: ticket.ended.at, by: ticket.ended.by, reason: ticket.ended.reason ?? ticket.ended.outcome }
  const { attention } = ticket
  return { ticket_id: ticket.id, title: ticket.title, digest: digestOf(ticket), state: cardState(ticket), strength: ticket.mandate.strength,
    ...(pullOf(ticket) ? { pr_number: pullOf(ticket) } : {}), ...(ended ? { ended } : {}),
    ...(attention ? { attention: { question: attention.question, ...attention.triggerId ? { trigger_id: attention.triggerId } : {} } } : {}),
    preview: preview(latestReport(ticket)?.summary ?? ''), read: `ticket/${ticket.id}` }
}
/**
 * A chat candidate's compact ticket card: what routing a message needs. `asked` is the start of the request it was accepted
 * from, which holds the paths and names a title leaves out; the digest leaves out the title the card already shows.
 */
export function routingCard(ticket: Ticket, asked?: string) {
  const { attention } = ticket
  const subject = subjectOf(ticket)
  return { ticket_id: ticket.id, title: ticket.title, ...asked ? { asked: preview(asked).slice(0, 100) } : {}, ...subject ? { digest: preview(subject) } : {},
    state: cardState(ticket), updated: ticket.updatedAt.slice(0, 16), ...(attention ? { attention: { question: attention.question } } : {}) }
}
/** Strips `policyVersion`, an internal hash that callers never query by. */
const mandateOf = ({ policyVersion: _version, ...mandate }: Mandate) => mandate
export const INPUTS = 10, ASSIGNMENTS = 3
const INPUT_TEXT = 80
/** Summarizes a ticket input inline for short text or as a resource reference, omitting decision IDs for worker Sessions. */
export function inputLine(ticket: Ticket, input: TicketInput, worker = false) {
  const read = { read: inputResource(ticket.id, input.id) }
  const names = input.kind === 'trigger' || input.kind === 'resumed' ? { trigger_id: input.triggerId }
    : input.kind === 'reopen' && !worker ? { decision_id: input.decisionId }
    : input.kind !== 'text' ? read
    : input.text.length <= INPUT_TEXT ? { text: input.text }
    : { preview: preview(input.text).slice(0, INPUT_TEXT), chars: input.text.length, ...read }
  return { kind: input.kind, at: input.at, ...names, ...ticket.undelivered.includes(input.id) ? { undelivered: true } : {} }
}
export function assignmentLine(ticket: Ticket, item: Ticket['assignments'][number]) {
  return { id: item.id, state: item.state, at: item.createdAt, ...(item.endedReason ? { ended_reason: reasonText({ code: item.endedReason }) } : {}),
    ...(item.report ? { report: { state: item.report.state, at: item.report.at, preview: preview(item.report.summary).slice(0, 100),
      chars: item.report.summary.length, read: `ticket/${ticket.id}/report/${item.id}` } } : {}) }
}
export function newestPage<T, L>(items: readonly T[], offset: number, size: number, line: (item: T) => L, next: string) {
  const newest = items.slice().reverse()
  const more = offset + size < newest.length
  return { items: newest.slice(offset, offset + size).map(line), ...more ? { next_resource: next, next_offset: offset + size } : {} }
}
export interface TicketThread { thread: string; context?: true; bound?: true }
/** Projects a ticket with its linked triggers, threads, and first pages of assignments and inputs, omitting decision IDs for workers. */
export function ticketDetails(ticket: Ticket, threads: TicketThread[], batch: readonly Trigger[], worker = false) {
  // Drop card preview because the latest report's preview is already shown on the first assignment entry.
  const { preview: _preview, ...card } = ticketCard(ticket)
  return { ...card, trigger_id: ticket.origin.triggerId, ...batch.length ? { batch: batch.map(batchLine) } : {},
    ...worker ? {} : { decision_id: ticket.decisionId }, threads, directory: ticket.execution?.directory,
    scope: ticket.mandate.scope, requested_by: ticket.mandate.actor.id,
    assignments: newestPage(ticket.assignments, 0, ASSIGNMENTS, item => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`),
    inputs: newestPage(ticket.inputs, 0, INPUTS, input => inputLine(ticket, input, worker), `ticket/${ticket.id}/inputs`),
    assignment: `ticket/${ticket.id}/assignment`, result: `ticket/${ticket.id}/result`, transcript: `ticket/${ticket.id}/transcript` }
}

export function threadCard(thread: Thread, label: string) {
  return { thread: thread.key, label, source: thread.ref.source, tickets: thread.subscriptions,
    ...(thread.evaluating ? { evaluating: { since: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } } : {}),
    pending: thread.pending.length,
    ...(thread.meta.pollError ? { error: preview(String(thread.meta.pollError)) } : {}), ...(thread.meta.url ? { url: thread.meta.url } : {}),
    read: `thread/${thread.key}` }
}
export function decisionCard(decision: Decision) {
  return { decision_id: decision.id, kind: decision.kind, reason: reasonText(decision.reason), strength: decision.strength,
    thread: decision.threadKey,
    trigger_ids: decision.triggerIds, ...(decision.ticketId ? { ticket_id: decision.ticketId } : {}), at: decision.at,
    read: `decision/${decision.id}` }
}
export function decisionDetails(decision: Decision) {
  return { ...decisionCard(decision), ...(decision.mandate ? { mandate: mandateOf(decision.mandate) } : {}),
    ...(decision.audit ? { audit: decision.audit } : {}) }
}
/** Slices text by UTF-16 code units so concatenated pages reconstruct the exact string. */
export function textPage(resource: string, text: string, offset: number, limit: number) {
  const end = Math.min(text.length, offset + limit)
  return { resource, offset, total_chars: text.length, next_offset: end < text.length ? end : null, text: text.slice(offset, end) }
}
export function relatedTickets(tickets: readonly Ticket[], limit = 8, card: (ticket: Ticket) => object = ticketCard) {
  const order = [...tickets].sort((a, b) => Number(!a.ended) === Number(!b.ended) ? b.createdAt.localeCompare(a.createdAt) : a.ended ? 1 : -1)
  return { related_tickets: order.slice(0, limit).map(card), tickets_total: tickets.length }
}

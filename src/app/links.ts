/** Source message link resolution and candidate card assembly for the main Session. */
import type { Candidate, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { triggerMessage } from '../executor/omp.ts'
import { relatedTickets, routingCard, ticketCard, triggerCard } from './cards.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'

export interface LinkHost {
  readonly store: Pick<Store, 'settings' | 'triggers' | 'threads' | 'tickets'>
  readonly links: TextCache
  readonly commands: Commands
  readonly sources: SourceRegistry
  readonly lifetime: AbortSignal
}

/** GitHub Triggers carry their external URL; no secondary link lookup is needed. */
export async function sourceLink(_host: LinkHost, trigger: Trigger, _signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }> {
  return trigger.url ? { source_url: trigger.url } : {}
}

export function repliedTo({ store, sources }: { store: Pick<Store, 'triggers'>; sources: Pick<SourceRegistry, 'repliesTo'> },
  trigger: Trigger): Trigger | undefined {
  const parent = sources.repliesTo(trigger)
  return parent === undefined ? undefined : store.triggers.get(parent)
}
/** Finds tickets subscribed to threads referenced in `trigger.text` (such as `#12` or URLs) that are not already in `known`. */
function referencedTickets(host: LinkHost, trigger: Trigger, known: readonly Ticket[]): Ticket[] {
  const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap(reference => host.sources.find(reference).threads)
  const ids = new Set(threads.flatMap(thread => host.store.threads.get(thread)?.subscriptions ?? []))
  for (const ticket of known) ids.delete(ticket.id)
  return [...ids].flatMap(id => host.store.tickets.get(id) ?? []).slice(0, 4)
}
/** Chat threads keep every ticket subscribed, so a chat candidate lists more of them than another Source's. */
const CHAT_RELATED = 20
/** Workers that handed one message back before no open ticket is taken to own it: it is new work. */
const MISS_LIMIT = 3
/** Builds the main Session's candidate card with routing metadata, handback history, and related or referenced tickets. */
export async function candidateCard(host: LinkHost, candidate: Candidate) {
  const primary = candidate.triggers.at(-1)!
  const settings = host.store.settings()
  const delivered = host.store.triggers.disposition(primary.id)?.fanout ?? []
  const referenced = referencedTickets(host, primary, candidate.tickets)
  // Triggers that a worker Session handed back as outside its ticket's scope, with the worker's reason.
  const handedBack = candidate.triggers.flatMap(trigger => (host.store.triggers.disposition(trigger.id)?.handbacks ?? [])
    .map(item => ({ trigger_id: trigger.id, ticket_id: item.ticketId, reason: item.reason })))
  // Format the primary trigger like a worker input (including the message it replies to) and summarize earlier batch triggers as cards.
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  const missed = handedBack.filter(item => item.trigger_id === primary.id).length >= MISS_LIMIT
  return { ...triggerMessage(primary, await sourceLink(host, primary), undefined, repliedTo(host, primary)), strength: candidate.strength,
    mode: settings.eval.mode, ...others.length ? { batch: others.map(trigger => triggerCard(trigger)) } : {},
    ...handedBack.length ? { handed_back: handedBack } : {},
    ...primary.source === 'chat'
      ? relatedTickets(candidate.tickets, CHAT_RELATED, ticket => routingCard(ticket, host.store.triggers.get(ticket.origin.triggerId)?.text))
      : relatedTickets(candidate.tickets),
    ...(delivered.length ? { delivered_to: delivered } : {}), ...(referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {}),
    next_action: missed ? `${MISS_LIMIT} tickets handed this message back, so no ticket owns it: treat it as new work and route it with orchestrator_route kind=accept; do not attach it to another ticket. If it is ordinary conversation needing no ticket, use kind=ignore with answer set instead.`
      : candidate.strength === 'explicit' ? primary.source === 'chat'
      ? 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore. If ordinary conversation needs no ticket, use kind=ignore with answer set to a natural response in the source language and tone; this sends through the existing reply pipeline in the same call, without another model turn or a stock no-ticket response.'
      : 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.'
      : 'Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.' }
}

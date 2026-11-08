/** Paginated GitHub/domain resources exposed through orchestrator_read. */
import { UserError, key, latestReport, reached, threadKey, type Ticket, type Trigger } from '../core/index.ts'
import { batchOf, inputMessage, triggerMessage, workerSessionId } from '../executor/omp.ts'
import { readGithub } from '../sources/github-read.ts'
import { ASSIGNMENTS, INPUTS, assignmentLine, decisionCard, decisionDetails, inputLine, newestPage, preview, textPage, threadCard, ticketCard,
  ticketDetails, triggerCard, type TicketThread } from './cards.ts'
import { threadTitle } from './views/records.ts'
import type { Commands } from '../infra/commands.ts'
import type { OMPSessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'

export const RESOURCES: readonly { name: string; holds: string; executor?: true }[] = [
  { name: 'tickets', holds: 'ticket cards, newest first' },
  { name: 'triggers', holds: 'trigger cards with where each went, newest first' },
  { name: 'threads', holds: 'subscribed threads, newest activity first' },
  { name: 'thread/<key>', holds: 'one thread and its triggers', executor: true },
  { name: 'decisions', holds: 'decisions, newest first' },
  { name: 'decision/<id>', holds: 'one decision with its audit' },
  { name: 'ticket/<id>', holds: 'a ticket, its origin, threads, assignments and inputs', executor: true },
  { name: 'ticket/<id>/assignment', holds: 'its assignment text', executor: true },
  { name: 'ticket/<id>/assignments', holds: 'its assignments, newest first', executor: true },
  { name: 'ticket/<id>/inputs', holds: 'its inputs, newest first', executor: true },
  { name: 'ticket/<id>/result', holds: 'its latest report', executor: true },
  { name: 'ticket/<id>/report/<id>', holds: 'the report of one assignment', executor: true },
  { name: 'ticket/<id>/transcript', holds: 'its OMP worker messages, newest first', executor: true },
  { name: 'ticket/<id>/message/<n>', holds: 'one OMP worker message', executor: true },
  { name: 'ticket/<id>/input/<id>', holds: 'one delivered input', executor: true },
  { name: 'trigger/<id>', holds: 'a trigger and its nearby thread messages', executor: true },
  { name: 'github/…', holds: 'a GitHub original, as the bundled GitHub skill describes', executor: true },
]
export const resourceGrammar = (executor: boolean): string => RESOURCES.filter(resource => !executor || resource.executor)
  .map(resource => `${resource.name}: ${resource.holds}`).join('; ')

export interface ResourceHost {
  readonly store: Pick<Store, 'settings' | 'triggers' | 'tickets' | 'threads' | 'read' | 'decisions' | 'replyStatus'>
  readonly pages: TextCache
  readonly commands: Commands
  readonly masterId: string
  readonly sessions: Pick<OMPSessions, 'transcript'>
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
}
interface Read { host: ResourceHost; resource: string; rest: string; offset: number; limit?: number; sessionId: string; ticketId?: string; signal?: AbortSignal }
type Route = readonly [name: string, read: (read: Read) => unknown]
const main = ({ ticketId }: Read): void => { if (ticketId) throw new Error('This resource belongs to the main Session') }
const text = ({ resource, offset, limit }: Read, body: string) => textPage(resource, body, offset, limit ?? 4000)
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? 20, 50)
  const items = fetch(offset, size + 1)
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null }
}
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean => reached(ticket, trigger, key => host.store.threads.get(key))
  || ticket.origin.triggerIds.includes(trigger.id) || trigger.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)))
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  const found = host.store.triggers.get(id)
  if (!found) throw new UserError('unknownTrigger')
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError('notReached')
  return found
}
async function sourcePage(read: Read, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`)
  if (body === undefined) throw new Error('Read this GitHub resource from offset 0 first')
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body)
  return text(read, body)
}
const THREAD_DECISIONS = 5
const triggerLine = (trigger: Trigger) => ({ trigger_id: trigger.id, actor: trigger.actor.id, human: trigger.human, at: trigger.at,
  preview: preview(trigger.text), chars: trigger.text.length, read: `trigger/${trigger.id}` })

function messagePreview(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  const content = 'content' in event ? event.content : 'message' in event && event.message && typeof event.message === 'object' && 'content' in event.message
    ? event.message.content : undefined
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (!block || typeof block !== 'object' || !('type' in block)) return ''
    return block.type === 'text' && 'text' in block && typeof block.text === 'string' ? block.text : `[${String(block.type)}]`
  }).join(' ')
}
function messageType(event: unknown): string {
  if (!event || typeof event !== 'object') return 'unknown'
  if ('role' in event && typeof event.role === 'string') return event.role
  if ('customType' in event && typeof event.customType === 'string') return event.customType
  return 'message'
}

const ROUTES: readonly Route[] = [
  ['tickets', read => {
    main(read)
    const tickets = read.host.store.tickets.list()
    return list(read, (offset, count) => tickets.slice(offset, offset + count).map(ticket => ticketCard(ticket)))
  }],
  ['triggers', read => {
    main(read)
    const { store } = read.host
    return list(read, (offset, count) => store.read.recentTriggers(offset, count).map(item => triggerCard(item, store.triggers.disposition(item.id))))
  }],
  ['threads', read => {
    main(read)
    const { store } = read.host
    const threads = store.read.subscribedThreads().sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt))
    return list(read, (offset, count) => threads.slice(offset, offset + count).map(thread => threadCard(thread, threadTitle(store, thread))))
  }],
  ['thread/', read => {
    const { host, rest, ticketId } = read
    const thread = host.store.threads.get(rest)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    if (!thread || (ticketId && !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === rest)))) {
      throw new Error('Unknown or inaccessible thread')
    }
    const { store } = host
    const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread))
    const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine))
    if (ticketId) return { ...card, ...page }
    const tickets = ids.flatMap(id => { const found = store.tickets.get(id); return found ? [ticketCard(found)] : [] })
    const decisions = store.decisions.byThread(thread.key).slice(-THREAD_DECISIONS).reverse().map(decisionCard)
    return { ...card, tickets, decisions, ...page }
  }],
  ['decisions', read => { main(read); return list(read, (offset, count) => read.host.store.read.recentDecisions(offset, count).map(decisionCard)) }],
  ['decision/', read => {
    main(read)
    const decision = read.host.store.decisions.get(read.rest)
    if (!decision) throw new Error('Unknown decision')
    return decisionDetails(decision)
  }],
  ['github/', read => sourcePage(read, () => readGithub(read.host.commands.withSignal(read.signal), read.resource))],
  ['trigger/', async read => {
    const { host, rest, ticketId, offset, signal } = read
    if (!rest || rest.includes('/')) throw new Error('Unknown context resource')
    const found = trigger(host, rest, ticketId)
    const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
    const shown = (item: Trigger | undefined) => item && (!ticket || readable(host, ticket, item)) ? item : undefined
    const disposition = host.store.triggers.disposition(found.id)
    const visible = disposition && ticket ? { ...disposition, decisionId: undefined, fanout: disposition.fanout.filter(id => id === ticket.id) } : disposition
    const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible)
    const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id)
    const around = { before: shown(neighbours.before), after: shown(neighbours.after) }
    return { ...card, ...await host.sourceLink(found, signal), acknowledgement: host.store.replyStatus(key('ack', found.id)) ?? 'not_requested',
      ...(offset === 0 ? { around: { ...around.before ? { before: triggerLine(around.before) } : {}, ...around.after ? { after: triggerLine(around.after) } : {} } } : {}),
      ...text(read, found.text) }
  }],
  ['ticket/', async read => {
    const { host, resource, rest, ticketId, signal } = read
    const [id, section, part, ...more] = rest.split('/')
    if (!id || more.length) throw new Error('Unknown context resource')
    if (ticketId && ticketId !== id) throw new Error('Ticket does not belong to this worker')
    const ticket = host.store.tickets.get(id)
    if (!ticket) throw new UserError('unknownTicket')
    if (section === undefined) {
      const bound = new Set((ticket.follows ?? []).map(follow => follow.thread))
      const subscribed = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(id))
      const marked = (key: string, context: boolean): TicketThread => ({ thread: key, ...context ? { context: true } : {}, ...bound.has(key) ? { bound: true } : {} })
      const threads = [...subscribed.map(thread => marked(thread.key, !!thread.context?.includes(id))),
        ...[...bound].filter(key => !subscribed.some(thread => thread.key === key)).map(key => marked(key, false))]
      return ticketDetails(ticket, threads, batchOf(host, ticket), !!ticketId)
    }
    if (section === 'assignments' || section === 'inputs') {
      if (part !== undefined) throw new Error('Unknown context resource')
      const size = Math.min(read.limit ?? (section === 'assignments' ? ASSIGNMENTS : INPUTS), 50)
      const { items, next_offset } = section === 'assignments'
        ? newestPage(ticket.assignments, read.offset, size, item => assignmentLine(ticket, item), resource)
        : newestPage(ticket.inputs, read.offset, size, input => inputLine(ticket, input, !!ticketId), resource)
      return { items, next_offset: next_offset ?? null }
    }
    let body: string
    if (section === 'input' && part) {
      const input = ticket.inputs.find(item => key(item.id) === part || item.id === part)
      const found = input?.kind === 'trigger' ? host.store.triggers.get(input.triggerId) : undefined
      const card = found && input?.kind === 'trigger' ? triggerMessage(found, await host.sourceLink(found, signal), input.note) : undefined
      const message = input && inputMessage(input, card)
      if (message === undefined) throw new Error('Unknown ticket input')
      body = message
    } else if (section === 'message' && part && /^\d+$/.test(part)) {
      const event = (await host.sessions.transcript(id))[Number(part)]
      if (!event || typeof event !== 'object') throw new Error('Unknown transcript entry')
      body = JSON.stringify(event)
    } else if (section === 'report' && part) {
      const report = ticket.assignments.find(item => item.id === part)?.report
      if (!report) throw new Error('Unknown assignment report')
      body = report.summary
    } else if (part !== undefined) throw new Error('Unknown context resource')
    else if (section === 'assignment') body = ticket.execution?.assignment ?? ''
    else if (section === 'result') body = latestReport(ticket)?.summary ?? ''
    else if (section === 'transcript') {
      body = (await host.sessions.transcript(id)).flatMap((event, index) => {
        if (!event || typeof event !== 'object') return []
        const said = messagePreview(event)
        return [{ type: messageType(event), preview: preview(said).slice(0, 80), chars: JSON.stringify(event).length,
          read: `ticket/${id}/message/${index}` }]
      }).reverse().map(event => JSON.stringify(event)).join('\n')
    } else throw new Error('Unknown context resource')
    return text(read, body)
  }],
]

/** Read a core resource; removed resources and legacy aliases all use the same unknown-resource error. */
export async function readResource(host: ResourceHost, resource: string, offset: number, limit: number | undefined, ticketId?: string,
  signal?: AbortSignal) {
  const route = ROUTES.find(([prefix]) => prefix.endsWith('/') ? resource.startsWith(prefix) : resource === prefix)
  if (!route) throw new Error('Unknown context resource')
  const sessionId = ticketId ? workerSessionId(ticketId) : host.masterId
  const rest = route[0].endsWith('/') ? resource.slice(route[0].length) : ''
  return route[1]({ host, resource, rest, offset, sessionId, ...limit ? { limit } : {}, ...ticketId ? { ticketId } : {},
    ...signal ? { signal } : {} })
}

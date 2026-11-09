/** Actual worker state and bounded progress projections for the Web panel. */
import { latestAssignment, ticketStage, type Assignment, type Ticket, type TicketInput, type TicketOutcome, type TicketStage } from '../core/index.ts'
import { workerSessionId } from '../executor/omp.ts'
import type { OMPSessions } from './sessions.ts'
import type { Store } from './store.ts'

export interface WorkerCard {
  ticketId: string
  title: string
  stage: TicketStage
  outcome?: TicketOutcome
  updatedAt: string
  directory?: string
  session: { loaded: boolean; streaming: boolean }
  assignment?: Pick<Assignment, 'id' | 'state' | 'createdAt' | 'startedAt' | 'endedAt' | 'deliveredAt' | 'idleAt'>
  progress?: Assignment['report']
  attention?: Ticket['attention']
  pendingInputs: number
  delivery?: Ticket['delivery']
}
export interface WorkerDetail extends WorkerCard {
  inputs: (TicketInput & { delivered: boolean })[]
  recent: { id: number; role: string; text: string; at?: number }[]
}

function activityText(message: unknown): string {
  if (!message || typeof message !== 'object' || !('content' in message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (!block || typeof block !== 'object' || !('type' in block)) return []
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') return [block.text]
    if (block.type === 'image') return ['[图片]']
    if (block.type === 'toolCall' && 'name' in block && typeof block.name === 'string') {
      const args = 'arguments' in block ? JSON.stringify(block.arguments) : ''
      return [`[调用 ${block.name}]${args ? `\n${args.slice(0, 2000)}` : ''}`]
    }
    return []
  }).join('\n').slice(0, 4000)
}

/** Reads Ticket, Assignment and real OMP Session state without inferring activity from message text. */
export class WorkerView {
  constructor(private readonly store: Pick<Store, 'tickets'>, private readonly sessions: Pick<OMPSessions, 'get' | 'transcript'>) {}

  private card(ticket: Ticket): WorkerCard {
    const assignment = latestAssignment(ticket)
    const session = this.sessions.get(workerSessionId(ticket.id))
    return {
      ticketId: ticket.id, title: ticket.title, stage: ticketStage(ticket), outcome: ticket.ended?.outcome,
      updatedAt: ticket.updatedAt, directory: ticket.execution?.directory,
      session: { loaded: !!session, streaming: !!session && !session.isDisposed && session.isStreaming },
      assignment: assignment ? { id: assignment.id, state: assignment.state, createdAt: assignment.createdAt, startedAt: assignment.startedAt,
        endedAt: assignment.endedAt, deliveredAt: assignment.deliveredAt, idleAt: assignment.idleAt } : undefined,
      progress: assignment?.report,
      attention: ticket.attention,
      pendingInputs: ticket.undelivered.length,
      delivery: ticket.delivery,
    }
  }
  list(): WorkerCard[] {
    return this.store.tickets.list().sort((left, right) => Number(!!left.ended) - Number(!!right.ended) || right.updatedAt.localeCompare(left.updatedAt)).map(ticket => this.card(ticket))
  }
  async detail(ticketId: string): Promise<WorkerDetail | undefined> {
    const ticket = this.store.tickets.get(ticketId)
    if (!ticket) return undefined
    const transcript = await this.sessions.transcript(ticketId)
    const recent = transcript.flatMap((message, index) => {
      const text = activityText(message)
      if (!text) return []
      const at = message && typeof message === 'object' && 'timestamp' in message && typeof message.timestamp === 'number' ? message.timestamp : undefined
      const role = message && typeof message === 'object' && 'role' in message && typeof message.role === 'string' ? message.role : 'unknown'
      return [{ id: index, role, text, ...at === undefined ? {} : { at } }]
    }).slice(-30)
    return { ...this.card(ticket), inputs: ticket.inputs.slice().reverse().map(input => ({ ...input, delivered: !ticket.undelivered.includes(input.id) })), recent }
  }
}

/** Idempotent, file-backed custom-message delivery to OMP sessions. */
import type { AgentSession, SessionEntry } from '@oh-my-pi/pi-coding-agent'

interface Pending {
  visible: boolean
  readonly done: Promise<void>
  readonly markVisible: () => void
  readonly fail: (error: Error) => void
}
interface DeliveryState {
  readonly pending: Map<string, Pending>
  readonly acceptInputs: (inputIds: string[]) => void
  readonly unhook: () => void
  readonly installed: (entry: SessionEntry) => void
  readonly onEntry: (entry: SessionEntry) => void
  readonly previous: ((entry: SessionEntry) => void) | undefined
  readonly unsubscribe: () => void
}

function requestIdOf(entry: SessionEntry): string | undefined {
  if (entry.type !== 'custom_message' || entry.customType !== 'omp-superagent') return undefined
  const details: unknown = entry.details
  if (!details || typeof details !== 'object' || !('requestId' in details)) return undefined
  return typeof details.requestId === 'string' ? details.requestId : undefined
}

function persisted(session: AgentSession, requestId: string): boolean {
  return session.sessionManager.getBranch().some(entry => requestIdOf(entry) === requestId)
}

/** Tracks SessionEntry visibility separately from the model run returned by sendCustomMessage. */
export class AgentDelivery {
  private readonly states = new WeakMap<AgentSession, DeliveryState>()

  bind(session: AgentSession, acceptInputs: (inputIds: string[]) => void): void {
    if (this.states.has(session)) return
    const pending = new Map<string, Pending>()
    const onEntry = (entry: SessionEntry): void => {
      const requestId = requestIdOf(entry)
      if (requestId) pending.get(requestId)?.markVisible()
    }
    const previous = session.sessionManager.onEntryAppended
    const installed = (entry: SessionEntry): void => {
      try { previous?.(entry) } finally { onEntry(entry) }
    }
    const unsubscribe = session.subscribe(event => {
      if (event.type !== 'message_end' || event.message.role !== 'custom' || event.message.customType !== 'omp-superagent') return
      const details: unknown = event.message.details
      if (details && typeof details === 'object' && 'requestId' in details && typeof details.requestId === 'string') {
        const requestId = details.requestId
        queueMicrotask(() => { if (persisted(session, requestId)) pending.get(requestId)?.markVisible() })
      }
    })
    const unhook = session.agent.addBeforeModelCallHook(async () => {
      await Promise.all([...pending.values()].filter(item => item.visible).map(item => item.done))
    })
    this.states.set(session, { pending, acceptInputs, unhook, onEntry, installed, previous, unsubscribe })
  }

  async holds(session: AgentSession, requestId: string): Promise<boolean> {
    const state = this.states.get(session)
    return persisted(session, requestId) || !!state?.pending.has(requestId)
  }

  async send(session: AgentSession, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal,
    inputIds: string[] | undefined, authorize?: () => void, accepted?: () => void): Promise<void> {
    signal.throwIfAborted()
    if (session.isDisposed) throw new Error('Delivery target was disposed')
    const state = this.states.get(session)
    if (!state) throw new Error('Delivery target is not bound')
    authorize?.()
    const existing = state.pending.get(requestId)
    if (existing) {
      await existing.done
      accepted?.()
      if (inputIds?.length) state.acceptInputs(inputIds)
      return
    }
    if (persisted(session, requestId)) {
      await session.flushToDisk()
      accepted?.()
      if (inputIds?.length) state.acceptInputs(inputIds)
      return
    }

    const { promise: visible, resolve: entryVisible, reject: fail } = Promise.withResolvers<void>()
    let pending: Pending
    const markVisible = (): void => { pending.visible = true; entryVisible() }
    const done = visible.then(async () => {
      await session.flushToDisk()
      accepted?.()
      if (inputIds?.length) state.acceptInputs(inputIds)
    }).finally(() => { if (state.pending.get(requestId) === pending) state.pending.delete(requestId) })
    pending = { visible: false, done, markVisible, fail }
    state.pending.set(requestId, pending)
    const options = typeof mode === 'object' ? { triggerTurn: false } : mode === 'steer'
      ? { triggerTurn: true, deliverAs: 'steer' as const } : { triggerTurn: true, deliverAs: 'followUp' as const }
    let running: Promise<boolean>
    try {
      running = session.sendCustomMessage({ customType: 'omp-superagent', content: text, display: false, attribution: 'agent',
        details: { requestId, ...(inputIds?.length ? { inputIds } : {}) } }, options)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      await done
      return
    }
    // Entry append is the delivery barrier. The returned run promise may include an entire model turn, so never await it here.
    void running.catch((error: unknown) => {
      if (persisted(session, requestId)) markVisible()
      else fail(error instanceof Error ? error : new Error(String(error)))
    })
    if (persisted(session, requestId)) markVisible()
    if (typeof mode === 'object') {
      try { await running } catch (error) {
        if (!persisted(session, requestId)) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      }
      if (persisted(session, requestId)) markVisible()
    }
    await done
  }

  /** Synchronously bars new turns and rejects all unconfirmed sends before asynchronous disposal begins. */
  beginDispose(session: AgentSession, reason: string): void {
    session.beginDispose()
    const state = this.states.get(session)
    if (!state) return
    for (const pending of state.pending.values()) pending.fail(new Error(reason))
    state.pending.clear()
  }

  async stop(session: AgentSession, reason: string): Promise<void> {
    this.beginDispose(session, reason)
    await session.dispose()
    const state = this.states.get(session)
    if (!state) return
    state.unhook()
    state.unsubscribe()
    if (session.sessionManager.onEntryAppended === state.installed) session.sessionManager.onEntryAppended = state.previous
    this.states.delete(session)
  }
}

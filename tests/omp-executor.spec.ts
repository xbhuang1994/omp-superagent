import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Later, Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { OMPExecutor, WorkerSlots, type ExecutorHost } from '../src/executor/omp.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'
import type { WorkerReport } from '../src/core/assignments.ts'

let dir: string
let store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omp-executor-')); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { vi.useRealTimers(); store.close(); rmSync(dir, { recursive: true, force: true }) })
function ticket(id: string, assignmentState: 'pending' | 'running' | 'ended' = 'pending'): Ticket {
  const at = '2026-01-01T00:00:00Z'
  return { id, title: id, decisionId: `decision-${id}`, mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'addressed', addressed: 'mention' },
    actor: { source: 'github', id: 'alice' }, scope: id }, channels: [], assignments: [{ id: `assignment-${id}`, state: assignmentState, createdAt: at }],
    inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] },
    execution: { name: id, directory: dir, assignment: id } }
}

it('holds launch capacity while allowing one human wake above the limit', () => {
  const running = ['one']
  const slots = new WorkerSlots(() => running, () => 1)
  expect(() => slots.reserve('two', 'launch')).toThrow(Later)
  slots.reserve('two', 'person')
  expect(slots.used()).toBe(2)
  slots.free('two')
  expect(() => slots.reserve('two', 'launch')).toThrow(Later)
  expect(slots.launches()).toBe(0)
  slots.free('two')
  running.length = 0
  expect(slots.launches()).toBe(1)
})

it('releases a failed launch reservation and disposes a stopped worker', async () => {
  const first = ticket('first'), second = ticket('second')
  store.tickets.save(first); store.tickets.save(second)
  const effects = new Effects(store, new HealthBoard())
  const ensure = vi.fn(async (sessionId: string) => { if (sessionId.endsWith('first')) throw new Error('ensure failed'); return { subscribe: () => () => {} } as never })
  const prompt = vi.fn(async () => {})
  const stop = vi.fn(async () => {})
  const host: ExecutorHost = {
    engine: {
      assignmentStarted: () => {}, turnEnded: () => {}, deliveryFailed: () => {}, assignmentInterrupted: () => {},
      report: (ticketId, report) => {
        const current = store.tickets.get(ticketId)!
        return { ...current, ended: { at: new Date().toISOString(), by: 'executor', outcome: report.state === 'failed' ? 'stopped' : 'completed' } }
      },
    },
    store, effects, health: new HealthBoard().claim('worker'), machine: { stateDir: dir }, lifetime: new AbortController().signal,
    sessions: { ensure, prompt, stop, relay: () => {}, get: () => undefined, holds: async () => false }, closing: () => false, paused: () => false,
    environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
  }
  const executor = new OMPExecutor(host)
  executor.start(first, first.assignments[0]!)
  effects.start()
  await effects.idle('launch')
  expect(ensure).toHaveBeenCalledOnce()
  executor.start(second, second.assignments[0]!)
  await effects.idle('launch')
  expect(ensure).toHaveBeenCalledTimes(2)
  expect(prompt).toHaveBeenCalledOnce()
  expect(executor.activeCount()).toBe(0)

  const ended = { ...second, ended: { at: new Date().toISOString(), by: 'human' as const, outcome: 'stopped' as const } }
  store.tickets.save(ended)
  executor.stop(ended, ended.assignments[0]!, 'stopped')
  expect(stop).toHaveBeenCalledWith('worker-second', 'stopped')
  executor.dispose()
})

interface FakeJob { id: string; type: 'bash' | 'task'; ownerId: string; label: string; startTime: number; progressText?: string }
/** A launched worker on a fake OMP Session whose events and background jobs the test drives. */
async function backgroundWorker() {
  const work = ticket('work')
  store.tickets.save(work)
  const listeners: ((event: object) => void)[] = []
  let running: FakeJob[] = []
  let failWake = false
  const prompts: { sessionId: string; requestId: string; text: string; mode: unknown }[] = []
  const relays: { id: string; text: string }[] = []
  const jobs = {
    getRunningJobs: vi.fn((filter?: { ownerId?: string }) => running.filter(job => !filter?.ownerId || job.ownerId === filter.ownerId)),
    acknowledgeDeliveries: vi.fn((ids: string[]) => ids.length),
    cancel: vi.fn((id: string) => { const had = running.some(job => job.id === id); running = running.filter(job => job.id !== id); return had }),
  }
  const session = { subscribe: (listener: (event: object) => void) => { listeners.push(listener); return () => {} }, asyncJobManager: jobs,
    isDisposed: false, messages: [], getLastAssistantText: () => 'Last words.' }
  const reports: WorkerReport[] = []
  const effects = new Effects(store, new HealthBoard())
  const host: ExecutorHost = {
    engine: {
      assignmentStarted: (ticketId, assignmentId) => {
        const current = store.tickets.get(ticketId)!
        store.tickets.save({ ...current, assignments: current.assignments.map(assignment => assignment.id === assignmentId
          ? { ...assignment, state: 'running', startedAt: new Date().toISOString() } : assignment) })
      },
      turnEnded: () => {}, deliveryFailed: () => {}, assignmentInterrupted: () => {},
      report: (ticketId, report) => { reports.push(report); return store.tickets.get(ticketId)! },
    },
    store, effects, health: new HealthBoard().claim('worker'), machine: { stateDir: dir }, lifetime: new AbortController().signal,
    sessions: { ensure: async () => session as never, get: () => session as never, stop: vi.fn(async () => {}),
      relay: (id, text) => { relays.push({ id, text }) }, holds: async () => false,
      prompt: async (sessionId, requestId, text, mode, authorize, accepted) => {
        authorize?.()
        if (failWake && requestId !== `assignment:${work.id}`) throw new Error('wake failed')
        prompts.push({ sessionId, requestId, text, mode })
        accepted?.()
      } },
    closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
  }
  const executor = new OMPExecutor(host)
  executor.start(work, work.assignments[0]!)
  effects.start()
  await effects.idle('launch')
  prompts.length = 0
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const turn = (next: FakeJob[]) => {
    for (const listener of listeners) listener({ type: 'agent_start' })
    running = next
    for (const listener of listeners) listener({ type: 'agent_end', isTerminal: false, awaitingAsyncWork: true })
  }
  const terminalTurn = () => {
    for (const listener of listeners) listener({ type: 'agent_start' })
    running = []
    for (const listener of listeners) listener({ type: 'agent_end', isTerminal: true })
  }
  return { executor, jobs, reports, prompts, relays, turn, terminalTurn, setFailWake: (value: boolean) => { failWake = value } }
}

it('keeps the slot across multi-hour background runs without blind kills, and cancels+wakes only when Watchdog intervenes', async () => {
  const { executor, jobs, reports, prompts, turn, setFailWake } = await backgroundWorker()
  turn([{ id: 'bg_1', type: 'bash', ownerId: 'Main', label: 'python backtest.py\n--full', startTime: Date.now() - 7200_000, progressText: '91/135' },
    { id: 'Helper', type: 'task', ownerId: 'Main', label: 'Helper', startTime: Date.now() - 3600_000 },
    { id: 'bg_9', type: 'bash', ownerId: 'Helper', label: 'subagent build', startTime: Date.now() - 600_000 }])
  // Multi-hour backtest keeps its slot and is never killed by a blind Executor timer.
  vi.advanceTimersByTime(6 * 60 * 60_000)
  expect(jobs.cancel).not.toHaveBeenCalled()
  expect(executor.activeCount()).toBe(1)
  expect(reports).toEqual([])
  expect(executor.runningJobs('work')).toMatchObject([
    { id: 'bg_1', type: 'bash', label: 'python backtest.py', progress: '91/135' },
    { id: 'Helper', type: 'task', label: 'Helper' },
  ])

  // When Watchdog cancels a hung job, Executor acknowledges+cancels only that job and wakes the worker.
  expect(await executor.cancelJob('work', 'bg_1', 'No log output for 45 minutes')).toBe(true)
  expect(jobs.acknowledgeDeliveries).toHaveBeenCalledWith(['bg_1'])
  expect(jobs.cancel).toHaveBeenCalledExactlyOnceWith('bg_1')
  expect(reports).toEqual([])
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatchObject({ sessionId: 'worker-work', mode: 'steer' })
  expect(prompts[0]!.text).toContain('bg_1 (python backtest.py): No log output for 45 minutes')
  expect(prompts[0]!.text).toContain('Remaining background jobs: Helper.')
  expect(executor.activeCount()).toBe(1)

  // Fallback: if waking the worker fails with no remaining jobs, free the slot and record waiting with the Watchdog note.
  setFailWake(true)
  turn([{ id: 'bg_2', type: 'bash', ownerId: 'Main', label: 'npm run build', startTime: Date.now() }])
  await expect(executor.cancelJob('work', 'bg_2', 'Stuck build')).rejects.toThrow('wake failed')
  expect(jobs.cancel).toHaveBeenLastCalledWith('bg_2')
  expect(executor.activeCount()).toBe(0)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ state: 'waiting' })
  expect(reports[0]!.summary).toContain('bg_2 (npm run build): Stuck build')
  executor.dispose()
})

it('frees the slot at a handoff, ignores stale prior-assignment reports, and lifts blocked handoff after a human follow-up', async () => {
  const { executor, jobs, reports, relays, prompts, turn, terminalTurn } = await backgroundWorker()
  const reportedAt = '2026-01-01T01:00:00.000Z'
  const started = store.tickets.get('work')!
  store.tickets.save({ ...started, assignments: started.assignments.map(assignment => ({ ...assignment, report: { state: 'ready', summary: 'Ready.', at: reportedAt } })) })
  turn([{ id: 'bg_1', type: 'bash', ownerId: 'Main', label: 'npm run dev', startTime: Date.now() },
    { id: 'Helper', type: 'task', ownerId: 'Main', label: 'Helper', startTime: Date.now() }])
  expect(jobs.acknowledgeDeliveries).toHaveBeenCalledWith(['bg_1', 'Helper'])
  expect(jobs.cancel).toHaveBeenCalledExactlyOnceWith('Helper')
  expect(executor.activeCount()).toBe(0)
  expect(executor.runningJobs('work')).toEqual([])
  expect(reports).toEqual([])

  // A server left to the person cannot be cancelled by Watchdog; a later turn's new job can.
  const handedOff = store.tickets.get('work')!
  store.tickets.save({ ...handedOff, assignments: handedOff.assignments.map(assignment => ({ ...assignment, deliveredAt: '2026-01-01T01:00:01.000Z' })) })
  turn([{ id: 'bg_1', type: 'bash', ownerId: 'Main', label: 'npm run dev', startTime: Date.now() },
    { id: 'bg_2', type: 'bash', ownerId: 'Main', label: 'npm test', startTime: Date.now() }])
  expect(executor.activeCount()).toBe(1)
  expect(await executor.cancelJob('work', 'bg_1', 'Left server')).toBe(false)
  expect(await executor.cancelJob('work', 'bg_2', 'Hung test')).toBe(true)
  expect(jobs.cancel).toHaveBeenLastCalledWith('bg_2')
  expect(jobs.cancel).not.toHaveBeenCalledWith('bg_1')
  expect(prompts).toHaveLength(1)

  // A blocked report hands off only until a human message arrives after it.
  const blocked = store.tickets.get('work')!
  store.tickets.save({ ...blocked, inputs: [{ id: 'in-1', kind: 'trigger', triggerId: 'tr-1', human: true, at: '2026-01-01T02:00:01.000Z' }],
    assignments: blocked.assignments.map(assignment => ({ ...assignment, report: { state: 'blocked', summary: 'Need token', at: '2026-01-01T02:00:00.000Z' } })) })
  turn([{ id: 'Helper2', type: 'task', ownerId: 'Main', label: 'Helper2', startTime: Date.now() }])
  expect(jobs.cancel).not.toHaveBeenCalledWith('Helper2')
  expect(executor.activeCount()).toBe(1)
  // A resumed second Assignment with no report of its own must not inherit Assignment 1's ready report.
  const multi = store.tickets.get('work')!
  store.tickets.save({ ...multi, assignments: [
    { id: 'assignment-old', state: 'ended', createdAt: '2026-01-01T00:00:00Z', report: { state: 'ready', summary: 'Old ready', at: '2026-01-01T00:10:00Z' } },
    { id: 'assignment-work', state: 'running', createdAt: '2026-01-01T03:00:00Z', startedAt: '2026-01-01T03:00:01Z' },
  ] })
  terminalTurn()
  await Promise.resolve()
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ state: 'waiting', summary: 'Last words.' })
  expect(relays.at(-1)?.text).toContain('orchestrator_ticket_request_status')
  executor.dispose()
})

it('observes a worker Session reopened by input delivery and defers disposal until its turn ends', async () => {
  const current = { ...ticket('reopened', 'running'),
    inputs: [{ id: 'in-1', kind: 'text' as const, text: 'Continue', at: '2026-01-01T00:01:00Z' }],
    undelivered: ['in-1'] }
  store.tickets.save(current)
  const listeners: ((event: object) => void)[] = []
  let loaded: object | undefined
  const session = { subscribe: (listener: (event: object) => void) => { listeners.push(listener); return () => {} },
    isDisposed: false, messages: [], getLastAssistantText: () => 'Completed.' }
  const stop = vi.fn(async () => { loaded = undefined })
  const effects = new Effects(store, new HealthBoard())
  const host: ExecutorHost = {
    engine: { assignmentStarted: () => {}, turnEnded: () => {}, deliveryFailed: () => {}, assignmentInterrupted: () => {}, report: (_, __) => store.tickets.get('reopened')! },
    store, effects, health: new HealthBoard().claim('worker'), machine: { stateDir: dir }, lifetime: new AbortController().signal,
    sessions: {
      ensure: async () => { loaded = session; return session as never },
      get: () => loaded as never,
      stop, relay: () => {}, holds: async () => false,
      prompt: async (_sessionId, _requestId, _text, _mode, authorize) => {
        authorize?.()
        const stored = store.tickets.get('reopened')!
        store.tickets.save({ ...stored, undelivered: [] })
        for (const listener of listeners) listener({ type: 'agent_start' })
      },
    },
    closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
  }
  const executor = new OMPExecutor(host)
  executor.deliver(current, current.assignments[0]!)
  effects.start()
  await effects.idle('delivery')
  expect(executor.activeCount()).toBe(1)

  const readyTicket: Ticket = { ...store.tickets.get('reopened')!, ended: { at: '2026-01-01T00:02:00Z', by: 'executor', outcome: 'completed' },
    assignments: [{ ...current.assignments[0]!, state: 'ended', endedAt: '2026-01-01T00:02:00Z', report: { state: 'ready', summary: 'Done', at: '2026-01-01T00:02:00Z' } }] }
  store.tickets.save(readyTicket)
  executor.stop(readyTicket, readyTicket.assignments[0]!, 'completed')
  // Still running its own turn: disposal waits for terminal agent_end instead of aborting mid-turn.
  expect(stop).not.toHaveBeenCalled()
  for (const listener of listeners) listener({ type: 'agent_end', isTerminal: true })
  expect(stop).toHaveBeenCalledWith('worker-reopened', 'Ticket ended')
  executor.dispose()
})

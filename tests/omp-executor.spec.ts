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

interface FakeJob { id: string; type: 'bash' | 'task'; ownerId: string; label: string }
const LIMIT_MS = 30 * 60_000
/** A launched worker on a fake OMP Session whose events and background jobs the test drives. */
async function backgroundWorker() {
  const work = ticket('work')
  store.tickets.save(work)
  const listeners: ((event: object) => void)[] = []
  let running: FakeJob[] = []
  const jobs = {
    getRunningJobs: vi.fn((filter?: { ownerId?: string }) => running.filter(job => !filter?.ownerId || job.ownerId === filter.ownerId)),
    acknowledgeDeliveries: vi.fn((ids: string[]) => ids.length),
    cancel: vi.fn((id: string) => { running = running.filter(job => job.id !== id); return true }),
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
    sessions: { ensure: async () => session as never, get: () => session as never, stop: vi.fn(async () => {}), relay: () => {}, holds: async () => false,
      prompt: async (_sessionId, _requestId, _text, _mode, authorize, accepted) => { authorize?.(); accepted?.() } },
    closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined,
  }
  const executor = new OMPExecutor(host)
  executor.start(work, work.assignments[0]!)
  effects.start()
  await effects.idle('launch')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const turn = (next: FakeJob[]) => {
    for (const listener of listeners) listener({ type: 'agent_start' })
    running = next
    for (const listener of listeners) listener({ type: 'agent_end', isTerminal: false, awaitingAsyncWork: true })
  }
  return { executor, jobs, reports, turn }
}

it('keeps the slot while background work runs, then stops shell jobs at the limit and reports waiting', async () => {
  const { executor, jobs, reports, turn } = await backgroundWorker()
  turn([{ id: 'bg_1', type: 'bash', ownerId: 'Main', label: 'npm test\n--watch' }, { id: 'Helper', type: 'task', ownerId: 'Main', label: 'Helper' },
    { id: 'bg_9', type: 'bash', ownerId: 'Helper', label: 'subagent build' }])
  vi.advanceTimersByTime(LIMIT_MS - 1)
  expect(executor.activeCount()).toBe(1)
  expect(reports).toEqual([])
  vi.advanceTimersByTime(1)
  expect(jobs.acknowledgeDeliveries).toHaveBeenCalledWith(['bg_1'])
  expect(jobs.cancel).toHaveBeenCalledExactlyOnceWith('bg_1')
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ state: 'waiting' })
  expect(reports[0]!.summary).toContain('Last words.')
  expect(reports[0]!.summary).toContain('Stopped shell jobs: bg_1 (npm test)')
  expect(reports[0]!.summary).toContain('Subagents still running: Helper')
  expect(executor.activeCount()).toBe(1)

  turn([{ id: 'bg_2', type: 'bash', ownerId: 'Main', label: 'npm run build' }])
  vi.advanceTimersByTime(LIMIT_MS)
  expect(jobs.cancel).toHaveBeenLastCalledWith('bg_2')
  expect(executor.activeCount()).toBe(0)
  executor.dispose()
})

it('frees the slot at a handoff, cancels subagents, and leaves shell jobs running unwoken and unlimited', async () => {
  const { executor, jobs, reports, turn } = await backgroundWorker()
  const reportedAt = new Date().toISOString()
  const started = store.tickets.get('work')!
  store.tickets.save({ ...started, assignments: started.assignments.map(assignment => ({ ...assignment, report: { state: 'ready', summary: 'Ready.', at: reportedAt } })) })
  turn([{ id: 'bg_1', type: 'bash', ownerId: 'Main', label: 'npm run dev' }, { id: 'Helper', type: 'task', ownerId: 'Main', label: 'Helper' }])
  expect(jobs.acknowledgeDeliveries).toHaveBeenCalledWith(['bg_1', 'Helper'])
  expect(jobs.cancel).toHaveBeenCalledExactlyOnceWith('Helper')
  expect(executor.activeCount()).toBe(0)
  expect(reports).toEqual([])

  // A person's later message starts a turn whose own job is bounded; the server left to the person is not.
  const handedOff = store.tickets.get('work')!
  store.tickets.save({ ...handedOff, assignments: handedOff.assignments.map(assignment => ({ ...assignment, deliveredAt: new Date(Date.parse(reportedAt) + 1000).toISOString() })) })
  turn([{ id: 'bg_1', type: 'bash', ownerId: 'Main', label: 'npm run dev' }, { id: 'bg_2', type: 'bash', ownerId: 'Main', label: 'npm test' }])
  expect(executor.activeCount()).toBe(1)
  vi.advanceTimersByTime(LIMIT_MS)
  expect(jobs.cancel).toHaveBeenLastCalledWith('bg_2')
  expect(jobs.cancel).not.toHaveBeenCalledWith('bg_1')
  expect(executor.activeCount()).toBe(0)
  executor.dispose()
})

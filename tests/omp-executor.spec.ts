import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Later, Effects } from '../src/app/effects.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { OMPExecutor, WorkerSlots, type ExecutorHost } from '../src/executor/omp.ts'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/index.ts'

let dir: string
let store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omp-executor-')); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
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

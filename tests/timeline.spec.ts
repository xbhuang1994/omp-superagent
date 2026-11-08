import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { isoTime, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'

let directory: string
let store: Store
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'omp-timeline-')); store = new Store(join(directory, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const comment = (id: string, at: string): Trigger => ({ id, source: 'github', threads: [{ source: 'github', id: '7' }],
  actor: { source: 'github', id: 'alice' }, human: true, at, text: `comment ${id}`, meta: {} })
const ids = (items: Trigger[]) => items.map(item => item.id)

it('pages by timestamp then ID without skipping same-second triggers', () => {
  for (const item of [comment('a', '2026-10-01T00:00:00Z'), comment('b', '2026-10-01T00:00:01Z'), comment('c', '2026-10-01T00:00:01Z')]) store.triggers.save(item)
  const first = store.read.threadTriggers('github:7', 1)
  const second = store.read.threadTriggers('github:7', 1, { at: first[0]!.at, id: first[0]!.id })
  const third = store.read.threadTriggers('github:7', 1, { at: second[0]!.at, id: second[0]!.id })
  expect([ids(first), ids(second), ids(third)]).toEqual([['c'], ['b'], ['a']])
})
it('normalizes GitHub whole-second timestamps for deterministic neighbour lookup', () => {
  for (const item of [comment('old', '2026-10-01T00:00:00Z'), comment('new', '2026-10-01T00:00:00.500Z'), comment('newest', '2026-10-01T00:00:01Z')]) store.triggers.save({ ...item, at: isoTime(item.at) })
  expect(ids(store.read.threadTriggers('github:7', 50))).toEqual(['old', 'new', 'newest'])
  expect(store.read.neighbours('github:7', '2026-10-01T00:00:00.500Z', 'new')).toMatchObject({ before: { id: 'old' }, after: { id: 'newest' } })
})

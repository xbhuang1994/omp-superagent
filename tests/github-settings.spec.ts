import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { Config, machineOf } from '../src/deployment.ts'
import { KV } from '../src/kv.ts'
import { startOmpOpenAIServer, writeFixtureModels, type OmpFixture } from './fixtures/omp-openai-server.ts'
vi.setConfig({ testTimeout: 60_000 })

let dir: string
let provider: OmpFixture
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'omp-github-settings-'))
  provider = await startOmpOpenAIServer()
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
})
afterEach(async () => {
  await provider.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A gh wrapper signed in as agent-bot with push access to one repository, which logs its calls to `<name>.log`. An ambient
 * token makes it act as the operator, as gh does; its Issue stream answers a conditional request with HTTP 304.
 */
function fakeGh(name: string, repository = 'acme/widgets', id = 11): string {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh
printf '%s\\n' "$*" >> '${file}.log'
case "$*" in
  "api user") if [ -n "$GH_TOKEN" ]; then echo '{"login":"operator","id":9}'; else echo '{"login":"agent-bot","id":7}'; fi ;;
  "api repos/${repository} --jq"*) echo '{"id":${id},"name":"${repository}","push":true}' ;;
  "api repos/${repository}/notifications"*) printf 'HTTP/2.0 200 OK\\nX-Poll-Interval: 60\\n\\n[]\\n' ;;
  "api repos/${repository}/issues?state=all"*"If-None-Match"*) echo 'gh: HTTP 304' >&2; exit 1 ;;
  "api repos/${repository}/issues?state=all"*) printf 'HTTP/2.0 200 OK\\nEtag: W/"page"\\n\\n[]\\n' ;;
  *"--slurp"*) echo '[[]]' ;;
  *) echo '[]' ;;
esac
`, { mode: 0o755 })
  return file
}
const config = (overrides: Record<string, unknown> = {}) => Config.parse({ stateDir: join(dir, 'state'), agentDir: join(dir, 'omp'),
  web: { enabled: true, host: '127.0.0.1', port: 0 }, sources: { chat: { enabled: true, config: {} } },
  eval: { model: { provider: 'fixture', model: 'fixture' } }, executor: { model: { provider: 'fixture', model: 'fixture' } }, ...overrides })
const put = (runtime: Runtime, body: unknown) => fetch(`${runtime.web.url}api/settings/github`, { method: 'PUT',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const view = async (runtime: Runtime): Promise<unknown> => (await fetch(`${runtime.web.url}api/settings/github`)).json()
const patiently = { timeout: 20_000, interval: 100 }

it('fails startup, rather than hanging, when the panel port is taken while GitHub is connected', async () => {
  const taken = createServer()
  await new Promise<void>(resolve => { taken.listen(0, '127.0.0.1', resolve) })
  const { port } = taken.address() as AddressInfo
  const settings = config({ web: { enabled: true, host: '127.0.0.1', port },
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: fakeGh('gh') } } } })
  const runtime = new Runtime(machineOf(settings), settings)
  try { await expect(runtime.ready).rejects.toThrow(/EADDRINUSE|in use/) }
  finally {
    await runtime.stop()
    await new Promise(resolve => { taken.close(resolve) })
  }
}, 25_000)

it('connects from the panel as the wrapper account, changes nothing when verification fails, and holds across restarts', async () => {
  const settings = config()
  const cli = fakeGh('gh')
  let runtime = new Runtime(machineOf(settings), settings)
  process.env.GH_TOKEN = 'operator-token'
  try {
    await runtime.ready
    expect(await view(runtime)).toMatchObject({ enabled: false, connection: null })
    const connected = await put(runtime, { enabled: true, config: { repository: 'acme/widgets', cli } })
    expect(connected.status).toBe(200)
    expect(await connected.json()).toMatchObject({ enabled: true, connection: { repository: 'acme/widgets', account: 'agent-bot' } })

    const refused = await put(runtime, { enabled: true, config: { repository: 'acme/widgets', cli: join(dir, 'absent') } })
    expect(refused.status).toBe(400)
    expect(await view(runtime)).toMatchObject({ enabled: true, config: { cli }, connection: { repository: 'acme/widgets' } })

    await runtime.stop()
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    expect(await view(runtime)).toMatchObject({ enabled: true, connection: { repository: 'acme/widgets', account: 'agent-bot' } })
    expect((await put(runtime, { enabled: false, config: { repository: 'acme/widgets', cli } })).status).toBe(200)

    await runtime.stop()
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    expect(await view(runtime)).toMatchObject({ enabled: false, config: { repository: 'acme/widgets' }, connection: null })
  } finally {
    await runtime.stop()
    delete process.env.GH_TOKEN
  }
})

it('keeps a state directory to the repository its GitHub conversations belong to', async () => {
  const settings = config()
  const runtime = new Runtime(machineOf(settings), settings)
  try {
    await runtime.ready
    const widgets = { repository: 'acme/widgets', cli: fakeGh('gh-widgets') }
    const gadgets = { repository: 'acme/gadgets', cli: fakeGh('gh-gadgets', 'acme/gadgets', 12) }
    expect((await put(runtime, { enabled: true, config: widgets })).status).toBe(200)
    runtime.store.set(KV.github.cursor(1), '2026-01-01T00:00:00.000Z')
    // With no conversation stored, the other repository takes over without the first one's read cursors.
    expect((await put(runtime, { enabled: true, config: gadgets })).status).toBe(200)
    expect(runtime.store.get(KV.github.cursor(1))).toBeUndefined()

    runtime.store.threads.save({ key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: new Date().toISOString(),
      subscriptions: [], correlated: [], pending: [], meta: {} })
    const refused = await put(runtime, { enabled: true, config: widgets })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('acme/gadgets') })
    expect(await view(runtime)).toMatchObject({ connection: { repository: 'acme/gadgets' } })
  } finally { await runtime.stop() }
})

it('reads a repository stream in full after an observed kind is switched on, so its start is saved', async () => {
  const cli = fakeGh('gh')
  const github = (observed: Record<string, boolean>) => ({ enabled: true, config: { repository: 'acme/widgets', cli, ...observed } })
  const settings = config({ sources: { chat: { enabled: true, config: {} }, github: github({ observeIssues: true }) } })
  const runtime = new Runtime(machineOf(settings), settings)
  const stream = () => runtime.store.get(KV.github.stream('issues'))
  const lastRead = () => readFileSync(`${cli}.log`, 'utf8').split('\n').findLast(line => line.includes('issues?state=all'))
  try {
    await runtime.ready
    await vi.waitFor(() => { expect(stream()?.etag).toBe('W/"page"') }, patiently)
    // Every save restarts the polling loop: with nothing changed, the stream costs a conditional request.
    expect((await put(runtime, github({ observeIssues: true }))).status).toBe(200)
    await vi.waitFor(() => { expect(lastRead()).toContain('If-None-Match') }, patiently)
    expect((await put(runtime, github({ observeIssues: true, observePulls: true }))).status).toBe(200)
    await vi.waitFor(() => { expect(Object.keys(stream()?.started ?? {})).toEqual(['issues', 'pulls']) }, patiently)
    expect(lastRead()).not.toContain('If-None-Match')
  } finally { await runtime.stop() }
})

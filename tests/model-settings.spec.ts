import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import { Config, machineOf } from '../src/deployment.ts'
import type { RoleModel } from '../src/policy.ts'
import { startOmpOpenAIServer, writeFixtureModels } from './fixtures/omp-openai-server.ts'
vi.setConfig({ testTimeout: 30_000 })

it('applies valid models, preserves panel choices on restart, and honors explicit config changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-model-settings-'))
  const provider = await startOmpOpenAIServer()
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl, ['fixture', 'fixture-two', 'fixture-three'])
  const settings = Config.parse({ stateDir: dir, agentDir: join(dir, 'omp'), web: { enabled: true, host: '127.0.0.1', port: 0 },
    sources: { chat: { enabled: true, config: {} } }, eval: { model: { provider: 'fixture', model: 'fixture' } },
    executor: { model: { provider: 'fixture', model: 'fixture' } } })
  let runtime = new Runtime(machineOf(settings), settings)
  const selected: RoleModel = { provider: 'fixture', model: 'fixture-two', thinkingLevel: 'low' }
  try {
    await runtime.ready
    const available = await (await fetch(`${runtime.web.url}api/settings/models`)).json() as { available: { id: string }[] }
    expect(available.available.map(model => model.id)).toEqual(expect.arrayContaining(['fixture', 'fixture-two']))
    const response = await fetch(`${runtime.web.url}api/settings/models`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eval: selected, executor: selected }) })
    expect(response.status).toBe(200)
    expect(runtime.sessions.get(runtime.masterId)?.model?.id).toBe('fixture-two')
    expect(runtime.store.settings().eval.model).toEqual(selected)
    expect(runtime.store.settings().executor.model).toEqual(selected)

    await runtime.stop()
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    expect(runtime.store.settings().eval.model).toEqual(selected)
    expect(runtime.sessions.get(runtime.masterId)?.model?.id).toBe('fixture-two')

    const invalid = await fetch(`${runtime.web.url}api/settings/models`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eval: { provider: 'fixture', model: 'missing' }, executor: selected }) })
    expect(invalid.status).toBe(400)
    expect(runtime.store.settings().eval.model).toEqual(selected)

    await runtime.stop()
    settings.eval.model = { provider: 'fixture', model: 'fixture-three' }
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    expect(runtime.store.settings().eval.model).toEqual(settings.eval.model)
    expect(runtime.store.settings().executor.model).toEqual(selected)
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

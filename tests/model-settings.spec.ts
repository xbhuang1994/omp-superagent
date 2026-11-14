import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ClaudeSession } from '../src/kernel/claude.ts'
import { isClaudeJournal } from '../src/kernel/journal.ts'
import { KV } from '../src/kv.ts'
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
  const advisor: RoleModel = { provider: 'fixture', model: 'fixture-three', thinkingLevel: 'high' }
  try {
    await runtime.ready
    const available = await (await fetch(`${runtime.web.url}api/settings/models`)).json() as { available: { id: string }[] }
    expect(available.available.map(model => model.id)).toEqual(expect.arrayContaining(['fixture', 'fixture-two']))
    const response = await fetch(`${runtime.web.url}api/settings/models`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eval: selected, executor: selected, advisor }) })
    expect(response.status).toBe(200)
    expect(runtime.sessions.get(runtime.masterId)?.model?.id).toBe('fixture-two')
    expect(runtime.store.settings().eval.model).toEqual(selected)
    expect(runtime.store.settings().executor.model).toEqual(selected)
    expect(runtime.store.settings().executor.advisor).toEqual(advisor)

    await runtime.stop()
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    expect(runtime.store.settings().eval.model).toEqual(selected)
    expect(runtime.store.settings().executor.advisor).toEqual(advisor)
    expect(runtime.sessions.get(runtime.masterId)?.model?.id).toBe('fixture-two')

    const invalid = await fetch(`${runtime.web.url}api/settings/models`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eval: selected, executor: selected, advisor: { provider: 'fixture', model: 'missing' } }) })
    expect(invalid.status).toBe(400)
    expect(runtime.store.settings().executor.advisor).toEqual(advisor)

    await runtime.stop()
    settings.eval.model = { provider: 'fixture', model: 'fixture-three' }
    settings.executor.advisor = null
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    expect(runtime.store.settings().eval.model).toEqual(settings.eval.model)
    expect(runtime.store.settings().executor.model).toEqual(selected)
    expect(runtime.store.settings().executor.advisor).toEqual(advisor)
  } finally {
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('switches the execution kernel from the panel, keeps the choice and the chat across restarts, and lets a startup JSON edit win', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-kernel-settings-'))
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9')
  const provider = await startOmpOpenAIServer()
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl, ['fixture'])
  const settings = Config.parse({ stateDir: dir, agentDir: join(dir, 'omp'), web: { enabled: true, host: '127.0.0.1', port: 0 },
    sources: { chat: { enabled: true, config: {} } }, eval: { model: { provider: 'fixture', model: 'fixture' } } })
  let runtime = new Runtime(machineOf(settings), settings)
  const put = (kernel: unknown) => fetch(`${runtime.web.url}api/settings/kernel`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kernel }) })
  const view = async () => await (await fetch(`${runtime.web.url}api/settings/models`)).json() as { kernel: string; available: { id: string }[] }
  const chat = async () => (await (await fetch(`${runtime.web.url}api/messages`)).json() as { messages: { role: string; text: string }[] }).messages.map(message => message.text)
  try {
    await runtime.ready
    expect((await view()).kernel).toBe('omp')
    await runtime.sessions.publish(runtime.masterId, 'reply-1', 'kept across kernels')
    expect(await chat()).toEqual(['kept across kernels'])

    expect((await put('nope')).status).toBe(400)
    const switched = await put('claude')
    expect(switched.status).toBe(200)
    const body = await switched.json() as { kernel: string; available: { id: string }[] }
    expect(body.kernel).toBe('claude')
    // Nothing is built in: an unreachable backend lists no model, and a kernel's own choice stays selectable.
    expect(body.available).toEqual([])
    const main = runtime.sessions.get(runtime.masterId)
    expect(main).toBeInstanceOf(ClaudeSession)
    expect(await isClaudeJournal(main!.sessionFile!)).toBe(true)
    expect(await chat()).toEqual(['kept across kernels'])
    await runtime.sessions.publish(runtime.masterId, 'reply-2', 'said on claude')

    await runtime.stop()
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    expect((await view()).kernel).toBe('claude')
    expect(runtime.sessions.get(runtime.masterId)).toBeInstanceOf(ClaudeSession)

    expect((await put('omp')).status).toBe(200)
    expect(runtime.sessions.get(runtime.masterId)).not.toBeInstanceOf(ClaudeSession)
    expect(runtime.sessions.get(runtime.masterId)?.model?.id).toBe('fixture')
    expect(await chat()).toEqual(['kept across kernels', 'said on claude'])
    expect(runtime.store.get(KV.runtime.kernel)).toBe('omp')

    // Each kernel has its own model choices, following the kernel default until set.
    const models = async (body?: object) => await (await fetch(`${runtime.web.url}api/settings/models`, body ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}))
      .json() as { current: Record<string, unknown>; supports: { advisor: boolean; thinkingLevels: string[] }; error?: string }
    const fixture = { provider: 'fixture', model: 'fixture' }
    await models({ eval: fixture, executor: fixture, advisor: fixture })
    expect((await models()).supports).toEqual({ advisor: true, thinkingLevels: expect.arrayContaining(['minimal']) })
    const onClaude = await (await put('claude')).json() as { current: unknown; supports: { advisor: boolean; thinkingLevels: string[] } }
    expect(onClaude.current).toEqual({ eval: null, executor: null, advisor: null })
    expect(onClaude.supports.advisor).toBe(false)
    expect(onClaude.supports.thinkingLevels).not.toContain('minimal')
    const sonnet = { provider: 'anthropic', model: 'sonnet', thinkingLevel: 'high' }
    expect((await models({ eval: sonnet, executor: { ...sonnet, thinkingLevel: 'minimal' }, advisor: null })).error).toContain('not supported')
    // Claude Code has no advisor: one sent anyway is not kept.
    expect((await models({ eval: sonnet, executor: sonnet, advisor: sonnet })).current).toEqual({ eval: sonnet, executor: sonnet, advisor: null })
    expect((await view()).available.map(model => model.id)).toEqual(['sonnet'])
    expect((await (await put('omp')).json() as { current: unknown }).current).toEqual({ eval: fixture, executor: fixture, advisor: fixture })
    expect(runtime.store.settings().executor.advisor).toEqual(fixture)
    expect((await (await put('claude')).json() as { current: unknown }).current).toEqual({ eval: sonnet, executor: sonnet, advisor: null })

    // A model OMP does not know keeps the switch back from happening, and leaves the kernel and its choices as they were.
    runtime.store.set(KV.runtime.kernelModels('omp'), { eval: null, executor: { provider: 'fixture', model: 'missing' }, advisor: null })
    const refused = await put('omp')
    expect(refused.status).toBe(400)
    expect((await refused.json() as { error: string }).error).toContain('Unknown OMP model')
    expect((await view()).kernel).toBe('claude')
    expect((await models()).current).toEqual({ eval: sonnet, executor: sonnet, advisor: null })
    runtime.store.set(KV.runtime.kernelModels('omp'), { eval: fixture, executor: null, advisor: null })

    // The panel choice holds until the startup JSON names another kernel than it did.
    await runtime.stop()
    const edited = Config.parse({ ...settings, kernel: 'claude' })
    runtime = new Runtime(machineOf(edited), edited)
    await runtime.ready
    expect((await view()).kernel).toBe('claude')
    await runtime.stop()
    runtime = new Runtime(machineOf(settings), settings)
    await runtime.ready
    expect((await view()).kernel).toBe('omp')
    // The startup JSON moved the service to OMP: its own choices came back, and Claude Code's wait.
    expect(runtime.store.settings().executor.model).toBeNull()
    expect(runtime.store.settings().eval.model).toEqual({ provider: 'fixture', model: 'fixture' })
    expect(runtime.store.get(KV.runtime.kernelModels('claude'))).toMatchObject({ executor: { model: 'sonnet' } })
  } finally {
    vi.unstubAllEnvs()
    await runtime.stop()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

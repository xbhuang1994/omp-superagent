import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebPanel } from '../../src/app/web.ts'
import { OMPSessions } from '../../src/app/sessions.ts'
import { Store } from '../../src/app/store.ts'
import { Effects } from '../../src/app/effects.ts'
import { Prompts } from '../../src/app/prompts.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { startOmpOpenAIServer, writeFixtureModels } from './omp-openai-server.ts'
import { WeChatBridge } from '../../src/app/wechat.ts'

const dir = mkdtempSync(join(tmpdir(), 'omp-web-browser-'))
const provider = await startOmpOpenAIServer(() => ({ content: '浏览器回复：你好，OMP 已收到。' }))
await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
const store = new Store(join(dir, 'db.sqlite'))
store.saveSettings(SettingsSchema.parse({ eval: { model: { provider: 'fixture', model: 'fixture' } } }))
const sessions = new OMPSessions({ store, prompts: new Prompts(store, () => 100000, () => []),
  effects: new Effects(store, new HealthBoard()), machine: { stateDir: dir, agentDir: join(dir, 'omp') }, masterId: 'main',
  lifetime: new AbortController().signal, closing: () => false, environment: () => [],
  engine: { inputsDelivered: () => {}, inputsRead: () => {} }, tools: () => [] })
await sessions.ready
await sessions.ensure('main', dir, 'Main', 'orchestrator')
const wechat = new WeChatBridge({ store, sessions, masterId: 'main' })
await wechat.start()
const panel = new WebPanel({ enabled: true, host: '127.0.0.1', port: 3082 }, 'main', sessions, wechat)
await panel.start()
console.log(panel.url)
process.once('SIGINT', async () => {
  await panel.stop()
  await wechat.stop()
  await sessions.stopAll()
  await provider.close()
  store.close()
  process.exit(0)
})

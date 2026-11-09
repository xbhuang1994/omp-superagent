import { createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Prompts } from '../src/app/prompts.ts'
import { OMPSessions } from '../src/app/sessions.ts'
import { Store } from '../src/app/store.ts'
import { WebPanel } from '../src/app/web.ts'
import { WeChatBridge } from '../src/app/wechat.ts'
import { WeChatProtocol } from '../src/app/wechat-protocol.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { startOmpOpenAIServer, writeFixtureModels } from './fixtures/omp-openai-server.ts'
import { ChatSource } from '../src/sources/chat.ts'
import { WorkerView } from '../src/app/workers.ts'
import { ModelSettings } from '../src/app/model-settings.ts'
import type { Trigger } from '../src/core/index.ts'

vi.setConfig({ testTimeout: 30_000 })
const encrypted = (data: Buffer, key: Buffer): Buffer => {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}
const decrypted = (data: Buffer, key: Buffer): Buffer => {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}
async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function startWeChatFixture() {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const file = Buffer.from('wechat file payload')
  const imageKey = Buffer.alloc(16, 7), fileKey = Buffer.alloc(16, 9)
  const sent: Record<string, unknown>[] = [], uploads: { plain: Buffer; name: string }[] = [], updateCursors: string[] = []
  let base = '', confirmed = false, delivered = false, qrCount = 0, uploadKey = Buffer.alloc(16)
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', base)
      if (request.method === 'POST' && url.pathname === '/ilink/bot/get_bot_qrcode') {
        qrCount++
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ qrcode: 'qr-id', qrcode_img_content: 'weixin://fixture-bind' }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/ilink/bot/get_qrcode_status') {
        if (url.searchParams.get('verify_code') === '1234') confirmed = true
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(confirmed
          ? { status: 'confirmed', bot_token: 'secret-token', ilink_bot_id: 'fixture-bot', ilink_user_id: 'bound-user', baseurl: base }
          : { status: 'need_verifycode' }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/ilink/bot/getupdates') {
        const payload = JSON.parse((await body(request)).toString('utf8')) as { get_updates_buf?: string }
        updateCursors.push(payload.get_updates_buf ?? '')
        const text = { message_id: '9007199254740993', from_user_id: 'bound-user', message_type: 1, context_token: 'context-1', item_list: [{ type: 1, text_item: { text: '微信文本' } }] }
        const media = { message_id: 'media-1', from_user_id: 'bound-user', message_type: 1, context_token: 'context-1', item_list: [
          { type: 1, text_item: { text: '微信附件' } },
          { type: 2, image_item: { aeskey: imageKey.toString('hex'), media: { full_url: `${base}cdn/image` } } },
          { type: 4, file_item: { file_name: '../notes.txt', media: { full_url: `${base}cdn/file`, aes_key: Buffer.from(fileKey.toString('hex')).toString('base64') } } },
        ] }
        const stranger = { message_id: 'ignored', from_user_id: 'stranger', message_type: 1, item_list: [{ type: 1, text_item: { text: '不得投递' } }] }
        const messages = delivered ? [] : [text, text, stranger, media]
        delivered = true
        // Numeric uint64 exercises lossless message ID parsing.
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ret: 0, msgs: messages, get_updates_buf: 'cursor-1', longpolling_timeout_ms: 100 }).replace('"message_id":"9007199254740993"', '"message_id":9007199254740993'))
        return
      }
      if (request.method === 'POST' && url.pathname === '/ilink/bot/sendmessage') {
        const payload = JSON.parse((await body(request)).toString('utf8')) as { msg: Record<string, unknown> }
        sent.push(payload.msg)
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ret: 0, message_id: 9007199254740995 }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/ilink/bot/getuploadurl') {
        const payload = JSON.parse((await body(request)).toString('utf8')) as { aeskey: string }
        uploadKey = Buffer.from(payload.aeskey, 'hex')
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ upload_full_url: `${base}cdn/upload` }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/cdn/upload') {
        uploads.push({ plain: decrypted(await body(request), uploadKey), name: '' })
        response.writeHead(200, { 'x-encrypted-param': `download-${uploads.length}` }).end()
        return
      }
      if (url.pathname === '/cdn/image') { response.writeHead(200).end(encrypted(image, imageKey)); return }
      if (url.pathname === '/cdn/file') { response.writeHead(200).end(encrypted(file, fileKey)); return }
      response.writeHead(404).end()
    })().catch(error => { response.writeHead(500).end(String(error)) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return { server, base, sent, uploads, updateCursors, image, file, qrCount: () => qrCount }
}

it('binds through WebUI and exchanges text, images and files with the persistent orchestrator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-wechat-'))
  const provider = await startOmpOpenAIServer(() => ({ content: 'orchestrator 微信回复' }))
  const wechatServer = await startWeChatFixture()
  await writeFixtureModels(join(dir, 'omp'), provider.baseUrl)
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ eval: { model: { provider: 'fixture', model: 'fixture' } } }))
  const sessions = new OMPSessions({ store, prompts: new Prompts(store, () => 100000, () => []), effects: new Effects(store, new HealthBoard()),
    machine: { stateDir: dir, agentDir: join(dir, 'omp') }, masterId: 'main', lifetime: new AbortController().signal,
    closing: () => false, environment: () => [], engine: { inputsDelivered: () => {}, inputsRead: () => {} }, tools: () => [] })
  let bridge: WeChatBridge | undefined
  let panel: WebPanel | undefined
  try {
    await sessions.ready
    await sessions.ensure('main', dir, 'Main', 'orchestrator')
    const protocol = new WeChatProtocol({ apiBaseUrl: wechatServer.base, cdnBaseUrl: `${wechatServer.base}cdn` })
    const triggers: Trigger[] = []
    const chat = new ChatSource({ sessions, masterId: 'main', receive: async trigger => {
      if (triggers.some(item => item.id === trigger.id)) return 'duplicate' as const
      triggers.push(trigger)
      await sessions.prompt('main', `candidate:${trigger.id}`, JSON.stringify({ kind: 'candidate', trigger_id: trigger.id, text: trigger.text }), 'steer')
      return 'stored' as const
    }, deliverWeChat: (id, text, userId) => bridge!.deliver(id, text, userId) })
    bridge = new WeChatBridge({ store, chat }, protocol)
    await bridge.start()
    panel = new WebPanel({ enabled: true, host: '127.0.0.1', port: 0 }, 'main', sessions, bridge, () => sessions.resetOrchestrator(), chat, new WorkerView(store, sessions), new ModelSettings(store, sessions))
    await panel.start()

    const connecting = await fetch(`${panel.url}api/wechat/connect`, { method: 'POST' })
    const initial = await connecting.json() as { state: string; qrCode?: string }
    expect(connecting.status).toBe(200)
    expect(initial.state).toBe('waiting')
    expect(initial.qrCode).toMatch(/^data:image\/png;base64,/)
    expect(JSON.stringify(initial)).not.toContain('secret-token')
    await vi.waitFor(() => { expect(bridge!.status().state).toBe('verify') })
    const verified = await fetch(`${panel.url}api/wechat/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '1234' }) })
    expect(verified.status).toBe(200)
    await vi.waitFor(async () => {
      const status = await (await fetch(`${panel!.url}api/wechat`)).json() as { state: string }
      expect(status.state).toBe('connected')
    }, { timeout: 5000 })
    await vi.waitFor(() => { expect(provider.requests).toHaveLength(2) }, { timeout: 5000 })
    for (const [index, trigger] of triggers.entries()) await chat.send({ id: `reply-${index}`, channel: trigger.channel!, text: 'orchestrator 微信回复', kind: 'reply' })
    await vi.waitFor(() => {
      expect(wechatServer.sent.filter(message => JSON.stringify(message).includes('orchestrator 微信回复'))).toHaveLength(2)
      expect(store.get(KV.wechat.cursor)).toBe('cursor-1')
    }, { timeout: 5000 })
    expect(JSON.stringify(wechatServer.sent)).toContain('"client_id":"omp-superagent:reply-0"')
    const transcript = JSON.stringify(sessions.get('main')?.sessionManager.getBranch())
    expect(transcript).toContain('wechat:9007199254740993')
    expect(transcript).toContain('wechat:media-1')
    expect(transcript).toContain('wechat file payload')
    expect(transcript).toContain('.._notes.txt')
    expect(transcript).not.toContain('不得投递')
    expect(JSON.stringify(provider.requests)).toContain('image_url')
    const imagePath = join(dir, 'attachments', 'chat-wechat-media-1', '1-wechat-media-1.jpg')
    expect(await readFile(imagePath)).toEqual(wechatServer.image)
    expect(triggers.find(trigger => trigger.meta.messageId === 'wechat:media-1')?.text).toContain(`path="${imagePath}"`)
    expect(transcript).toContain(`"kind":"image"`)
    expect(sessions.get('main')?.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && JSON.stringify(entry.details).includes('"requestId":"chat:wechat:9007199254740993"'))).toHaveLength(1)
    const panelMessages = await (await fetch(`${panel.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
    expect(panelMessages.messages.find(message => message.text === '微信文本')?.role).toBe('user')

    const output = join(dir, 'out.bin')
    await writeFile(output, Buffer.from([0, 255, 1, 2, 3]))
    await bridge.sendFile(output, '文件说明')
    const picture = join(dir, 'pixel.png')
    await writeFile(picture, wechatServer.image)
    await bridge.sendFile(picture)
    expect(wechatServer.uploads.map(upload => [...upload.plain])).toEqual([[0, 255, 1, 2, 3], [...wechatServer.image]])
    expect(wechatServer.sent.some(message => JSON.stringify(message).includes('"type":4') && JSON.stringify(message).includes('out.bin'))).toBe(true)
    expect(wechatServer.sent.some(message => JSON.stringify(message).includes('"type":2') && JSON.stringify(message).includes('image_item'))).toBe(true)

    await bridge.stop()
    const polls = wechatServer.updateCursors.length
    bridge = new WeChatBridge({ store, chat }, protocol)
    await bridge.start()
    await vi.waitFor(() => { expect(wechatServer.updateCursors.length).toBeGreaterThan(polls) })
    expect(wechatServer.updateCursors.at(-1)).toBe('cursor-1')
    expect(wechatServer.qrCount()).toBe(1)
    expect(bridge.status().state).toBe('connected')

    const previousSession = sessions.get('main')
    const reset = await fetch(`${panel.url}api/session/reset`, { method: 'POST' })
    expect(reset.status).toBe(200)
    expect(sessions.get('main')).not.toBe(previousSession)
    expect((await (await fetch(`${panel.url}api/messages`)).json() as { messages: unknown[] }).messages).toEqual([])
    const requestsBeforeReset = provider.requests.length
    await fetch(`${panel.url}api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '重置后的消息' }) })
    await vi.waitFor(() => { expect(provider.requests.length).toBeGreaterThan(requestsBeforeReset) }, { timeout: 5000 })
    const latest = triggers.at(-1)!
    await chat.send({ id: 'reset-reply', channel: latest.channel!, text: '重置后的回复', kind: 'reply' })
    const afterReset = await (await fetch(`${panel.url}api/messages`)).json() as { messages: { role: string; text: string }[] }
    expect(afterReset.messages.some(message => message.role === 'assistant' && message.text === '重置后的回复')).toBe(true)
  } finally {
    await panel?.stop()
    await bridge?.stop()
    await sessions.stopAll()
    await provider.close()
    await new Promise<void>(resolve => { wechatServer.server.closeAllConnections(); wechatServer.server.close(() => resolve()) })
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

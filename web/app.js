'use strict'

const transcript = document.querySelector('#transcript')
const empty = document.querySelector('#empty')
const status = document.querySelector('#status')
const form = document.querySelector('#composer')
const textarea = document.querySelector('#message')
const send = document.querySelector('#send')
const feedback = document.querySelector('#feedback')
const fileInput = document.querySelector('#attachments')
const attachmentList = document.querySelector('#attachment-list')
const wechatButton = document.querySelector('#wechat-button')
const wechatModal = document.querySelector('#wechat-modal')
const wechatMessage = document.querySelector('#wechat-message')
const wechatQr = document.querySelector('#wechat-qr')
const wechatVerify = document.querySelector('#wechat-verify')
const wechatCode = document.querySelector('#wechat-code')
const wechatDisconnect = document.querySelector('#wechat-disconnect')
const wechatRefresh = document.querySelector('#wechat-refresh')
let wechatState
const rendered = new Set()
let selected = []

function render(messages) {
  for (const message of messages) {
    if (rendered.has(message.id)) continue
    rendered.add(message.id)
    const article = document.createElement('article')
    article.className = `message ${message.role}`
    const role = document.createElement('strong')
    role.textContent = message.role === 'assistant' ? 'OMP' : message.role === 'user' ? '用户' : '事件'
    const text = document.createElement('pre')
    text.textContent = message.text
    article.append(role, text)
    for (const image of message.images ?? []) {
      const figure = document.createElement('figure')
      figure.className = 'attachment-image'
      const img = document.createElement('img')
      img.src = `data:${image.mediaType};base64,${image.data}`
      img.alt = image.name
      img.loading = 'lazy'
      const caption = document.createElement('figcaption')
      caption.textContent = image.name
      figure.append(img, caption)
      article.append(figure)
    }
    for (const file of message.files ?? []) {
      const chip = document.createElement('span')
      chip.className = 'attachment-chip attachment-file'
      chip.textContent = `${file.name} · ${file.mediaType}`
      article.append(chip)
    }
    transcript.append(article)
  }
  empty.hidden = rendered.size > 0
  transcript.scrollTop = transcript.scrollHeight
}

async function refresh() {
  try {
    const response = await fetch('/api/messages', { cache: 'no-store' })
    if (!response.ok) throw new Error(`读取失败 (${response.status})`)
    const data = await response.json()
    render(data.messages)
    status.textContent = '已连接'
    status.className = 'status online'
  } catch (error) {
    status.textContent = '连接失败'
    status.className = 'status offline'
  }
}
function renderWeChat(data) {
  wechatState = data
  wechatButton.textContent = data.state === 'connected' ? '微信已连接' : '连接微信'
  wechatButton.classList.toggle('connected', data.state === 'connected')
  wechatMessage.textContent = data.message
  wechatQr.hidden = !data.qrCode || !['waiting', 'scaned', 'verify'].includes(data.state)
  if (data.qrCode) wechatQr.src = data.qrCode
  wechatVerify.hidden = data.state !== 'verify'
  wechatDisconnect.hidden = data.state === 'disconnected'
  wechatRefresh.hidden = data.state === 'connected'
}
async function wechatRequest(path, options) {
  const response = await fetch(path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `微信操作失败 (${response.status})`)
  renderWeChat(data)
  return data
}
async function refreshWeChat() {
  try { await wechatRequest('/api/wechat') }
  catch (error) {
    if (wechatModal.open) wechatMessage.textContent = error instanceof Error ? error.message : String(error)
  }
}
async function connectWeChat() {
  wechatRefresh.disabled = true
  try { await wechatRequest('/api/wechat/connect', { method: 'POST' }) }
  catch (error) { wechatMessage.textContent = error instanceof Error ? error.message : String(error) }
  finally { wechatRefresh.disabled = false }
}
wechatButton.addEventListener('click', async () => {
  wechatModal.showModal()
  await refreshWeChat()
  if (['disconnected', 'error'].includes(wechatState?.state)) await connectWeChat()
})
wechatRefresh.addEventListener('click', connectWeChat)
wechatDisconnect.addEventListener('click', async () => {
  wechatDisconnect.disabled = true
  try { await wechatRequest('/api/wechat/disconnect', { method: 'POST' }) }
  catch (error) { wechatMessage.textContent = error instanceof Error ? error.message : String(error) }
  finally { wechatDisconnect.disabled = false }
})
wechatVerify.addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await wechatRequest('/api/wechat/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: wechatCode.value }) })
    wechatCode.value = ''
  } catch (error) { wechatMessage.textContent = error instanceof Error ? error.message : String(error) }
})

function updateSend() { send.disabled = !textarea.value.trim() && selected.length === 0 }
function showSelected() {
  attachmentList.replaceChildren()
  selected.forEach((file, index) => {
    const chip = document.createElement('span')
    chip.className = 'attachment-chip'
    chip.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KiB)`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '移除'
    remove.addEventListener('click', () => { selected.splice(index, 1); showSelected(); updateSend() })
    chip.append(remove)
    attachmentList.append(chip)
  })
  updateSend()
}

fileInput.addEventListener('change', async () => {
  feedback.textContent = ''
  const files = [...fileInput.files]
  if (selected.length + files.length > 3) {
    feedback.textContent = '最多选择 3 个附件'
    fileInput.value = ''
    return
  }
  if (files.some(file => file.size > 5 * 1024 * 1024)) {
    feedback.textContent = '每个附件不能超过 5 MiB'
    fileInput.value = ''
    return
  }
  selected.push(...files)
  fileInput.value = ''
  showSelected()
})
textarea.addEventListener('input', updateSend)

function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(reader.result.split(',', 2)[1])
    reader.readAsDataURL(file)
  })
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  const text = textarea.value.trim()
  if (!text && selected.length === 0) return
  send.disabled = true
  feedback.textContent = ''
  try {
    const attachments = await Promise.all(selected.map(async file => ({
      name: file.name,
      mediaType: file.type || '',
      data: await base64(file),
    })))
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, attachments }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `发送失败 (${response.status})`)
    textarea.value = ''
    selected = []
    showSelected()
    await refresh()
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    updateSend()
    textarea.focus()
  }
})

textarea.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit()
})

updateSend()
refresh()
refreshWeChat()
setInterval(refreshWeChat, 2000)
setInterval(refresh, 2000)

'use strict'

const transcript = document.querySelector('#transcript')
const empty = document.querySelector('#empty')
const status = document.querySelector('#status')
const form = document.querySelector('#composer')
const textarea = document.querySelector('#message')
const send = document.querySelector('#send')
const feedback = document.querySelector('#feedback')
const rendered = new Set()

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

form.addEventListener('submit', async event => {
  event.preventDefault()
  const text = textarea.value.trim()
  if (!text) return
  send.disabled = true
  feedback.textContent = ''
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `发送失败 (${response.status})`)
    textarea.value = ''
    await refresh()
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : String(error)
  } finally {
    send.disabled = false
    textarea.focus()
  }
})

textarea.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) form.requestSubmit()
})

refresh()
setInterval(refresh, 2000)

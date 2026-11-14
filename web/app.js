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
const settingsButton = document.querySelector('#settings-button')
const settingsModal = document.querySelector('#settings-modal')
const modelForm = document.querySelector('#model-form')
const modelSave = document.querySelector('#model-save')
const modelFeedback = document.querySelector('#model-feedback')
const modelSelects = { eval: document.querySelector('#eval-model'), executor: document.querySelector('#executor-model'), advisor: document.querySelector('#advisor-model') }
const thinkingSelects = { eval: document.querySelector('#eval-thinking'), executor: document.querySelector('#executor-thinking'), advisor: document.querySelector('#advisor-thinking') }
const resetSession = document.querySelector('#reset-session')
const wechatMessage = document.querySelector('#wechat-message')
const wechatQr = document.querySelector('#wechat-qr')
const wechatVerify = document.querySelector('#wechat-verify')
const wechatCode = document.querySelector('#wechat-code')
const wechatDisconnect = document.querySelector('#wechat-disconnect')
const wechatRefresh = document.querySelector('#wechat-refresh')
const githubForm = document.querySelector('#github-form')
const githubSave = document.querySelector('#github-save')
const githubFeedback = document.querySelector('#github-feedback')
const githubStatus = document.querySelector('#github-status')
const githubEnabled = document.querySelector('#github-enabled')
const githubTexts = { repository: document.querySelector('#github-repository'), cli: document.querySelector('#github-cli') }
const githubNumbers = { pollSeconds: document.querySelector('#github-poll-seconds'), failuresBeforeError: document.querySelector('#github-failures') }
const githubSwitches = { observeIssues: document.querySelector('#github-observe-issues'), observePulls: document.querySelector('#github-observe-pulls'),
  observeComments: document.querySelector('#github-observe-comments'), observeCi: document.querySelector('#github-observe-ci') }
const workerButton = document.querySelector('#worker-button')
const workerModal = document.querySelector('#worker-modal')
const workerCount = document.querySelector('#worker-count')
const workerSummary = document.querySelector('#worker-summary')
const workerList = document.querySelector('#worker-list')
const workerDetail = document.querySelector('#worker-detail')
let selectedWorker
let workerDetailVersion = 0
let workerDetailSnapshot = ''
let refreshingWorkers = false
let wechatState
let selected = []
let pendingMessageId
let followOutput = true

transcript.addEventListener('scroll', () => {
  followOutput = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80
})

function codeView(text, language, json = false) {
  const pre = document.createElement('pre')
  pre.className = 'code-view'
  pre.dataset.language = language
  const code = document.createElement('code')
  if (json) {
    const tokens = /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
    let cursor = 0
    for (const match of text.matchAll(tokens)) {
      code.append(document.createTextNode(text.slice(cursor, match.index)))
      const span = document.createElement('span')
      span.className = match[2] ? 'json-key' : match[1] ? 'json-string' : match[0] === 'true' || match[0] === 'false' ? 'json-boolean' : match[0] === 'null' ? 'json-null' : 'json-number'
      span.textContent = match[0]
      code.append(span)
      cursor = match.index + match[0].length
    }
    code.append(document.createTextNode(text.slice(cursor)))
  } else code.textContent = text
  pre.append(code)
  return pre
}

function appendFormatted(container, text) {
  const trimmed = text.trim()
  if (/^[\[{]/.test(trimmed)) {
    try {
      container.append(codeView(JSON.stringify(JSON.parse(trimmed), null, 2), 'JSON', true))
      return
    } catch { /* Not complete JSON; render as text or code below. */ }
  }
  const fences = /```([\w+-]*)[^\S\n]*\n?([\s\S]*?)```/g
  const plain = value => {
    if (!value) return
    const pre = document.createElement('pre')
    pre.className = 'message-text'
    pre.textContent = value
    container.append(pre)
  }
  let cursor = 0
  let found = false
  for (const match of text.matchAll(fences)) {
    found = true
    plain(text.slice(cursor, match.index))
    container.append(codeView(match[2].replace(/\n$/, ''), match[1] || 'code'))
    cursor = match.index + match[0].length
  }
  if (found) { plain(text.slice(cursor)); return }
  if (/\n/.test(text) && /(?:^|\n)\s*(?:[\w.-]+\s*=|[\w.-]+\s*:\s|\[[\w.-]+\])/.test(text)) {
    container.append(codeView(text, 'config'))
    return
  }
  plain(text)
}

function render(messages) {
  transcript.replaceChildren()
  for (const message of messages) {
    const article = document.createElement('article')
    article.className = `message ${message.role}`
    const meta = document.createElement('div')
    meta.className = 'message-meta'
    const role = document.createElement('strong')
    role.textContent = message.role === 'assistant' ? 'Neo Agent' : message.role === 'user' ? '用户' : '事件'
    meta.append(role)
    if (message.at) {
      const time = document.createElement('time')
      time.dateTime = new Date(message.at).toISOString()
      time.textContent = new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      meta.append(time)
    }
    const body = document.createElement('div')
    body.className = 'message-body'
    body.id = `message-body-${message.id}`
    appendFormatted(body, message.text)
    article.append(meta, body)
    if (message.text.length > 700 || (body.textContent ?? '').split('\n').length > 12) {
      body.classList.add('collapsed')
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'message-toggle'
      toggle.textContent = '展开全部'
      toggle.setAttribute('aria-controls', body.id)
      toggle.setAttribute('aria-expanded', 'false')
      toggle.addEventListener('click', () => {
        const collapsed = body.classList.toggle('collapsed')
        toggle.textContent = collapsed ? '展开全部' : '收起'
        toggle.setAttribute('aria-expanded', String(!collapsed))
      })
      article.append(toggle)
    }
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
  empty.hidden = transcript.querySelector('.message.user, .message.assistant') !== null
  if (followOutput) transcript.scrollTop = transcript.scrollHeight
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
function workerStatus(worker) {
  if (worker.session.streaming) return { text: '正在执行', kind: 'working' }
  if (worker.background.length && worker.stage.stage !== 'person') return { text: '后台运行', kind: 'working' }
  if (worker.stage.stage === 'ended') return { text: worker.outcome === 'completed' ? '已完成' : '已结束', kind: 'ended' }
  if (worker.stage.stage === 'person') {
    const labels = { delivery: '投递失败', answer: '等待回复', review: '待确认结果', blocked: '已阻塞', failed: '执行失败' }
    return { text: labels[worker.stage.action], kind: 'person' }
  }
  if (worker.stage.stage === 'idle') return { text: '空闲', kind: 'idle' }
  return { text: worker.stage.action === 'queued' ? '排队等待' : '工作中', kind: 'working' }
}
function renderWorkers(workers) {
  const active = workers.filter(worker => worker.stage.stage !== 'ended').length
  workerCount.textContent = String(active)
  workerSummary.textContent = `${active} 个进行中 · ${workers.length} 个总计`
  workerList.replaceChildren()
  if (!workers.length) {
    const emptyWorkers = document.createElement('div')
    emptyWorkers.className = 'worker-placeholder'
    emptyWorkers.textContent = '暂无 Worker。聊天中的明确请求被接受后会显示在这里。'
    workerList.append(emptyWorkers)
    return
  }
  for (const worker of workers) {
    const state = workerStatus(worker)
    const card = document.createElement('button')
    card.type = 'button'
    card.className = `worker-card${selectedWorker === worker.ticketId ? ' selected' : ''}`
    const statusText = document.createElement('span')
    statusText.className = `worker-state ${state.kind}`
    statusText.textContent = state.text
    const title = document.createElement('span')
    title.className = 'worker-card-title'
    title.textContent = worker.title
    const meta = document.createElement('span')
    meta.className = 'worker-card-meta'
    const progress = document.createElement('span')
    progress.textContent = worker.progress?.state ?? worker.assignment?.state ?? '未启动'
    const pending = document.createElement('span')
    pending.textContent = worker.pendingInputs ? `${worker.pendingInputs} 条待投递` : '输入已投递'
    meta.append(progress, pending)
    if (worker.background.length) {
      const background = document.createElement('span')
      background.textContent = `${worker.background.length} 个后台任务`
      meta.append(background)
    }
    card.append(statusText, title, meta)
    card.addEventListener('click', () => { void showWorker(worker.ticketId).catch(error => { workerSummary.textContent = error instanceof Error ? error.message : String(error) }) })
    workerList.append(card)
  }
}
function renderWorker(worker) {
  workerDetail.replaceChildren()
  const state = workerStatus(worker)
  const badge = document.createElement('span')
  badge.className = `worker-state ${state.kind}`
  badge.textContent = state.text
  const title = document.createElement('h3')
  title.textContent = worker.title
  workerDetail.append(badge, title)
  const facts = document.createElement('div')
  facts.className = 'worker-facts'
  const entries = [
    ['Ticket', worker.ticketId],
    ['Session', worker.session.streaming ? '正在执行' : worker.session.loaded ? '已加载，空闲' : '未加载'],
    ['Assignment', worker.assignment ? `${worker.assignment.state} · ${worker.assignment.id}` : '无'],
    ['待投递输入', String(worker.pendingInputs)],
    ['后台任务', String(worker.background.length)],
    ['工作目录', worker.directory ?? '无'],
  ]
  for (const [label, value] of entries) {
    const item = document.createElement('div')
    item.className = 'worker-fact'
    const name = document.createElement('span')
    name.textContent = label
    const content = document.createElement('code')
    content.textContent = value
    item.append(name, content)
    facts.append(item)
  }
  workerDetail.append(facts)
  if (worker.delivery?.error || worker.attention?.question) {
    const warning = document.createElement('pre')
    warning.className = 'worker-error message-text'
    warning.textContent = worker.delivery?.error ?? worker.attention.question
    workerDetail.append(warning)
  }
  if (worker.background.length) {
    const section = document.createElement('section')
    section.className = 'worker-section'
    const heading = document.createElement('h4')
    heading.textContent = `后台任务（${worker.background.length}）`
    section.append(heading)
    for (const job of worker.background) {
      const item = document.createElement('div')
      item.className = 'worker-fact'
      const name = document.createElement('span')
      name.textContent = `${job.type === 'task' ? '子代理' : 'Shell'} · ${new Date(job.startedAt).toLocaleTimeString('zh-CN')} 起`
      const content = document.createElement('code')
      content.textContent = `${job.id} · ${job.label}`
      item.append(name, content)
      section.append(item)
    }
    workerDetail.append(section)
  }
  if (worker.progress) {
    const section = document.createElement('section')
    section.className = 'worker-section'
    const heading = document.createElement('h4')
    heading.textContent = `最新报告 · ${worker.progress.state} · ${new Date(worker.progress.at).toLocaleTimeString('zh-CN')}`
    const body = document.createElement('div')
    appendFormatted(body, worker.progress.summary)
    section.append(heading, body)
    workerDetail.append(section)
  }
  const activity = document.createElement('section')
  activity.className = 'worker-section'
  const heading = document.createElement('h4')
  heading.textContent = `最近活动（${worker.recent.length} 条）`
  activity.append(heading)
  if (!worker.recent.length) {
    const none = document.createElement('p')
    none.className = 'worker-placeholder'
    none.textContent = '暂无持久消息。'
    activity.append(none)
  }
  for (const message of worker.recent) {
    const item = document.createElement('article')
    item.className = 'worker-activity'
    const meta = document.createElement('div')
    meta.className = 'worker-activity-meta'
    const role = document.createElement('span')
    role.textContent = message.role
    const time = document.createElement('time')
    time.textContent = message.at ? new Date(message.at).toLocaleTimeString('zh-CN') : ''
    meta.append(role, time)
    const body = document.createElement('div')
    appendFormatted(body, message.text)
    item.append(meta, body)
    activity.append(item)
  }
  workerDetail.append(activity)
}
async function showWorker(ticketId) {
  selectedWorker = ticketId
  const version = ++workerDetailVersion
  const response = await fetch(`/api/workers/${encodeURIComponent(ticketId)}`, { cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Worker 详情读取失败')
  if (version !== workerDetailVersion) return
  const snapshot = JSON.stringify(data)
  if (snapshot === workerDetailSnapshot) return
  workerDetailSnapshot = snapshot
  renderWorker(data)
}
async function refreshWorkers() {
  if (refreshingWorkers) return
  refreshingWorkers = true
  try {
    const response = await fetch('/api/workers', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Worker 列表读取失败')
    renderWorkers(data.workers)
    if (workerModal.open && selectedWorker) await showWorker(selectedWorker)
  } catch (error) {
    if (workerModal.open) workerSummary.textContent = error instanceof Error ? error.message : String(error)
  } finally { refreshingWorkers = false }
}
workerButton.addEventListener('click', () => { workerModal.showModal(); void refreshWorkers() })
function fillModelOptions(select, current, available, fallbackText) {
  select.replaceChildren()
  const fallback = document.createElement('option')
  fallback.value = ''
  fallback.textContent = fallbackText
  select.append(fallback)
  for (const model of available) {
    const option = document.createElement('option')
    option.value = JSON.stringify([model.provider, model.id])
    option.textContent = `${model.name} · ${model.provider}/${model.id}`
    select.append(option)
  }
  if (current) {
    const value = JSON.stringify([current.provider, current.model])
    if (![...select.options].some(option => option.value === value)) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = `${current.provider}/${current.model}（当前）`
      select.append(option)
    }
    select.value = value
  } else select.value = ''
}
const kernelSelect = document.querySelector('#kernel-select')
const kernelHint = document.querySelector('#kernel-hint')
const advisorFields = document.querySelector('#advisor-fields')
const THINKING_LABELS = { auto: 'Auto', off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }
const KERNEL_HINTS = {
  omp: '模型来自 OMP agentDir 的 provider 配置。',
  claude: '经 Agent SDK 运行 Claude Code：认证与默认模型取自 ANTHROPIC_* 环境，只使用模型名（provider 被忽略）。',
}
function renderModelSettings(data) {
  kernelSelect.value = data.kernel
  kernelHint.textContent = `${KERNEL_HINTS[data.kernel] ?? ''} 切换立即生效并跨重启保留，下方模型配置随之换成该内核自己的一套：orchestrator 会话在新内核上重开（聊天记录保留、模型上下文重新开始），运行中的 worker 在原内核上跑完当前加载。`
  // Only what the current kernel supports is shown.
  advisorFields.hidden = !data.supports.advisor
  for (const role of ['eval', 'executor', 'advisor']) {
    thinkingSelects[role].replaceChildren(...data.supports.thinkingLevels.map(level => {
      const option = document.createElement('option')
      option.value = level
      option.textContent = THINKING_LABELS[level] ?? level
      return option
    }))
    fillModelOptions(modelSelects[role], data.current[role], data.available, role === 'advisor' ? '关闭' : '跟随内核默认')
    thinkingSelects[role].value = data.current[role]?.thinkingLevel ?? 'auto'
  }
}
async function refreshModels() {
  modelSave.disabled = true
  try {
    const response = await fetch('/api/settings/models', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '模型配置读取失败')
    renderModelSettings(data)
  } catch (error) { modelFeedback.textContent = error instanceof Error ? error.message : String(error) }
  finally { modelSave.disabled = false }
}
kernelSelect.addEventListener('change', async () => {
  const kernel = kernelSelect.value
  kernelSelect.disabled = modelSave.disabled = true
  modelFeedback.textContent = '正在切换内核…'
  try {
    const response = await fetch('/api/settings/kernel', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kernel }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
    renderModelSettings(data)
    modelFeedback.textContent = `已切换到 ${kernel === 'claude' ? 'Claude Code' : 'OMP'}`
  } catch (error) {
    modelFeedback.textContent = error instanceof Error ? error.message : String(error)
    await refreshModels()
  } finally { kernelSelect.disabled = modelSave.disabled = false }
})
modelForm.addEventListener('submit', async event => {
  event.preventDefault()
  modelSave.disabled = true
  modelFeedback.textContent = ''
  try {
    const selection = role => {
      if (!modelSelects[role].value) return null
      const [provider, model] = JSON.parse(modelSelects[role].value)
      return { provider, model, thinkingLevel: thinkingSelects[role].value }
    }
    const response = await fetch('/api/settings/models', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eval: selection('eval'), executor: selection('executor'), advisor: selection('advisor') }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '模型配置保存失败')
    renderModelSettings(data)
    modelFeedback.textContent = '已保存并应用'
  } catch (error) { modelFeedback.textContent = error instanceof Error ? error.message : String(error) }
  finally { modelSave.disabled = false }
})
function requireGithubAccount() {
  for (const input of Object.values(githubTexts)) input.required = githubEnabled.checked
}
function renderGithub(data) {
  githubEnabled.checked = data.enabled
  for (const [key, input] of Object.entries({ ...githubTexts, ...githubNumbers })) input.value = data.config[key]
  for (const [key, input] of Object.entries(githubSwitches)) input.checked = data.config[key]
  requireGithubAccount()
  const polled = data.health?.state === 'error' ? `；轮询异常：${data.health.detail}`
    : data.health?.state === 'ready' && data.health.at ? `；最近轮询 ${new Date(data.health.at).toLocaleTimeString()}` : ''
  githubStatus.textContent = data.connection ? `已连接 ${data.connection.repository}，账号 @${data.connection.account}${polled}` : '未连接'
}
async function refreshGithub() {
  githubSave.disabled = true
  try {
    const response = await fetch('/api/settings/github', { cache: 'no-store' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'GitHub 配置读取失败')
    renderGithub(data)
  } catch (error) { githubFeedback.textContent = error instanceof Error ? error.message : String(error) }
  finally { githubSave.disabled = false }
}
githubEnabled.addEventListener('change', requireGithubAccount)
githubForm.addEventListener('submit', async event => {
  event.preventDefault()
  githubSave.disabled = true
  githubFeedback.textContent = githubEnabled.checked ? '正在校验账号与仓库权限…' : ''
  try {
    const config = Object.fromEntries([
      ...Object.entries(githubTexts).map(([key, input]) => [key, input.value.trim()]),
      ...Object.entries(githubNumbers).map(([key, input]) => [key, Number(input.value)]),
      ...Object.entries(githubSwitches).map(([key, input]) => [key, input.checked]),
    ])
    const response = await fetch('/api/settings/github', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: githubEnabled.checked, config }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'GitHub 配置保存失败')
    renderGithub(data)
    githubFeedback.textContent = data.enabled ? '已连接并保存' : '已保存，GitHub 未连接'
  } catch (error) { githubFeedback.textContent = error instanceof Error ? error.message : String(error) }
  finally { githubSave.disabled = false }
})
for (const tab of document.querySelectorAll('[data-settings-tab]')) {
  tab.addEventListener('click', () => {
    for (const item of document.querySelectorAll('[data-settings-tab]')) {
      const active = item === tab
      item.classList.toggle('active', active)
      item.setAttribute('aria-selected', String(active))
    }
    for (const page of ['models', 'wechat', 'github']) document.querySelector(`#settings-${page}`).hidden = tab.dataset.settingsTab !== page
    if (tab.dataset.settingsTab === 'wechat') void refreshWeChat()
  })
}
function renderWeChat(data) {
  wechatState = data
  wechatRefresh.textContent = ['waiting', 'scaned', 'verify'].includes(data.state) ? '重新获取二维码' : '连接微信'
  wechatMessage.textContent = data.senderId ? `${data.message} 发送者 ID：${data.senderId}` : data.message
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
    if (settingsModal.open) wechatMessage.textContent = error instanceof Error ? error.message : String(error)
  }
}
async function connectWeChat() {
  wechatRefresh.disabled = true
  try { await wechatRequest('/api/wechat/connect', { method: 'POST' }) }
  catch (error) { wechatMessage.textContent = error instanceof Error ? error.message : String(error) }
  finally { wechatRefresh.disabled = false }
}
settingsButton.addEventListener('click', async () => {
  settingsModal.showModal()
  await Promise.all([refreshModels(), refreshWeChat(), refreshGithub()])
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
resetSession.addEventListener('click', async () => {
  if (!window.confirm('确定重置 orchestrator Session？当前对话上下文将清空，微信绑定保留。')) return
  resetSession.disabled = true
  feedback.textContent = ''
  try {
    const response = await fetch('/api/session/reset', { method: 'POST' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `重置失败 (${response.status})`)
    transcript.replaceChildren()
    empty.hidden = false
    feedback.textContent = 'Session 已重置'
  } catch (error) { feedback.textContent = error instanceof Error ? error.message : String(error) }
  finally { resetSession.disabled = false }
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
textarea.addEventListener('input', () => { pendingMessageId = undefined; updateSend() })

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
    const random = new Uint32Array(4)
    crypto.getRandomValues(random)
    const messageId = pendingMessageId ??= `web:${[...random].map(value => value.toString(16).padStart(8, '0')).join('')}`
    const attachments = await Promise.all(selected.map(async file => ({
      name: file.name,
      mediaType: file.type || '',
      data: await base64(file),
    })))
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId, text, attachments }),
    })
    const data = await response.json()
    followOutput = true
    if (!response.ok) throw new Error(data.error || `发送失败 (${response.status})`)
    pendingMessageId = undefined
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
refreshWorkers()
setInterval(refreshWorkers, 2000)
setInterval(refreshWeChat, 2000)
setInterval(refresh, 2000)

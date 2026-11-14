/** File-backed JSONL transcript for Claude Code kernel Sessions: delivery barrier, replay source and Web transcript. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { KernelContent, KernelEntry, KernelJournal, KernelMessage } from './types.ts'

type Line = { type: 'header'; kernel: 'claude'; id: string; cwd: string; timestamp: string }
  | { type: 'claude_session'; id: string } | { type: 'name'; name: string }
  | { type: 'context'; id: string } | { type: 'context_sent'; ids: string[] } | KernelEntry

/** Chat transcript sources the Web panel shows; carried over when a Session changes kernel. */
const VISIBLE_SOURCES = new Set(['web-panel', 'wechat', 'chat-reply'])

/** First line sniffed to tell a Claude kernel journal from an OMP session file. */
export async function isClaudeJournal(file: string): Promise<boolean> {
  const text = await readFile(file, 'utf8').catch(() => '')
  const first = text.slice(0, text.indexOf('\n') < 0 ? undefined : text.indexOf('\n'))
  try { return (JSON.parse(first) as { kernel?: string }).kernel === 'claude' } catch { return false }
}

/** Append-only transcript of one Claude Code Session; an entry is visible once appended and durable after flush(). */
export class Journal implements KernelJournal {
  onEntryAppended: ((entry: KernelEntry) => void) | undefined
  claudeSessionId: string | undefined
  name: string | undefined
  /** Decides, for a just-appended custom entry, whether the model must still be shown it on its next turn. */
  contextFilter: ((entry: KernelEntry) => boolean) | undefined
  private entries: KernelEntry[] = []
  /** Ids of entries the model has not been sent yet: injected notices and chat images, kept across restarts. */
  private context: string[] = []
  private writing: Promise<void> = Promise.resolve()
  private failure: unknown

  private constructor(readonly file: string, readonly cwd: string) {}

  static async create(dir: string, cwd: string): Promise<Journal> {
    const id = randomUUID()
    const journal = new Journal(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`), cwd)
    await mkdir(dirname(journal.file), { recursive: true, mode: 0o700 })
    const header: Line = { type: 'header', kernel: 'claude', id, cwd, timestamp: new Date().toISOString() }
    await writeFile(journal.file, `${JSON.stringify(header)}\n`, { mode: 0o600 })
    return journal
  }

  static async open(file: string, cwd: string): Promise<Journal> {
    const journal = new Journal(file, cwd)
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let parsed: Line
      try { parsed = JSON.parse(line) as Line } catch { continue }
      if (parsed.type === 'claude_session') journal.claudeSessionId = parsed.id
      else if (parsed.type === 'name') journal.name = parsed.name
      else if (parsed.type === 'context') journal.context.push(parsed.id)
      else if (parsed.type === 'context_sent') journal.context = journal.context.filter(id => !parsed.ids.includes(id))
      else if (parsed.type === 'message' || parsed.type === 'custom_message') journal.entries.push(parsed)
    }
    return journal
  }

  getBranch(): KernelEntry[] { return this.entries }
  messages(): KernelMessage[] {
    return this.entries.flatMap(entry => entry.type === 'message' ? [entry.message]
      : [{ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, details: entry.details,
        attribution: entry.attribution, timestamp: Date.parse(entry.timestamp) }])
  }

  private write(line: Line): void {
    const text = `${JSON.stringify(line)}\n`
    this.writing = this.writing.then(() => appendFile(this.file, text)).catch((error: unknown) => { this.failure = error })
  }
  private append(entry: KernelEntry): void {
    this.entries.push(entry)
    this.write(entry)
    this.onEntryAppended?.(entry)
  }
  appendCustomMessageEntry(customType: string, content: KernelContent, display: boolean,
    details?: unknown, attribution?: string): KernelEntry {
    const entry: KernelEntry = { type: 'custom_message', id: randomUUID(), timestamp: new Date().toISOString(), customType, content, display,
      ...details === undefined ? {} : { details }, ...attribution ? { attribution } : {} }
    this.append(entry)
    if (this.contextFilter?.(entry)) this.markContext(entry)
    return entry
  }
  markContext(entry: KernelEntry): void {
    if (!entry.id || this.context.includes(entry.id)) return
    this.context.push(entry.id)
    this.write({ type: 'context', id: entry.id })
  }
  /** Contents not yet sent to the model, in order; they count as sent from here on. */
  takeContext(): KernelContent[] {
    if (!this.context.length) return []
    const ids = this.context
    this.context = []
    this.write({ type: 'context_sent', ids })
    return this.entries.flatMap(entry => entry.type === 'custom_message' && entry.id && ids.includes(entry.id) ? [entry.content] : [])
  }
  /** The visible chat transcript, which a Session keeps when it moves to another kernel. */
  chat(): Extract<KernelEntry, { type: 'custom_message' }>[] {
    return this.entries.flatMap(entry => entry.type === 'custom_message' && entry.details && typeof entry.details === 'object'
      && VISIBLE_SOURCES.has(String((entry.details as { source?: unknown }).source)) ? [entry] : [])
  }
  /** Copy the visible chat transcript of an OMP session file, so the Web panel keeps its history across a kernel switch. */
  async importChat(ompFile: string): Promise<number> {
    const text = await readFile(ompFile, 'utf8').catch(() => '')
    let count = 0
    for (const line of text.split('\n')) {
      if (!line.includes('"custom_message"')) continue
      let entry: KernelEntry & { details?: { source?: unknown } }
      try { entry = JSON.parse(line) as typeof entry } catch { continue }
      if (entry.type !== 'custom_message' || !entry.details || !VISIBLE_SOURCES.has(String(entry.details.source))) continue
      const copy: KernelEntry = { type: 'custom_message', id: entry.id ?? randomUUID(), timestamp: entry.timestamp, customType: entry.customType,
        content: entry.content, display: entry.display, details: entry.details, ...entry.attribution ? { attribution: entry.attribution } : {} }
      this.entries.push(copy)
      this.write(copy)
      count++
    }
    return count
  }
  appendMessage(message: KernelMessage): void {
    this.append({ type: 'message', id: randomUUID(), timestamp: new Date(message.timestamp ?? Date.now()).toISOString(), message })
  }
  setClaudeSession(id: string): void {
    if (this.claudeSessionId === id) return
    this.claudeSessionId = id
    this.write({ type: 'claude_session', id })
  }
  setName(name: string): void {
    if (this.name === name) return
    this.name = name
    this.write({ type: 'name', name })
  }
  async flush(): Promise<void> {
    await this.writing
    if (this.failure) { const error = this.failure; this.failure = undefined; throw error }
  }
}

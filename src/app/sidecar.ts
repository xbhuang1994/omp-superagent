/**
 * Lightweight `/btw`-style read-only Sidecar: answers progress, summary, comparison, and evaluation queries on existing
 * tickets in a stateless, prefix-cached in-memory Session without waking or polluting heavy Worker Sessions.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import z from 'zod'
import { latestReport, type EngineForMainSession } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { IM_WORDS, checkedImText, wordCount } from '../infra/text.ts'
import { ticketCard } from './cards.ts'
import { Later, type EffectPayloads, type Effects } from './effects.ts'
import { receiptNotice } from './notices.ts'
import type { OMPSessions } from './sessions.ts'
import type { Store } from './store.ts'
import { AcknowledgementSchema, tool } from './tools/tool.ts'
import type { OMPExecutor } from '../executor/omp.ts'

export interface SidecarHost {
  readonly store: Pick<Store, 'tickets' | 'triggers'>
  readonly engine: Pick<EngineForMainSession, 'reply'>
  readonly executor: Pick<OMPExecutor, 'runningJobs'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly sessions: Pick<OMPSessions, 'runSidecar' | 'notify'>
  readonly machine: Pick<Machine, 'stateDir'>
  paused(): boolean
  closing(): boolean
  sendReplies(): Promise<void>
}

const REPORT_EXCERPT_CHARS = 4000
const SUBDIRS_TO_LIST = ['docs', 'results', 'out', 'run']

async function listDeliverables(directory: string | undefined): Promise<string[]> {
  if (!directory || !await stat(directory).then(info => info.isDirectory(), () => false)) return []
  const top = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = top.filter(entry => !entry.name.startsWith('.')).map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name)
  for (const sub of SUBDIRS_TO_LIST) {
    if (!top.some(entry => entry.isDirectory() && entry.name === sub)) continue
    const nested = await readdir(join(directory, sub), { withFileTypes: true }).catch(() => [])
    for (const entry of nested.slice(0, 12)) {
      if (!entry.name.startsWith('.')) files.push(`${sub}/${entry.name}${entry.isDirectory() ? '/' : ''}`)
    }
  }
  return files.slice(0, 40)
}

function fallbackReply(raw: string): string {
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  if (!cleaned) return '当前工单暂无更多补充结论，请稍后再试。'
  if (wordCount(cleaned) <= IM_WORDS) return checkedImText(cleaned)
  let cut = cleaned.slice(0, 240)
  while (cut.length > 20 && wordCount(`${cut}…`) > IM_WORDS) cut = cut.slice(0, -10)
  return `${cut}…`
}

/**
 * Executes durable `sidecar` effects: gathers a ticket's live jobs, latest report, and deliverable index, runs one
 * read-only `OMPSessions.runSidecar` turn, pushes the concise answer straight through Outbox, and records a silent notice
 * on the main Session so global memory stays continuous without another orchestrator turn.
 */
export class Sidecar {
  constructor(private readonly host: SidecarHost) {
    host.effects.handle('sidecar', payload => this.run(payload), { limit: () => host.paused() ? 0 : 4 })
  }

  enqueue(payload: EffectPayloads['sidecar']): void {
    this.host.effects.enqueue('sidecar', payload.triggerId, payload)
  }

  private async run(payload: EffectPayloads['sidecar']): Promise<void> {
    if (this.host.closing() || this.host.paused()) throw new Later('Sidecar is paused or stopping')
    const ticket = this.host.store.tickets.get(payload.ticketId)
    const trigger = this.host.store.triggers.get(payload.triggerId)
    if (!ticket || !trigger?.human || !trigger.channel) return
    const questions = (payload.batchIds.length ? payload.batchIds : [payload.triggerId])
      .flatMap(id => this.host.store.triggers.get(id) ?? [])
      .map(item => ({ trigger_id: item.id, at: item.at, text: item.text }))
    const directory = ticket.execution?.directory
    const report = latestReport(ticket)
    const packet = {
      questions,
      ...(payload.note ? { routing_note: payload.note } : {}),
      ticket: ticketCard(ticket),
      directory: directory ?? null,
      running_jobs: this.host.executor.runningJobs(ticket.id),
      latest_report: report ? {
        state: report.state,
        at: report.at,
        summary: report.summary.slice(0, REPORT_EXCERPT_CHARS),
        truncated: report.summary.length > REPORT_EXCERPT_CHARS,
      } : null,
      workspace_files: await listDeliverables(directory),
    }

    let repliedText: string | undefined
    const replyTool = tool({
      name: 'sidecar_reply',
      description: `Send the concise read-only answer (at most ${IM_WORDS} words) directly to the person's conversation.`,
      schema: z.object({ text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`) }).strict(),
      execute: async ({ text }) => {
        const reply = this.host.engine.reply({ purpose: 'answer', triggerId: payload.triggerId, text })
        repliedText = text
        return { sent: true, id: reply.id }
      },
    })

    const cwd = directory && await stat(directory).then(info => info.isDirectory(), () => false) ? directory : this.host.machine.stateDir
    const finalText = await this.host.sessions.runSidecar(cwd, JSON.stringify(packet), [replyTool])
    if (!repliedText) {
      repliedText = fallbackReply(finalText)
      this.host.engine.reply({ purpose: 'answer', triggerId: payload.triggerId, text: repliedText })
    }
    await this.host.sendReplies()
    this.host.sessions.notify(...receiptNotice(
      { sidecar_answered: { ticket_id: ticket.id, trigger_id: payload.triggerId, answer: repliedText } },
      `Sidecar answered ${payload.triggerId} on ticket ${ticket.id}`,
    ))
  }
}

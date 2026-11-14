/** Kernel-neutral Session contract: the subset of an agent runtime the application relies on (OMP AgentSession or Claude Code). */
export type KernelKind = 'omp' | 'claude'
export type KernelContent = string | { type: string }[]

export interface KernelMessage {
  role: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OMP and Claude messages carry different block shapes; consumers narrow them.
  content?: any
  stopReason?: string
  customType?: string
  details?: unknown
  display?: boolean
  attribution?: string
  timestamp?: number
}
export type KernelEntry =
  | { type: 'message'; id?: string; timestamp?: string; message: KernelMessage }
  | { type: 'custom_message'; id?: string; timestamp: string; customType: string; content: KernelContent;
    display: boolean; details?: unknown; attribution?: string }
export type KernelEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; isTerminal?: boolean; awaitingAsyncWork?: boolean }
  | { type: 'auto_retry_start' }
  | { type: 'message_end'; message: KernelMessage }

export interface KernelJournal {
  onEntryAppended: ((entry: KernelEntry) => void) | undefined
  getBranch(): KernelEntry[]
  appendCustomMessageEntry(customType: string, content: KernelContent, display: boolean,
    details?: unknown, attribution?: string): unknown
}
export interface KernelJob {
  id: string
  type: 'bash' | 'task' | 'eval'
  label: string
  startTime: number
  progressText?: string
  process?: { command: string; pids(): readonly number[] }
}
export interface KernelJobs {
  getRunningJobs(filter?: { ownerId?: string }): KernelJob[]
  acknowledgeDeliveries(ids: readonly string[]): void
  cancel(id: string): boolean
}
export interface KernelSession {
  readonly isStreaming: boolean
  readonly isDisposed: boolean
  readonly hasAdmittedSubmission: boolean
  readonly messages: KernelMessage[]
  readonly sessionFile?: string | undefined
  /** OMP-only introspection; undefined on the Claude Code kernel. */
  readonly model?: { id: string } | undefined
  isAdvisorEnabled?(): boolean
  readonly sessionManager: KernelJournal
  readonly asyncJobManager?: KernelJobs | undefined
  readonly agent: { addBeforeModelCallHook(hook: () => Promise<void>): () => void; appendMessage(message: KernelMessage): void }
  subscribe(listener: (event: KernelEvent) => void): () => void
  getLastAssistantText(): string | undefined
  sendCustomMessage(message: { customType: string; content: KernelContent; display: boolean; attribution?: string; details?: unknown },
    options: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' }): Promise<boolean>
  flushToDisk(): Promise<void>
  beginDispose(): void
  dispose(): Promise<void>
}

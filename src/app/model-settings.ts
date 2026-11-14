/** Validated, immediately applied model settings for the independent settings panel. */
import z from 'zod'
import { RoleModelSchema, policyVersion, type RoleModel, type Settings } from '../policy.ts'
import { KV } from '../kv.ts'
import type { OMPSessions } from './sessions.ts'
import type { Store } from './store.ts'

const KernelUpdateSchema = z.object({ kernel: z.enum(['omp', 'claude']) }).strict()
const ModelUpdateSchema = z.object({ eval: RoleModelSchema.nullable(), executor: RoleModelSchema.nullable(), advisor: RoleModelSchema.nullable() }).strict()
export type ModelUpdate = z.infer<typeof ModelUpdateSchema>
type Kernel = 'omp' | 'claude'
type Models = { eval: RoleModel | null; executor: RoleModel | null; advisor: RoleModel | null }
const DEFAULTS: Models = { eval: null, executor: null, advisor: null }
/** What each kernel can be configured with; the panel shows nothing else. Claude Code has no advisor model and no `minimal` effort. */
export const KERNEL_SUPPORT: Record<Kernel, { advisor: boolean; thinkingLevels: string[] }> = {
  omp: { advisor: true, thinkingLevels: ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  claude: { advisor: false, thinkingLevels: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] },
}
const modelsOf = (settings: Settings): Models => ({ eval: settings.eval.model, executor: settings.executor.model, advisor: settings.executor.advisor })
const withModels = (settings: Settings, models: Models): Settings =>
  ({ ...settings, eval: { ...settings.eval, model: models.eval }, executor: { ...settings.executor, model: models.executor, advisor: models.advisor } })

/**
 * Coordinates catalog reads, validation, live Session application, and durable model settings. Each kernel has its own
 * model choices, all following the kernel's default until set: the settings hold the current kernel's, and the other's wait in KV.
 */
export class ModelSettings {
  constructor(private readonly store: Pick<Store, 'settings' | 'saveSettings' | 'get' | 'set'>, private readonly sessions: Pick<OMPSessions, 'modelOptions' | 'applyModel' | 'checkModel' | 'kernel' | 'setKernel'>) {}
  async view() {
    const { eval: evaluation, executor } = this.store.settings()
    return { kernel: this.sessions.kernel, supports: KERNEL_SUPPORT[this.sessions.kernel], current: { eval: evaluation.model, executor: executor.model, advisor: executor.advisor }, available: await this.sessions.modelOptions() }
  }
  /** Switch the execution kernel; the choice is durable and the model catalog follows it. */
  async setKernel(value: unknown) {
    const kernel = KernelUpdateSchema.parse(value).kernel
    const from = this.sessions.kernel
    if (kernel === from) return this.view()
    const before = this.store.settings()
    const save = (settings: Settings) => { this.store.saveSettings(settings, { source: 'panel', policyVersion: policyVersion(settings), policyChanged: false, notified: [] }) }
    // The target kernel starts and is checked with its own choices, so they are in place before the switch.
    save(withModels(before, this.store.get(KV.runtime.kernelModels(kernel)) ?? DEFAULTS))
    try { await this.sessions.setKernel(kernel) }
    catch (error) {
      save(withModels(this.store.settings(), modelsOf(before)))
      throw error
    }
    this.store.set(KV.runtime.kernelModels(from), modelsOf(before))
    return this.view()
  }
  async update(value: unknown) {
    const support = KERNEL_SUPPORT[this.sessions.kernel]
    const parsed = ModelUpdateSchema.parse(value)
    const update = { ...parsed, advisor: support.advisor ? parsed.advisor : null }
    for (const selection of [update.eval, update.executor, update.advisor]) {
      if (selection?.thinkingLevel && !support.thinkingLevels.includes(selection.thinkingLevel)) {
        throw new Error(`Thinking level ${selection.thinkingLevel} is not supported by the ${this.sessions.kernel} kernel`)
      }
    }
    // Check every selector first, so an unknown one applies none of them.
    for (const selection of [update.eval, update.executor, update.advisor]) await this.sessions.checkModel(selection)
    const current = this.store.settings()
    await this.sessions.applyModel('orchestrator', update.eval)
    await this.sessions.applyModel('worker', update.executor)
    await this.sessions.applyModel('advisor', update.advisor)
    const next: Settings = { ...current, eval: { ...current.eval, model: update.eval }, executor: { ...current.executor, model: update.executor, advisor: update.advisor } }
    this.store.saveSettings(next, { source: 'panel', policyVersion: policyVersion(next), policyChanged: false, notified: [] })
    return this.view()
  }
}

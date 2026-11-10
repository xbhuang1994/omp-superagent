/** Validated, immediately applied model settings for the independent settings panel. */
import z from 'zod'
import { RoleModelSchema, policyVersion, type RoleModel, type Settings } from '../policy.ts'
import type { OMPSessions } from './sessions.ts'
import type { Store } from './store.ts'

const ModelUpdateSchema = z.object({ eval: RoleModelSchema.nullable(), executor: RoleModelSchema.nullable(), advisor: RoleModelSchema.nullable() }).strict()
export type ModelUpdate = z.infer<typeof ModelUpdateSchema>

/** Coordinates catalog reads, validation, live Session application, and durable model settings. */
export class ModelSettings {
  constructor(private readonly store: Pick<Store, 'settings' | 'saveSettings'>, private readonly sessions: Pick<OMPSessions, 'modelOptions' | 'applyModel' | 'checkModel'>) {}
  async view() {
    const { eval: evaluation, executor } = this.store.settings()
    return { current: { eval: evaluation.model, executor: executor.model, advisor: executor.advisor }, available: await this.sessions.modelOptions() }
  }
  async update(value: unknown) {
    const update = ModelUpdateSchema.parse(value)
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

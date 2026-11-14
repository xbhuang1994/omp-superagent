/** The GitHub Source's connection: verified agent account and repository, worker environment, and polling loop. */
import z from 'zod'
import { resolveDeployment, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, writeEnvironment } from '../infra/environment.ts'
import { KV } from '../kv.ts'
import { policyVersion, type Settings } from '../policy.ts'
import { SetupError } from '../setup.ts'
import { githubKind, watch } from '../sources/github.ts'
import { health, type Health, type SourceContext } from '../sources/host.ts'
import type { Store } from './store.ts'

const SOURCE = githubKind.kind
const GithubUpdateSchema = z.object({ enabled: z.boolean(), config: githubKind.schema }).strict()
export interface GithubConnectionHost {
  readonly machine: Machine
  readonly store: Pick<Store, 'atomic' | 'get' | 'set' | 'delete' | 'keys' | 'settings' | 'saveSettings' | 'threads'>
  readonly lifetime: AbortSignal
  /** PATH without the worker shim directory. */
  readonly path: string
  context(): SourceContext
  health(): Health | undefined
  closing(): boolean
  /** Runs after the connected account or repository changed, which the execution environment in Session prompts names. */
  changed(): Promise<void>
}

/**
 * Connects the GitHub Source at startup and from the settings panel: verifies the agent CLI's account and push access,
 * keeps one state directory to one repository, writes the worker environment, and runs the polling loop.
 * A connection that fails verification changes nothing; disconnecting stops polling and leaves the worker environment
 * in place until restart, so running workers keep the agent account rather than falling back to ambient credentials.
 */
export class GithubConnection {
  private resolved?: Deployment
  private restoreEnvironment?: () => void
  private watching?: { stop: AbortController; done: Promise<void> }
  private switching: Promise<unknown> = Promise.resolve()
  constructor(private readonly host: GithubConnectionHost) {}

  get deployment(): Deployment | undefined { return this.resolved }

  /** Connects the startup GitHub Source before any Session exists; failure fails the start. */
  async start(instance: { enabled: boolean; config: Record<string, unknown> } | undefined, blockedCommands: readonly string[]): Promise<void> {
    if (!instance?.enabled) { this.host.context().report('github', health('paused', 'sourceOff')); return }
    const deployment = await this.verify(instance.config)
    await this.prepare(deployment, blockedCommands)
    this.bind(deployment)
  }

  /** Starts the polling loop of the connected repository. */
  watch(): void {
    if (!this.resolved || this.watching) return
    const stop = new AbortController()
    const source = this.host.context()
    const done = watch(source, stop.signal).catch((error: unknown) => { source.report('github', { state: 'error', detail: String(error) }) })
    this.watching = { stop, done }
  }

  /** Stops the polling loop and waits for its round in flight to end. */
  async stop(): Promise<void> {
    const watching = this.watching
    this.watching = undefined
    watching?.stop.abort()
    await watching?.done
  }

  /** Puts back the process environment the worker environment replaced. */
  restore(): void {
    this.restoreEnvironment?.()
    this.restoreEnvironment = undefined
  }

  view() {
    const stored = githubKind.schema.safeParse(this.host.store.settings().sources[SOURCE]?.config ?? {})
    return { enabled: this.resolved !== undefined, config: stored.success ? stored.data : githubKind.schema.parse({}),
      connection: this.resolved ? { repository: this.resolved.repository, account: this.resolved.github.login } : null,
      health: this.host.health() ?? null }
  }

  /** Verifies and applies a panel connection, one at a time, and saves it once it holds. */
  async update(value: unknown) {
    const instance = GithubUpdateSchema.parse(value)
    const applied = this.switching.then(() => this.switch(instance))
    this.switching = applied.catch(() => {})
    return applied
  }

  private async switch(instance: z.infer<typeof GithubUpdateSchema>) {
    if (this.host.closing()) throw new Error('neo-agent is stopping')
    const { store } = this.host
    const previous = this.resolved
    const deployment = instance.enabled ? await this.verify(instance.config) : undefined
    // A round in flight reads the account and repository it started with.
    await this.stop()
    try { if (deployment) await this.prepare(deployment, store.settings().executor.blockedCommands) }
    catch (error) { this.watch(); throw error }
    if (deployment) this.bind(deployment); else this.resolved = undefined
    const current = store.settings()
    const settings: Settings = { ...current, sources: { ...current.sources, [SOURCE]: instance } }
    store.saveSettings(settings, { source: 'panel', block: `source:${SOURCE}`, policyVersion: policyVersion(settings), policyChanged: false, notified: [] })
    if (deployment) this.watch(); else this.host.context().report('github', health('paused', 'sourceOff'))
    const [before, after] = [previous, deployment].map(value => JSON.stringify(value ? [value.repositoryId, value.repository, value.github] : null))
    if (before !== after) await this.host.changed()
    return this.view()
  }

  private async verify(config: unknown): Promise<Deployment> {
    const { machine, store, lifetime } = this.host
    const deployment = await resolveDeployment(machine, config, workerProbe(machine.stateDir, machine.stateDir, lifetime))
    const bound = store.get(KV.github.repository)
    // Stored Threads are keyed by Issue and PR number alone, so they would be read as the other repository's.
    if (bound && bound.id !== deployment.repositoryId && store.threads.list().some(thread => thread.ref.source === SOURCE)) {
      throw new SetupError('repositoryChanged', { bound: bound.name, repository: deployment.repository })
    }
    return deployment
  }

  private async prepare(deployment: Deployment, blockedCommands: readonly string[]): Promise<void> {
    const { machine, lifetime, path } = this.host
    const applied = this.restoreEnvironment !== undefined
    try {
      await writeEnvironment(deployment, blockedCommands)
      this.restoreEnvironment ??= applyEnvironment(agentVariables(machine.stateDir), machine.stateDir, path)
      await verifyEnvironment(deployment, lifetime)
    } catch (error) {
      // The shims go back to the account that stays connected; a first connection leaves the process as it was.
      if (this.resolved) await writeEnvironment(this.resolved, blockedCommands).catch(() => {})
      else if (!applied) this.restore()
      throw error
    }
  }

  private bind(deployment: Deployment): void {
    const { store } = this.host
    const bound = store.get(KV.github.repository)
    store.atomic(() => {
      if (bound && bound.id !== deployment.repositoryId) {
        // Read cursors and CI baselines count the previous repository's Issues and PRs.
        for (const name of [KV.github.since, KV.github.retries, KV.github.branchCi]) store.delete(name)
        for (const prefix of [KV.github.cursor.prefix, KV.github.stream.prefix, KV.github.ci.prefix]) for (const name of store.keys(prefix)) store.delete(name)
      }
      store.set(KV.github.repository, { id: deployment.repositoryId, name: deployment.repository })
    })
    this.resolved = deployment
  }
}

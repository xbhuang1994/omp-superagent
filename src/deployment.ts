/** Standalone service configuration and GitHub deployment verification. */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import z from 'zod'
import { LIMITS } from './limits.ts'
import { SettingsSchema } from './policy.ts'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => z.string().regex(/^\//).describe(`${description} Absolute path.`)
/** Startup JSON is the only runtime settings source. */
export const Config = z.object({
  stateDir: absolute('Directory for the database, locks, worker shims, sessions and, by default, ticket directories.'),
  agentDir: absolute('Directory for OMP authentication, models and agent state.').optional(),
  promptMaxChars: z.number().int().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).default(100000),
  admissionContextMaxPages: z.number().int().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).default(10),
  admissionContextTimeoutMs: z.number().int().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).default(15000),
  ...SettingsSchema.shape,
}).strict()
export type DeploymentConfig = z.infer<typeof Config>
export interface Machine {
  stateDir: string
  agentDir: string
  promptMaxChars: number
  admissionContextMaxPages: number
  admissionContextTimeoutMs: number
}

export function machineOf(config: DeploymentConfig): Machine {
  const parsed = Config.parse(config)
  return { stateDir: parsed.stateDir, agentDir: parsed.agentDir ?? join(parsed.stateDir, 'omp'), promptMaxChars: parsed.promptMaxChars,
    admissionContextMaxPages: parsed.admissionContextMaxPages, admissionContextTimeoutMs: parsed.admissionContextTimeoutMs }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
}

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
export function workerProbe(stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

/** Verify the configured gh identity and push access. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(machine.stateDir)) }
  catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}'])
    .catch((error: unknown) => { throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) }) }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository: remote })
  return { ...machine, repository: access.name,
    github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

import type { GithubConnection } from '../../src/app/github-connection.ts'
import type { Deployment, Machine } from '../../src/deployment.ts'
import { githubKind } from '../../src/sources/github.ts'

export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  kernel: 'omp', stateDir: '/tmp/omp-superagent-test', agentDir: '/tmp/omp-superagent-test/omp', promptMaxChars: 100000,
  admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000, web: { enabled: false, host: '127.0.0.1', port: 0 }, ...overrides,
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets', repositoryId: 11,
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' }, ...overrides,
})
/** A panel GitHub connection that is off and takes no change. */
export const noGithub: Pick<GithubConnection, 'view' | 'update'> = {
  view: () => ({ enabled: false, config: githubKind.schema.parse({}), connection: null, health: null }),
  update: async () => { throw new Error('This fixture has no GitHub connection') },
}

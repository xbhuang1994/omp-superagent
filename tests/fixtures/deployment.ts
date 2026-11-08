import type { Deployment, Machine } from '../../src/deployment.ts'

export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/omp-superagent-test', agentDir: '/tmp/omp-superagent-test/omp', promptMaxChars: 100000,
  admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000, web: { enabled: false, host: '127.0.0.1', port: 0 }, ...overrides,
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' }, ...overrides,
})

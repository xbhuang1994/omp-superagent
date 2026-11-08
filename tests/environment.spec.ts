import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentVariables, runAsWorker, verifyDirectory, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omp-environment-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('writes only gh and blocked-command shims plus isolated git config', async () => {
  const deployment = testDeployment({ stateDir: dir, github: { cli: '/bin/true', login: 'agent', noreply: 'agent@example.com' } })
  await writeEnvironment(deployment, ['rm'])
  expect(readdirSync(workerBin(dir)).sort()).toEqual(['gh', 'rm'])
  expect(readFileSync(join(workerBin(dir), 'gh'), 'utf8')).toContain("exec '/bin/true'")
  expect(readFileSync(workerGitConfig(dir), 'utf8')).toContain('useConfigOnly = true')
  expect(readdirSync(dir)).not.toContain('lark-cli')
})
it('refuses to overwrite foreign files', async () => {
  mkdirSync(workerBin(dir), { recursive: true })
  writeFileSync(join(workerBin(dir), 'gh'), 'foreign')
  await expect(writeEnvironment(testDeployment({ stateDir: dir }), [])).rejects.toThrow('was not written by omp-superagent')
  expect(readFileSync(join(workerBin(dir), 'gh'), 'utf8')).toBe('foreign')
})
it('runs commands through execFile with argument boundaries and worker env', async () => {
  const script = join(dir, 'probe')
  writeFileSync(script, '#!/bin/sh\nprintf "%s|%s" "$1" "$OMP_SUPERAGENT_TICKET"\n'); chmodSync(script, 0o755)
  expect(await runAsWorker([script, '$(touch nope)'], dir, new AbortController().signal, { OMP_SUPERAGENT_TICKET: 't1' })).toBe('$(touch nope)|t1')
})
it('rejects repository-local credential overrides', async () => {
  const repo = join(dir, 'repo'); mkdirSync(repo)
  await runAsWorker(['git', 'init'], repo, new AbortController().signal)
  await runAsWorker(['git', 'config', 'credential.helper', 'unsafe'], repo, new AbortController().signal)
  await expect(verifyDirectory(repo, new AbortController().signal)).rejects.toThrow('credential.helper')
})
it('clears ambient GitHub and git identity variables', () => {
  const env = agentVariables(dir)
  expect(env.GH_TOKEN).toBeUndefined()
  expect(env.GIT_AUTHOR_NAME).toBeUndefined()
  expect(env.GIT_CONFIG_GLOBAL).toBe(workerGitConfig(dir))
})

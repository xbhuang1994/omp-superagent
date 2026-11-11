import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, executable, machineOf, resolveDeployment, type Probe } from '../src/deployment.ts'

let dir: string
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omp-deployment-')); const gh = join(dir, 'gh'); writeFileSync(gh, '#!/bin/sh\n'); chmodSync(gh, 0o755) })
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
describe('startup JSON', () => {
  it('requires absolute stateDir and resolves the default agentDir and limits', () => {
    const config = Config.parse(minimal())
    expect(machineOf(config)).toEqual({ stateDir: join(dir, 'state'), agentDir: join(dir, 'state', 'omp'), promptMaxChars: 100000,
      admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000, web: { enabled: true, host: '127.0.0.1', port: 3082 } })
    expect(() => Config.parse({})).toThrow('stateDir')
    expect(() => Config.parse({ stateDir: 'relative' })).toThrow()
    expect(() => Config.parse(minimal({ extra: true }))).toThrow()
    expect(machineOf(Config.parse(minimal({ agentDir: join(dir, 'agent') }))).agentDir).toBe(join(dir, 'agent'))
  })
  it('accepts startup Settings and the OMP thinking levels', () => {
    const config = Config.parse(minimal({ paused: true, eval: { model: { provider: 'fixture', model: 'test', thinkingLevel: 'minimal' } } }))
    expect(config.paused).toBe(true)
    expect(config.eval.model?.thinkingLevel).toBe('minimal')
  })
})

describe('GitHub deployment', () => {
  it('finds executable commands while excluding the worker shim directory', () => {
    const bin = join(dir, 'bin'); const file = join(bin, 'gh')
    mkdirSync(bin); writeFileSync(file, ''); chmodSync(file, 0o755)
    expect(executable('gh', bin)).toBe(file)
    expect(() => executable('gh', bin, bin)).toThrow('not an executable')
    expect(() => executable('relative/gh', bin)).toThrow('absolute path')
  })
  it('validates the account and canonical repository push access', async () => {
    const probe: Probe = async argv => argv.includes('user') ? '{"login":"agent","id":7}' : '{"id":11,"name":"acme/widgets","push":true}'
    const deployment = await resolveDeployment(machineOf(Config.parse(minimal())), { repository: 'acme/old', cli: 'gh' }, probe, dir)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', repositoryId: 11, github: { login: 'agent', noreply: '7+agent@users.noreply.github.com' } })
  })
  it('fails closed for missing accounts or read-only repositories', async () => {
    const machine = machineOf(Config.parse(minimal()))
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli: 'gh' }, async () => '{}', dir)).rejects.toThrow('account')
    const probe: Probe = async argv => argv.includes('user') ? '{"login":"agent","id":7}' : '{"id":11,"name":"acme/widgets","push":false}'
    await expect(resolveDeployment(machine, { repository: 'acme/widgets', cli: 'gh' }, probe, dir)).rejects.toThrow('cannot push')
  })
})

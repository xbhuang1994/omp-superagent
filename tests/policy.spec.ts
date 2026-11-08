import { describe, expect, it } from 'vitest'
import { RoleModelSchema, SettingsSchema, allowedSender, anyoneAllowed, assessmentOutcome, policyVersion, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { githubKind } from '../src/sources/github.ts'
import type { Thread, Trigger } from '../src/core/index.ts'

const settings = SettingsSchema.parse({ eval: { mode: 'auto' }, policy: { sources: { github: { allowed: [{ id: 'alice', name: 'Alice' }] } } } })
const sources = new SourceRegistry(() => settings)
sources.register(githubKind)
const thread = (): Thread => ({ key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: '2026-01-01T00:00:00Z',
  subscriptions: [], correlated: [], pending: [], meta: {} })
const trigger = (id = 'alice', human = true): Trigger => ({ id: `t-${id}`, source: 'github', threads: [{ source: 'github', id: '1' }],
  actor: { source: 'github', id }, human, addressed: 'mention', at: '2026-01-01T00:00:00Z', text: '@agent fix typo', meta: { kind: 'issue' } })

describe('authorization', () => {
  it('admits only whitelisted explicit senders and never bots as explicit people', () => {
    const policy = settingsPolicy(settings, sources)
    expect(allowedSender(settings, { source: 'github', id: 'alice' })?.name).toBe('Alice')
    expect(anyoneAllowed(settings)).toBe(true)
    expect(policy.gate(trigger(), thread(), [])).toMatchObject({ admissible: true, strength: 'explicit' })
    expect(policy.gate(trigger('mallory'), thread(), [])).toMatchObject({ admissible: false })
    expect(policy.gate(trigger('alice', false), thread(), [])).toMatchObject({ admissible: false })
  })
  it('requires auto mode and an enabled matched rule for inferred work', () => {
    expect(settingsPolicy(settings, sources).admitsInferred(['copy'])).toBe(true)
    expect(settingsPolicy(settings, sources).admitsInferred(['unknown'])).toBe(false)
    const observe = { ...settings, eval: { ...settings.eval, mode: 'observe' as const } }
    expect(settingsPolicy(observe, sources).admitsInferred(['copy'])).toBe(false)
  })
  it('changes policyVersion for authorization, rules and mode only', () => {
    expect(policyVersion({ ...settings, paused: true })).toBe(policyVersion(settings))
    expect(policyVersion({ ...settings, eval: { ...settings.eval, mode: 'observe' } })).not.toBe(policyVersion(settings))
    expect(policyVersion({ ...settings, policy: { ...settings.policy, sources: { github: { allowed: [], admission: {} } } } }))
      .not.toBe(policyVersion(settings))
  })
})

describe('assessment outcomes and models', () => {
  const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'asked' }
  const value = (matched: boolean) => ({ decision: 'accept' as const, direction, title: 'Fix typo', scope: 'README', reason: 'asked',
    intent_evidence: 'fix typo', worktree_name: 'fix-typo', rule_assessments: settings.policy.rules.filter(rule => rule.enabled)
      .map(rule => ({ rule_id: rule.id, matched: matched && rule.id === 'copy', reason: 'judged' })) })
  it('accepts bounded inferred work only with a matched rule', () => {
    expect(assessmentOutcome(value(true), settings, 'inferred')).toMatchObject({ kind: 'accept', name: 'fix-typo' })
    expect(assessmentOutcome(value(false), settings, 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
    expect(assessmentOutcome(value(true), settings, 'explicit')).toMatchObject({ kind: 'accept' })
  })
  it('validates exact OMP role model selectors', () => {
    expect(RoleModelSchema.parse({ provider: 'fixture', model: 'test', thinkingLevel: 'max' })).toMatchObject({ thinkingLevel: 'max' })
    expect(() => RoleModelSchema.parse({ provider: 'fixture', model: 'test', reasoningEffort: 'high' })).toThrow()
    expect(() => RoleModelSchema.parse({ provider: 'fixture', model: 'test', thinkingLevel: 'auto' })).toThrow()
  })
})

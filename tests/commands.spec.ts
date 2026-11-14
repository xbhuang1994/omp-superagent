import { describe, expect, it, vi } from 'vitest'
import z from 'zod'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { githubKind } from '../src/sources/github.ts'
import { githubChannel } from '../src/sources/github-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment = testDeployment({ github: { ...testDeployment().github, cli: '/path/agent-gh' } })
const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(githubKind)
const reply = { id: 'stable-operation', channel: githubChannel(8), text: 'Done', kind: 'reply' as const }

describe('Commands', () => {
  it('uses argv without shell evaluation and restricts API paths to the configured repository', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run').mockResolvedValue('{"number":12}')
    await value.gh(['api', 'issues/12', '-f', 'body=`whoami` $(touch x)'])
    expect(run).toHaveBeenCalledWith('/path/agent-gh', ['api', 'issues/12', '-f', 'body=`whoami` $(touch x)'])
    expect(await value.api(z.object({ number: z.number() }), 'issues/12')).toEqual({ number: 12 })
    for (const path of ['../other/repo', '/repos/x/y', 'https://api.github.com/x']) {
      await expect(value.api(z.unknown(), path)).rejects.toThrow('restricted')
    }
  })
  it('paginates and skips invalid items with a count', async () => {
    const value = commands()
    vi.spyOn(value, 'run').mockResolvedValue('[[{"id":1}],[{"id":"bad"}]]')
    const tally = { skipped: 0 }
    expect(await value.pages(z.object({ id: z.number() }), 'issues/8/comments', tally)).toEqual([{ id: 1 }])
    expect(tally).toEqual({ skipped: 1 })
  })
  it('sanitizes subprocess failures without echoing args', async () => {
    await expect(commands().run('sh', ['-c', 'exit 3', 'secret'])).rejects.toMatchObject({ message: 'sh exited with code 3', exitCode: 3 })
    const error = commandError({ stderr: JSON.stringify({ error: { code: 500, message: 'failed' } }), code: 1 })
    expect(error).toMatchObject({ message: 'failed (500)', code: 500 })
  })
})

describe('GitHub Channel', () => {
  it('reconciles an existing marker without posting a duplicate', async () => {
    const value = commands()
    vi.spyOn(value, 'pages').mockResolvedValue([{ body: '<!-- neo-agent:stable-operation -->', user: { login: 'agent-bot' } }])
    const gh = vi.spyOn(value, 'gh')
    expect(await sources.send(reply, value)).toBe('sent')
    expect(gh).not.toHaveBeenCalled()
  })
  it('posts one reply and drops deleted or locked conversations only', async () => {
    const value = commands()
    vi.spyOn(value, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(value, 'gh').mockResolvedValue({})
    expect(await sources.send(reply, value)).toBe('sent')
    expect(gh).toHaveBeenCalledWith(['api', 'repos/acme/widgets/issues/8/comments', '--method', 'POST', '-f', expect.stringContaining('Done')])
    for (const [stderr, gone] of [['gh: deleted (HTTP 410)', true], ['gh: locked (HTTP 403)', true], ['gh: Server Error (HTTP 500)', false]] as const) {
      gh.mockRejectedValueOnce(new CliError(stderr, Number(/HTTP (\d+)/.exec(stderr)?.[1])))
      if (gone) expect(await sources.send(reply, value)).toBe('gone')
      else await expect(sources.send(reply, value)).rejects.toThrow('HTTP 500')
    }
  })
  it('links Issues and review comments to their GitHub URLs', () => {
    expect(githubKind.channel!.link(githubChannel(8).address, { repository: 'acme/widgets' }).url).toBe('https://github.com/acme/widgets/issues/8')
    const review = 'https://github.com/acme/widgets/pull/8#discussion_r7'
    expect(githubKind.channel!.link(githubChannel(8, review).address, { repository: 'acme/widgets' }).url).toBe(review)
  })
})

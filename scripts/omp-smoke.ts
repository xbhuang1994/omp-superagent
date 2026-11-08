import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { startOmpOpenAIServer, writeFixtureModels, type OmpFixture } from '../tests/fixtures/omp-openai-server.ts'

const root = mkdtempSync(join(tmpdir(), 'omp-cli-smoke-'))
const stateDir = join(root, 'state'), repository = join(root, 'repository'), agentDir = join(root, 'agent')
const cli = resolve(process.argv[2] ?? 'lib/cli.js')
const children: ChildProcess[] = []
const sleep = (ms: number) => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, ms); return promise }
let output = ''
let server: OmpFixture
const textOfDiagnostic = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(part => part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '').join('') : ''
async function until(check: () => boolean, detail: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) {
      const calls = existsSync(join(root, 'gh-calls.log')) ? readFileSync(join(root, 'gh-calls.log'), 'utf8') : ''
      const matched = existsSync(join(root, 'matched-notifications')) ? 'matched' : 'unmatched'
      let domain = ''
      if (existsSync(join(stateDir, 'orchestrator.sqlite'))) {
        const db = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'), { readOnly: true })
        domain = JSON.stringify({ tickets: db.prepare('SELECT * FROM ticket').all(), effects: db.prepare('SELECT * FROM effect').all(), dispositions: db.prepare('SELECT * FROM disposition').all() })
        db.close()
      }
      const payload = existsSync(join(root, 'issue-response.log')) ? readFileSync(join(root, 'issue-response.log'), 'utf8') : ''
      const toolCalls = server.requests.flatMap(request => request.messages).filter(message => message.tool_calls?.length).slice(-3)
      const relay = server.requests.flatMap(request => request.messages).map(message => textOfDiagnostic(message.content)).filter(text => text.includes('worker_report')).at(-1) ?? ''
      throw new Error(`Timed out: ${detail}\nCLI: ${output}\nGH: ${calls}\nNotification case: ${matched}\nDomain: ${domain}\nIssue: ${payload}\nTools: ${JSON.stringify(toolCalls)}\nRelay: ${relay}`)
    }
    await sleep(25)
  }
}
function config(baseUrl: string): string {
  const path = join(root, 'config.json')
  writeFileSync(path, JSON.stringify({ stateDir, agentDir, sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: join(root, 'gh'), pollSeconds: 60 } } },
    policy: { sources: { github: { allowed: [{ id: 'alice' }] } } }, eval: { mode: 'auto', model: { provider: 'fixture', model: 'fixture' } },
    executor: { model: { provider: 'fixture', model: 'fixture' }, prepare: `git clone --quiet ${repository} "$OMP_SUPERAGENT_DIR"`, maxWorkers: 1 } }, null, 2))
  return path
}
function fakeGh(): void {
  const gh = join(root, 'gh')
  writeFileSync(gh, `#!/bin/sh
args="$*"
printf '%s\\n' "$args" >> '${join(root, 'gh-calls.log')}'
case "$args" in
  "api user") echo '{"login":"agent","id":7}' ;;
  "api repos/acme/widgets --jq"*) echo '{"name":"acme/widgets","push":true}' ;;
  "api repos/acme/widgets/notifications"*)
    touch '${join(root, 'matched-notifications')}'
    printf 'HTTP/1.1 200 OK\\nX-Poll-Interval: 60\\n\\n'
    if [ -f '${join(root, 'notified')}' ]; then echo '[]'; else touch '${join(root, 'notified')}'; echo '[{"repository":{"full_name":"acme/widgets"},"subject":{"url":"https://api.github.com/repos/acme/widgets/issues/1"}}]'; fi ;;
  "api repos/acme/widgets/issues/1/comments --paginate --slurp") echo '[[]]' ;;
  "api repos/acme/widgets/issues/1/comments?per_page=100"*' --paginate --slurp') echo '[[]]' ;;
  "api repos/acme/widgets/issues/1/comments --method POST -f body="*)
    printf '%s\\n' "$args" >> '${join(root, 'replies.log')}'
    echo '{}' ;;
  "api repos/acme/widgets/issues/1") printf '{"id":1,"number":1,"title":"README typo","state":"open","created_at":"%s","html_url":"https://github.com/acme/widgets/issues/1","body":"@agent Fix the README typo","user":{"login":"alice"},"pull_request":null}\n' "$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)" | tee -a '${join(root, 'issue-response.log')}' ;;
  *) echo '[]' ;;
esac
`, { mode: 0o755 })
  chmodSync(gh, 0o755)
}
async function start(path: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [cli, '--config', path], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stdout!.on('data', chunk => { output += chunk })
  child.stderr!.on('data', chunk => { output += chunk })
  child.on('error', error => { throw error })
  child.on('exit', (code, signal) => { if (code && !signal) throw new Error(`CLI exited ${code}: ${output}`) })
  return child
}
async function stop(child: ChildProcess, label: string): Promise<void> {
  const ended = Promise.withResolvers<void>()
  child.once('exit', (code, signal) => code === 0 && signal === null ? ended.resolve() : ended.reject(new Error(`${label}: Unexpected exit ${code}/${signal}: ${output}`)))
  child.kill('SIGINT')
  await ended.promise
}

try {
  server = await startOmpOpenAIServer()
  await writeFixtureModels(agentDir, server.baseUrl)
  fakeGh()
  mkdirSync(repository, { recursive: true })
  execFileSync('git', ['init', '--quiet', repository])
  writeFileSync(join(repository, 'README.md'), 'Hello\n')
  const first = await start(config(server.baseUrl))
  await until(() => existsSync(join(root, 'replies.log')) && readFileSync(join(root, 'replies.log'), 'utf8').includes('Fixture work completed'), 'acknowledgement and result')
  const resultFile = [...readdirSync(join(stateDir, 'work'))].map(name => join(stateDir, 'work', name, 'fixture-result.txt')).find(existsSync)
  if (!resultFile || readFileSync(resultFile, 'utf8') !== 'fixed\n') throw new Error(`Worker result file missing: ${JSON.stringify(readdirSync(join(stateDir, 'work'), { recursive: true }))}`)
  await stop(first, 'first')
  const db = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'), { readOnly: true })
  const ticket = db.prepare('SELECT value FROM ticket').get()
  db.close()
  if (!ticket || JSON.parse(String(ticket.value)).ended?.outcome !== 'completed') throw new Error('Ticket not completed')
  const sessions = readdirSync(join(stateDir, 'sessions')).filter(name => name.endsWith('.jsonl'))
  if (sessions.length < 2) throw new Error(`Expected orchestrator and worker JSONL, got ${sessions.join(', ')}`)
  const replies = readFileSync(join(root, 'replies.log'), 'utf8').split('\n').filter(line => line.includes('--method POST'))
  if (replies.length !== 2 || !replies[0]!.includes('I will fix the fixture typo') || !replies[1]!.includes('Fixture work completed')) {
    throw new Error(`Unexpected replies: ${replies.join('\n')}`)
  }
  const before = server.requests.length
  output = ''
  const second = await start(config(server.baseUrl))
  await until(() => output.includes('omp-superagent ready'), 'restart ready')
  await sleep(500)
  await stop(second, 'second')
  if (server.requests.length !== before) throw new Error('Restart repeated model work')
  await server.close()
  console.log(JSON.stringify({ ticket: 'completed', workerFile: resultFile, sessions: sessions.length, acknowledgements: 1, results: 1, restartDuplicates: 0 }))
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
}

#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf } from './deployment.ts'

const usage = 'Usage: neo-agent --config <absolute-json-path>'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--config' || !args[1]) throw new Error(usage)
  const path = args[1]
  if (!isAbsolute(path)) throw new Error(`Configuration path must be absolute: ${path}\n${usage}`)
  const config = Config.parse(JSON.parse(await readFile(path, 'utf8')))
  const runtime = new Runtime(machineOf(config), config)
  await runtime.ready
  console.error('neo-agent ready')
  if (config.web.enabled) console.error(`Web panel: ${runtime.web.url}`)
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= runtime.stop().then(() => { process.exitCode = 0 }, error => {
    console.error(error)
    process.exitCode = 1
  })
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

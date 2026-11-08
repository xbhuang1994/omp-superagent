import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  deps: { neverBundle: ['@oh-my-pi/pi-coding-agent', 'zod', 'proper-lockfile'] },
})

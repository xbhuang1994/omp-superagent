import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const textFile = (id: string) => /\.(?:md|html|sh|sql|txt|py|applescript)(?:\?|$)/.test(id)
export default defineConfig({
  resolve: { alias: { zod: resolve(process.cwd(), 'node_modules/zod/index.js') } },
  plugins: [{
    name: 'omp-bun-compat',
    resolveId: (source, importer) => textFile(source) && importer ? resolve(dirname(importer), source) : undefined,
    transform: (code, id) => id.includes('node_modules/@oh-my-pi/') && code.includes('import.meta.dir')
      ? `import { dirname as __ompDirname } from 'node:path'; import { fileURLToPath as __ompFileURLToPath } from 'node:url';\n${code.replaceAll('import.meta.dir', '__ompDirname(__ompFileURLToPath(import.meta.url))')}` : undefined,
    load: id => {
      const path = id.split('?')[0]!
      return id.includes('node_modules/@oh-my-pi/') && textFile(id) ? `export default ${JSON.stringify(readFileSync(path, 'utf8'))}` : undefined
    },
  }],
  test: { include: ['tests/**/*.spec.ts'] },
})

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

const nodeCommon = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
  external: ['electron'],
}

await build({ ...nodeCommon, entryPoints: ['src/server/cli.ts'], outfile: 'dist/server/cli.js' })
await build({ ...nodeCommon, entryPoints: ['electron/main.ts'], outfile: 'dist/electron/main.js' })
await build({ ...nodeCommon, entryPoints: ['electron/preload.ts'], outfile: 'dist/electron/preload.js' })
await build({
  entryPoints: ['web/app.ts'],
  outfile: 'web/app.js',
  bundle: true,
  format: 'iife',
  target: 'chrome130',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
})

const r = spawnSync('npx', ['tsc', '--noEmit'], { stdio: 'inherit', shell: true })
process.exit(r.status ?? 1)

// 测试入口：用 esbuild 把 tests/*.test.ts 打成单文件后交给 node 内置 test runner
// （项目零测试框架依赖，esbuild 本就是 devDependency，不额外引包）
// tests/*.test.mjs（如 floating-geometry.test.mjs，依赖 npm run build 产出的 dist/）由 node 直接运行
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.tmp-test')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const testsDir = join(root, 'tests')
const names = readdirSync(testsDir)
const tsTests = names.filter(f => f.endsWith('.test.ts'))
const mjsTests = names.filter(f => f.endsWith('.test.mjs'))

for (const f of tsTests) {
  await build({
    entryPoints: [join(testsDir, f)],
    outfile: join(outDir, f.replace(/\.ts$/, '.cjs')),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  })
}

// theme.test.ts 按仓库相对路径读文件，bundle 后用环境变量传递仓库根目录
let failed = false
for (const f of readdirSync(outDir).filter(f => f.endsWith('.cjs'))) {
  const p = spawnSync(process.execPath, [join(outDir, f)], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, TOKENUSE_REPO_ROOT: root },
  })
  if (p.status !== 0) failed = true
}

for (const f of mjsTests) {
  const p = spawnSync(process.execPath, [join(testsDir, f)], { stdio: 'inherit', cwd: root })
  if (p.status !== 0) failed = true
}

rmSync(outDir, { recursive: true, force: true })
process.exit(failed ? 1 : 0)

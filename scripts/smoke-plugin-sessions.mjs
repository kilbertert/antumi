import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(path.join(root, 'packages/desktop/package.json'))
const directory = await mkdtemp(path.join(os.tmpdir(), 'antumi-plugin-sessions-'))
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
  const script = path.join(directory, 'main.cjs')
  await build({
    entryPoints: [path.join(root, 'packages/desktop/src/main/browser/plugin-sessions-smoke.ts')], outfile: script,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'],
    plugins: [{ name: 'native-package-paths', setup(build) {
      build.onResolve({ filter: /^(playwright-core|ws)$/ }, (args) => ({ path: require.resolve(args.path), external: true }))
    } }]
  })
  await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [script], { env: { ...process.env, ANTUMI_PLUGIN_SMOKE_HOME: directory }, stdio: 'inherit' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron plugin session smoke timed out')) }, 60_000)
    child.on('error', reject)
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Electron smoke exited ${code}`)) })
  })
} finally {
  await rm(directory, { recursive: true, force: true })
}

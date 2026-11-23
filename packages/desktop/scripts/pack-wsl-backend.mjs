// Packs out/backend, bundled for Linux, into the archive a Windows app installs into a WSL distro
// (docs/WSL.md): build/wsl/backend-linux-x64.tar.gz and, beside it, what the app checks it against.
// Runs on Linux after `bundle-backend.mjs --platform linux --wsl`, on the oldest glibc worth supporting:
// node-pty compiled against a newer one does not load in a distro with an older.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const backend = path.join(desktop, 'out', 'backend')
const out = path.join(desktop, 'build', 'wsl')
const archive = path.join(out, 'backend-linux-x64.tar.gz')

if (!existsSync(path.join(backend, 'node_modules/node-pty/build/Release/pty.node'))) {
  throw new Error('[pack-wsl-backend] out/backend holds no Linux node-pty: run bundle-backend.mjs --platform linux --wsl first, on Linux')
}
if (!existsSync(path.join(backend, 'backend-control.mjs'))) throw new Error('[pack-wsl-backend] out/backend was bundled without --wsl')
if (process.arch !== 'x64') throw new Error(`[pack-wsl-backend] the archive is for x64, this machine is ${process.arch}`)

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
execFileSync('tar', ['-czf', archive, '-C', backend, '.'], { stdio: 'inherit' })

const bytes = readFileSync(archive)
const { version } = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'))
const manifest = { file: path.basename(archive), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, version }
writeFileSync(path.join(out, 'backend-linux-x64.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[pack-wsl-backend] ${manifest.file} ${(manifest.size / 1024 / 1024).toFixed(1)}MB ${manifest.sha256}`)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codebuddyInstallation, detectCodebuddy } from './codebuddy-cli'
import { codebuddy } from './codebuddy-adapter'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'antumi-codebuddy-cli-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const executable = (body: string) => writeFileSync(path.join(root, 'codebuddy'), `#!${process.execPath}\n${body}`, { mode: 0o755 })

describe('CodeBuddy Code CLI', () => {
  it.skipIf(process.platform === 'win32')('tells a missing, an unresponsive and a working executable apart without claiming a sign-in', async () => {
    expect(await detectCodebuddy(root, process.platform)).toMatchObject({ status: 'missing', path: null })
    executable('process.exit(1)')
    expect(await detectCodebuddy(root, process.platform)).toMatchObject({ status: 'unknown', problem: 'probe-failed' })
    executable("console.log('2.185.0')")
    expect(await detectCodebuddy(root, process.platform)).toEqual({ status: 'ok', version: '2.185.0', path: path.join(root, 'codebuddy'), signedIn: null })
  })

  it('offers the official npm package, starts ACP with the other folders on its command line and finds its user skills', () => {
    expect(codebuddyInstallation('win32')).toMatchObject({ shell: 'powershell', command: 'npm install -g @tencent-ai/codebuddy-code' })
    expect(codebuddyInstallation('darwin').shell).toBe('bash')
    expect(codebuddy.command({ providerSessionId: null, resume: false, handoffPath: null, extraProjects: [] })).toEqual({ command: 'codebuddy', args: ['--acp'] })
    expect(codebuddy.globalSkillDirs?.({ CODEBUDDY_CONFIG_DIR: '/cb' })).toEqual([path.join('/cb', 'skills')])
    expect(codebuddy.globalSkillDirs?.({})).toEqual([path.join(os.homedir(), '.codebuddy', 'skills')])
    expect(codebuddy.command({ providerSessionId: null, resume: false, handoffPath: null, extraProjects: ['/other'], references: ['/refs', '/other'], knowledgeBase: { path: '/vault', write: false } }))
      .toEqual({ command: 'codebuddy', args: ['--acp', '--add-dir', '/other', '--add-dir', '/refs', '--add-dir', '/vault'] })
  })
})

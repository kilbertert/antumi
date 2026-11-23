import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentCliInstallation, ChatCatalog } from '@antumi/protocol'
import { launchFile } from '@antumi/protocol/node'
import { findOnPath, parseVersion } from '../../environment-check'
import { probeChatCatalog } from '../../chat-catalog'
import { Rejection } from '../../rejection'
import type { AgentDetection } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { codebuddyDialect } from './codebuddy-dialect'

const execute = promisify(execFile)

async function codebuddyVersion(command: string): Promise<string | null> {
  const launch = launchFile(command, ['--version'], process.env)
  const result = await execute(launch.file, launch.args, { env: launch.env, timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }).catch(() => null)
  return parseVersion(result?.stdout ?? '')
}

// Whether it is signed in is not read: the sign-in sits in its own encrypted store.
export async function detectCodebuddy(pathEnv: string, platform: NodeJS.Platform): Promise<AgentDetection> {
  const path = await findOnPath('codebuddy', pathEnv, platform)
  if (!path) return { status: 'missing', version: null, path: null, signedIn: null }
  const version = await codebuddyVersion(path)
  return version ? { status: 'ok', version, path, signedIn: null } : { status: 'unknown', version: null, path, signedIn: null, problem: 'probe-failed' }
}

export async function requireCodebuddy(): Promise<string> {
  const command = await findOnPath('codebuddy', process.env.PATH ?? '', process.platform)
  if (!command) throw new Rejection('codebuddy-cli-missing', '未找到 CodeBuddy Code，请安装后重新检测')
  return command
}

export async function codebuddyCatalog(cwd: string): Promise<ChatCatalog | null> {
  return probeChatCatalog(new AcpDriver(codebuddyDialect, 'catalog', { cwd, extraDirs: [], resume: null }), { command: await requireCodebuddy(), args: ['--acp'] }, cwd)
}

export function codebuddyInstallation(platform: NodeJS.Platform): AgentCliInstallation {
  return { agent: 'codebuddy', shell: platform === 'win32' ? 'powershell' : 'bash', command: 'npm install -g @tencent-ai/codebuddy-code' }
}

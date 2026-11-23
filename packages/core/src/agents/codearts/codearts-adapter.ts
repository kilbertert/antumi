import os from 'node:os'
import path from 'node:path'
import { Rejection } from '../../rejection'
import type { AgentAdapter } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { mcpReadyWithin } from '../mcp-ready-file'
import { codeartsBridgeCommand } from '../../codearts-bridge-command'
import { codeartsCatalog, codeartsEnv, codeartsInstallation, detectCodearts, codeartsInstallers, requireCodearts } from './codearts-cli'
import { codeartsConfig } from './codearts-config'
import { codeartsDialect } from './codearts-dialect'
import { codeartsPluginReadyFile, writeCodeartsPlugin } from './codearts-permissions'

// It loads its plugins as its server opens the session's folder, before it answers session/new.
const PLUGIN_WAIT_MS = 10_000

export const codearts: AgentAdapter = {
  kind: 'codearts',
  globalSkillDirs: () => [path.join(os.homedir(), '.codeartsdoer', 'skills')],
  // Its installer's own folder, which `codearts upgrade` replaces.
  maintenance: { native: { roots: { darwin: [codeartsInstallers()], linux: [codeartsInstallers()], win32: [codeartsInstallers()] }, args: ['upgrade'] } },
  createDriver: (stageId, options) => new AcpDriver(codeartsDialect, stageId, options),
  // Antumi's bridge to its local server (codearts-bridge-main.ts), with what its launcher would set
  // and the config naming Antumi's agents. The launch adds the executable it finds, and the config
  // again with the plugin it writes.
  command: (launch) => {
    const bridge = codeartsBridgeCommand()
    return { command: bridge.command, args: bridge.args, env: { ...codeartsEnv(), ...bridge.env, OPENCODE_CONFIG_CONTENT: codeartsConfig(launch) } }
  },
  permissionModes: Object.keys(codeartsDialect.modes),
  fallbackMode: 'ask',
  // A session belongs to its folder. Its ACP forks a session whole (session/fork).
  session: { preassignedId: false, folderBound: true, nativeFork: 'latest' },
  // It starts a server of its own and signs in to Huawei Cloud before it answers.
  startTimeoutMs: 60_000,
  // Its agents allow every tool, Antumi's terminal tools among them, so Antumi asks in the chat.
  mcpApproval: 'antumi',
  catalog: codeartsCatalog,
  detect: detectCodearts,
  installation: codeartsInstallation,
  installWithoutApplication: true,
  launch: {
    mcp: (server) => server,
    prepare: async (stage, _mcp, launch) => {
      const executable = await requireCodearts()
      const plugin = await writeCodeartsPlugin(stage, launch)
      return { args: ['--codearts', executable], env: { OPENCODE_CONFIG_CONTENT: codeartsConfig(launch, plugin) } }
    },
    // Without its plugin, Antumi's modes would be names only: the start fails rather than run so.
    ready: async (stage) => {
      if (!await mcpReadyWithin(codeartsPluginReadyFile(stage), PLUGIN_WAIT_MS)) throw new Rejection('codearts-plugin-unavailable', 'CodeArts 未能加载 Antumi 的权限插件，请升级码道 CLI 后重试')
    }
  },
  turns: {
    serialized: true,
    stopAfterCancel: { cancelGraceMs: 3000, termGraceMs: 2000 },
    retryByRestart: true,
    // Like OpenCode, it ends the turn on a rejected request: the user's reason reaches it as the next message.
    denialAsMessage: true
  },
  optionsFromState: true,
  discovery: { commands: ['codearts'], applications: {} }
}

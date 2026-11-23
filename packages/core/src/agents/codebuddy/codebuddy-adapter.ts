import path from 'node:path'
import type { AgentAdapter } from '../agent-adapter'
import { AcpDriver } from '../acp/acp-driver'
import { codebuddyDialect } from './codebuddy-dialect'
import { codebuddyCatalog, codebuddyInstallation, detectCodebuddy, requireCodebuddy } from './codebuddy-cli'
import { codebuddyHome, codebuddyTranscripts } from './codebuddy-transcripts'
import { codebuddyAccounts, codebuddySignedIn } from './codebuddy-account'

export const codebuddy: AgentAdapter = {
  kind: 'codebuddy',
  // Its user skills live in its config folder, which CODEBUDDY_CONFIG_DIR moves.
  globalSkillDirs: (env) => [path.join(codebuddyHome(env), 'skills')],
  transcripts: codebuddyTranscripts(),
  maintenance: { packageName: '@tencent-ai/codebuddy-code' },
  createDriver: (stageId, options) => new AcpDriver(codebuddyDialect, stageId, options),
  // Its ACP takes no additional directories in session/new, so the other folders go on its command line.
  command: (launch) => ({
    command: 'codebuddy',
    args: ['--acp', ...[...new Set([...launch.extraProjects, ...(launch.references ?? []), ...(launch.knowledgeBase ? [launch.knowledgeBase.path] : [])])].flatMap((dir) => ['--add-dir', dir])],
    ...(launch.account ? { env: launch.account.env } : {})
  }),
  permissionModes: Object.keys(codebuddyDialect.modes),
  fallbackMode: 'ask',
  // It offers no fork over ACP.
  session: { preassignedId: false, folderBound: true, nativeFork: 'none' },
  startTimeoutMs: 60_000,
  // Auto and Bypass approve MCP calls themselves; Antumi keeps its terminal approval policy.
  mcpApproval: 'antumi',
  catalog: codebuddyCatalog,
  detect: detectCodebuddy,
  // Only the user's own account signs in in a terminal: the others are API keys, which core reads.
  signedIn: async (home) => home === undefined ? codebuddySignedIn() : null,
  accounts: codebuddyAccounts,
  installation: codebuddyInstallation,
  installWithoutApplication: true,
  launch: {
    mcp: (server) => server,
    prepare: async () => ({ command: await requireCodebuddy() }),
    ready: async () => {}
  },
  turns: { serialized: true, stopAfterCancel: { cancelGraceMs: 3000, termGraceMs: 2000 }, retryByRestart: true, denialAsMessage: true },
  optionsFromState: true,
  discovery: { commands: ['codebuddy', 'cbc'], applications: {} }
}

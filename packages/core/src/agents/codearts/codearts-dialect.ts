import { RESERVED_MCP_SERVER_NAME } from '@antumi/protocol'
import type { AcpDialect } from '../acp/acp-dialect'
import { CODEARTS_AGENTS } from './codearts-permissions'

const MCP_PREFIX = `${RESERVED_MCP_SERVER_NAME}_`
// Its tools whose ACP kind already names them (execute, edit, read, search, fetch).
const BUILT_IN_BY_KIND: ReadonlySet<string> = new Set(['bash', 'edit', 'write', 'patch', 'apply_patch', 'read', 'list', 'grep', 'glob', 'webfetch'])
const TOOL_ID = /^[A-Za-z][\w-]*$/

// CodeArts as Antumi's bridge to its local server tells it (codearts-bridge.ts), in the ACP its own
// disabled ACP server spoke: its modes are its primary agents, a tool call is titled with the tool's
// name, and a permission request with the permission's. It takes no additional directories, so the
// start names them.
export const codeartsDialect: AcpDialect = {
  name: 'CodeArts',
  idPrefix: 'codearts',
  modes: { ask: 'build', acceptEdits: CODEARTS_AGENTS.auto, plan: CODEARTS_AGENTS.plan, readOnly: CODEARTS_AGENTS.readOnly, bypass: CODEARTS_AGENTS.bypass },
  // An MCP tool is <server>_<tool>; Antumi knows its own as antumi.<tool>, as Codex and Cursor name
  // them. Its built-in tools are left to their kind; any other keeps its own name. A finished call
  // is titled with what it did instead, which leaves the name it had.
  toolName: (_rawInput, _name, title) => {
    if (!title || !TOOL_ID.test(title) || BUILT_IN_BY_KIND.has(title)) return null
    return title.startsWith(MCP_PREFIX) ? `${RESERVED_MCP_SERVER_NAME}.${title.slice(MCP_PREFIX.length)}` : title
  },
  startNote: (options) => options.extraDirs.length ? `此会话还包含以下项目，请按绝对路径访问；命令分别指定各项目的工作目录：\n${options.extraDirs.map((dir) => `- ${dir}`).join('\n')}` : null
}

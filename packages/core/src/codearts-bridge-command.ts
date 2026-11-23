import { fileURLToPath } from 'node:url'
import type { AgentCommand } from './agent-command'

// How a stage starts the CodeArts bridge (codearts-bridge-main.ts), as mcp-command starts Antumi's
// MCP server: from source through the workspace's tsx, packaged as the codearts-bridge.mjs bundled
// beside core.mjs, run by the Electron binary as plain Node.
export function codeartsBridgeCommand(): AgentCommand {
  if (!import.meta.url.endsWith('.ts')) {
    return { command: process.execPath, args: [fileURLToPath(new URL('./codearts-bridge.mjs', import.meta.url))], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
  return { command: process.execPath, args: ['--import', loader, fileURLToPath(new URL('./codearts-bridge-main.ts', import.meta.url))] }
}

import { z } from 'zod'
import type { AcpDialect } from '../acp/acp-dialect'

const MCP_TOOL = /^mcp__(.+?)__(.+)$/
// Its plan review is the ExitPlanMode call's permission request; the plan is the file it wrote.
// A subagent runs inside the session: its words and calls name the Agent call it runs for.
const SubagentStep = z.looseObject({ _meta: z.looseObject({ 'codebuddy.ai/parentToolCallId': z.string() }) })
const PlanReview = z.looseObject({ toolCall: z.looseObject({ _meta: z.looseObject({ 'codebuddy.ai/toolName': z.literal('ExitPlanMode'), 'codebuddy.ai/planFilePath': z.string().optional() }) }) })

// CodeBuddy Code's ACP (`codebuddy --acp`): Claude Code's modes and tools under its own ACP
// server. A call's first update is titled with the bare tool name, a later one with what it does.
export const codebuddyDialect: AcpDialect = {
  name: 'CodeBuddy',
  idPrefix: 'codebuddy',
  modes: { ask: 'default', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', bypass: 'bypassPermissions' },
  toolName: (_input, _name, title) => {
    const mcp = title?.match(MCP_TOOL)
    // Antumi knows an MCP tool as <server>.<tool>, as it does Codex's and Cursor's.
    if (mcp) return `${mcp[1]}.${mcp[2]}`
    if (title === 'Agent') return 'Task'
    if (title === 'ExitPlanMode') return title
    return null
  },
  permissionPrompt: (request) => {
    const path = PlanReview.safeParse(request).data?.toolCall._meta['codebuddy.ai/planFilePath']
    return path ? { kind: 'plan', path, runMode: 'ask' } : null
  },
  subagentOf: (update) => SubagentStep.safeParse(update).data?._meta['codebuddy.ai/parentToolCallId'] ?? null,
  planApprovalSetsMode: true,
  // Its ACP transport (the SDK's 1.7.0) caps a line at 32 MiB and then reads nothing more.
  maxLineBytes: 32 * 1024 * 1024
}

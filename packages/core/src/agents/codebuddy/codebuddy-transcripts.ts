import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clip } from '../../chat-items'
import { fileTranscriptSource, type FileTranscriptParser } from '../../file-transcript-source'
import { TranscriptBuilder, transcriptImages } from '../../transcript-builder'
import { array, json, object, string, timestamp } from '../../transcript-values'
import { COMMAND_TOOLS, describeClaudeTool, HIDDEN_TOOLS, inputDiffs, inputText } from '../claude/claude-stream'

export const codebuddyHome = (env: NodeJS.ProcessEnv = process.env, home = os.homedir()) => env.CODEBUDDY_CONFIG_DIR?.trim() || path.join(home, '.codebuddy')

// CodeBuddy keeps each session in projects/<its folder, dashed>/<session id>.jsonl, Claude Code's
// layout, but each line is an OpenAI Agents SDK item: a message with input_text or output_text
// parts, reasoning, a function_call and its function_call_result; and records of its own (titles,
// snapshots, session metadata). A subagent's steps go to <session id>/subagents/, which the scan
// leaves out.
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
const COMMAND = /^\s*<command-(?:message|name)>/
const COMMAND_NAME = /<command-name>\/?([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
// The note it adds after each image of a prompt, naming where it saved the file.
const IMAGE_PATH_NOTE = /^\s*<image_local_path>[\s\S]*<\/image_local_path>\s*$/
// What its titler writes when there was nothing to name.
const PLACEHOLDER_TITLE = /^(\(No content\)|\/compact)$/
const BLOB_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff' }

// What the user typed: a prompt command as its invocation, not the prompt it expands to.
function promptText(content: unknown): string {
  const text = array(content).map(object).filter((part) => part.type === 'input_text' && !IMAGE_PATH_NOTE.test(string(part.text))).map((part) => string(part.text)).join('')
  if (!COMMAND.test(text)) return text
  const name = COMMAND_NAME.exec(text)?.[1]?.trim()
  return name ? `/${name} ${COMMAND_ARGS.exec(text)?.[1]?.trim() ?? ''}`.trim() : text
}

// A prompt's images, from its blob store under the checks its own reader makes: the id is the
// file's SHA-256, and the record never names the file. One that fails stays a notice.
async function promptImages(content: unknown, blobs: string): Promise<unknown[]> {
  return Promise.all(array(content).map(object).filter((part) => part.type === 'image_blob_ref').map(async (part) => {
    const id = string(part.blob_id)
    const extension = BLOB_EXTENSIONS[string(part.mime)]
    if (!/^[0-9a-f]{64}$/.test(id) || !extension) return { type: 'image' }
    const bytes = await readFile(path.join(blobs, id.slice(0, 2), `${id}.${extension}`)).catch(() => null)
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== id) return { type: 'image' }
    return { type: 'image', data: bytes.toString('base64') }
  }))
}

// A call by the tool it runs: an MCP tool behind DeferExecuteTool, a subagent as Antumi's Task.
function call(name: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  if (name === 'DeferExecuteTool' && string(args.toolName)) return call(string(args.toolName), object(args.params))
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return { name: `${mcp[1]}.${mcp[2]}`, input: args }
  return { name: name === 'Agent' ? 'Task' : name, input: args }
}

export function codebuddyTranscripts(home: () => string = () => codebuddyHome()) {
  const parse: FileTranscriptParser = async (lines, file, modifiedAt, attachments) => {
    const sessionId = path.basename(file, '.jsonl')
    const builder = new TranscriptBuilder()
    const titles: Record<string, string> = {}
    let cwd = ''
    let startedAt: number | null = null
    for (const [position, line] of lines.entries()) {
      const row = object(json(line))
      const type = string(row.type)
      const at = timestamp(row.timestamp, modifiedAt)
      if (type === 'custom-title' || type === 'ai-title' || type === 'topic') {
        const title = string(row[type === 'custom-title' ? 'customTitle' : type === 'ai-title' ? 'aiTitle' : 'topic']).trim()
        if (title && (type === 'custom-title' || !PLACEHOLDER_TITLE.test(title))) titles[type] = title
        continue
      }
      if (!['message', 'reasoning', 'function_call', 'function_call_result'].includes(type)) continue
      cwd ||= string(row.cwd)
      startedAt ??= at
      const id = string(row.id) || `${type}:${position}`
      if (type === 'message' && row.role === 'user') {
        // What it put in the user's place: a background task's report, a reminder.
        if (object(row.providerData).isMeta === true) continue
        builder.user(id, promptText(row.content), at, await transcriptImages(await promptImages(row.content, path.join(home(), 'blobs')), cwd, attachments, builder, at))
      } else if (type === 'message' && row.role === 'assistant') {
        builder.assistant(id, array(row.content).map(object).filter((part) => part.type === 'output_text').map((part) => string(part.text)).join(''), at)
      } else if (type === 'reasoning') {
        const parts = array(row.rawContent).length ? row.rawContent : row.content
        builder.assistant(id, array(parts).map((part) => string(object(part).text)).join(''), at, true)
      } else if (type === 'function_call') {
        const { name, input } = call(string(row.name), object(json(row.arguments)))
        if (HIDDEN_TOOLS.has(name)) continue
        const callId = string(row.callId) || id
        builder.tool(callId, name, input, null, at, 'pending')
        const description = COMMAND_TOOLS.has(name) ? string(input.description).trim() || null : null
        const entry = builder.transcript.entries.find((each) => each.item.id === `t:${callId}`)
        if (entry?.item.kind === 'tool') builder.put({ ...entry, item: { ...entry.item, title: clip(describeClaudeTool(name, input) || name, 200), description, input: inputText(name, input), diffs: inputDiffs(name, input) } })
      } else if (type === 'function_call_result') {
        const output = object(row.output)
        const error = object(object(row.providerData).toolResult).error
        const text = string(output.text) || string(row.output)
        builder.result(string(row.callId), text, at, Boolean(error) || /fail|error/i.test(string(row.status)) || text.startsWith('Error:'))
      }
    }
    if (!cwd) return null
    const title = titles['custom-title'] ?? titles['ai-title'] ?? titles.topic
    return { sessionId, cwd, ...(title ? { title, named: Boolean(titles['custom-title']) } : {}), startedAt: startedAt ?? modifiedAt, transcript: builder.build() }
  }
  return fileTranscriptSource(() => path.join(home(), 'projects'), (name) => SESSION_FILE.test(name), parse)
}

import type { SourceFailure, SourceProblem } from '../../protocol/src/source.js'

export class SourceError extends Error {
  constructor(readonly code: SourceFailure, message: string) {
    super(message)
    this.name = 'SourceError'
  }
}

export function sourceProblem(error: unknown): SourceProblem {
  if (error instanceof SourceError) return { code: error.code, message: error.message }
  // Validation and transport errors may contain credentials or upstream response bodies, so the
  // message never travels. The class name does not carry either, and without it every fault read
  // as the same sentence: a schema mismatch and a bug were indistinguishable from the outside.
  // A ZodError is the one case worth naming precisely — its issues say which field, and zod never
  // puts input values in them.
  const name = error instanceof Error ? error.constructor.name : typeof error
  const issues = error instanceof Error && error.name === 'ZodError' && Array.isArray((error as unknown as { issues?: unknown[] }).issues)
    ? ` ${JSON.stringify((error as unknown as { issues: unknown[] }).issues).slice(0, 300)}`
    : ''
  console.error(`[plugin] ${name}${issues}`)
  return { code: 'request-failed', message: `插件请求失败（${name}${issues}）` }
}

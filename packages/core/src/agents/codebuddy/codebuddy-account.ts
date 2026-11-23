import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { linkShared, type SharedEntry } from '../../agent-account-home'
import type { AccountSupport } from '../agent-adapter'
import { codebuddyHome } from './codebuddy-transcripts'

// Its sign-in is not in its config folder but one for the whole machine, in its data folder: so
// the accounts added beside the user's own are API keys, each in a config folder of its own.
export function codebuddyAuthDir(platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  const data = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? path.join(home, 'AppData', 'Local')
      : path.join(home, '.local', 'share')
  return path.join(data, 'CodeBuddyExtension', 'Data', 'Public', 'auth')
}

// Signed in: a <hash>.info file, with no <hash>.info.logged-out beside it. A signed-out one is
// renamed with a timestamp, so it no longer reads <hash>.info.
export async function codebuddySignedIn(dir = codebuddyAuthDir()): Promise<boolean> {
  const names = await readdir(dir).catch((): string[] => [])
  return names.some((name) => /^[^.]+\.info$/.test(name) && !names.includes(`${name}.logged-out`))
}

// What is the user's rather than the account's: the sessions, so one switched to another account
// resumes there, and their skills, agents, commands, MCP servers and custom models. Its settings
// may name an edition and its local storage caches the last one, so neither is shared.
const SHARED: readonly SharedEntry[] = [
  { name: 'projects', create: 'dir' }, { name: 'skills' }, { name: 'agents' }, { name: 'commands' }, { name: 'plugins' }, { name: '.mcp.json' }, { name: 'models.json' }
]

const EDITION_ENV: Record<string, string> = { international: '', china: 'internal', ioa: 'ioa' }

export const codebuddyAccounts: AccountSupport = {
  env: (home) => ({ CODEBUDDY_CONFIG_DIR: home }),
  prepare: (home) => linkShared(home, codebuddyHome(), SHARED),
  identity: async () => ({ email: null }),
  // The user's own account signs in where its CLI starts, picking the site there.
  login: [],
  logout: [],
  signInFolder: true,
  // Set even when empty: a variable the user's shell left would otherwise pick the edition.
  keys: (apiKey, edition) => ({ CODEBUDDY_API_KEY: apiKey, CODEBUDDY_INTERNET_ENVIRONMENT: EDITION_ENV[edition] ?? '' })
}

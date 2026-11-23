import { z } from 'zod'

// Where the app's backend (daemon and core) runs: on this machine, inside a WSL distro, or on a
// remote host over ssh (docs/WSL.md, docs/REMOTE-CORE.md), with the app as its client. Chosen in
// Settings, kept by main, applied at the next start.
export const BackendLocation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({ kind: z.literal('wsl'), distro: z.string().min(1).max(200) }),
  // The ssh target and port live in remote.json, which the operator owns; the choice only names it.
  z.object({ kind: z.literal('remote') })
])
export type BackendLocation = z.infer<typeof BackendLocation>

// Why a backend in WSL did not start, for the renderer to say what to do about it.
export const WslBackendProblem = z.discriminatedUnion('kind', [
  // No wsl.exe, so no WSL on this machine.
  z.object({ kind: z.literal('wsl-unavailable') }),
  // wsl.exe would not say: nothing is known, least of all that the distro is gone.
  z.object({ kind: z.literal('wsl-unknown'), detail: z.string() }),
  z.object({ kind: z.literal('distro-missing'), distro: z.string() }),
  z.object({ kind: z.literal('distro-wsl1'), distro: z.string() }),
  z.object({ kind: z.literal('arch'), arch: z.string() }),
  z.object({ kind: z.literal('login-environment') }),
  z.object({ kind: z.literal('node-missing') }),
  z.object({ kind: z.literal('node-old'), version: z.string(), path: z.string() }),
  z.object({ kind: z.literal('install'), detail: z.string() }),
  // node-pty does not load there: a libc older than the one it was compiled against, mostly.
  z.object({ kind: z.literal('pty'), detail: z.string() }),
  z.object({ kind: z.literal('start'), detail: z.string() })
])
export type WslBackendProblem = z.infer<typeof WslBackendProblem>

// Why a remote backend did not come up: remote.json unreadable, or the ssh link or the core
// behind it failed. There is no fallback to this machine's — the problem is the state.
export const RemoteBackendProblem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('remote-config'), detail: z.string() }),
  z.object({ kind: z.literal('remote-link'), detail: z.string() })
])
export type RemoteBackendProblem = z.infer<typeof RemoteBackendProblem>

export const BackendProblem = z.union([WslBackendProblem, RemoteBackendProblem])
export type BackendProblem = z.infer<typeof BackendProblem>

export const BackendLocationState = z.object({
  // Whether this app can run its backend in WSL at all: Windows, installed, carrying the archive.
  supported: z.boolean(),
  chosen: BackendLocation,
  // Where the backend this app talks to runs now: the chosen place, or this machine when the one
  // in WSL did not start. A remote that did not come up still reads remote, with problem set.
  running: z.enum(['local', 'wsl', 'remote']),
  // The distros to choose from; null when wsl.exe would not say.
  distros: z.array(z.object({ name: z.string(), version: z.union([z.literal(1), z.literal(2)]), isDefault: z.boolean() })).nullable(),
  // remote.json as a choice: the ssh host once it parses, the file's problem when it does not,
  // null when the file is not there at all and remote is not a choice to offer.
  remote: z.object({ host: z.string().nullable(), error: z.string().nullable() }).nullable(),
  problem: BackendProblem.nullable()
})
export type BackendLocationState = z.infer<typeof BackendLocationState>

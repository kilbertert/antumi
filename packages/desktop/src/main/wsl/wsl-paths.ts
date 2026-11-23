import path from 'node:path'

// Where in which distro a `\\wsl.localhost\` or `\\wsl$\` path points.
export type WslLocation = { distro: string; linuxPath: string }

// Either slash, any case for the host; `\\?\UNC\` is the same share spelled for long paths.
const WSL_UNC = /^(?:[\\/]{2}\?[\\/]UNC[\\/]|[\\/]{2})(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/i
const DRIVE_PATH = /^(?:\\\\\?\\)?([A-Za-z]):[\\/](.*)$/
const DRIVE_MOUNT = /^\/mnt\/([a-z])(?:\/(.*))?$/i
// What Windows refuses in a file name, so a Linux path holding one has no UNC spelling we can trust.
const NOT_WINDOWS_NAME = /[\\:*?"<>|]/

const sameDistro = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// Absolute, without `.`, `..`, doubled or trailing slashes.
function cleanLinuxPath(linuxPath: string): string {
  const normal = path.posix.normalize(linuxPath)
  return normal.length > 1 ? normal.replace(/\/+$/, '') : normal
}

export function parseWslPath(windowsPath: string): WslLocation | null {
  const match = WSL_UNC.exec(windowsPath)
  if (!match?.[1]) return null
  return { distro: match[1], linuxPath: cleanLinuxPath(`/${(match[2] ?? '').replace(/\\/g, '/')}`) }
}

// How Windows reaches a Linux path; null for one that is not absolute or has no Windows spelling.
export function wslUncPath(distro: string, linuxPath: string): string | null {
  if (!linuxPath.startsWith('/')) return null
  const clean = cleanLinuxPath(linuxPath)
  if (NOT_WINDOWS_NAME.test(clean)) return null
  return `\\\\wsl.localhost\\${distro}${clean === '/' ? '\\' : clean.replace(/\//g, '\\')}`
}

// A Windows path as the backend in `distro` sees it: its own UNC paths in Linux terms, a drive
// through /mnt; null for another distro's, any other share, or a relative path.
export function linuxPathForBackend(distro: string, windowsPath: string): string | null {
  const location = parseWslPath(windowsPath)
  if (location) return sameDistro(location.distro, distro) ? location.linuxPath : null
  const drive = DRIVE_PATH.exec(windowsPath)
  if (!drive?.[1]) return null
  const rest = path.posix.normalize(`/${(drive[2] ?? '').replace(/\\/g, '/')}`)
  return cleanLinuxPath(`/mnt/${drive[1].toLowerCase()}${rest}`)
}

// A Linux path of the backend in `distro` as Windows shows or opens it: a /mnt drive as itself,
// anything else through the distro's share. Null for a relative path.
export function windowsPathForLinux(distro: string, linuxPath: string): string | null {
  if (!linuxPath.startsWith('/')) return null
  const clean = cleanLinuxPath(linuxPath)
  const drive = DRIVE_MOUNT.exec(clean)
  if (!drive?.[1]) return wslUncPath(distro, clean)
  if (drive[2] && NOT_WINDOWS_NAME.test(drive[2])) return null
  return `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}`
}

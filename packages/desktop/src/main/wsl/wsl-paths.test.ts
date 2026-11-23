import { describe, expect, it } from 'vitest'
import { linuxPathForBackend, parseWslPath, windowsPathForLinux, wslUncPath } from './wsl-paths'

describe('parseWslPath', () => {
  it('reads both share names, either slash and any case for the host', () => {
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\my project')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/me/my project' })
    expect(parseWslPath('\\\\wsl$\\Ubuntu-24.04\\home\\me')).toEqual({ distro: 'Ubuntu-24.04', linuxPath: '/home/me' })
    expect(parseWslPath('//WSL.LocalHost/Debian/srv/x')).toEqual({ distro: 'Debian', linuxPath: '/srv/x' })
    expect(parseWslPath('\\\\WSL$/Debian\\srv/x')).toEqual({ distro: 'Debian', linuxPath: '/srv/x' })
    expect(parseWslPath('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home')).toEqual({ distro: 'Ubuntu', linuxPath: '/home' })
  })

  it('reads the root, trailing and doubled separators, and dot segments', () => {
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu')).toEqual({ distro: 'Ubuntu', linuxPath: '/' })
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\')).toEqual({ distro: 'Ubuntu', linuxPath: '/' })
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\\\')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/me' })
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\\\me\\.\\a\\..\\b')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/me/b' })
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\..\\..\\etc')).toEqual({ distro: 'Ubuntu', linuxPath: '/etc' })
  })

  it('is null for anything else', () => {
    for (const other of ['C:\\Users\\me', '\\\\server\\share\\x', '\\\\wsl.localhost\\', '\\\\wsl.localhostx\\Ubuntu\\x', '/home/me', 'relative\\x', '']) {
      expect(parseWslPath(other)).toBeNull()
    }
  })
})

describe('wslUncPath', () => {
  it('spells a Linux path through the distro share', () => {
    expect(wslUncPath('Ubuntu', '/home/me/my project/a.ts')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\my project\\a.ts')
    expect(wslUncPath('Ubuntu', '/home/me/')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me')
    expect(wslUncPath('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu\\')
  })

  it('is null for a relative path or a name Windows cannot spell', () => {
    expect(wslUncPath('Ubuntu', 'home/me')).toBeNull()
    expect(wslUncPath('Ubuntu', '/home/me/12:00.log')).toBeNull()
    expect(wslUncPath('Ubuntu', '/home/me/a\\b')).toBeNull()
  })

  it('round-trips with parseWslPath', () => {
    const unc = wslUncPath('Ubuntu', '/home/me/空 格')
    expect(unc && parseWslPath(unc)).toEqual({ distro: 'Ubuntu', linuxPath: '/home/me/空 格' })
  })
})

describe('linuxPathForBackend', () => {
  it('takes its own distro share in any case, and refuses another distro', () => {
    expect(linuxPathForBackend('Ubuntu', '\\\\wsl.localhost\\ubuntu\\home\\me\\proj\\')).toBe('/home/me/proj')
    expect(linuxPathForBackend('Ubuntu', '\\\\wsl$\\Debian\\home\\me')).toBeNull()
  })

  it('sees a drive under /mnt', () => {
    expect(linuxPathForBackend('Ubuntu', 'C:\\Users\\me\\My Documents\\a.png')).toBe('/mnt/c/Users/me/My Documents/a.png')
    expect(linuxPathForBackend('Ubuntu', 'd:/work/x/')).toBe('/mnt/d/work/x')
    expect(linuxPathForBackend('Ubuntu', 'C:\\')).toBe('/mnt/c')
    expect(linuxPathForBackend('Ubuntu', 'C:\\a\\..\\..\\b')).toBe('/mnt/c/b')
    expect(linuxPathForBackend('Ubuntu', '\\\\?\\C:\\long\\path')).toBe('/mnt/c/long/path')
  })

  it('is null for other shares and relative paths', () => {
    for (const other of ['\\\\server\\share\\x', 'C:', 'C:relative', 'relative\\x', '\\rooted', '/home/me']) {
      expect(linuxPathForBackend('Ubuntu', other)).toBeNull()
    }
  })
})

describe('windowsPathForLinux', () => {
  it('shows a /mnt drive as itself', () => {
    expect(windowsPathForLinux('Ubuntu', '/mnt/c/Users/me/My Documents')).toBe('C:\\Users\\me\\My Documents')
    expect(windowsPathForLinux('Ubuntu', '/mnt/d')).toBe('D:\\')
    expect(windowsPathForLinux('Ubuntu', '/mnt/d/')).toBe('D:\\')
    expect(windowsPathForLinux('Ubuntu', '/mnt/c/x/../y')).toBe('C:\\y')
  })

  it('shows anything else through the distro share', () => {
    expect(windowsPathForLinux('Ubuntu', '/home/me/proj')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj')
    expect(windowsPathForLinux('Ubuntu', '/mnt/wsl/shared')).toBe('\\\\wsl.localhost\\Ubuntu\\mnt\\wsl\\shared')
    expect(windowsPathForLinux('Ubuntu', '/mnt')).toBe('\\\\wsl.localhost\\Ubuntu\\mnt')
    expect(windowsPathForLinux('Ubuntu', '/')).toBe('\\\\wsl.localhost\\Ubuntu\\')
  })

  it('is null for a relative path or a name Windows cannot spell', () => {
    expect(windowsPathForLinux('Ubuntu', 'proj')).toBeNull()
    expect(windowsPathForLinux('Ubuntu', '/mnt/c/a:b')).toBeNull()
  })

  it('round-trips with linuxPathForBackend', () => {
    for (const linux of ['/home/me/a b', '/mnt/c/Users/me', '/']) {
      const windows = windowsPathForLinux('Ubuntu', linux)
      expect(windows && linuxPathForBackend('Ubuntu', windows)).toBe(linux)
    }
  })
})

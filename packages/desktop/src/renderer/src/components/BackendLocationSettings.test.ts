import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StateCreator } from 'zustand'
import type { BackendLocationState, WslBackendProblem } from '../../../shared/backend-location'
import { distroNotStarted, useBackendLocation } from '../backend-location-state'
import { setLocale } from '../i18n'
import { BackendLocationNotice } from './BackendLocationNotice'
import { backendLocationOptions, BackendLocationSettings, confirmSwitch } from './BackendLocationSettings'

vi.mock('zustand', async (original) => {
  const actual = await original<typeof import('zustand')>()
  return { ...actual, create: <T>() => (initializer: StateCreator<T>) => {
    const store = actual.create(initializer)
    return Object.assign((selector: (state: T) => unknown) => selector(store.getState()), store)
  } }
})
const askConfirm = vi.hoisted(() => vi.fn(async () => false))
vi.mock('../confirm-dialog', () => ({ askConfirm }))

const DISTROS = [
  { name: 'Ubuntu', version: 2 as const, isDefault: true },
  { name: 'Legacy', version: 1 as const, isDefault: false }
]
const LOCAL: BackendLocationState = { supported: true, chosen: { kind: 'local' }, running: 'local', distros: DISTROS, remote: null, problem: null }
const failed = (problem: WslBackendProblem): BackendLocationState => ({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Ubuntu' }, problem })
const settings = (state: BackendLocationState | null) => {
  useBackendLocation.setState({ state })
  return renderToStaticMarkup(createElement(BackendLocationSettings))
}
const notice = (state: BackendLocationState | null) => {
  useBackendLocation.setState({ state })
  return renderToStaticMarkup(createElement(BackendLocationNotice))
}

beforeEach(() => useBackendLocation.setState(useBackendLocation.getInitialState(), true))
afterEach(() => setLocale('zh-CN'))

describe('backend location settings', () => {
  it('shows nothing where the app cannot run its backend in WSL', () => {
    expect(settings(null)).toBe('')
    expect(settings({ ...LOCAL, supported: false, distros: [] })).toBe('')
  })

  it('offers this machine and each distro, marking the default and keeping WSL 1 out of reach', () => {
    const options = backendLocationOptions(LOCAL)
    expect(options.map((option) => option.label)).toEqual(['本机', 'WSL 里的 Ubuntu', 'WSL 里的 Legacy'])
    expect(options[1]).toMatchObject({ value: 'wsl:Ubuntu', description: '默认发行版 · WSL 2' })
    expect(options[1]?.disabled).toBe(false)
    expect(options[2]).toMatchObject({ disabled: true, description: 'WSL 1，要转成 WSL 2 才能选' })
  })

  it('keeps a chosen distro wsl.exe no longer lists, or would not say', () => {
    const gone = backendLocationOptions({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Arch' } })
    expect(gone.at(-1)).toMatchObject({ value: 'wsl:Arch', description: '找不到这个发行版', disabled: true })
    const unknown = backendLocationOptions({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Arch' }, distros: null })
    expect(unknown.map((option) => option.value)).toEqual(['local', 'wsl:Arch'])
    expect(unknown.at(-1)?.description).toBeNull()
  })

  it('offers the remote host once remote.json names it, and says a broken file', () => {
    const options = backendLocationOptions({ ...LOCAL, remote: { host: 'dev-us', error: null } })
    expect(options.at(-1)).toMatchObject({ value: 'remote', label: '远程主机 dev-us', disabled: false })
    const broken = backendLocationOptions({ ...LOCAL, remote: { host: null, error: 'remote.json is not valid JSON' } })
    expect(broken.at(-1)).toMatchObject({ value: 'remote', label: '远程主机（未配置）', disabled: true })
    expect(broken.at(-1)?.description).toBe('remote.json is not valid JSON')
  })

  it('says a remote that did not come up serves nothing, without falling back', () => {
    const html = settings({ ...LOCAL, supported: false, distros: [], chosen: { kind: 'remote' }, running: 'remote', remote: { host: 'dev-us', error: null }, problem: { kind: 'remote-link', detail: 'ssh: connect to host dev-us port 22: refused' } })
    expect(html).toContain('连不上远程后端')
    expect(html).toContain('远程后端没能启动，这次哪里也没连上')
    expect(html).toContain('port 22')
    expect(html).toContain('role="alert"')
  })

  it('says where it runs now and what WSL does not have yet', () => {
    const html = settings(LOCAL)
    expect(html).toContain('现在运行在')
    expect(html).toContain('后端在 WSL 里时暂时没有：手机在局域网里直连，以及保持电脑唤醒。')
    expect(html).not.toContain('role="alert"')
    expect(settings({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Ubuntu' }, running: 'wsl' })).toContain('>WSL 里的 Ubuntu</span>')
  })

  it('offers a retry when wsl.exe could not be asked, and the install when there is no distro', () => {
    const unlisted = settings({ ...LOCAL, distros: null })
    expect(unlisted).toContain('没能从 wsl.exe 读到发行版列表。')
    expect(unlisted).toContain('重新检测')
    const none = settings({ ...LOCAL, distros: [] })
    expect(none).toContain('还没有 WSL 发行版')
    expect(none).toContain('<code>wsl --install</code>')
  })

  it('says the distro did not start and that this machine runs instead', () => {
    const html = settings(failed({ kind: 'node-missing' }))
    expect(html).toContain('「Ubuntu」里的后端没能启动，这次先用本机的')
    expect(html).toContain('role="alert"')
    expect(html).toContain('重启 Antumi 再试')
  })

  it('gives the commands that install Node 24 as the default', () => {
    const html = settings(failed({ kind: 'node-old', version: 'v22.11.0', path: '/usr/bin/node' }))
    expect(html).toContain('「Ubuntu」里的 Node 是 v22.11.0，需要 24 以上。')
    expect(html).toContain('<code>/usr/bin/node</code>')
    expect(html).toContain('装了新版但没设成默认')
    expect(html).toContain('<code>nvm install 24 &amp;&amp; nvm alias default 24</code>')
    expect(html).toContain('<code>curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -</code>')
    expect(html).toContain('<code>sudo apt-get install -y nodejs</code>')
    expect(settings(failed({ kind: 'node-missing' }))).toContain('nvm alias default 24')
  })

  it('says what to do for each problem', () => {
    const cases: [WslBackendProblem, string[]][] = [
      [{ kind: 'wsl-unavailable' }, ['这台电脑没有装 WSL。', '<code>wsl --install</code>']],
      [{ kind: 'wsl-unknown', detail: 'E_ACCESSDENIED' }, ['wsl.exe 没有回答', '<pre class="backend-location-detail">E_ACCESSDENIED</pre>']],
      [{ kind: 'distro-missing', distro: 'Arch' }, ['找不到发行版「Arch」。', '改回本机']],
      [{ kind: 'distro-wsl1', distro: 'Legacy' }, ['「Legacy」是 WSL 1 的发行版。', '<code>wsl --set-version Legacy 2</code>']],
      [{ kind: 'arch', arch: 'arm64' }, ['「Ubuntu」是 arm64 的发行版，目前只支持 x64。']],
      [{ kind: 'login-environment' }, ['登录 shell 没有回应', '<code>wsl -d Ubuntu</code>']],
      [{ kind: 'install', detail: 'tar: no space left' }, ['没能把后端装进「Ubuntu」。', 'tar: no space left']],
      [{ kind: 'pty', detail: 'GLIBC_2.34 not found' }, ['系统库太旧', 'Ubuntu 22.04', 'GLIBC_2.34 not found']],
      [{ kind: 'start', detail: 'exited with 1' }, ['「Ubuntu」里的后端没能启动。', '<code>~/.antumi/logs/core.log</code>', 'exited with 1']]
    ]
    for (const [problem, expected] of cases) {
      const html = settings(failed(problem))
      for (const text of expected) expect(html, problem.kind).toContain(text)
    }
    expect(settings(failed({ kind: 'arch', arch: 'arm64' }))).not.toContain('重启 Antumi 再试')
    expect(settings(failed({ kind: 'distro-missing', distro: 'Arch' }))).not.toContain('重启 Antumi 再试')
  })

  it('reads in English', () => {
    setLocale('en')
    const html = settings(failed({ kind: 'node-old', version: 'v20.0.0', path: '/usr/bin/node' }))
    expect(html).toContain('Node in Ubuntu is v20.0.0; 24 or later is needed.')
    expect(html).toContain('Not yet available with the backend in WSL')
  })

  it('asks before switching, saying the app restarts and the other place has its own data', async () => {
    askConfirm.mockResolvedValueOnce(true)
    expect(await confirmSwitch({ kind: 'wsl', distro: 'Ubuntu' })).toBe(true)
    expect(await confirmSwitch({ kind: 'local' })).toBe(false)
    expect(askConfirm).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: expect.stringMatching(/^把后端换到 WSL 里的「Ubuntu」？ Antumi 会立即重启。那边有自己的一份任务、会话和设置/), confirm: '切换并重启' }))
    expect(askConfirm).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: expect.stringMatching(/^把后端换到本机？/) }))
  })
})

describe('backend location notice', () => {
  it('shows only when a chosen distro did not start, until dismissed', () => {
    expect(notice(null)).toBe('')
    expect(notice(LOCAL)).toBe('')
    expect(notice({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Ubuntu' }, running: 'wsl' })).toBe('')
    expect(notice({ ...failed({ kind: 'node-missing' }), supported: false })).toBe('')
    const html = notice(failed({ kind: 'start', detail: '' }))
    expect(html).toContain('「Ubuntu」里的后端没能启动，现在显示的是本机的任务和会话。')
    expect(html).toContain('aria-label="关闭提示"')
    useBackendLocation.setState({ dismissed: true })
    expect(renderToStaticMarkup(createElement(BackendLocationNotice))).toBe('')
  })

  it('names the distro the user chose', () => {
    expect(distroNotStarted(failed({ kind: 'login-environment' }))).toBe('Ubuntu')
    expect(distroNotStarted({ ...LOCAL, chosen: { kind: 'wsl', distro: 'Ubuntu' } })).toBeNull()
  })
})

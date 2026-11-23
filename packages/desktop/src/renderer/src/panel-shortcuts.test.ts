import { beforeEach, describe, expect, it } from 'vitest'
import { useCore } from './core-store'
import { runShortcutChord, SHORTCUT_PLATFORM } from './panel-shortcuts'

const primary = (key: string, code: string) => ({ key, code, metaKey: SHORTCUT_PLATFORM === 'darwin', ctrlKey: SHORTCUT_PLATFORM !== 'darwin', altKey: false, shiftKey: false })

beforeEach(() => useCore.setState(useCore.getInitialState(), true))

describe('a chord pressed outside the window', () => {
  it('runs the app shortcut it matches', () => {
    expect(runShortcutChord(primary('k', 'KeyK'))).toBe(true)
    expect(useCore.getState().search).toBe('all')
    expect(runShortcutChord(primary(',', 'Comma'))).toBe(true)
    expect(useCore.getState().settingsOpen).toBe(true)
  })

  it('does nothing for a chord that matches none', () => {
    const before = useCore.getState()
    expect(runShortcutChord({ key: 'q', code: 'KeyQ', metaKey: false, ctrlKey: false, altKey: true, shiftKey: true })).toBe(false)
    expect(runShortcutChord({ key: 'k', code: 'KeyK', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })).toBe(false)
    expect(useCore.getState()).toBe(before)
  })
})

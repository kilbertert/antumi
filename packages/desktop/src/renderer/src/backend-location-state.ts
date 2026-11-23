import { useEffect } from 'react'
import { create } from 'zustand'
import type { BackendLocation, BackendLocationState } from '../../shared/backend-location'
import { backendLocation } from './desktop-bridge'

// What main says of where the backend runs; null until it has, and outside Electron. `dismissed`
// lasts for this start only: the notice comes back with the next one if the problem does.
export const useBackendLocation = create<{ state: BackendLocationState | null; reading: boolean; dismissed: boolean }>()(() => ({ state: null, reading: false, dismissed: false }))

// Re-asks main, which lists the distros afresh; a failed read keeps what was known.
export async function readBackendLocation(): Promise<void> {
  useBackendLocation.setState({ reading: true })
  try {
    const state = await backendLocation()
    if (state) useBackendLocation.setState({ state })
  } finally {
    useBackendLocation.setState({ reading: false })
  }
}

export function useBackendLocationFeed(): void {
  useEffect(() => { void readBackendLocation() }, [])
}

export function useBackendLocationShown(): boolean {
  return useBackendLocation((s) => (s.state?.supported ?? false) || s.state?.remote != null)
}

export function dismissBackendLocationNotice(): void {
  useBackendLocation.setState({ dismissed: true })
}

// The distro the user chose when this machine's backend runs instead, because the one there did
// not start: the tasks they see are not the ones they expect. Null otherwise.
export function distroNotStarted(state: BackendLocationState | null): string | null {
  if (!state?.supported || state.chosen.kind !== 'wsl' || state.running !== 'local' || !state.problem) return null
  return state.chosen.distro
}

export function sameLocation(a: BackendLocation, b: BackendLocation): boolean {
  if (a.kind === 'local' || a.kind === 'remote') return b.kind === a.kind
  return b.kind === 'wsl' && a.distro === b.distro
}

import { randomUUID } from 'node:crypto'
import type { CallbackResponse, WebRequestFilter } from 'electron'
import { BROWSER_HOST_DECISION_WAIT_MS, isLocalHost, type BrowserNavigationOutcome } from '@antumi/protocol'
import type { Tab } from './tabs'

export type HostCheck = { checkId: string; tabId: string; conversationId: string | null; host: string; url: string }

type GatedRequest = { url: string; resourceType: string; webContentsId?: number }
export type GatedSession = {
  webRequest: { onBeforeRequest(filter: WebRequestFilter, listener: (details: GatedRequest, callback: (response: CallbackResponse) => void) => void): void }
}

// Whether a request is a page-level navigation the gate has a say in: a top frame going to a
// web host outside local development. Everything a page loads for itself passes.
export function gatedHost(request: Pick<GatedRequest, 'url' | 'resourceType'>): string | null {
  if (request.resourceType !== 'mainFrame') return null
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return isLocalHost(url.hostname) ? null : url.hostname
}

// Holds every top-level navigation to a site outside local development until core says whether
// the user allows it. One place for all of them: the agent's goto, a link the user clicks in the
// live view, a redirect. Core keeps the policy; the gate only asks.
// It holds them in the network stack rather than through the tab's debugger: a page whose requests
// pass through DevTools interception is one Cloudflare's challenge never clears, however often
// the user ticks its box.
export class HostGate {
  private readonly pending = new Map<string, { resolve: (allow: boolean) => void; timer: NodeJS.Timeout }>()
  // Why the tab's last navigation was stopped, for the navigate call to report.
  private readonly blocked = new Map<string, BrowserNavigationOutcome>()
  private readonly sessions = new WeakSet<GatedSession>()

  constructor(
    private readonly tabOf: (webContentsId: number) => Pick<Tab, 'id' | 'conversationId'> | null,
    private readonly ask: (check: HostCheck) => void
  ) {}

  // Once per session: a session takes a single listener, and every tab in it shares this one.
  install(session: GatedSession): void {
    if (this.sessions.has(session)) return
    this.sessions.add(session)
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] }, (request, callback) => {
      const host = gatedHost(request)
      const tab = host && request.webContentsId !== undefined ? this.tabOf(request.webContentsId) : null
      if (!host || !tab) {
        callback({})
        return
      }
      void this.check({ checkId: randomUUID(), tabId: tab.id, conversationId: tab.conversationId, host, url: request.url }).then((outcome) => {
        if (outcome === 'done') {
          callback({})
        } else {
          this.blocked.set(tab.id, outcome)
          callback({ cancel: true })
        }
      })
    })
  }

  private check(check: HostCheck): Promise<BrowserNavigationOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(check.checkId)
        resolve('awaiting-host')
      }, BROWSER_HOST_DECISION_WAIT_MS)
      this.pending.set(check.checkId, {
        resolve: (allow) => {
          clearTimeout(timer)
          this.pending.delete(check.checkId)
          resolve(allow ? 'done' : 'denied')
        },
        timer
      })
      this.ask(check)
    })
  }

  resolve(checkId: string, allow: boolean): void {
    this.pending.get(checkId)?.resolve(allow)
  }

  // The outcome of the tab's last blocked navigation, once; done when nothing was blocked.
  takeOutcome(tabId: string): BrowserNavigationOutcome {
    const outcome = this.blocked.get(tabId) ?? 'done'
    this.blocked.delete(tabId)
    return outcome
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) entry.resolve(false)
  }
}

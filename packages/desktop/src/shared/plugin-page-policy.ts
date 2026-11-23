import { PLUGIN_PAGE_SCHEME } from '@antumi/protocol'

// A plugin page runs its own files and nothing else: no inline script, since a page shows HTML from
// the web (a forum's posts), which must stay inert even where the page's own sanitizer misses. It
// fetches nothing; its backend is reached through the bridge. Pictures and media may come from the
// web. The frame is sandboxed without an origin, so its files are named by scheme, not 'self'.
const own = `${PLUGIN_PAGE_SCHEME}:`
export const PLUGIN_PAGE_POLICY = [
  "default-src 'none'", `script-src ${own}`, `style-src ${own} 'unsafe-inline'`, `img-src ${own} https: data: blob:`,
  `media-src ${own} https:`, "connect-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"
].join('; ')

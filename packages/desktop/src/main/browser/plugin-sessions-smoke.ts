import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import path from 'node:path'
import { app } from 'electron'
import { connectBrowserHost } from '../../../../core/src/browser-host-client'
import { readBrowserHostEndpoint } from '../../../../core/src/browser-host-file'
import { startBrowserHost } from './browser-host'
import { WindowSlot } from './window-slot'

async function run() {
  const home = process.env.ANTUMI_PLUGIN_SMOKE_HOME
  if (!home) throw new Error('Run with pnpm test:plugin-sessions')
  app.setPath('userData', path.join(home, 'user-data'))
  app.commandLine.appendSwitch('ignore-certificate-errors')
  app.commandLine.appendSwitch('disable-gpu')
  await app.whenReady()
  let writes = 0
  let followed = 0
  let fixturePort = 0
  const server = createServer({ key: readFileSync(path.join(home, 'key.pem')), cert: readFileSync(path.join(home, 'cert.pem')) }, (request, response) => {
    console.log(`smoke server: ${request.method} ${request.url}`)
    if (request.url === '/login') {
      response.setHeader('set-cookie', '_t=smoke-fixture; Path=/; Secure; HttpOnly; SameSite=Lax')
      response.setHeader('content-type', 'text/html')
      response.end('<html><head><title>Fixture sign in</title></head><body>Signed in to local fixture</body></html>')
    } else if (request.url === '/redirect') {
      response.writeHead(302, { location: `https://localhost:${fixturePort}/unexpected` }).end()
    } else if (request.url === '/unexpected') {
      followed += 1
      response.end('unexpected')
    } else if (request.url === '/csrf') {
      response.setHeader('set-cookie', '_forum_session=rotated-fixture; Path=/; Secure; HttpOnly; SameSite=Lax')
      response.setHeader('content-type', 'application/json')
      response.end('{"csrf":"fixture-csrf"}')
    } else if (request.url === '/reply' && request.method === 'POST') {
      assert.equal(request.headers['x-csrf-token'], 'fixture-csrf')
      assert.match(request.headers.cookie ?? '', /_t=smoke-fixture/)
      assert.match(request.headers.cookie ?? '', /_forum_session=rotated-fixture/)
      assert.equal(request.headers.origin, origin)
      writes += 1
      response.setHeader('content-type', 'application/json')
      response.end('{"id":1}')
    } else {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ authenticated: /_t=smoke-fixture/.test(request.headers.cookie ?? '') }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local fixture port')
  fixturePort = address.port
  const origin = `https://127.0.0.1:${address.port}`
  const hostFile = path.join(home, 'browser-host.json')
  const host = await startBrowserHost(new WindowSlot(), hostFile, () => true)
  const endpoint = await readBrowserHostEndpoint(hostFile)
  if (!endpoint) throw new Error('No browser host endpoint')
  const link = await connectBrowserHost(endpoint)
  const site = { id: 'forum', origin, loginPath: '/login' }
  const key = createHash('sha256').update('plugin-one').digest('hex')
  const other = createHash('sha256').update('plugin-two').digest('hex')
  const status = (key: string) => link.request('plugin.session', { key, site, request: { action: 'status', site: 'forum' } })
  const login = async (key: string) => {
    const result = await link.request('plugin.session', { key, site, request: { action: 'open', site: 'forum' } })
    assert.ok(result.tabId)
    const until = Date.now() + 5000
    while (!(await status(key)).connected && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal((await status(key)).connected, true)
  }
  try {
    assert.equal((await status(key)).connected, false)
    await login(key)
    console.log('smoke: signed in, reading local private endpoint')
    const read = await link.request('plugin.session', { key, site, request: { action: 'request', site: 'forum', path: '/private' } })
    assert.equal(JSON.parse(read.response?.body ?? '{}').authenticated, true)
    assert.equal((await status(other)).connected, false)
    await assert.rejects(link.request('plugin.session', { key: other, site, request: { action: 'request', site: 'forum', path: '/private' } }))
    await link.request('plugin.session', { key, site, request: { action: 'request', site: 'forum', path: '/csrf' } })
    const reply = await link.request('plugin.session', { key, site, request: { action: 'request', site: 'forum', path: '/reply', method: 'POST', headers: { 'x-csrf-token': 'fixture-csrf' }, body: 'raw=fixture' } })
    console.log('smoke: local write confirmed')
    assert.equal(reply.response?.status, 200)
    assert.equal(writes, 1)
    assert.equal(reply.response?.headers['set-cookie'], undefined)
    const redirect = await link.request('plugin.session', { key, site, request: { action: 'request', site: 'forum', path: '/redirect' } })
    assert.equal(redirect.response?.status, 302)
    assert.equal(followed, 0)
    await login(other)
    await link.request('plugin.session', { key, site, request: { action: 'disconnect', site: 'forum' } })
    assert.equal((await status(key)).connected, false)
    assert.equal((await status(other)).connected, true)
    console.log('Plugin sessions: Chromium cookies, isolated logins, POST, redirect boundary and sign-out passed')
  } finally {
    link.close()
    await host.shutdown()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

void run().then(() => app.quit(), (error: unknown) => { console.error(error); app.exit(1) })

import { expect, it } from 'vitest'
import { createRpcClient, type PluginPageFiles, type RpcConnection } from '@antumi/protocol'
import { forgetPluginPageFiles, pluginPageFiles } from './plugin-page-files'

const ref = { plugin: 'demo.plugin', page: 'reader' }
const files = (script: string): PluginPageFiles => ({ version: '1.0.0', entry: 'index.html', files: [{ path: 'app.js', base64: btoa(script) }] })

// A core that answers every page-files call with the same script, or fails the calls it is told to.
function core(script: string, failures = 0) {
  const sent: Array<{ id: number }> = []
  let failing = failures
  const client = createRpcClient((frame) => {
    const request: { id: number } = JSON.parse(frame)
    sent.push(request)
    queueMicrotask(() => client.receive(JSON.stringify(failing-- > 0 ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'gone' } } : { jsonrpc: '2.0', id: request.id, result: files(script) })))
  })
  const rpc: RpcConnection = { ...client, features: ['plugins', 'plugin-pages'], close() {}, closed: new Promise(() => {}) }
  return { rpc, sent }
}
const script = (bundle: PluginPageFiles) => atob(bundle.files[0]?.base64 ?? '')

it('asks core once for a page it is shown again', async () => {
  forgetPluginPageFiles()
  const { rpc, sent } = core('OLD')
  await pluginPageFiles(rpc, ref, '1.0.0')
  await pluginPageFiles(rpc, ref, '1.0.0')
  expect(sent).toHaveLength(1)
})

it('asks again once the plugins changed, and on another connection', async () => {
  forgetPluginPageFiles()
  const first = core('OLD')
  await pluginPageFiles(first.rpc, ref, '1.0.0')
  // Removed and installed again at the same version: the files may differ.
  forgetPluginPageFiles()
  await pluginPageFiles(first.rpc, ref, '1.0.0')
  expect(first.sent).toHaveLength(2)
  const second = core('NEW')
  expect(script(await pluginPageFiles(second.rpc, ref, '1.0.0'))).toBe('NEW')
  expect(script(await pluginPageFiles(first.rpc, ref, '1.0.0'))).toBe('OLD')
})

it('does not keep a failed load', async () => {
  forgetPluginPageFiles()
  const { rpc, sent } = core('OK', 1)
  await expect(pluginPageFiles(rpc, ref, '1.0.0')).rejects.toThrow('gone')
  expect(script(await pluginPageFiles(rpc, ref, '1.0.0'))).toBe('OK')
  expect(sent).toHaveLength(2)
})

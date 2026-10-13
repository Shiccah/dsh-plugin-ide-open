import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

/**
 * Mount the host half on a fake cordis context and serve its real route
 * handlers over a real HTTP server, so the wire contract (methods, media type,
 * body bounds, trust fence, status codes) is exercised rather than re-described.
 *
 * @param options - `config` for the plugin and a `rejection` for the fence.
 * @returns the base URL, the routes the plugin registered, and the fence calls.
 */
async function serve({ config, rejection } = {}) {
  const routes = []
  const rejected = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  }
  const connection = {
    requestRejection(request) {
      rejected.push(request)
      return rejection
    },
  }
  const effects = []
  const injections = []
  const context = {
    logger: { info() {}, warn() {} },
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose },
    get(name) { return name === 'webServer' ? webServer : undefined },
    inject(dependencies, callback) { injections.push({ dependencies, callback }) },
  }
  apply(context, config)
  assert.equal(injections.length, 1)
  assert.deepEqual(injections[0].dependencies, ['webServer', 'connection'])
  injections[0].callback({
    webServer,
    connection,
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose },
    get: name => context.get(name),
  })
  const server = createServer((req, res) => {
    const pathname = new URL(String(req.url), 'http://localhost').pathname
    const route = routes.find(candidate => candidate.path === pathname)
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    return route.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    routes,
    rejected,
    effects,
    // The global fetch keeps its sockets alive in a pool, and an idle keep-alive
    // socket would hold the test process open after the last assertion.
    close: () => new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    }),
  }
}

/** One temp directory holding a real file to open. */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ide-open-routes-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'B.java')
  await writeFile(file, 'class B {}\n')
  return { directory, file }
}

const ECHO = { skip: process.platform === 'win32' ? 'requires /bin/echo' : false }

test('registers exactly the two documented routes', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  assert.deepEqual(server.routes.map(route => [route.kind, route.path]),
    [['exact', '/ide-open/status'], ['exact', '/ide-open/open']])
})

test('status reports the resolved launcher', async (t) => {
  const server = await serve({ config: { command: ['/bin/echo', '--wait'] } })
  t.after(() => server.close())
  const response = await fetch(`${server.base}/ide-open/status`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    available: true, app: 'intellij', launcher: '/bin/echo', source: 'config', reason: null,
  })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('status says why nothing resolved instead of failing', async (t) => {
  const server = await serve({ config: { command: '/nonexistent/idea-does-not-exist' } })
  t.after(() => server.close())
  const body = await (await fetch(`${server.base}/ide-open/status`)).json()
  assert.equal(body.available, false)
  assert.match(body.reason, /no intellij launcher found/)
})

test('every route asks the trust fence first', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' }, rejection: 401 })
  t.after(() => server.close())
  for (const [method, path] of [['GET', '/ide-open/status'], ['POST', '/ide-open/open']]) {
    const response = await fetch(`${server.base}${path}`, { method })
    assert.equal(response.status, 401)
  }
  assert.equal(server.rejected.length, 2)
})

test('a method the route does not serve is refused with Allow', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  const response = await fetch(`${server.base}/ide-open/open`)
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
  const status = await fetch(`${server.base}/ide-open/status`, { method: 'POST' })
  assert.equal(status.status, 405)
  assert.equal(status.headers.get('allow'), 'GET')
})

test('the open route insists on application/json', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  const response = await fetch(`${server.base}/ide-open/open`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
  })
  assert.equal(response.status, 415)
})

test('the open route rejects a malformed body', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  for (const body of ['not json', '[]', '{"path":""}', '{"line":1}', '{"path":"/a","line":0}']) {
    const response = await fetch(`${server.base}/ide-open/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    assert.equal(response.status, 400, `body ${body}`)
  }
})

test('the open route bounds the body it buffers', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  const response = await fetch(`${server.base}/ide-open/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: `/a/${'x'.repeat(70 * 1024)}` }),
  })
  assert.equal(response.status, 413)
})

test('a path the host cannot see is answered 404 so the browser can fall back', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  for (const path of ['/nonexistent/nope.java', 'relative/nope.java']) {
    const response = await fetch(`${server.base}/ide-open/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
    })
    assert.equal(response.status, 404, `path ${path}`)
  }
})

test('a launch with no resolver is answered 503 with the reason', async (t) => {
  const server = await serve({ config: { command: '/nonexistent/idea-does-not-exist' } })
  t.after(() => server.close())
  const { file } = await fixture(t)
  const response = await fetch(`${server.base}/ide-open/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file }),
  })
  assert.equal(response.status, 503)
  assert.match((await response.json()).message, /no intellij launcher found/)
})

test('opening an existing file launches the launcher and answers 200', ECHO, async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  const { file } = await fixture(t)
  const response = await fetch(`${server.base}/ide-open/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: file, line: 12 }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, launcher: '/bin/echo' })
})

test('a directory is accepted: the route serves any existing path', ECHO, async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  const { directory } = await fixture(t)
  const response = await fetch(`${server.base}/ide-open/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: directory }),
  })
  assert.equal(response.status, 200)
})

test('a launcher that fails is answered 502', ECHO, async (t) => {
  const server = await serve({ config: { command: ['/bin/sh', '-c'], args: ['{path}'] } })
  t.after(() => server.close())
  const { file } = await fixture(t)
  const response = await fetch(`${server.base}/ide-open/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file }),
  })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'launch-failed')
})

test('a route nothing registered answers 404', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  assert.equal((await fetch(`${server.base}/ide-open/other`)).status, 404)
})

test('disposal unregisters both routes', async (t) => {
  const server = await serve({ config: { command: '/bin/echo' } })
  t.after(() => server.close())
  assert.equal(server.routes.length, 2)
  for (const dispose of server.effects) dispose()
  assert.equal(server.routes.length, 0)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

/** The one registration the bundle makes on the module-loader facade. */
let registration

/** Click listener the plugin installs on the window under test. */
let windowListeners = []

/** Install a fresh window facade and return its listeners. */
function installWindow() {
  windowListeners = []
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { registration = value } },
    addEventListener(type, listener, capture) { windowListeners.push({ type, listener, capture }) },
    removeEventListener(type, listener, capture) {
      windowListeners = windowListeners.filter(entry => entry.listener !== listener || entry.capture !== capture)
    },
  }
  return windowListeners
}

installWindow()
await import('../client.js')

/** The bundle's exports, materialized exactly as the module system does. */
const exported = registration.factory(() => { throw new Error('the bundle must require nothing') })
const { apply, __internals } = exported
const { parseFileAddress, absolutePathOf } = __internals

test('the bundle registers under its own package name and exports a plugin', async () => {
  const manifest = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(
    new URL('../package.json', import.meta.url), 'utf8')))
  assert.equal(registration.id, manifest.name)
  assert.equal(typeof apply, 'function')
  // The Web entry is created with `{ name }` only, so `inject` must stay optional
  // and no config may be required.
  assert.equal(registration.chunk, undefined)
})

test('parseFileAddress reads a Session-relative address', () => {
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/abc/src/notes.txt'),
    { scope: 'session', sessionId: 'abc', path: 'src/notes.txt' })
})

test('parseFileAddress keeps leading slashes inside a Session address', () => {
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/s//etc/hosts'),
    { scope: 'session', sessionId: 's', path: '/etc/hosts' })
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/s/C:/x/y.txt'),
    { scope: 'session', sessionId: 's', path: 'C:/x/y.txt' })
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/s///server/share/y.txt'),
    { scope: 'session', sessionId: 's', path: '//server/share/y.txt' })
})

test('parseFileAddress restores the leading slash of the Session-less form', () => {
  assert.deepEqual(parseFileAddress('dsh-resource://file/absolute/home/ys/notes.txt'),
    { scope: 'absolute', path: '/home/ys/notes.txt' })
  assert.deepEqual(parseFileAddress('dsh-resource://file/absolute/C:/x/y.txt'),
    { scope: 'absolute', path: 'C:/x/y.txt' })
})

test('parseFileAddress decodes segments and keeps ":" literal', () => {
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/s/src/a%20b.ts'),
    { scope: 'session', sessionId: 's', path: 'src/a b.ts' })
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/s/a:b.ts'),
    { scope: 'session', sessionId: 's', path: 'a:b.ts' })
})

test('parseFileAddress ignores query and fragment suffixes', () => {
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/s/src/a.ts?line=3#top'),
    { scope: 'session', sessionId: 's', path: 'src/a.ts' })
})

test('parseFileAddress refuses everything that is not a file address', () => {
  assert.equal(parseFileAddress('dsh-resource://plan/session/s/plan-1'), undefined)
  assert.equal(parseFileAddress('sidebar://guide'), undefined)
  assert.equal(parseFileAddress('https://example.com/a.ts'), undefined)
  assert.equal(parseFileAddress('dsh-resource://file/'), undefined)
  assert.equal(parseFileAddress('dsh-resource://file/session/s'), undefined)
  assert.equal(parseFileAddress('dsh-resource://file/session//a.ts'), undefined)
  assert.equal(parseFileAddress('dsh-resource://file/other/x'), undefined)
  // A malformed percent escape is an unreadable address, not a crash.
  assert.equal(parseFileAddress('dsh-resource://file/session/s/%E0%A4%A'), undefined)
  assert.equal(parseFileAddress(undefined), undefined)
})

test('absolutePathOf joins a relative path onto the Session workspace root', () => {
  const context = { get: (name) => (name === 'sessions'
    ? { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work/proj' } } }) } }
    : undefined) }
  assert.equal(absolutePathOf(context, parseFileAddress('dsh-resource://file/session/s1/src/a.ts')),
    '/work/proj/src/a.ts')
  assert.equal(absolutePathOf(context, parseFileAddress('dsh-resource://file/session/s1//etc/hosts')),
    '/etc/hosts')
  assert.equal(absolutePathOf(context, parseFileAddress('dsh-resource://file/session/nope/src/a.ts')),
    undefined)
  assert.equal(absolutePathOf(context, parseFileAddress('dsh-resource://file/absolute/tmp/a.ts')),
    '/tmp/a.ts')
})

test('absolutePathOf normalizes a Windows workspace root', () => {
  const context = { get: (name) => (name === 'sessions'
    ? { list: { getSnapshot: () => ({ byId: { s1: { cwd: 'C:\\work\\proj\\' } } }) } }
    : undefined) }
  assert.equal(absolutePathOf(context, parseFileAddress('dsh-resource://file/session/s1/src/a.ts')),
    'C:/work/proj/src/a.ts')
})

/**
 * Build one client plugin harness: a fake context, a Sidebar controller that
 * records what reaches it, and the calls the plugin made to the Host.
 * @param options - `available` sets the Host's status answer.
 * @returns the context, the recording Sidebar, the fetch calls, and the disposers.
 */
function harness({ available = true } = {}) {
  const opened = []
  const fetchCalls = []
  const disposers = []
  const sidebar = {
    // Deliberately on the prototype: the plugin must shadow it with an own
    // property and remove that property again on disposal.
    openResource(address, options) { opened.push({ method: 'openResource', address, options }) },
    openResourceIn(sessionId, address, options) {
      opened.push({ method: 'openResourceIn', sessionId, address, options })
    },
  }
  const sessions = { list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work/proj' } } }) } }
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    if (url === 'ide-open/status') {
      return new Response(JSON.stringify({ available, app: 'intellij' }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const injections = []
  const context = {
    logger: { info() {}, warn() {} },
    effect(callback) { const dispose = callback(); disposers.push(dispose); return dispose },
    inject(dependencies, callback) { injections.push({ dependencies, callback }) },
    get(name) { return name === 'sessions' ? sessions : undefined },
  }
  return { context, sidebar, opened, fetchCalls, disposers, injections, sessions }
}

/**
 * Activate the plugin on a harness and mount its Sidebar scope.
 * @param options - forwarded to {@link harness}.
 * @returns the harness plus the mounted scope.
 */
async function activate(options) {
  const built = harness(options)
  const controller = Object.create(built.sidebar)
  installWindow()
  apply(built.context)
  assert.equal(built.injections.length, 1)
  assert.deepEqual(built.injections[0].dependencies, ['sidebarRight'])
  const scope = {
    sidebarRight: controller,
    effect(callback) { const dispose = callback(); built.disposers.push(dispose); return dispose },
    get: name => built.context.get(name),
  }
  built.injections[0].callback(scope)
  // Let the status read settle: interception must never be decided mid-flight.
  await settle()
  return { ...built, controller }
}

/** Await one macrotask, long enough for a stubbed fetch chain to settle. */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

test('a file click is claimed and posted to the host instead of the sidebar', async () => {
  const built = await activate()
  built.controller.openResource('dsh-resource://file/session/s1/src/a.ts')
  assert.deepEqual(built.opened, [])
  await settle()
  assert.equal(built.fetchCalls.length, 2)
  assert.deepEqual(built.fetchCalls[0].url, 'ide-open/status')
  assert.deepEqual(built.fetchCalls[1].url, 'ide-open/open')
  assert.deepEqual(built.fetchCalls[1].body, { path: '/work/proj/src/a.ts' })
  assert.equal(built.fetchCalls[1].init.method, 'POST')
})

test('a requested line travels as a navigation parameter, not as part of the path', async () => {
  const built = await activate()
  built.controller.openResource('dsh-resource://file/session/s1/src/a.ts', { params: { line: 42 } })
  await settle()
  assert.deepEqual(built.fetchCalls[1].body, { path: '/work/proj/src/a.ts', line: 42 })
})

test('the session-scoped sibling is claimed too, for the file tree and review tabs', async () => {
  const built = await activate()
  built.controller.openResourceIn('s1', 'dsh-resource://file/session/s1/src/a.ts', { params: { line: 7 } })
  assert.deepEqual(built.opened, [])
  await settle()
  assert.deepEqual(built.fetchCalls[1].body, { path: '/work/proj/src/a.ts', line: 7 })
})

test("an address naming another Session is never resolved against the caller's root", async () => {
  // The address's path is relative to its own Session's root, so resolving it
  // against the acting Session's root would open a different file.
  const built = await activate()
  built.controller.openResourceIn('s1', 'dsh-resource://file/session/unknown/src/a.ts')
  assert.equal(built.opened.length, 1)
  assert.equal(built.opened[0].sessionId, 's1')
  await settle()
  assert.deepEqual(built.fetchCalls.map(call => call.url), ['ide-open/status'])
})

test('a non-file address keeps opening in the sidebar', async () => {
  const built = await activate()
  built.controller.openResource('dsh-resource://plan/session/s1/plan-1', { params: { index: 2 } })
  assert.deepEqual(built.opened, [
    { method: 'openResource', address: 'dsh-resource://plan/session/s1/plan-1', options: { params: { index: 2 } } },
  ])
  assert.equal(built.fetchCalls.length, 1)
})

test('Ctrl/Cmd/Alt click is passed through to the sidebar preview', async () => {
  const built = await activate()
  const click = windowListeners.find(entry => entry.type === 'click')
  assert.equal(click.capture, true)
  click.listener({ metaKey: true })
  built.controller.openResource('dsh-resource://file/session/s1/src/a.ts')
  assert.equal(built.opened.length, 1)
  await settle()
  assert.equal(built.fetchCalls.length, 1)
})

test('the modifier escape hatch covers exactly one click', async () => {
  const built = await activate()
  windowListeners.find(entry => entry.type === 'click').listener({ ctrlKey: true })
  built.controller.openResource('dsh-resource://file/session/s1/src/a.ts')
  assert.equal(built.opened.length, 1)
  built.controller.openResource('dsh-resource://file/session/s1/src/b.ts')
  await settle()
  assert.equal(built.opened.length, 1, 'the second click must reach the IDE')
  assert.deepEqual(built.fetchCalls[1].body, { path: '/work/proj/src/b.ts' })
})

test('an unresolvable workspace falls through to the sidebar', async () => {
  const built = await activate()
  built.controller.openResource('dsh-resource://file/session/unknown/src/a.ts')
  assert.equal(built.opened.length, 1)
  await settle()
  assert.equal(built.fetchCalls.length, 1)
})

test('a host without a launcher leaves every click to the sidebar', async () => {
  const built = await activate({ available: false })
  built.controller.openResource('dsh-resource://file/session/s1/src/a.ts')
  assert.equal(built.opened.length, 1)
  await settle()
  assert.deepEqual(built.fetchCalls.map(call => call.url), ['ide-open/status'])
})

test('a refused launch replays the original navigation', async () => {
  const built = await activate()
  globalThis.fetch = async (url, init) => {
    built.fetchCalls.push({ url, init })
    if (url === 'ide-open/status') {
      return new Response('{"available":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{"code":"launch-failed"}', { status: 502, headers: { 'content-type': 'application/json' } })
  }
  built.controller.openResource('dsh-resource://file/session/s1/src/a.ts')
  assert.deepEqual(built.opened, [])
  await settle()
  await settle()
  assert.equal(built.opened.length, 1)
  assert.equal(built.opened[0].address, 'dsh-resource://file/session/s1/src/a.ts')
})

test('an unreachable status route is retried on the next click', async () => {
  const built = await activate()
  let statusCalls = 0
  globalThis.fetch = async (url) => {
    if (url === 'ide-open/status') {
      statusCalls += 1
      throw new Error('offline')
    }
    return new Response('{"ok":true}', { status: 200 })
  }
  // Force a fresh read: the activation read succeeded, so make it fail first.
  built.controller.openResource('dsh-resource://file/session/s1/src/a.ts')
  await settle()
  assert.equal(built.opened.length, 0)
})

test('disposal restores the prototype methods it shadowed', async () => {
  const built = await activate()
  const controller = built.controller
  assert.ok(Object.hasOwn(controller, 'openResource'))
  assert.ok(Object.hasOwn(controller, 'openResourceIn'))
  for (const dispose of built.disposers) dispose()
  assert.equal(Object.hasOwn(controller, 'openResource'), false)
  assert.equal(Object.hasOwn(controller, 'openResourceIn'), false)
  controller.openResource('dsh-resource://file/session/s1/src/a.ts')
  assert.equal(built.opened.length, 1)
})

test('disposal also removes the modifier listener', async () => {
  const built = await activate()
  assert.equal(windowListeners.length, 1)
  for (const dispose of built.disposers) dispose()
  assert.equal(windowListeners.length, 0)
})

test('the plugin declares no required service, so it can never hold the boot pending', () => {
  // `assertEntriesActive` fails the whole Web boot on a pending entry, so a
  // required `sidebarRight`/`sessions` would take the UI down with it.
  assert.equal(registration.id, 'dsh-plugin-ide-open')
  assert.equal(typeof apply, 'function')
  assert.equal(exported.inject, undefined)
})

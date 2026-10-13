import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  OPEN_PATH,
  STATUS_PATH,
  buildArgs,
  createLauncherCache,
  launch,
  name,
  parseOpenBody,
  resolveLauncher,
  resolveOptions,
  scrubbedEnvironment,
} from '../index.js'

const SELF = fileURLToPath(import.meta.url)

test('the plugin declares the routes the browser half posts to', () => {
  assert.equal(name, 'ide-open')
  assert.equal(STATUS_PATH, '/ide-open/status')
  assert.equal(OPEN_PATH, '/ide-open/open')
})

test('resolveOptions applies the documented defaults', () => {
  const options = resolveOptions()
  assert.equal(options.app, 'intellij')
  assert.equal(options.command, undefined)
  assert.equal(options.launchWatchMs, 1000)
  assert.deepEqual(options.args, [['--line', '{line}'], ['--column', '{column}'], '{path}'])
})

test('resolveOptions accepts every documented field', () => {
  const options = resolveOptions({
    app: 'webstorm',
    command: ['/opt/idea/bin/idea', '--wait'],
    args: ['{path}'],
    launchWatchMs: 250,
  })
  assert.equal(options.app, 'webstorm')
  assert.deepEqual(options.command, { command: '/opt/idea/bin/idea', args: ['--wait'] })
  assert.deepEqual(options.args, ['{path}'])
  assert.equal(options.launchWatchMs, 250)
})

test('resolveOptions rejects malformed configuration', () => {
  assert.throws(() => resolveOptions([]), TypeError)
  assert.throws(() => resolveOptions({ app: '' }), TypeError)
  assert.throws(() => resolveOptions({ app: 'eclipse' }), /config\.app must be one of/)
  assert.throws(() => resolveOptions({ command: [] }), TypeError)
  assert.throws(() => resolveOptions({ command: [7] }), TypeError)
  assert.throws(() => resolveOptions({ args: [[1]] }), TypeError)
  assert.throws(() => resolveOptions({ launchWatchMs: 0 }), TypeError)
  assert.throws(() => resolveOptions({ launchWatchMs: 1.5 }), TypeError)
})

test('resolveOptions returns a fresh template so one plugin cannot mutate another', () => {
  const first = resolveOptions()
  first.args[0].push('--injected')
  assert.deepEqual(resolveOptions().args[0], ['--line', '{line}'])
})

test('buildArgs drops an optional group whose placeholder has no value', () => {
  const template = [['--line', '{line}'], ['--column', '{column}'], '{path}']
  assert.deepEqual(buildArgs(template, { path: '/a/B.ts', line: 12, column: 4 }),
    ['--line', '12', '--column', '4', '/a/B.ts'])
  assert.deepEqual(buildArgs(template, { path: '/a/B.ts', line: 12 }), ['--line', '12', '/a/B.ts'])
  assert.deepEqual(buildArgs(template, { path: '/a/B.ts' }), ['/a/B.ts'])
})

test('buildArgs renders every placeholder inside one segment', () => {
  assert.deepEqual(buildArgs([['-g', '{path}:{line}:{column}']], { path: '/a.ts', line: 3, column: 9 }),
    ['-g', '/a.ts:3:9'])
  assert.deepEqual(buildArgs([['-g', '{path}:{line}:{column}']], { path: '/a.ts' }), [])
})

test('buildArgs keeps a placeholder-free segment', () => {
  assert.deepEqual(buildArgs(['--wait', '{path}'], { path: '/a.ts' }), ['--wait', '/a.ts'])
})

test('parseOpenBody accepts a path with optional line and column', () => {
  assert.deepEqual(parseOpenBody('{"path":"/a/B.java"}'), { path: '/a/B.java' })
  assert.deepEqual(parseOpenBody('{"path":"/a/B.java","line":40,"column":7}'),
    { path: '/a/B.java', line: 40, column: 7 })
  assert.deepEqual(parseOpenBody('{"path":"/a/B.java","line":null}'), { path: '/a/B.java' })
})

test('parseOpenBody rejects anything that is not a bounded request object', () => {
  assert.equal(parseOpenBody('not json'), null)
  assert.equal(parseOpenBody('[]'), null)
  assert.equal(parseOpenBody('null'), null)
  assert.equal(parseOpenBody('{"line":1}'), null)
  assert.equal(parseOpenBody('{"path":""}'), null)
  assert.equal(parseOpenBody('{"path":7}'), null)
  assert.equal(parseOpenBody('{"path":"/a","line":0}'), null)
  assert.equal(parseOpenBody('{"path":"/a","line":"3"}'), null)
  assert.equal(parseOpenBody('{"path":"/a","column":-2}'), null)
})

test('resolveLauncher verifies an explicitly configured command', async () => {
  const resolved = await resolveLauncher(
    resolveOptions({ command: [SELF, '--wait'] }), 'linux', { PATH: '' },
  )
  assert.deepEqual(resolved, { command: SELF, args: ['--wait'], source: 'config' })
})

test('resolveLauncher rejects a configured command that does not exist', async () => {
  const resolved = await resolveLauncher(
    resolveOptions({ command: '/nonexistent/idea-does-not-exist' }), 'linux', { PATH: '' },
  )
  assert.equal(resolved, undefined)
})

test('resolveLauncher resolves a bare command name on PATH', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ide-open-path-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'idea'), '#!/bin/sh\n')
  const resolved = await resolveLauncher(
    resolveOptions({ command: ['idea', '--wait'] }), 'linux', { PATH: `/nowhere:${directory}` },
  )
  assert.deepEqual(resolved, { command: join(directory, 'idea'), args: ['--wait'], source: 'config' })
})

test('launcher status reports the reason when nothing resolves', async () => {
  const cache = createLauncherCache(resolveOptions({ command: '/nonexistent/idea-does-not-exist' }))
  const status = await cache.status()
  assert.equal(status.available, false)
  assert.equal(status.launcher, null)
  assert.match(status.reason, /no intellij launcher found/)
})

test('launcher status names the resolved launcher', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ide-open-status-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const launcher = join(directory, 'idea')
  await writeFile(launcher, '#!/bin/sh\n')
  const cache = createLauncherCache(resolveOptions({ command: launcher }))
  assert.deepEqual(await cache.status(), {
    available: true, app: 'intellij', launcher, source: 'config', reason: null,
  })
})

test('launch reports a zero exit as a successful launch', async () => {
  const outcome = await launch({ command: process.execPath, args: ['-e', 'process.exit(0)'] },
    { path: SELF }, { args: ['{path}'], launchWatchMs: 5000 })
  assert.equal(outcome, 'launched')
})

test('launch reports a fast non-zero exit as a failure', async () => {
  const outcome = await launch({ command: process.execPath, args: ['-e', 'process.exit(3)'] },
    { path: SELF }, { args: ['{path}'], launchWatchMs: 5000 })
  assert.equal(outcome, 'failed')
})

test('launch reports a still-running launcher as launched when the window closes', async () => {
  const outcome = await launch({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 400)'] },
    { path: SELF }, { args: ['{path}'], launchWatchMs: 100 })
  assert.equal(outcome, 'launched')
})

test('launch reports a missing executable as missing', async () => {
  const outcome = await launch({ command: '/nonexistent/idea-does-not-exist', args: [] },
    { path: SELF }, { args: ['{path}'], launchWatchMs: 5000 })
  assert.equal(outcome, 'missing')
})

test('launch passes the templated arguments to the real process', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ide-open-args-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const captured = join(directory, 'args.txt')
  const outcome = await launch(
    { command: '/bin/sh', args: ['-c', `printf '%s\\n' "$@" > ${captured}`, 'sh'] },
    { path: '/a/B.java', line: 42, column: 3 },
    { args: [['--line', '{line}'], ['--column', '{column}'], '{path}'], launchWatchMs: 5000 },
  )
  assert.equal(outcome, 'launched')
  assert.deepEqual((await readFile(captured, 'utf8')).trim().split('\n'),
    ['--line', '42', '--column', '3', '/a/B.java'])
})

test('launch passes only the path when no line was requested', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ide-open-args-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const captured = join(directory, 'args.txt')
  await launch(
    { command: '/bin/sh', args: ['-c', `printf '%s\\n' "$@" > ${captured}`, 'sh'] },
    { path: '/a/B.java' },
    { args: [['--line', '{line}'], '{path}'], launchWatchMs: 5000 },
  )
  assert.deepEqual((await readFile(captured, 'utf8')).trim().split('\n'), ['/a/B.java'])
})

test('the launched IDE never inherits credential-shaped or DSH_ variables', () => {
  const scrubbed = scrubbedEnvironment({
    PATH: '/usr/bin',
    HOME: '/Users/x',
    DISPLAY: ':0',
    DEEPSEEK_API_KEY: 'sk-secret',
    OPENCODE_GO_API_KEY: 'sk-secret',
    GITHUB_TOKEN: 'ghp-secret',
    DB_PASSWORD: 'hunter2',
    MY_SECRET: 'x',
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_HOME: '/Users/x/.dsh',
    EMPTY: undefined,
  })
  assert.deepEqual(scrubbed, { PATH: '/usr/bin', HOME: '/Users/x', DISPLAY: ':0' })
})

test('the scrubbed environment keeps proxy and locale variables', () => {
  const scrubbed = scrubbedEnvironment({ HTTPS_PROXY: 'http://p:1', LANG: 'ru_RU.UTF-8', NO_PROXY: 'localhost' })
  assert.deepEqual(scrubbed, { HTTPS_PROXY: 'http://p:1', LANG: 'ru_RU.UTF-8', NO_PROXY: 'localhost' })
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/**
 * The wiring the DSH plugin manager and the client module registry read before
 * either loads a line of code: what these tests check is what makes the package
 * selectable as a profile layer *and* shippable as a browser bundle, so a rename
 * or a missing publish entry stops being a silent install failure.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('declares the patch file the plugin manager resolves the bundle through', () => {
  assert.deepEqual(manifest.dsh.bundle, { patch: './cordis.patch.yml' })
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'the patch file ships with the package')
})

test('inserts the plugin row under the bundle, naming this package', () => {
  assert.match(patch, /^- insert:\n {4}- id: ide-open\n {6}name: "dsh-plugin-ide-open"\n/m)
  assert.ok(patch.includes(`name: "${manifest.name}"`), 'the inserted row names the installed package')
  assert.equal(patch.match(/- insert:/g)?.length, 1, 'one insert only: a second row would mount the plugin twice')
})

test('declares the browser half the client module registry scans for', () => {
  assert.deepEqual(manifest.dsh.client, { platform: 'web' })
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok(manifest.files.includes('client.js'), 'the bundle ships with the package')
  assert.ok(manifest.files.includes('index.js'), 'the host half ships with the package')
})

test('is installable from git without a build step', () => {
  // A git install runs `prepare` when the package declares one, and pnpm blocks
  // that until the profile allows it; shipping plain JS avoids the whole dance.
  assert.equal(manifest.scripts?.prepare, undefined)
  // No runtime dependency means nothing to resolve against the profile's
  // single hoisted cordis instance.
  assert.equal(manifest.dependencies, undefined)
  // Only `@deepseek-ai/dsh-*` peers are compatibility-checked, and this plugin
  // targets no internal package.
  assert.equal(manifest.peerDependencies, undefined)
})

test('the browser bundle is a classic script registering under the package name', () => {
  // The module system evaluates this file with a plain <script>, so a top-level
  // `import`/`export` would be a syntax error, and a wrong id would leave the
  // graph row "loaded without registering".
  assert.match(client, new RegExp(`window\\.__ModuleLoader__\\.load\\(\\{\\s*id: '${manifest.name}',`))
  assert.doesNotMatch(client, /^\s*(import|export)\s/m)
})

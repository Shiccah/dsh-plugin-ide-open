/**
 * dsh-plugin-ide-open — host half.
 *
 * DeepSeek Harness opens every file link it renders in its own right Sidebar.
 * This plugin's browser half intercepts that navigation and delegates it here,
 * because only the Host can start a desktop process.
 *
 * Two routes are served on the composition's `webServer`, behind the same
 * Connection trust fence the shipped `open-in-app` routes use:
 *
 * - `GET  /ide-open/status` — whether a launcher resolved, so the browser half
 *   can hand the click back to the Sidebar instead of swallowing it.
 * - `POST /ide-open/open`   — launch the IDE on one verified absolute path.
 *
 * The plugin has no runtime dependencies: every DSH capability it touches is a
 * cordis service (`webServer`, `connection`), and IDE discovery is done here
 * with `node:fs`/`node:path` so the package stays installable from a git URL
 * with no build step and no version-pinned dependency on internal packages.
 *
 * @module dsh-plugin-ide-open
 */

import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'ide-open'

/** Absolute route serving launcher availability. */
export const STATUS_PATH = '/ide-open/status'

/** Absolute route launching the IDE on one path. */
export const OPEN_PATH = '/ide-open/open'

/** Default JetBrains product handed a clicked file. */
const DEFAULT_APP = 'intellij'

/**
 * Default argument template: optional `--line`/`--column` groups in front of the
 * path. A group disappears entirely when one of its placeholders has no value,
 * so an unknown line never leaves a dangling flag behind.
 */
const DEFAULT_ARGS = [['--line', '{line}'], ['--column', '{column}'], '{path}']

/** Early-failure window per launch, in milliseconds. */
const DEFAULT_WATCH_MS = 1000

/** Open-route request bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Environment names that never reach a launched IDE: the harness's own rule
 * (`SENSITIVE_ENV_PATTERN` in `@deepseek-ai/dsh-subprocess`), plus every `DSH_*`
 * name. An IDE keeps its environment for the terminals it opens, so inheriting
 * this host verbatim would hand the model's API keys to every shell started in
 * the editor. `PATH`, `HOME`, locale, and `DISPLAY` survive, so the launcher and
 * the IDE itself still work.
 */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * JetBrains products this plugin can locate on its own. Ids match the shipped
 * `open-in-app` catalog, so a value a user already knows from that menu works
 * here too. `cli` is the launcher name inside the macOS bundle and on `PATH`,
 * `winExe` the Windows launcher, `desktopId` the Linux XDG entry id.
 */
const JETBRAINS_APPS = {
  intellij: {
    product: 'IntelliJ IDEA',
    cli: 'idea',
    winExe: 'idea64.exe',
    desktopId: 'com.jetbrains.IntelliJ-IDEA-Ultimate',
    mac: [
      'IntelliJ IDEA.app',
      'IntelliJ IDEA Ultimate.app',
      'IntelliJ IDEA CE.app',
      'IntelliJ IDEA Community Edition.app',
    ],
  },
  pycharm: {
    product: 'PyCharm',
    cli: 'pycharm',
    winExe: 'pycharm64.exe',
    desktopId: 'com.jetbrains.PyCharm-Professional',
    mac: ['PyCharm.app', 'PyCharm Professional.app', 'PyCharm CE.app', 'PyCharm Community.app'],
  },
  webstorm: {
    product: 'WebStorm',
    cli: 'webstorm',
    winExe: 'webstorm64.exe',
    desktopId: 'com.jetbrains.WebStorm',
    mac: ['WebStorm.app'],
  },
  phpstorm: {
    product: 'PhpStorm',
    cli: 'phpstorm',
    winExe: 'phpstorm64.exe',
    desktopId: 'com.jetbrains.PhpStorm',
    mac: ['PhpStorm.app'],
  },
  goland: {
    product: 'GoLand',
    cli: 'goland',
    winExe: 'goland64.exe',
    desktopId: 'com.jetbrains.GoLand',
    mac: ['GoLand.app'],
  },
  rider: {
    product: 'Rider',
    cli: 'rider',
    winExe: 'rider64.exe',
    desktopId: 'com.jetbrains.Rider',
    mac: ['Rider.app', 'JetBrains Rider.app'],
  },
  clion: {
    product: 'CLion',
    cli: 'clion',
    winExe: 'clion64.exe',
    desktopId: 'com.jetbrains.CLion',
    mac: ['CLion.app'],
  },
  datagrip: {
    product: 'DataGrip',
    cli: 'datagrip',
    winExe: 'datagrip64.exe',
    desktopId: 'com.jetbrains.DataGrip',
    mac: ['DataGrip.app'],
  },
  rustrover: {
    product: 'RustRover',
    cli: 'rustrover',
    winExe: 'rustrover64.exe',
    desktopId: 'com.jetbrains.RustRover',
    mac: ['RustRover.app'],
  },
  androidstudio: {
    product: 'Android Studio',
    cli: 'studio',
    winExe: 'studio64.exe',
    desktopId: 'com.google.AndroidStudio',
    mac: ['Android Studio.app'],
  },
}

/**
 * Install the routes that resolve and launch a desktop IDE.
 *
 * The plugin injects nothing at the top level: a profile without a Web surface
 * (headless, ACP) must load it as an inert row rather than hold it pending, so
 * the two services are waited for in a nested scope and the plugin stays a
 * no-op wherever they never arrive.
 *
 * @param ctx - the plugin's context.
 * @param config - optional configuration; see the README table.
 * @throws {TypeError} when a configured field has the wrong type.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const launcher = createLauncherCache(options)

  ctx.inject(['webServer', 'connection'], (scope) => {
    /**
     * Answer an untrusted or unauthenticated request through Connection's own
     * Host/Origin fence and browser-session authentication.
     * @param req - the incoming request.
     * @param res - the response to refuse on.
     * @returns true when the request was rejected and answered.
     */
    const rejected = (req, res) => {
      const code = scope.connection.requestRejection(req)
      if (code === undefined) return false
      res.statusCode = code
      res.end()
      return true
    }

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        sendJson(res, 200, await launcher.status())
      },
    }), `ide-open: GET ${STATUS_PATH}`)

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST')
          return
        }
        // Body-format validation: the essence must be exactly application/json.
        // String(undefined) is 'undefined', which never matches.
        const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
        if (essence !== 'application/json') {
          sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
          return
        }
        let text
        try {
          text = await readBoundedBody(req)
        } catch {
          // Swallows connection errors mid-body: there is nothing left to answer precisely.
          sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
          return
        }
        if (text === null) {
          sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
          return
        }
        const parsed = parseOpenBody(text)
        if (parsed === null) {
          sendJson(res, 400, {
            code: 'bad-request',
            message: 'request body must be JSON with a string "path" and optional numeric "line"/"column"',
          })
          return
        }
        // A path the Host cannot see is not an IDE failure: answering 404 lets the
        // browser half fall back to the Sidebar and its own error presentation.
        if (!isAbsolute(parsed.path) || !(await exists(parsed.path))) {
          sendJson(res, 404, { code: 'not-found', message: `path does not exist: ${parsed.path}` })
          return
        }
        const resolved = await launcher.resolve()
        if (resolved === undefined) {
          sendJson(res, 503, { code: 'no-launcher', message: (await launcher.status()).reason })
          return
        }
        let outcome = await launch(resolved, parsed, options)
        if (outcome === 'missing') {
          // The verified launcher is gone (uninstalled or updated in place):
          // re-resolve once, then retry with the fresh artifact.
          const fresh = await launcher.refresh()
          outcome = fresh === undefined ? 'failed' : await launch(fresh, parsed, options)
        }
        if (outcome === 'launched') {
          sendJson(res, 200, { ok: true, launcher: resolved.command })
          return
        }
        sendJson(res, 502, {
          code: outcome === 'missing' ? 'launcher-missing' : 'launch-failed',
          message: `failed to launch ${options.app} (${resolved.command})`,
        })
      },
    }), `ide-open: POST ${OPEN_PATH}`)

    ctx.logger?.info?.(`ide-open: serving ${STATUS_PATH} and ${OPEN_PATH} for "${options.app}"`)
  })
}

/**
 * Validate and default the plugin configuration.
 * @param config - the raw entry configuration, or undefined.
 * @returns resolved options.
 * @throws {TypeError} when the configuration is not a mapping or a field has the wrong type.
 */
export function resolveOptions(config) {
  if (config === undefined || config === null) return defaults()
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('ide-open: config must be a mapping')
  }
  const app = config.app ?? DEFAULT_APP
  if (typeof app !== 'string' || app.length === 0) {
    throw new TypeError('ide-open: config.app must be a non-empty string')
  }
  if (!Object.hasOwn(JETBRAINS_APPS, app)) {
    throw new TypeError(
      `ide-open: config.app must be one of ${Object.keys(JETBRAINS_APPS).join(', ')}; set config.command to use another editor`,
    )
  }
  return {
    ...defaults(),
    app,
    command: commandField(config.command),
    args: argsField(config.args),
    launchWatchMs: boundedMs(config.launchWatchMs, DEFAULT_WATCH_MS, 'launchWatchMs'),
  }
}

/** The option values used when a field is absent. */
function defaults() {
  return {
    app: DEFAULT_APP,
    command: undefined,
    args: DEFAULT_ARGS.map(entry => (Array.isArray(entry) ? [...entry] : entry)),
    launchWatchMs: DEFAULT_WATCH_MS,
  }
}

/**
 * Read the optional launcher override.
 * @param value - the configured value.
 * @returns `undefined`, a command string, or a command plus fixed leading arguments.
 * @throws {TypeError} when the value is neither form.
 */
function commandField(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    if (value.length === 0) throw new TypeError('ide-open: config.command must not be empty')
    return { command: value, args: [] }
  }
  if (Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string')) {
    const [command, ...args] = value
    if (command.length === 0) throw new TypeError('ide-open: config.command[0] must not be empty')
    return { command, args }
  }
  throw new TypeError('ide-open: config.command must be a non-empty string or a non-empty array of strings')
}

/**
 * Read the optional argument template.
 * @param value - the configured value.
 * @returns the template as an array of groups.
 * @throws {TypeError} when an entry is neither a string nor a list of strings.
 */
function argsField(value) {
  if (value === undefined || value === null) return defaults().args
  if (!Array.isArray(value)) throw new TypeError('ide-open: config.args must be a list')
  return value.map((entry) => {
    if (typeof entry === 'string') return entry
    if (Array.isArray(entry) && entry.length > 0 && entry.every(part => typeof part === 'string')) return [...entry]
    throw new TypeError('ide-open: each config.args entry must be a string or a non-empty list of strings')
  })
}

/**
 * Read one optional bounded integer field.
 * @param value - the configured value.
 * @param fallback - the value used when the field is absent.
 * @param field - the field name, for the error message.
 * @returns the configured number or the fallback.
 * @throws {TypeError} when the value is not an integer inside 1…600000.
 */
function boundedMs(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1 || value > 600_000) {
    throw new TypeError(`ide-open: config.${field} must be an integer between 1 and 600000`)
  }
  return value
}

/**
 * Build the cached launcher resolution shared by both routes, so detection runs
 * once per plugin life and a click, a status read, or a page reload never
 * re-runs it.
 * @param options - resolved plugin options.
 * @returns resolution, status reading, and one-shot refresh after a stale launch.
 */
export function createLauncherCache(options) {
  let pending
  const detect = () => resolveLauncher(options)
  const resolve = () => (pending ??= detect())
  return {
    resolve,
    async refresh() {
      pending = detect()
      return await pending
    },
    async status() {
      const resolved = await resolve()
      if (resolved !== undefined) {
        return { available: true, app: options.app, launcher: resolved.command, source: resolved.source, reason: null }
      }
      return {
        available: false,
        app: options.app,
        launcher: null,
        source: null,
        reason: `no ${options.app} launcher found on this desktop; set config.command or install the IDE`,
      }
    },
  }
}

/**
 * Resolve one launchable IDE: an explicit `command` when configured, otherwise
 * the first verified candidate for the configured JetBrains product.
 * @param options - resolved plugin options.
 * @param platform - target platform; defaults to the running one (test seam).
 * @param env - environment to read `PATH`/`ProgramFiles` from (test seam).
 * @returns the command, its fixed leading arguments, and how it was found.
 */
export async function resolveLauncher(options, platform = process.platform, env = process.env) {
  if (options.command !== undefined) {
    const found = await verifyCommand(options.command.command, platform, env)
    return found === undefined
      ? undefined
      : { command: found, args: [...options.command.args], source: 'config' }
  }
  const app = JETBRAINS_APPS[options.app] ?? JETBRAINS_APPS[DEFAULT_APP]
  if (platform === 'darwin') {
    const found = await firstFile([
      ...app.mac.flatMap(bundle => [
        join('/Applications', bundle, 'Contents', 'MacOS', app.cli),
        join(homedir(), 'Applications', bundle, 'Contents', 'MacOS', app.cli),
      ]),
      join(homedir(), 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts', app.cli),
      join('/usr/local/bin', app.cli),
      join('/opt/homebrew/bin', app.cli),
    ])
    if (found !== undefined) return { command: found, args: [], source: 'mac-app' }
  }
  if (platform === 'linux') {
    const found = await firstFile([
      join(homedir(), '.local', 'share', 'JetBrains', 'Toolbox', 'scripts', app.cli),
      `/snap/bin/${app.cli}`,
      `/var/lib/flatpak/exports/bin/${app.desktopId}`,
      join(homedir(), '.local', 'share', 'flatpak', 'exports', 'bin', app.desktopId),
    ])
    if (found !== undefined) return { command: found, args: [], source: 'linux-entry' }
  }
  if (platform === 'win32') {
    const found = await firstFile(await windowsCandidates(app, env))
    if (found !== undefined) return { command: found, args: [], source: 'windows-install' }
  }
  const onPath = await resolveOnPath(app.cli, platform, env)
  if (onPath !== undefined) return { command: onPath, args: [], source: 'path' }
  if (platform === 'win32') {
    // A Toolbox install exposes `idea64.exe` on PATH even when no versioned
    // product directory matched above.
    const exe = await resolveOnPath(app.winExe, platform, env)
    if (exe !== undefined) return { command: exe, args: [], source: 'path' }
  }
  return undefined
}

/**
 * Verify an explicitly configured command: an absolute path must exist, any
 * other spelling is resolved on `PATH`.
 * @param command - the configured command.
 * @param platform - target platform.
 * @param env - environment to read `PATH` from.
 * @returns the usable command, or undefined when nothing matches.
 */
async function verifyCommand(command, platform, env) {
  if (command.includes('/') || command.includes('\\')) {
    return (await isFile(command)) ? command : undefined
  }
  return await resolveOnPath(command, platform, env)
}

/**
 * Candidate launchers for a JetBrains product installed on Windows, newest
 * version first: the versioned product directories under the JetBrains install
 * roots that the direct downloader, the Toolbox, and the installer write.
 * @param app - the product's catalog entry.
 * @param env - environment supplying `ProgramFiles` and `LOCALAPPDATA`.
 * @returns candidate launcher paths, best first.
 */
async function windowsCandidates(app, env) {
  const roots = [
    env.ProgramFiles === undefined ? undefined : join(env.ProgramFiles, 'JetBrains'),
    env['ProgramFiles(x86)'] === undefined ? undefined : join(env['ProgramFiles(x86)'], 'JetBrains'),
    env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'Programs'),
  ].filter(root => root !== undefined)
  const found = []
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root)
    } catch {
      // A missing install root is the ordinary case on a machine without it.
      continue
    }
    for (const entry of entries) {
      if (entry !== app.product && !entry.startsWith(`${app.product} `) && !entry.startsWith(`${app.product}-`)) continue
      found.push(join(root, entry, 'bin', app.winExe))
    }
  }
  // Newest version first, so an upgraded side-by-side install wins.
  return found.sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))
}

/**
 * First candidate naming an existing regular file.
 * @param candidates - paths to test in order.
 * @returns the first hit, or undefined.
 */
async function firstFile(candidates) {
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve one command name against `PATH`, honouring `PATHEXT` on Windows.
 * @param name - executable name without an extension.
 * @param platform - target platform.
 * @param env - environment supplying `PATH` and `PATHEXT`.
 * @returns the resolved absolute path, or undefined.
 */
async function resolveOnPath(name, platform, env) {
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(ext => ext.length > 0)
    : ['']
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, name + extension)
      if (await isFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Whether one path names an existing regular file (symlinks followed).
 * @param path - absolute path to test.
 * @returns true when the path is a readable regular file.
 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    // ENOENT and EACCES both mean "not a usable launcher here".
    return false
  }
}

/**
 * Whether one path exists at all.
 * @param path - absolute path to test.
 * @returns true when the path exists.
 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Render one argument template against the request values.
 *
 * A group (a nested list) is emitted only when every one of its segments
 * renders, so `[['--line', '{line}'], '{path}']` opens a file at a known line
 * and silently drops the flag when the line is unknown.
 *
 * @param template - the resolved `args` template.
 * @param values - `{ path, line, column }`; an absent entry makes its group drop.
 * @returns the argument list appended after the launcher's fixed arguments.
 */
export function buildArgs(template, values) {
  const out = []
  for (const entry of template) {
    const group = Array.isArray(entry) ? entry : [entry]
    const rendered = []
    let complete = true
    for (const segment of group) {
      const text = renderSegment(segment, values)
      if (text === undefined) {
        complete = false
        break
      }
      rendered.push(text)
    }
    if (complete) out.push(...rendered)
  }
  return out
}

/**
 * Substitute `{name}` placeholders in one segment.
 * @param segment - the template segment.
 * @param values - the request values.
 * @returns the rendered segment, or undefined when a referenced value is absent.
 */
function renderSegment(segment, values) {
  let missing = false
  const text = segment.replace(/\{(\w+)\}/g, (_match, key) => {
    const value = values[key]
    if (value === undefined || value === null || value === '') {
      missing = true
      return ''
    }
    return String(value)
  })
  return missing ? undefined : text
}

/**
 * Launch one resolved launcher on the requested path and classify the outcome
 * inside a bounded window.
 *
 * A launcher still running when the window closes counts as launched: the
 * macOS launcher blocks while it starts the IDE, and a launcher that forwards
 * to an already-running instance exits `0` at once. Both are successes; only a
 * missing executable or a fast non-zero exit is a failure.
 *
 * The child is detached and never awaited past the window: closing the session
 * that opened the file must not close the editor.
 *
 * @param resolved - `{ command, args }` from {@link resolveLauncher}.
 * @param request - the validated `{ path, line?, column? }` request.
 * @param options - resolved plugin options supplying the template and window.
 * @returns `'launched'`, `'failed'`, or `'missing'`.
 */
export function launch(resolved, request, options) {
  const watchMs = options.launchWatchMs
  const args = [...resolved.args, ...buildArgs(options.args, {
    path: request.path,
    line: request.line,
    column: request.column,
  })]
  return new Promise((settle) => {
    let child
    try {
      child = spawn(resolved.command, args, {
        detached: true,
        stdio: 'ignore',
        env: scrubbedEnvironment(),
      })
    } catch {
      // A spawn that throws synchronously is a malformed command, not a race.
      settle('failed')
      return
    }
    let done = false
    const finish = (outcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(outcome)
    }
    const timer = setTimeout(() => finish('launched'), watchMs)
    // The window is short and bounded; nothing here may keep the process alive.
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', (error) => {
      finish(error?.code === 'ENOENT' ? 'missing' : 'failed')
    })
    child.on('exit', (code) => {
      finish(code === 0 || code === null ? 'launched' : 'failed')
    })
    child.unref()
  })
}

/**
 * The ambient environment minus credential-shaped names and every `DSH_*` name.
 * @param env - the environment to scrub; defaults to this process's.
 * @returns a fresh environment safe to hand a long-lived desktop application.
 */
export function scrubbedEnvironment(env = process.env) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERN.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    out[key] = value
  }
  return out
}

/** JSON response (no-store: availability and launch outcomes are live facts). */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the route's one supported method. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param req - the incoming request.
 * @returns the body text, or null past the ceiling (stream drained).
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  // http server streams without setEncoding always yield Buffer chunks.
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate one open-route body at the wire.
 * @param text - the raw request body.
 * @returns `{ path, line?, column? }`, or null when malformed.
 */
export function parseOpenBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // Swallows the parse error: a non-JSON body is exactly the null case.
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { path, line, column } = body
  if (typeof path !== 'string' || path.length === 0) return null
  const parsed = { path }
  for (const [field, value] of [['line', line], ['column', column]]) {
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || value < 1) return null
    parsed[field] = value
  }
  return parsed
}

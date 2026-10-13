/**
 * dsh-plugin-ide-open — DeepSeek Harness plugin that opens clicked files in
 * IntelliJ IDEA (or another JetBrains IDE) instead of the built-in right
 * sidebar. See `README.md` for the installation, configuration, and failure
 * modes, and `client.js` for the browser half.
 *
 * @module dsh-plugin-ide-open
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Plugin name reported to the harness loader. */
export declare const name = 'ide-open'

/** Absolute route serving launcher availability (`GET`). */
export declare const STATUS_PATH = '/ide-open/status'

/** Absolute route launching the IDE on one path (`POST`). */
export declare const OPEN_PATH = '/ide-open/open'

/** One resolved launcher: the executable and its fixed leading arguments. */
export interface ResolvedLauncher {
  /** Absolute path of the resolved launcher. */
  command: string
  /** Arguments that always precede the templated ones. */
  args: string[]
  /** How the launcher was found: `config`, `mac-app`, `linux-entry`, `windows-install`, or `path`. */
  source: string
}

/** One parsed open request. */
export interface OpenRequest {
  /** Absolute path the IDE should open. */
  path: string
  /** 1-based line to land on. */
  line?: number
  /** 1-based column to land on. */
  column?: number
}

/** Plugin configuration, as it appears under the profile row's `config` key. */
export interface Config {
  /**
   * JetBrains product to locate when `command` is not set:
   * `intellij`, `pycharm`, `webstorm`, `phpstorm`, `goland`, `rider`, `clion`,
   * `datagrip`, `rustrover`, or `androidstudio`.
   * @default 'intellij'
   */
  app?: string
  /**
   * Explicit launcher, overriding detection: a path, a `PATH` name, or an array
   * whose first entry is the command and the rest are fixed leading arguments.
   */
  command?: string | string[]
  /**
   * Argument template appended after the launcher's fixed arguments. Each entry
   * is one segment or one group of segments; a group is emitted only when every
   * `{path}`/`{line}`/`{column}` placeholder inside it has a value.
   * @default [['--line', '{line}'], ['--column', '{column}'], '{path}']
   */
  args?: (string | string[])[]
  /**
   * How long a launch may take to fail before it counts as started, in
   * milliseconds.
   * @default 1000
   */
  launchWatchMs?: number
}

/** Resolved options with every default applied. */
export interface ResolvedOptions {
  app: string
  command?: { command: string; args: string[] }
  args: (string | string[])[]
  launchWatchMs: number
}

/** Launcher availability as the browser half reads it. */
export interface LauncherStatus {
  available: boolean
  app: string
  launcher: string | null
  source: string | null
  reason: string | null
}

/**
 * Install the routes that resolve and launch a desktop IDE. The plugin injects
 * nothing at the top level, so a composition without a Web surface loads it as
 * an inert row.
 * @param ctx - the plugin's context.
 * @param config - optional configuration.
 * @throws {TypeError} when a configured field has the wrong type.
 */
export declare function apply(ctx: unknown, config?: Config): void

/**
 * Validate and default the plugin configuration.
 * @param config - the raw entry configuration.
 * @returns resolved options.
 * @throws {TypeError} when the configuration is not a mapping or a field has the wrong type.
 */
export declare function resolveOptions(config?: Config | null): ResolvedOptions

/**
 * Build the cached launcher resolution shared by both routes.
 * @param options - resolved plugin options.
 * @returns resolution, status reading, and one-shot refresh.
 */
export declare function createLauncherCache(options: ResolvedOptions): {
  resolve(): Promise<ResolvedLauncher | undefined>
  refresh(): Promise<ResolvedLauncher | undefined>
  status(): Promise<LauncherStatus>
}

/**
 * Resolve one launchable IDE.
 * @param options - resolved plugin options.
 * @param platform - target platform; defaults to the running one.
 * @param env - environment to read `PATH`/`ProgramFiles` from.
 * @returns the resolved launcher, or undefined when nothing matched.
 */
export declare function resolveLauncher(
  options: ResolvedOptions,
  platform?: NodeJS.Platform,
  env?: Record<string, string | undefined>,
): Promise<ResolvedLauncher | undefined>

/**
 * Render one argument template against the request values.
 * @param template - the resolved `args` template.
 * @param values - `{ path, line, column }`; an absent entry makes its group drop.
 * @returns the argument list.
 */
export declare function buildArgs(
  template: (string | string[])[],
  values: { path?: string; line?: number; column?: number },
): string[]

/**
 * Launch one resolved launcher and classify the outcome inside the configured
 * window. The child is detached and started with a credential-scrubbed
 * environment.
 * @param resolved - `{ command, args }` from {@link resolveLauncher}.
 * @param request - the validated request.
 * @param options - resolved plugin options supplying the template and window.
 * @returns `'launched'`, `'failed'`, or `'missing'`.
 */
export declare function launch(
  resolved: { command: string; args: string[] },
  request: OpenRequest,
  options: Pick<ResolvedOptions, 'args' | 'launchWatchMs'>,
): Promise<'launched' | 'failed' | 'missing'>

/**
 * The ambient environment minus credential-shaped names and every `DSH_*` name.
 * @param env - the environment to scrub; defaults to this process's.
 * @returns a fresh environment safe to hand a long-lived desktop application.
 */
export declare function scrubbedEnvironment(env?: Record<string, string | undefined>): Record<string, string>

/**
 * Validate one open-route body at the wire.
 * @param text - the raw request body.
 * @returns the parsed request, or null when malformed.
 */
export declare function parseOpenBody(text: string): OpenRequest | null

/** Route handler shape, re-exported so a host can type an adapter around it. */
export type IdeOpenHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

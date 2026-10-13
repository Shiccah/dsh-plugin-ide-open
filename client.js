/**
 * dsh-plugin-ide-open — browser half.
 *
 * DeepSeek Harness opens every file link it renders in its own right Sidebar:
 * the conversation's file links, a tool row's line reference, a delivery card,
 * a row of the file tree. Every one of those paths ends in
 * `ctx.sidebarRight.openResource()` or its session-scoped sibling
 * `openResourceIn()`, so this plugin takes over exactly those two methods and
 * asks the Host half to hand the file to a desktop IDE instead.
 *
 * The takeover is deliberately conservative:
 *
 * - only `dsh-resource://file/…` addresses are claimed — plan previews, subagent
 *   chats and skill pages keep opening in the Sidebar;
 * - a click holding Ctrl/Cmd/Alt is passed through untouched, so the Sidebar
 *   preview is always one gesture away;
 * - nothing is claimed before the Host has confirmed a launcher exists, and a
 *   refused launch replays the original call, so a broken install degrades to
 *   the stock behaviour instead of swallowing the click.
 *
 * This file is a hand-written client bundle: a classic script registering one
 * lazy-CJS factory on `window.__ModuleLoader__`. It is served verbatim, so it
 * must stay free of top-level `import`/`export` and may only `require()` the
 * platform seed modules — this plugin needs none of them.
 *
 * @module dsh-plugin-ide-open/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-ide-open',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Prefix of the resource-address family that names a workspace file. */
    const FILE_PREFIX = 'dsh-resource://file/'

    /** Browser-relative route paths, so a deployment prefix is preserved. */
    const STATUS_ROUTE = 'ide-open/status'
    const OPEN_ROUTE = 'ide-open/open'

    /** How long a modifier held during a click keeps the next open in the Sidebar. */
    const BYPASS_MS = 1000

    /**
     * Parse a `dsh-resource://file/…` address into the file it names.
     *
     * The grammar (owned by the product's workspace-path package) is
     * `session/<sessionId>/<path>` for a Session-authorized file — the path may
     * itself be absolute, because leading slashes stay part of it — and
     * `absolute/<path>` for the Session-less form, whose leading slash was
     * dropped when the address was built. Every segment is component-encoded
     * except `:`, kept literal for Windows drive letters.
     *
     * @param address - the navigation address a caller passed to the Sidebar.
     * @returns `{ scope, sessionId?, path }`, or undefined for anything else.
     */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_PREFIX)) return undefined
      let rest = address.slice(FILE_PREFIX.length)
      const suffix = rest.search(/[?#]/)
      if (suffix !== -1) rest = rest.slice(0, suffix)
      const segments = rest.split('/')
      const scope = segments[0]
      try {
        if (scope === 'session') {
          const sessionId = decodeURIComponent(segments[1] ?? '')
          const path = segments.slice(2).map(decodeURIComponent).join('/')
          if (sessionId === '' || path === '') return undefined
          return { scope: 'session', sessionId, path }
        }
        if (scope === 'absolute') {
          const path = segments.slice(1).map(decodeURIComponent).join('/')
          return path === '' ? undefined : { scope: 'absolute', path: restoreLeadingSlash(path) }
        }
      } catch {
        // A malformed percent escape makes the address unreadable, not fatal.
        return undefined
      }
      return undefined
    }

    /**
     * Put back the leading slash the `absolute` form drops, keeping Windows
     * drive paths (`C:/x`) and UNC roots (`//server/share`) as they are.
     * @param path - the decoded path.
     * @returns an absolute spelling of the same path.
     */
    function restoreLeadingSlash(path) {
      if (path.startsWith('/') || /^[A-Za-z]:($|\/)/.test(path)) return path
      return '/' + path
    }

    /**
     * Whether a decoded path is already absolute on either separator convention.
     * @param path - a decoded path with backslashes normalized to slashes.
     * @returns true for a POSIX, drive-letter, or UNC absolute path.
     */
    function isAbsolutePath(path) {
      return path.startsWith('/') || /^[A-Za-z]:($|\/)/.test(path)
    }

    /**
     * Turn a parsed file address into the absolute path the Host can launch.
     *
     * The Session named by the address is the only one consulted, never the
     * caller's: the address's path is relative to *that* Session's workspace
     * root, so resolving it against any other root would silently open a
     * different file. An unresolvable address falls back to the Sidebar, which
     * owns the error presentation.
     *
     * @param context - the client context, read for the Session workspace root.
     * @param parsed - the result of {@link parseFileAddress}.
     * @returns an absolute path, or undefined when no workspace root is known.
     */
    function absolutePathOf(context, parsed) {
      const path = parsed.path.replace(/\\/g, '/')
      if (isAbsolutePath(path)) return path
      const cwd = workspaceRootOf(context, parsed.sessionId)
      if (cwd === undefined) return undefined
      return cwd.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + path
    }

    /**
     * Read one Session's workspace root off the Session list model.
     *
     * The service is read through `ctx.get` rather than an `inject` entry: a
     * missing model must leave this plugin inactive, never hold the whole Web
     * boot pending on a service some other composition may not mount.
     *
     * @param context - the client context.
     * @param sessionId - the Session whose root is wanted.
     * @returns the workspace root, or undefined when it is unknown.
     */
    function workspaceRootOf(context, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      try {
        const cwd = context.get('sessions')?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
        return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
      } catch {
        // A model mid-replacement is not a reason to drop the click.
        return undefined
      }
    }

    /**
     * The 1-based line a caller asked to land on. A line travels as a
     * navigation parameter, never as part of the address.
     * @param options - the options a caller passed to the Sidebar.
     * @returns the line, or undefined when none was requested.
     */
    function lineOf(options) {
      const line = options?.params?.line
      return Number.isInteger(line) && line > 0 ? line : undefined
    }

    /** Log through the client's logger when it has one, and the console otherwise. */
    function report(context, level, message, detail) {
      const logger = context?.logger
      if (logger !== undefined && typeof logger[level] === 'function') {
        if (detail === undefined) logger[level](message)
        else logger[level](message, detail)
        return
      }
      const sink = level === 'warn' ? console.warn : console.info
      if (detail === undefined) sink(message)
      else sink(message, detail)
    }

    /**
     * Read the Host's launcher status once per page.
     *
     * The browser entry is created with no config, so the Host half is the only
     * place a launcher is decided; this read is how the decision reaches the
     * click. A failed read is not cached, so a transiently unreachable route is
     * retried on the next gesture.
     *
     * @param state - the shared plugin state.
     * @returns resolves once the state reflects the Host's answer.
     */
    async function refreshStatus(state) {
      if (state.pending !== undefined) return await state.pending
      state.pending = (async () => {
        try {
          const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`status ${response.status}`)
          const value = await response.json()
          state.enabled = value?.available === true
          state.app = value?.app ?? null
          state.read = true
        } catch (error) {
          // Not fatal, and not cached: without an answer the click keeps
          // behaving exactly as it did before this plugin was installed.
          state.enabled = false
          state.read = false
          report(state.context, 'warn', 'ide-open: could not read the host launcher status', error)
        } finally {
          state.pending = undefined
        }
      })()
      return await state.pending
    }

    /**
     * Hand one absolute path to the Host and launch the IDE on it.
     * @param state - the shared plugin state.
     * @param path - the absolute path to open.
     * @param line - the 1-based line to land on, when one was requested.
     * @returns whether the Host accepted the launch.
     */
    async function openInIde(state, path, line) {
      try {
        const response = await fetch(OPEN_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(line === undefined ? { path } : { path, line }),
        })
        if (!response.ok) throw new Error(`open ${response.status}`)
        return true
      } catch (error) {
        report(state.context, 'warn', `ide-open: could not open ${path} in the IDE`, error)
        return false
      }
    }

    /**
     * Claim one navigation for the IDE when it is addressable and the Host is
     * ready.
     * @param state - the shared plugin state.
     * @param address - the navigation address.
     * @param options - the caller's placement and navigation parameters.
     * @param fallback - the original call to replay when the claim is refused.
     * @returns true when the click was claimed; false to let the caller pass through.
     */
    function intercept(state, address, options, fallback) {
      if (!state.enabled) {
        // A status that never arrived is retried here rather than at page load,
        // so installing the IDE and clicking again is enough to recover.
        if (!state.read) void refreshStatus(state)
        return false
      }
      if (Date.now() - state.modifierAt < BYPASS_MS) {
        // One-shot: the modifier buys exactly the click it was held for, so a
        // quick plain click right after it still reaches the IDE.
        state.modifierAt = 0
        return false
      }
      const parsed = parseFileAddress(address)
      if (parsed === undefined) return false
      const path = absolutePathOf(state.context, parsed)
      if (path === undefined) return false
      void openInIde(state, path, lineOf(options)).then((opened) => {
        // The Host refused after all: the user must still get their file, so the
        // original Sidebar navigation runs late rather than never.
        if (!opened) fallback()
      })
      return true
    }

    /**
     * Replace one Sidebar navigation method with this plugin's interceptor,
     * returning the undo that restores the exact prior descriptor.
     * @param target - the Sidebar controller.
     * @param key - the method name.
     * @param wrap - builds the replacement from the original.
     * @returns the restore callback.
     */
    function wrapMethod(target, key, wrap) {
      const original = target[key]
      if (typeof original !== 'function') return () => {}
      const existing = Object.getOwnPropertyDescriptor(target, key)
      const wrapper = wrap(original)
      target[key] = wrapper
      return () => {
        if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapper) return
        if (existing === undefined) delete target[key]
        else Object.defineProperty(target, key, existing)
      }
    }

    /**
     * Install the interceptor on a context whose Sidebar is available, for as
     * long as both the service and this plugin live.
     * @param scope - a context carrying `sidebarRight`.
     * @param state - the shared plugin state.
     * @returns the disposer restoring both methods.
     */
    function install(scope, state) {
      const sidebar = scope.sidebarRight
      if (sidebar === undefined) return () => {}
      const restore = [
        wrapMethod(sidebar, 'openResource', original => function (address, options) {
          const fallback = () => original.call(this, address, options)
          if (intercept(state, address, options, fallback)) return undefined
          return fallback()
        }),
        wrapMethod(sidebar, 'openResourceIn', original => function (sessionId, address, options) {
          const fallback = () => original.call(this, sessionId, address, options)
          if (intercept(state, address, options, fallback)) return undefined
          return fallback()
        }),
      ]
      return () => {
        for (const undo of restore) undo()
      }
    }

    /**
     * Plugin body: read the Host's answer, watch for the modifier escape hatch,
     * and take over file navigation wherever a Sidebar exists.
     *
     * No `inject` is declared on purpose. A plugin whose service never arrives
     * stays pending, and the Web boot audit treats a pending entry as a failed
     * boot — so a profile without `ui-sidebar-right` would lose the whole UI
     * instead of losing this plugin. Waiting in a nested scope keeps the entry
     * active and this plugin inert.
     *
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      const state = { context: ctx, enabled: false, read: false, app: null, pending: undefined, modifierAt: 0 }
      ctx.effect(() => {
        const listener = (event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) state.modifierAt = Date.now()
        }
        window.addEventListener('click', listener, true)
        return () => window.removeEventListener('click', listener, true)
      })
      ctx.inject(['sidebarRight'], (scope) => {
        scope.effect(() => install(scope, state))
      })
      void refreshStatus(state)
    }

    exports.apply = apply
    // Test seam: the Web boot reads only `apply`, `inject`, `name`, and `Config`,
    // so these pure helpers are exported for `node --test` and ignored in the browser.
    exports.__internals = { parseFileAddress, absolutePathOf, lineOf, restoreLeadingSlash }

    return module.exports
  },
})

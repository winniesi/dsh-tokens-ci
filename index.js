/**
 * dsh-tokens-ci host half.
 *
 * One exact Fetch route on Connection's shared `/api` transport serves the
 * tokens.ci usage report to this plugin's browser half. The browser cannot ask
 * tokens.ci itself — the API sends no CORS headers, so a cross-origin probe
 * fails before the status line — and the host is where the shared cache, the
 * account store, and the on-disk snapshot live anyway.
 *
 * Registering through Connection's exact Fetch registry (rather than a private
 * RPC channel) is deliberate: the route rides the same `/api` transport as the
 * rest of the GUI, so it inherits the Host/Origin fence and the browser-session
 * cookie, and only a same-origin page holding this process's cookie reaches it.
 *
 * The route never throws. Every expected condition travels as a successful
 * response carrying a `state` the page can explain; only a genuine programming
 * error on the caller's side is reported as `bad-request`, and only an
 * unexpected upstream failure as `internal`.
 *
 * @module dsh-tokens-ci
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  API_BASE,
  normalizePeriod,
  normalizeUsername,
  readReport,
  snapshotDir,
  snapshotFile,
} from './tokens-ci.mjs'

/** Plugin name shown in the Loader inventory. */
export const name = 'tokens-ci'

/** The exact Fetch registry lives on the host Connection service. */
export const inject = ['connection']

/** Shared browser transport; routes under it inherit its fence and session. */
const CHANNEL = '/api'

/** Absolute endpoint; the browser posts to `/api/tokens-ci/report`. */
const ENDPOINT = 'tokens-ci/report'

/** Path the exact Fetch registry matches, channel included. */
const ROUTE_PATH = `${CHANNEL}/${ENDPOINT}`

/**
 * Serve a cached report for this long.
 *
 * The page polls while it is open, and every miss is two upstream requests
 * against a service the user is not paying for. A minute is short enough that
 * reopening the page shows current numbers and long enough that a poll costs
 * nothing.
 */
const CACHE_MS = 60_000

/**
 * How old a snapshot may be and still answer a request whose live read failed.
 *
 * The snapshot exists to make the page paint at once on a cold start, not to
 * outlive the numbers: a window that has rolled over several times is not a
 * useful stand-in for "now". Past this age the page gets the failure instead.
 */
const SNAPSHOT_MAX_MS = 7 * 24 * 3_600_000

/**
 * How long a process-spawning identity probe may take before it is abandoned.
 * `gh` talks to the network; a machine that is offline must not hold the first
 * report open while it waits for a TCP timeout.
 */
const PROBE_TIMEOUT_MS = 4_000

/**
 * Which account to report on, in the order the host decides.
 *
 * The page's own store and the plugin row both beat guessing, and a guess that
 * looked like a GitHub handle but is not the tokens.ci account is the one
 * failure this order cannot prevent — which is why the page shows where the
 * name came from and offers to change it.
 *
 * 1. the plugin row's `config.username` — a deployment decision, never
 *    overridden by the page;
 * 2. the name the user typed into the settings page, kept in this plugin's own
 *    directory;
 * 3. `[github] user` from Git's global configuration (the conventional key);
 * 4. `gh api user`, which is an actual GitHub identity when `gh` is installed
 *    and signed in — note that a Harness running as a service often has no
 *    `gh` on its `PATH`, so this is a bonus, not the plan;
 * 5. `[user] name` from Git, the weakest signal, kept last for the common
 *    single-machine case where the two happen to agree.
 */

/**
 * Git's own global configuration files, in the order Git reads them.
 *
 * `~/.gitconfig` is not where a modern Git keeps this: the XDG path is read
 * first and `~/.gitconfig` wins on conflict. Reading only the legacy file —
 * which is what this probe used to do — misses every machine that never wrote
 * one, and on the machine this plugin was built on it silently fell through to
 * the weakest signal instead.
 *
 * @param home - home directory.
 * @param env - environment supplying `XDG_CONFIG_HOME`.
 * @returns absolute paths, in read order (later wins).
 */
function gitConfigPaths(home, env) {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== ''
    ? env.XDG_CONFIG_HOME
    : path.join(home, '.config')
  return [path.join(xdg, 'git', 'config'), path.join(home, '.gitconfig')]
}

/**
 * Read the account name out of Git's global configuration without running
 * anything.
 *
 * This leads the chain because the host may run inside a service whose `PATH`
 * holds no `git` at all, and because it costs one file read instead of a
 * process spawn on the request path.
 *
 * @param home - home directory.
 * @param env - environment supplying `XDG_CONFIG_HOME`.
 * @returns `{ handle, name }` — the conventional `[github] user`, and the
 *   weaker `[user] name` — either absent when that key is unset.
 */
function probeGitConfig(home, env) {
  let handle
  let name
  for (const file of gitConfigPaths(home, env)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let section
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/[#;].*$/, '').trim()
      if (line === '') continue
      const header = /^\[([^\]]+)\]$/.exec(line)
      if (header !== null) {
        section = header[1].trim().toLowerCase()
        continue
      }
      const entry = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line)
      if (entry === null) continue
      const key = entry[1].trim().toLowerCase()
      const value = normalizeUsername(entry[2].trim().replace(/^"|"$/g, ''))
      if (value === undefined) continue
      if (section === 'github' && key === 'user') handle = value
      if (section === 'user' && key === 'name') name = value
    }
  }
  return { handle, name }
}

/** Run one probe command and take its first line, or nothing. */
function runProbe(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    return normalizeUsername(stdout.split('\n')[0])
  } catch {
    // Missing binary, no config value, not signed in, or timed out: the next
    // probe is the answer, and the last failure means "ask the user".
    return undefined
  }
}

/**
 * Ask the local machine which GitHub account it belongs to.
 *
 * @param logger - host logger, used for one informational line per probe run.
 * @returns `{ username, origin }`, or undefined when nothing local names one.
 */
function probeUsername(logger) {
  const git = probeGitConfig(os.homedir(), process.env)
  if (git.handle !== undefined) {
    logger?.info(`tokens-ci: using account ${JSON.stringify(git.handle)} from git config github.user`)
    return { username: git.handle, origin: 'git config github.user' }
  }
  const fromGh = runProbe('gh', ['api', 'user', '--jq', '.login'])
  if (fromGh !== undefined) {
    logger?.info(`tokens-ci: using account ${JSON.stringify(fromGh)} from \`gh api user\``)
    return { username: fromGh, origin: 'gh api user' }
  }
  if (git.name !== undefined) {
    logger?.info(`tokens-ci: using account ${JSON.stringify(git.name)} from git config user.name`)
    return { username: git.name, origin: 'git config user.name' }
  }
  const fromGit = runProbe('git', ['config', '--global', 'user.name'])
  if (fromGit !== undefined) {
    logger?.info(`tokens-ci: using account ${JSON.stringify(fromGit)} from \`git config --global user.name\``)
    return { username: fromGit, origin: 'git config --global user.name' }
  }
  return undefined
}

/**
 * Wrap one result in the `server-response` envelope the browser caller checks.
 * @param rpcId - the caller's correlation id, echoed back verbatim.
 * @param result - `{ ok: true, value }` or `{ ok: false, error }`.
 * @returns the HTTP response carrying that envelope.
 */
function envelope(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

/** Build a failed result with the error shape the transport validates. */
function failure(rpcId, code, message) {
  return envelope(rpcId, { ok: false, error: { code, message, details: {} } })
}

/**
 * Read the last good report for one period from disk.
 *
 * Best effort in both directions: a missing, unreadable or malformed file means
 * there is nothing to show early, never an error the user sees.
 *
 * @param file - snapshot path.
 * @returns the stored report, or undefined.
 */
function readSnapshot(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) return undefined
    const report = parsed.report
    if (report === null || typeof report !== 'object') return undefined
    if (typeof report.fetchedAt !== 'string') return undefined
    if (typeof report.username !== 'string' || typeof report.period !== 'string') return undefined
    return report
  } catch {
    return undefined
  }
}

/**
 * Persist the last good report for one period.
 *
 * Best effort: a read-only home directory must not break the page; it only
 * costs the next cold start its head start. Written beside the target and
 * renamed, so a second Harness reading during this write never sees a
 * half-written report, and the per-pid name keeps two writers apart.
 *
 * @param file - snapshot path.
 * @param report - the report that was just fetched.
 */
function writeSnapshot(file, report) {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, report }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // Ignored on purpose: see above.
  }
}

/**
 * The account the user typed into the page, kept between restarts.
 *
 * This is the plugin's own directory rather than the profile's
 * `cordis.patch.yml`: a page cannot rewrite the profile safely (the plugin
 * manager owns that file and its lock), and a value the user set through the
 * UI is not a deployment decision. A row-level `config.username` still wins
 * over it, so an operator's explicit choice is never silently replaced.
 *
 * @param file - settings path.
 * @returns the saved name, or undefined.
 */
function readSavedAccount(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1) return undefined
    return normalizeUsername(parsed.username)
  } catch {
    return undefined
  }
}

/**
 * Persist the account the user typed, or forget it.
 *
 * @param file - settings path.
 * @param username - the name to keep, or undefined to clear it.
 * @returns whether the write landed.
 */
function writeSavedAccount(file, username) {
  try {
    if (username === undefined) {
      rmSync(file, { force: true })
      return true
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, username }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
    return true
  } catch {
    return false
  }
}

/**
 * Register the report route on the host Connection service.
 *
 * @param ctx - host plugin context carrying the `connection` service.
 * @param config - the plugin row's config (`{ username?, period? }`).
 */
export function apply(ctx, config) {
  const options = config !== null && typeof config === 'object' ? config : {}
  const configured = normalizeUsername(options.username)
  const defaultPeriod = normalizePeriod(options.period) ?? 'week'
  const dir = snapshotDir()
  const settingsFile = path.join(dir, 'settings.json')

  /** Reports already read in this process, one per account and period. */
  const cache = new Map()
  /** Reads in progress, so two callers share one upstream pair. */
  const inFlight = new Map()
  /** The name from the page, loaded once at activation. */
  let saved = readSavedAccount(settingsFile)
  /** Set once a probe has run, including a run that found nothing (`null`). */
  let detected

  /** Cache and in-flight keys: one report per account per period. */
  const keyOf = (username, period) => `${username}\u0000${period}`

  /**
   * The account this host reports on.
   * @param refresh - re-probe, but only when nothing has ever resolved.
   * @returns `{ username, origin }`, or undefined when nothing names one.
   */
  const account = (refresh) => {
    if (configured !== undefined) return { username: configured, origin: 'plugin config' }
    if (saved !== undefined) return { username: saved, origin: 'saved in this page' }
    if (detected === undefined || (refresh === true && detected === null)) {
      detected = probeUsername(ctx.logger) ?? null
    }
    return detected ?? undefined
  }

  /**
   * Read one period from upstream, then cache and persist the result.
   * @param period - normalized period.
   * @param username - the account to read.
   * @returns the read result; never throws for upstream conditions.
   */
  const load = (period, username) => {
    const key = keyOf(username, period)
    const existing = inFlight.get(key)
    if (existing !== undefined) return existing
    const task = readReport({ username, period })
      .then((result) => {
        if (result.ok === true) {
          cache.set(key, { at: Date.now(), report: result.value })
          writeSnapshot(path.join(dir, snapshotFile(period)), result.value)
        }
        return result
      })
      .finally(() => {
        inFlight.delete(key)
      })
    inFlight.set(key, task)
    return task
  }

  /**
   * The report for one period, from the freshest source that can answer.
   *
   * A cold start answers from the snapshot at once and re-reads behind it, so
   * the first paint costs no upstream round trip. The answer says which source
   * it came from, because the page dims cached numbers rather than either
   * hiding them or implying they are live.
   *
   * @param period - normalized period.
   * @param force - ignore the in-memory cache (the page's Refresh button).
   * @returns the result for this request; never throws.
   */
  const report = async (period, force) => {
    const file = path.join(dir, snapshotFile(period))
    let resolved = account(force === true)
    let stored
    if (resolved === undefined) {
      // A snapshot remembers whose numbers it holds, so a machine that stops
      // naming an account — a service without the user's Git configuration, a
      // `gh` sign-out — keeps reporting the account it was already reporting
      // instead of dropping the reader back to the setup panel.
      stored = readSnapshot(file)
      if (stored !== undefined) resolved = { username: stored.username, origin: 'the last saved reading' }
    }
    if (resolved === undefined) {
      return {
        ok: true,
        value: {
          state: 'no-account',
          period,
          configured: false,
          probed: ['git config github.user', 'gh api user', 'git config user.name'],
        },
      }
    }

    const { username, origin } = resolved
    const key = keyOf(username, period)
    const cached = cache.get(key)
    const age = cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - cached.at
    if (force !== true && cached !== undefined && age < CACHE_MS) {
      return { ok: true, value: { ...cached.report, account: { name: username, origin }, source: 'memory', ageMs: age } }
    }

    if (stored === undefined) stored = readSnapshot(file)
    // Another account's snapshot is not this account's early answer.
    const snapshot = stored !== undefined && stored.username === username ? stored : undefined
    const snapshotAge = snapshot === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() - Date.parse(snapshot.fetchedAt)

    // Serve what we have now and revalidate behind it, unless the caller asked
    // to force a live read. The page re-asks a few seconds later, so the read
    // runs while the reader is already looking at numbers.
    if (force !== true && snapshot !== undefined && snapshotAge < SNAPSHOT_MAX_MS) {
      void load(period, username).catch(() => {})
      return { ok: true, value: { ...snapshot, account: { name: username, origin }, source: 'snapshot', ageMs: snapshotAge } }
    }

    try {
      const result = await load(period, username)
      if (result.ok === true) {
        return { ok: true, value: { ...result.value, account: { name: username, origin }, source: 'live', ageMs: 0 } }
      }
      if (result.state === 'unknown-account') {
        return {
          ok: true,
          value: { state: 'unknown-account', username, period, configured: true, origin },
        }
      }
      throw new Error(`unexpected read result: ${JSON.stringify(result.state)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (snapshot !== undefined && snapshotAge < SNAPSHOT_MAX_MS) {
        return {
          ok: true,
          value: { ...snapshot, account: { name: username, origin }, source: 'snapshot', ageMs: snapshotAge, stale: true, error: message },
        }
      }
      return { ok: true, value: { state: 'error', username, period, configured: true, origin, message } }
    }
  }

  /**
   * Answer one request from the shared `/api` transport.
   * @param request - the authenticated Fetch request.
   * @returns the enveloped response.
   */
  const serve = async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const message = body !== null && typeof body === 'object' ? body : undefined
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
    if (message?.type !== 'client-request' || typeof message.method !== 'string') {
      return failure(rpcId, 'bad-request', 'invalid client-request message')
    }
    if (message.method !== ENDPOINT) {
      return failure(rpcId, 'bad-request', `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(ENDPOINT)}`)
    }
    const payload = message.payload !== null && typeof message.payload === 'object' ? message.payload : {}

    // A `username` in the payload is the page choosing an account: a durable
    // choice, written down before the read so a typo is remembered and can be
    // corrected rather than retyped. `null` forgets it.
    if (payload.username !== undefined) {
      const requested = payload.username === null ? undefined : normalizeUsername(payload.username)
      if (payload.username !== null && requested === undefined) {
        return failure(rpcId, 'bad-request', `invalid username ${JSON.stringify(payload.username)}; expected a GitHub handle`)
      }
      saved = requested
      writeSavedAccount(settingsFile, requested)
      // Every cached report belongs to the account that was just replaced.
      cache.clear()
      ctx.logger.info(`tokens-ci: account ${requested === undefined ? 'cleared' : `set to ${JSON.stringify(requested)}`} from the settings page`)
    }

    // An absent period takes the row's; a present but unknown one is refused.
    // `normalizePeriod` answers `week` for an absent value, so the two cases
    // cannot share one call: doing so silently ignored `config.period`.
    let period = defaultPeriod
    if (payload.period !== undefined && payload.period !== null && payload.period !== '') {
      const asked = normalizePeriod(payload.period)
      if (asked === undefined) {
        return failure(rpcId, 'bad-request', `unsupported period ${JSON.stringify(payload.period)}; expected one of week, month, all`)
      }
      period = asked
    }
    try {
      return envelope(rpcId, await report(period, payload.refresh === true))
    } catch (error) {
      return failure(rpcId, 'internal', error instanceof Error ? error.message : String(error))
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: serve,
  }))

  ctx.logger.info(
    `tokens-ci: serving tokens.ci reports on ${ROUTE_PATH} for ${JSON.stringify(configured ?? saved ?? 'the local GitHub account')} (${API_BASE}, default period ${defaultPeriod})`,
  )
  ctx.logger.info(`tokens-ci: snapshots and the saved account under ${dir}`)
}

/**
 * Export for the host-side self-check, which exercises the route without
 * booting. `probeGitConfig` is here because it is a pure function of a home
 * directory and an environment, and it reads a file whose location is the
 * whole point of it.
 */
export const internals = { CHANNEL, ENDPOINT, ROUTE_PATH, CACHE_MS, SNAPSHOT_MAX_MS, probeGitConfig }

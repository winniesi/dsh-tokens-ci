/**
 * tokens.ci data layer for the `dsh-tokens-ci` plugin.
 *
 * Everything the browser page shows is derived here, on the host, and shipped
 * as one plain-JSON report. Two reasons:
 *
 * - The upstream API is public but CORS-less, so the browser cannot call it;
 *   the host holds the only network path anyway.
 * - The two upstream documents (a profile and a leaderboard row) describe the
 *   same account in different shapes, and one number in them is a trap worth
 *   naming: `modelUsage[].percentage` is the **cost** share, not the token
 *   share (a model can carry 39 % of the tokens and 19 % of the share). The
 *   share is therefore recomputed for tokens and carried separately, so a
 *   renderer cannot accidentally print "39 % of tokens" beside a 19 % bar.
 *
 * Nothing in this module touches Cordis: it takes plain values and returns
 * plain values, which is what makes it testable without booting a profile.
 *
 * @module dsh-tokens-ci/data
 */

import os from 'node:os'
import path from 'node:path'

/** Upstream origin, without a trailing slash. */
export const API_BASE = 'https://tokens.ci'

/** Public profile page for one account. */
export function profileUrl(username) {
  return `${API_BASE}/u/${encodeURIComponent(username)}`
}

/** Public leaderboard page for one period. */
export function leaderboardUrl(period) {
  return `${API_BASE}/leaderboard?period=${encodeURIComponent(period)}`
}

/**
 * Periods the upstream API actually implements.
 *
 * `day` is not one of them: the profile endpoint answers `period=day` with the
 * all-time document and `period=year`/`period=7d`/anything unknown with the
 * same fallback, so a request for them would be answered with numbers that
 * silently describe a different window. They are refused here instead.
 */
export const PERIODS = ['week', 'month', 'all']

/**
 * Normalize a requested period.
 * @param value - any caller-supplied period.
 * @returns the period, or `week` when the request named none and `undefined`
 *   when it named one this API does not implement.
 */
export function normalizePeriod(value) {
  if (value === undefined || value === null || value === '') return 'week'
  return PERIODS.includes(value) ? value : undefined
}

/**
 * Normalize an account name for use in a URL path and a query value.
 * @param value - any caller-supplied name.
 * @returns the trimmed name, or `undefined` when nothing usable is left.
 */
export function normalizeUsername(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^@/, '')
  if (trimmed === '' || trimmed.length > 64) return undefined
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined
}

/**
 * Where the last good report per period is kept between process lifetimes.
 * Mirrors the convention the other local Harness plugins use: one directory
 * under `$DSH_HOME`, named after the package.
 *
 * @param options - explicit environment/home/dshHome for tests.
 * @returns the absolute directory holding this plugin's snapshots.
 */
export function snapshotDir(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? os.homedir()
  const dshHome = options.dshHome ?? env.DSH_HOME ?? path.join(home, '.dsh')
  return path.join(dshHome, 'dsh-tokens-ci')
}

/**
 * Snapshot filename for one period.
 * @param period - normalized period.
 * @returns the file name inside {@link snapshotDir}.
 */
export function snapshotFile(period) {
  return `report-${period}.json`
}

/**
 * Read one upstream JSON document.
 *
 * A non-JSON body (the site answers unknown API paths with its HTML 404 page)
 * and a non-2xx status are both failures; 404 is distinguished because "this
 * GitHub handle has never submitted usage" is a state the page explains
 * rather than an error it apologizes for.
 *
 * @param url - absolute request URL.
 * @param fetchImpl - `fetch` implementation (injected for tests).
 * @param timeoutMs - per-request ceiling.
 * @returns the parsed document.
 * @throws an Error carrying `code` (`not-found`, `http`, `malformed`, `network`).
 */
async function getJson(url, fetchImpl, timeoutMs) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        // A descriptive agent, so the upstream operator can tell this traffic
        // apart from a browser and from the CLI that submits the data.
        'user-agent': 'dsh-tokens-ci/1.0 (+https://tokens.ci)',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const failure = new Error(`cannot reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`)
    failure.code = 'network'
    throw failure
  }
  if (response.status === 404) {
    const missing = new Error(`no such resource: ${url}`)
    missing.code = 'not-found'
    throw missing
  }
  if (!response.ok) {
    const failure = new Error(`${new URL(url).host} answered HTTP ${response.status}`)
    failure.code = 'http'
    failure.status = response.status
    throw failure
  }
  try {
    return await response.json()
  } catch {
    const failure = new Error(`${new URL(url).host} answered with something that is not JSON`)
    failure.code = 'malformed'
    throw failure
  }
}

/**
 * Fetch both upstream documents a report needs, concurrently.
 *
 * The profile document carries the numbers; the leaderboard row carries the
 * standing. They are independent requests against the same origin, so waiting
 * for one before starting the other only doubles the latency.
 *
 * @param options - account, period, fetch implementation, timeout.
 * @returns `{ profile, leaderboard }`, either of which may be `undefined` when
 *   that one document could not be read.
 * @throws only when the account itself does not exist; a missing leaderboard
 *   row degrades the standing line instead of failing the page.
 */
export async function fetchUpstream({ username, period, fetchImpl = globalThis.fetch, timeoutMs = 12_000 }) {
  const profileRequest = getJson(`${API_BASE}/api/users/${encodeURIComponent(username)}?period=${period}`, fetchImpl, timeoutMs)
  // A handle that has never submitted has no leaderboard row either, so this
  // one request is allowed to fail quietly: the profile request is the one
  // that decides whether the account exists.
  const leaderboardRequest = getJson(
    `${API_BASE}/api/leaderboard?period=${period}&search=${encodeURIComponent(username)}`,
    fetchImpl,
    timeoutMs,
  ).then(
    (value) => value,
    () => undefined,
  )
  const [profile, leaderboard] = await Promise.all([profileRequest, leaderboardRequest])
  return { profile, leaderboard }
}

/* ------------------------------------------------------------------ *
 * Pure derivation
 * ------------------------------------------------------------------ */

/** Sum a list of numbers, treating anything non-finite as zero. */
function sum(values) {
  let total = 0
  for (const value of values) if (Number.isFinite(value)) total += value
  return total
}

/** Coerce an upstream count to a finite number. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Coerce an upstream string to a trimmed non-empty string, or undefined. */
function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Messages per contribution day.
 *
 * `totals.messages` is not populated by the API (it reads 0 even on days the
 * profile page prints a message count for); the per-client rows are, so they
 * are the source.
 * @param contribution - one `contributions[]` entry.
 * @returns the day's message count.
 */
function dayMessages(contribution) {
  const clients = Array.isArray(contribution?.clients) ? contribution.clients : []
  return sum(clients.map((client) => num(client?.messages)))
}

/**
 * One normalized day of activity.
 * @param contribution - one `contributions[]` entry.
 * @returns the day as the browser half consumes it.
 */
function normalizeDay(contribution) {
  const totals = contribution?.totals ?? {}
  const breakdown = contribution?.tokenBreakdown ?? {}
  return {
    date: str(contribution?.date) ?? '',
    tokens: num(totals.tokens),
    cost: num(totals.cost),
    messages: dayMessages(contribution),
    intensity: num(contribution?.intensity),
    input: num(breakdown.input),
    output: num(breakdown.output),
    cacheRead: num(breakdown.cacheRead),
    cacheWrite: num(breakdown.cacheWrite),
    reasoning: num(breakdown.reasoning),
  }
}

/**
 * Fold the per-day client rows into one row per client.
 *
 * The profile document also has a top-level `clients` array, but it is only a
 * list of names for the whole history: it carries no numbers and ignores the
 * requested period. The per-day rows are both scoped and numeric.
 *
 * @param days - normalized days.
 * @returns client rows, largest first, with a share of the period's tokens.
 */
function foldClients(days, contributions) {
  const byClient = new Map()
  for (const contribution of contributions) {
    const clients = Array.isArray(contribution?.clients) ? contribution.clients : []
    for (const row of clients) {
      const name = str(row?.client) ?? 'unknown'
      const entry = byClient.get(name) ?? { client: name, tokens: 0, cost: 0, messages: 0 }
      entry.tokens += num(row?.tokens?.input) + num(row?.tokens?.output) + num(row?.tokens?.cacheRead) + num(row?.tokens?.cacheWrite)
      entry.cost += num(row?.cost)
      entry.messages += num(row?.messages)
      byClient.set(name, entry)
    }
  }
  const periodTokens = sum(days.map((day) => day.tokens))
  return [...byClient.values()]
    .map((entry) => ({ ...entry, share: periodTokens > 0 ? entry.tokens / periodTokens : 0 }))
    .sort((left, right) => right.tokens - left.tokens)
}

/**
 * Normalize `modelUsage` into the page's model table.
 *
 * `percentage` upstream is the **cost** share. Both shares are computed here so
 * the renderer can label whichever bar it draws, and the upstream value is kept
 * under its true name.
 *
 * Every row is sent, not a top-N: which models matter depends on the ordering
 * the reader picks, and ranking by tokens puts a different model first than
 * ranking by cost (39 % of the tokens against 19 % of the bill, in this
 * account's own data). The rows are small, and the page slices the ordering it
 * draws.
 *
 * @param modelUsage - `modelUsage[]` from the profile document.
 * @returns `{ rows, total }`, ordered by cost.
 */
function foldModels(modelUsage) {
  const rows = Array.isArray(modelUsage) ? modelUsage : []
  const totalTokens = sum(rows.map((row) => num(row?.tokens)))
  const normalized = rows
    .map((row) => ({
      model: str(row?.model) ?? 'unknown',
      tokens: num(row?.tokens),
      cost: num(row?.cost),
      costShare: num(row?.percentage) / 100,
      tokenShare: totalTokens > 0 ? num(row?.tokens) / totalTokens : 0,
    }))
    .sort((left, right) => right.cost - left.cost)
  return { rows: normalized, total: normalized.length }
}

/**
 * Longest run of active days ending at the newest day in the window.
 *
 * A day with no usage yet is not a broken streak: the window's last day is
 * today for every period, and a user who has not coded yet sees yesterday's
 * streak rather than zero.
 *
 * @param days - normalized days, oldest first.
 * @returns the streak length in days.
 */
function currentStreak(days) {
  let index = days.length - 1
  if (index >= 0 && days[index].tokens === 0) index -= 1
  let streak = 0
  while (index >= 0 && days[index].tokens > 0) {
    streak += 1
    index -= 1
  }
  return streak
}

/**
 * Weekday totals over the window, Monday first.
 * @param days - normalized days.
 * @returns seven token totals.
 */
function weekdayTotals(days) {
  const totals = [0, 0, 0, 0, 0, 0, 0]
  for (const day of days) {
    const parsed = new Date(`${day.date}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) continue
    // getUTCDay: 0 = Sunday. Shift so Monday is 0, matching how a work week is
    // read in both of the languages this page ships.
    totals[(parsed.getUTCDay() + 6) % 7] += day.tokens
  }
  return totals
}

/**
 * Build the wire report from the two upstream documents.
 *
 * @param options - upstream documents plus the identity that was requested.
 * @returns the report the browser half renders.
 */
export function buildReport({ profile, leaderboard, username, period, fetchedAt }) {
  const user = profile?.user ?? {}
  const stats = profile?.stats ?? {}
  const contributions = Array.isArray(profile?.contributions) ? profile.contributions : []
  const days = contributions.map(normalizeDay).filter((day) => day.date !== '')
  const totals = {
    tokens: num(stats.totalTokens),
    cost: num(stats.totalCost),
    input: num(stats.inputTokens),
    output: num(stats.outputTokens),
    cacheRead: num(stats.cacheReadTokens),
    cacheWrite: num(stats.cacheWriteTokens),
    reasoning: num(stats.reasoningTokens),
    messages: sum(days.map((day) => day.messages)),
    activeDays: days.filter((day) => day.tokens > 0).length,
    // Reported for the whole history only: the endpoint answers 0 for every
    // narrower window, which is "not counted here", not "no sessions".
    sessions: period === 'all' ? num(stats.sessionCount) : undefined,
    submissions: num(stats.submissionCount),
  }
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite
  totals.cacheHitRate = prompt > 0 ? totals.cacheRead / prompt : 0
  totals.costPerMillion = totals.tokens > 0 ? (totals.cost / totals.tokens) * 1_000_000 : 0
  totals.averagePerActiveDay = totals.activeDays > 0 ? totals.tokens / totals.activeDays : 0

  const best = days.reduce(
    (winner, day) => (winner === undefined || day.tokens > winner.tokens ? day : winner),
    undefined,
  )

  const row = Array.isArray(leaderboard?.users)
    ? leaderboard.users.find((entry) => String(entry?.username ?? '').toLowerCase() === username.toLowerCase())
    : undefined
  const networkStats = leaderboard?.stats ?? {}
  const standing = row === undefined
    ? undefined
    : {
        position: num(row.rank),
        // `pagination.totalUsers` counts the *search result* (1 when the search
        // matched one account), so the field size is `stats.uniqueUsers`. A
        // search response that somehow omitted it falls back to the page size,
        // which is wrong but bounded, rather than to 1, which is absurd.
        of: num(networkStats.uniqueUsers) || num(leaderboard?.pagination?.totalUsers),
        networkTokens: num(networkStats.totalTokens),
        networkCost: num(networkStats.totalCost),
        networkUsers: num(networkStats.uniqueUsers),
        url: leaderboardUrl(period),
        /**
         * Whether the public table's period and this profile period are the
         * same window.
         *
         * `week` and `all` are: the leaderboard row and the profile total agree
         * to the token. `month` is not — the table's month is the *calendar*
         * month to date, while the profile's is the last 30 days, and on the
         * 1st of a month they describe windows three orders of magnitude apart.
         * The page says which one it is showing rather than printing a rank
         * beside numbers from another window.
         */
        sameWindow: false,
      }
  if (standing !== undefined) {
    standing.share = standing.networkTokens > 0 ? totals.tokens / standing.networkTokens : 0
    // "Ahead of" rather than "top N %": the number a reader can check against
    // the public table is how many accounts are behind them.
    standing.aheadOf = standing.of > 0 && standing.position > 0 ? (standing.of - standing.position) / standing.of : 0
    const tableTokens = num(row.totalTokens)
    const scale = Math.max(tableTokens, totals.tokens, 1)
    standing.sameWindow = Math.abs(tableTokens - totals.tokens) / scale <= 0.01
    standing.tableTokens = tableTokens
    standing.tableCost = num(row.totalCost)
  }

  const models = foldModels(profile?.modelUsage)
  const freshness = profile?.submissionFreshness ?? {}
  const dateRange = profile?.dateRange ?? {}

  return {
    configured: true,
    username: str(user.username) ?? username,
    displayName: str(user.displayName),
    avatarUrl: str(user.avatarUrl),
    verified: user.verified === true,
    joinedAt: str(user.createdAt),
    profileUrl: profileUrl(str(user.username) ?? username),
    period,
    fetchedAt,
    window: { start: str(dateRange.start), end: str(dateRange.end) },
    totals,
    daily: days,
    best: best === undefined ? undefined : { date: best.date, tokens: best.tokens, cost: best.cost },
    streak: currentStreak(days),
    weekday: weekdayTotals(days),
    models,
    clients: foldClients(days, contributions),
    standing,
    freshness: {
      lastUpdated: str(freshness.lastUpdated),
      cliVersion: str(freshness.cliVersion),
      schemaVersion: num(freshness.schemaVersion),
      isStale: freshness.isStale === true,
      backfilled: profile?.hasBackfill === true,
    },
    upstream: {
      periods: PERIODS,
      docs: profile?.period ?? period,
    },
  }
}

/**
 * Assemble one complete report for an account and period.
 *
 * @param options - account, period, fetch implementation, clock.
 * @returns `{ ok: true, value }` with the report, or `{ ok: false, state }`
 *   carrying a state the page can explain (`unknown-account`) — only genuinely
 *   unexpected failures throw.
 */
export async function readReport({ username, period, fetchImpl = globalThis.fetch, timeoutMs, now = () => new Date() }) {
  let upstream
  try {
    upstream = await fetchUpstream({ username, period, fetchImpl, timeoutMs })
  } catch (error) {
    if (error?.code === 'not-found') {
      return { ok: false, state: 'unknown-account', username, period }
    }
    throw error
  }
  return {
    ok: true,
    value: buildReport({
      ...upstream,
      username,
      period,
      fetchedAt: now().toISOString(),
    }),
  }
}

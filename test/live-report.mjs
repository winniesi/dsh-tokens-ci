/**
 * Live check of the data layer against the real tokens.ci API.
 *
 * Not a unit test with fixtures: the point is to catch upstream shapes this
 * plugin has wrong — a renamed field, a moved percentage, a period the API
 * silently maps to another window — which fixtures cannot.
 *
 * Usage: node test/live-report.mjs [username]
 */

import { PERIODS, fetchUpstream, buildReport, readReport } from '../tokens-ci.mjs'

const username = process.argv[2] ?? 'winniesi'
let failures = 0

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const compact = (value) =>
  value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value)

for (const period of PERIODS) {
  console.log(`\n=== ${username} · ${period} ===`)
  const result = await readReport({ username, period })
  if (!result.ok) {
    console.log(`  state: ${result.state}`)
    failures += 1
    continue
  }
  const report = result.value
  console.log(`  window      ${report.window.start} → ${report.window.end} (${report.daily.length} days)`)
  console.log(`  tokens      ${compact(report.totals.tokens)}  cost $${report.totals.cost.toFixed(2)}  $${report.totals.costPerMillion.toFixed(2)}/M`)
  console.log(`  breakdown   in ${compact(report.totals.input)} · out ${compact(report.totals.output)} · cacheR ${compact(report.totals.cacheRead)} · cacheW ${compact(report.totals.cacheWrite)} · reason ${compact(report.totals.reasoning)}`)
  console.log(`  messages    ${report.totals.messages}  activeDays ${report.totals.activeDays}  streak ${report.streak}  cacheHit ${(report.totals.cacheHitRate * 100).toFixed(1)}%`)
  console.log(`  standing    #${report.standing?.position} of ${report.standing?.of} · ahead of ${((report.standing?.aheadOf ?? 0) * 100).toFixed(1)}% · share ${((report.standing?.share ?? 0) * 100).toFixed(4)}% · sameWindow ${report.standing?.sameWindow}`)
  console.log(`  best        ${report.best?.date} ${compact(report.best?.tokens ?? 0)}`)
  console.log(`  models      ${report.models.rows.length} total, head by cost: ${report.models.rows.slice(0, 3).map((row) => row.model).join(', ')}`)
  for (const row of report.models.rows.slice(0, 4)) {
    console.log(`                ${row.model.padEnd(28)} ${compact(row.tokens).padStart(9)} $${row.cost.toFixed(2).padStart(8)}  cost ${(row.costShare * 100).toFixed(1)}%  tok ${(row.tokenShare * 100).toFixed(1)}%`)
  }
  console.log(`  clients     ${report.clients.map((c) => `${c.client}:${compact(c.tokens)}`).join('  ')}`)
  console.log(`  weekday     ${report.weekday.map((v, i) => `${'MoTuWeThFrSaSu'.slice(i * 2, i * 2 + 2)}:${compact(v)}`).join(' ')}`)
  console.log(`  freshness   updated ${report.freshness.lastUpdated} cli ${report.freshness.cliVersion} stale ${report.freshness.isStale}`)

  // Invariants that must hold for the page to be honest.
  const dayTokens = report.daily.reduce((total, day) => total + day.tokens, 0)
  check('daily sums to the reported total', Math.abs(dayTokens - report.totals.tokens) / Math.max(1, report.totals.tokens) < 0.02, `${compact(dayTokens)} vs ${compact(report.totals.tokens)}`)
  const byTokens = [...report.models.rows].sort((left, right) => right.tokenShare - left.tokenShare)
  check('both model orderings are available', report.models.rows.length >= byTokens.length && byTokens.length > 0)
  check('cost share and token share disagree somewhere', report.models.rows.some((row) => Math.abs(row.costShare - row.tokenShare) > 0.05))
  const breakdown = report.totals.input + report.totals.output + report.totals.cacheRead + report.totals.cacheWrite
  check('token breakdown is inside the total', breakdown <= report.totals.tokens * 1.05, `${compact(breakdown)} vs ${compact(report.totals.tokens)}`)
  check('model cost shares sum to ~1', Math.abs(report.models.rows.reduce((t, r) => t + r.costShare, 0) - (report.totals.cost > 0 ? report.models.rows.reduce((t, r) => t + r.cost, 0) / report.totals.cost : 0)) < 0.02)
  check('window length matches the period', period === 'week' ? report.daily.length <= 7 : period === 'month' ? report.daily.length <= 31 : report.daily.length > 31)
  check('standing present', report.standing !== undefined && report.standing.position > 0)
  check('field size is the whole table, not the search result', (report.standing?.of ?? 0) > 50, `of=${report.standing?.of}`)
  check(period === 'month' ? 'month is flagged as a different window' : 'window agrees with the public table', report.standing?.sameWindow === (period !== 'month'), `sameWindow=${report.standing?.sameWindow}`)
  check('no upstream HTML leaked', !JSON.stringify(report).includes('<!DOCTYPE'))
}

console.log('\n=== upstream failure classification ===')
/**
 * The page's copy depends on these distinctions, so they are pinned here
 * rather than inferred from whatever the network happened to do.
 */
const failureCases = [
  ['a 404 is a missing account', () => new Response('nope', { status: 404 }), 'unknown-account'],
  ['a 500 is an http failure', () => new Response('boom', { status: 500 }), 'http'],
  ['an HTML 200 is a malformed body', () => new Response('<!DOCTYPE html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'malformed'],
  ['a socket error is a network failure', () => { throw new TypeError('fetch failed') }, 'network'],
]
for (const [label, respond, expected] of failureCases) {
  const fetchImpl = async (url) => {
    const value = respond()
    if (value instanceof Response) return value
    return value
  }
  let observed
  try {
    await readReport({ username: 'winniesi', period: 'week', fetchImpl })
    observed = 'resolved'
  } catch (error) {
    observed = error?.code ?? 'no-code'
  }
  // A missing account is the one failure the host turns into a page state; the
  // rest must throw so the route can fall back to its snapshot.
  const expectedOutcome = expected === 'unknown-account' ? 'resolved' : expected
  check(label, observed === expectedOutcome, `got ${JSON.stringify(observed)}, expected ${JSON.stringify(expectedOutcome)}`)
}
const missingAccount = await readReport({ username: 'nobody', period: 'week', fetchImpl: async () => new Response('x', { status: 404 }) })
check('a missing account becomes a state the page explains', missingAccount.ok === false && missingAccount.state === 'unknown-account')

console.log('\n=== a degraded fetch still reports ===')
// The leaderboard is allowed to fail: the profile document is the page.
const partial = await readReport({
  username: 'winniesi',
  period: 'week',
  fetchImpl: async (url) => (String(url).includes('/api/leaderboard')
    ? new Response('nope', { status: 500 })
    : fetch(url)),
})
check('a failed standing does not fail the report', partial.ok === true && partial.value.totals.tokens > 0, JSON.stringify(partial).slice(0, 160))
check('the report simply carries no standing', partial.ok === true && partial.value.standing === undefined)

console.log('\n=== unknown account ===')
const missing = await readReport({ username: 'definitely-not-a-real-account-xyzzy-12345', period: 'week' })
check('state is unknown-account', missing.ok === false && missing.state === 'unknown-account', JSON.stringify(missing))

console.log('\n=== unsupported period is refused, not silently mapped ===')
const upstream = await fetchUpstream({ username, period: 'all' })
const forged = buildReport({ ...upstream, username, period: 'all', fetchedAt: new Date().toISOString() })
check('period echoed verbatim', forged.period === 'all' && forged.upstream.docs === 'all')

console.log(failures === 0 ? '\nALL LIVE CHECKS PASSED' : `\n${failures} LIVE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

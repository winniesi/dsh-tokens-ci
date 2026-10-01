/**
 * Offline checks for the host half.
 *
 * Drives `apply` with a stub context, captures the exact Fetch route it
 * registers, and serves real `Request`s through it — so what is checked is the
 * route's actual behaviour: envelope shape, period validation, caching, the
 * snapshot hand-off, and the states the page explains instead of failing on.
 *
 * The account is read from the live tokens.ci API: fixtures cannot catch an
 * upstream rename, and a route that only works against a mock is not verified.
 *
 * Usage: node test/host-route.mjs [--child-no-account]
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** A fresh scratch home so the checks never touch the real ~/.dsh. */
function scratch(label) {
  return mkdtempSync(path.join(os.tmpdir(), `dsh-tokens-ci-${label}-`))
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/* ------------------------------------------------------------------ *
 * Child mode: a machine that names no account.
 * ------------------------------------------------------------------ */

if (process.argv.includes('--child-no-account')) {
  // No Git configuration, no `git`/`gh` on PATH, no home file to read. What the
  // route answers then is exactly what the parent is asserting about.
  const result = await runRoute({ config: undefined, dshHome: process.argv[3] ?? process.env.DSH_HOME })
  console.log(JSON.stringify(result.body.result, null, 1))
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * Harness for one plugin instance.
 * ------------------------------------------------------------------ */

/**
 * Instantiate the plugin against a stub context and return the route handler.
 * @param options - plugin config and the scratch directory to use.
 * @returns the captured route plus a `serve` helper that posts a payload.
 */
async function mount(options) {
  process.env.DSH_HOME = options.dshHome
  const { apply } = await import('../index.js')
  let route
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (callback) => {
      callback()
      return () => {}
    },
    connection: { fetch: { register: (registered) => {
      route = registered
      return async () => {}
    } } },
  }
  apply(ctx, options.config)
  if (route === undefined) throw new Error('plugin registered no route')
  return route
}

/** Post one client-request envelope and decode the answer. */
async function post(route, payload, overrides = {}) {
  const rpcId = overrides.rpcId ?? 'check-1'
  const body = overrides.raw ?? JSON.stringify({
    type: 'client-request',
    rpcId,
    method: overrides.method ?? 'tokens-ci/report',
    payload,
  })
  const response = await route.fetch(new Request(`http://127.0.0.1:3080${route.path}`, {
    method: overrides.httpMethod ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }))
  let parsed
  try {
    parsed = await response.json()
  } catch {
    parsed = undefined
  }
  return { status: response.status, body: parsed }
}

/** Run one report request end to end on a fresh instance. */
async function runRoute(options) {
  const route = await mount(options)
  return post(route, options.payload ?? { period: options.period ?? 'week' })
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

console.log('=== route registration ===')
const home = scratch('route')
const route = await mount({ dshHome: home, config: { username: 'winniesi' } })
check('route path is the shared /api channel endpoint', route.path === '/api/tokens-ci/report', route.path)
check('route owns POST only', Array.isArray(route.methods) && route.methods.length === 1 && route.methods[0] === 'POST', JSON.stringify(route.methods))
check('route buffers its body', route.requestBody === 'buffered', String(route.requestBody))
check('route exposes a Fetch handler', typeof route.fetch === 'function')

console.log('\n=== happy path (live upstream) ===')
const first = await post(route, { period: 'week' })
check('HTTP 200', first.status === 200, String(first.status))
check('server-response envelope', first.body?.type === 'server-response' && first.body.rpcId === 'check-1', JSON.stringify(first.body)?.slice(0, 120))
check('result is ok', first.body?.result?.ok === true, JSON.stringify(first.body?.result)?.slice(0, 200))
const report = first.body?.result?.value
check('period echoed', report?.period === 'week', String(report?.period))
check('source is live', report?.source === 'live', String(report?.source))
check('daily window is 7 days', Array.isArray(report?.daily) && report.daily.length === 7, String(report?.daily?.length))
check('totals carry tokens and cost', report?.totals?.tokens > 0 && report?.totals?.cost > 0, JSON.stringify(report?.totals)?.slice(0, 120))
check('standing is a rank in the whole table', report?.standing?.position > 0 && report?.standing?.of > 50, JSON.stringify(report?.standing)?.slice(0, 160))
check('models folded with both shares', report?.models?.rows?.length > 0 && typeof report.models.rows[0].costShare === 'number' && typeof report.models.rows[0].tokenShare === 'number')
check('clients folded from the daily rows', report?.clients?.length > 0 && report.clients[0].tokens > 0, JSON.stringify(report?.clients?.[0]))
check('week agrees with the public table', report?.standing?.sameWindow === true, String(report?.standing?.sameWindow))

console.log('\n=== cache ===')
const second = await post(route, { period: 'week' })
check('second read is answered from memory', second.body?.result?.value?.source === 'memory', String(second.body?.result?.value?.source))
check('cached read reports its age', second.body?.result?.value?.ageMs >= 0, String(second.body?.result?.value?.ageMs))
const forced = await post(route, { period: 'week', refresh: true })
check('refresh bypasses the cache', forced.body?.result?.value?.source === 'live', String(forced.body?.result?.value?.source))

console.log('\n=== snapshot hand-off ===')
const snapshotFile = path.join(home, 'dsh-tokens-ci', 'report-week.json')
const stored = JSON.parse(readFileSync(snapshotFile, 'utf8'))
check('snapshot written for the period', stored.version === 1 && stored.report.period === 'week')
const snapshotMode = (await import('node:fs')).statSync(snapshotFile).mode & 0o777
check('snapshot is private to the user', snapshotMode === 0o600, snapshotMode.toString(8))
const cold = await post(await mount({ dshHome: home, config: { username: 'winniesi' } }), { period: 'week' })
check('a cold instance answers from the snapshot', cold.body?.result?.value?.source === 'snapshot', String(cold.body?.result?.value?.source))
check('the snapshot carries the same numbers', cold.body?.result?.value?.totals?.tokens === report?.totals?.tokens)

console.log('\n=== where the account guess comes from ===')
{
  const { internals } = await import('../index.js')
  const write = (dir, file, text) => {
    const target = path.join(dir, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, text)
    return target
  }
  const xdgOnly = scratch('xdg')
  write(xdgOnly, '.config/git/config', '[user]\n\tname = legacy-user\n')
  const xdgSeen = internals.probeGitConfig(xdgOnly, {})
  check('git’s XDG config is read', xdgSeen.name === 'legacy-user', JSON.stringify(xdgSeen))

  const both = scratch('both')
  write(both, '.config/git/config', '[github]\n\tuser = from-xdg\n')
  write(both, '.gitconfig', '[github]\n\tuser = from-legacy\n')
  check('~/.gitconfig still wins, as git does', internals.probeGitConfig(both, {}).handle === 'from-legacy', JSON.stringify(internals.probeGitConfig(both, {})))

  const explicit = scratch('xdg-env')
  write(explicit, 'custom/git/config', '[github]\n\tuser = from-env\n')
  check('XDG_CONFIG_HOME is honoured', internals.probeGitConfig(explicit, { XDG_CONFIG_HOME: path.join(explicit, 'custom') }).handle === 'from-env')

  const empty = scratch('no-config')
  check('an unconfigured machine yields nothing', internals.probeGitConfig(empty, {}).handle === undefined && internals.probeGitConfig(empty, {}).name === undefined)
  for (const dir of [xdgOnly, both, explicit, empty]) rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== bad requests ===')
const wrongMethod = await post(route, { period: 'week' }, { method: 'tokens-ci/other' })
check('wrong endpoint is a bad-request', wrongMethod.body?.result?.ok === false && wrongMethod.body.result.error.code === 'bad-request')
const badPeriod = await post(route, { period: 'day' })
check('unsupported period is refused, not mapped', badPeriod.body?.result?.ok === false && badPeriod.body.result.error.code === 'bad-request', JSON.stringify(badPeriod.body?.result?.error))
const notJson = await post(route, { period: 'week' }, { raw: 'not json at all' })
check('non-JSON body is an HTTP 400', notJson.status === 400, String(notJson.status))
const malformed = await post(route, { period: 'week' }, { raw: JSON.stringify({ hello: 'world' }) })
check('malformed envelope is a bad-request', malformed.body?.result?.ok === false && malformed.body.result.error.code === 'bad-request')

console.log('\n=== upstream states ===')
const missingRoute = await mount({ dshHome: scratch('missing'), config: { username: 'definitely-not-a-real-account-xyzzy-12345' } })
const missing = await post(missingRoute, { period: 'week' })
check('unknown account is a state, not an error', missing.body?.result?.ok === true && missing.body.result.value.state === 'unknown-account', JSON.stringify(missing.body?.result?.value))

/** Run the plugin in a child process whose machine names no account at all. */
function runBare(dshHome) {
  const env = { HOME: path.join(dshHome, 'empty-home'), DSH_HOME: dshHome, PATH: '/nonexistent' }
  return JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--child-no-account', dshHome], {
    cwd: root,
    encoding: 'utf8',
    env,
  }))
}

console.log('\n=== the account the reader chooses ===')
const savedHome = scratch('saved')
const savedRoute = await mount({ dshHome: savedHome, config: undefined })
const chosen = await post(savedRoute, { period: 'week', username: 'winniesi' })
check('a posted account is used at once', chosen.body?.result?.value?.account?.name === 'winniesi', JSON.stringify(chosen.body?.result?.value?.account))
check('and is marked as the reader’s choice', chosen.body?.result?.value?.account?.origin === 'saved in this page', String(chosen.body?.result?.value?.account?.origin))
const settingsFile = path.join(savedHome, 'dsh-tokens-ci', 'settings.json')
const settingsMode = (await import('node:fs')).statSync(settingsFile).mode & 0o777
check('the choice is kept on disk', JSON.parse(readFileSync(settingsFile, 'utf8')).username === 'winniesi')
check('and is private to the user', settingsMode === 0o600, settingsMode.toString(8))

const absurd = await post(savedRoute, { period: 'week', username: 'not a handle' })
check('a malformed handle is refused', absurd.body?.result?.ok === false && absurd.body.result.error.code === 'bad-request', JSON.stringify(absurd.body?.result?.error))
const swapped = await post(savedRoute, { period: 'week', username: 'definitely-not-a-real-account-xyzzy-12345' })
check('another account is not answered from the first one’s cache', swapped.body?.result?.value?.state === 'unknown-account', JSON.stringify(swapped.body?.result?.value)?.slice(0, 160))
const back = await post(savedRoute, { period: 'week', username: 'winniesi' })
check('and switching back reports the first account again', back.body?.result?.value?.account?.name === 'winniesi' && back.body.result.value.state === undefined)
const cleared = await post(savedRoute, { period: 'week', username: null })
check('a null account forgets the choice', !(await import('node:fs')).existsSync(settingsFile) && cleared.body?.result?.ok === true)

console.log('\n=== the row’s default period ===')
const monthRoute = await mount({ dshHome: scratch('period'), config: { username: 'winniesi', period: 'month' } })
const noPeriod = await post(monthRoute, { refresh: true })
check('a request without a period takes the row’s', noPeriod.body?.result?.value?.period === 'month', String(noPeriod.body?.result?.value?.period))
const explicit = await post(monthRoute, { period: 'all' })
check('an explicit period still wins', explicit.body?.result?.value?.period === 'all', String(explicit.body?.result?.value?.period))

console.log('\n=== a machine that names no account ===')
const bare = scratch('bare')
const child = runBare(path.join(bare, '.dsh'))
check('reports the no-account state', child.ok === true && child.value.state === 'no-account', JSON.stringify(child.value)?.slice(0, 200))
check('names every probe it tried', Array.isArray(child.value.probed) && child.value.probed.length === 3, JSON.stringify(child.value.probed))

console.log('\n=== a machine that lost the account but kept the snapshot ===')
const orphanHome = scratch('orphan')
const orphanRoute = await mount({ dshHome: orphanHome, config: { username: 'winniesi' } })
await post(orphanRoute, { period: 'week' })
const orphan = runBare(orphanHome)
check('the snapshot keeps answering for the account it names',
  orphan.ok === true && orphan.value.username === 'winniesi' && orphan.value.account?.origin === 'the last saved reading',
  JSON.stringify(orphan.value?.account))
check('and it is still labelled as a cached reading', orphan.value.source === 'snapshot', String(orphan.value?.source))

console.log('\n=== a machine that lost the account but kept the reader’s choice ===')
const keptHome = scratch('kept')
const keptRoute = await mount({ dshHome: keptHome, config: undefined })
await post(keptRoute, { period: 'week', username: 'winniesi' })
const kept = runBare(keptHome)
check('the saved account survives a restart into a bare machine',
  kept.ok === true && kept.value.account?.name === 'winniesi' && kept.value.account?.origin === 'saved in this page',
  JSON.stringify(kept.value?.account))

for (const leftover of [home, bare, orphanHome, keptHome, savedHome]) rmSync(leftover, { recursive: true, force: true })
rmSync(bare, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL HOST CHECKS PASSED' : `\n${failures} HOST CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

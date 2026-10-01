/**
 * Offline checks for the browser half.
 *
 * Loads the shipped bundle exactly as the module loader would, runs its
 * factory, drives `apply` against a stub client context to inspect what it
 * registers, then renders every visual state to static markup with
 * react-dom/server — the same React the page uses.
 *
 * Rendering is not a screenshot and does not claim to be one. What it does
 * establish is stronger than a syntax check: the component tree builds, no
 * state throws (a throwing component blanks the slot silently in the browser),
 * the copy is interpolated, and the numbers reach the markup formatted.
 *
 * Usage: node test/render.mjs
 */

import { readFileSync } from 'node:fs'
import path, { join } from 'node:path'

import { dshPackageDir, packageDir as root, requireFromProfile } from './support.mjs'

/** React comes from the profile, because that is the instance the page uses. */
const React = requireFromProfile('react')
const { renderToStaticMarkup } = requireFromProfile('react-dom/server')
const h = React.createElement

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
 * Load the bundle the way the module system does
 * ------------------------------------------------------------------ */

console.log('=== bundle contract ===')
const source = readFileSync(path.join(root, 'client.js'), 'utf8')
const registrations = []
const fakeWindow = {
  __ModuleLoader__: {
    load: (definition) => registrations.push(definition),
  },
}
/** Just enough DOM for the stylesheet effect, which the browser would run. */
const stylesheets = []
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({
    set id(value) {
      this._id = value
    },
    set textContent(value) {
      stylesheets.push(value)
    },
    remove: () => {},
  }),
  head: { appendChild: () => {} },
}
// eslint-disable-next-line no-new-func
new Function('window', 'document', source)(fakeWindow, fakeDocument)
check('registers exactly one factory', registrations.length === 1, String(registrations.length))
const definition = registrations[0]
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
check('factory id equals the package name', definition.id === manifest.name, `${definition.id} vs ${manifest.name}`)
check('package declares the client half', manifest.dsh?.client?.platform === 'web')
check('package exports ./client', manifest.exports?.['./client'] === './client.js')

const plugin = definition.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require(${JSON.stringify(specifier)}) from the client bundle`)
})
check('exports apply()', typeof plugin.apply === 'function')
check('injects slots, connection and locale', JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'connection', 'locale']), JSON.stringify(plugin.inject))

/* ------------------------------------------------------------------ *
 * Drive apply() against a stub client context
 * ------------------------------------------------------------------ */

console.log('\n=== registration ===')
const effects = []
const dictionaries = []
const injected = []
const slotKeys = []
let registration
let rpcCall
const ctx = {
  effect: (callback, label) => {
    const disposer = callback()
    effects.push({ label, disposer })
    return () => {}
  },
  locale: {
    register: (namespace, dicts) => {
      dictionaries.push({ namespace, dicts })
      return () => {}
    },
    bind: (namespace) => (key) => dictionaries.find((entry) => entry.namespace === namespace)?.dicts.en[key] ?? key,
  },
  slots: {
    inject: (key, callback) => {
      slotKeys.push(key)
      callback()
      return () => {}
    },
    register: (options, component) => {
      registration = { options, component }
      return () => {}
    },
  },
  connection: {
    rpc: {
      call: (...args) => {
        rpcCall = args
        return Promise.resolve({ ok: true, value: { state: 'error' } })
      },
    },
  },
}
plugin.apply(ctx)

check('installs a stylesheet effect', effects.some((effect) => effect.label.includes('stylesheet')), JSON.stringify(effects.map((e) => e.label)))
check('registers one locale namespace', dictionaries.length === 1 && dictionaries[0].namespace === plugin.__test.NS, JSON.stringify(dictionaries.map((d) => d.namespace)))
const en = Object.keys(dictionaries[0].dicts.en).sort()
const zh = Object.keys(dictionaries[0].dicts.zh).sort()
check('both dictionaries carry the same keys', JSON.stringify(en) === JSON.stringify(zh), `en-only: ${en.filter((k) => !zh.includes(k))} zh-only: ${zh.filter((k) => !en.includes(k))}`)
check('injects into settings.section', slotKeys.length === 1 && slotKeys[0] === 'settings.section', JSON.stringify(slotKeys))
check('registration targets settings.section', registration?.options?.name === 'settings.section', String(registration?.options?.name))
check('registration has a stable section id', registration?.options?.id === 'tokens-ci', String(registration?.options?.id))
check('registration declares its locale namespace', registration?.options?.locale === plugin.__test.NS, String(registration?.options?.locale))
check('nav label is a thunk returning localized text', registration?.options?.label?.() === 'Tokens.ci', String(registration?.options?.label?.()))
check('component is a function', typeof registration?.component === 'function')
const face = registration.options.inject()
check('inject face exposes fetchReport', typeof face.fetchReport === 'function')
await face.fetchReport({ period: 'week' }, undefined)
check('fetchReport posts to the host endpoint', rpcCall?.[0] === '/api' && rpcCall?.[1] === 'tokens-ci/report', JSON.stringify(rpcCall?.slice(0, 2)))
await face.fetchReport({ period: 'week', username: 'someone' }, undefined)
check('fetchReport carries a chosen account verbatim', rpcCall?.[2]?.username === 'someone', JSON.stringify(rpcCall?.[2]))

/* ------------------------------------------------------------------ *
 * Stylesheet
 * ------------------------------------------------------------------ */

console.log('\n=== stylesheet ===')
const css = stylesheets.join('\n')
check('injects exactly one stylesheet', stylesheets.length === 1, String(stylesheets.length))
check('every rule is namespaced', !/(^|\})\s*(?![.@:]|\/\*)[a-z]/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'unprefixed selector')
check('no literal colours outside the series fallback', !/#[0-9a-fA-F]{3,8}\b/.test(css), (css.match(/#[0-9a-fA-F]{3,8}\b/) ?? [])[0])
check('the page adapts when the panel narrows', css.includes('container-type:inline-size') && css.includes('@container (max-width:460px)'))
check('focus rings keep the theme fallback', !/--dsw-focus-ring-color\)/.test(css) && (css.match(/--dsw-focus-ring-color,/g) ?? []).length >= 3)

try {
  const theme = readFileSync(join(dshPackageDir(), 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'), 'utf8')
  const known = new Set(theme.match(/--dsw-[a-z0-9-]+/g) ?? [])
  const used = new Set(css.match(/--dsw-[a-z0-9-]+/g) ?? [])
  const unknown = [...used].filter((token) => !known.has(token))
  check(`all ${used.size} theme tokens exist in the installed theme`, unknown.length === 0, unknown.join(', '))
} catch (error) {
  console.log(`  SKIP the theme token check could not run: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

console.log('\n=== formatting ===')
const { compact, money, percent, formatDay, group } = plugin.__test.format
const formatCases = [
  ['compact 0', compact(0), '0'],
  ['compact below a thousand', compact(999), '999'],
  ['compact thousands', compact(3_619), '3.62K'],
  ['compact hundreds stay exact', compact(451), '451'],
  ['compact hundred-thousands', compact(721_435), '721.4K'],
  ['compact millions', compact(540_480_761), '540.5M'],
  ['compact billions', compact(3_186_087_684), '3.19B'],
  ['compact trillions', compact(8_587_307_473_026), '8.59T'],
  ['compact refuses a non-number', compact(undefined), '—'],
  ['money zero', money(0), '$0'],
  ['money a dime keeps two decimals', money(0.1), '$0.10'],
  ['money tens', money(93.804), '$93.80'],
  ['money four-digit', money(1234.5), '$1,235'],
  ['money sub-cent keeps precision', money(0.0004), '$0.0004'],
  ['money refuses a non-number', money(undefined), '—'],
  ['percent', percent(0.4453), '44.5%'],
  ['percent three digits', percent(0.001377, 3), '0.138%'],
  ['percent refuses a non-number', percent(undefined), '—'],
  ['group refuses a non-number', group(undefined), '—'],
  ['a UTC day stays on its own date', formatDay('2026-10-01', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }), 'Oct 1, 2026'],
  ['an unparseable day echoes itself', formatDay('nonsense', { month: 'short' }), 'nonsense'],
]
for (const [label, actual, expected] of formatCases) {
  check(`${label} → ${expected}`, actual === expected, `got ${JSON.stringify(actual)}`)
}

/* ------------------------------------------------------------------ *
 * Model ranking
 * ------------------------------------------------------------------ */

console.log('\n=== model ranking ===')
const modelTable = {
  rows: [
    { model: 'big-bill', tokens: 100, cost: 90, costShare: 0.9, tokenShare: 0.01 },
    { model: 'big-volume', tokens: 9_000, cost: 10, costShare: 0.1, tokenShare: 0.9 },
    { model: 'middle', tokens: 900, cost: 5, costShare: 0.05, tokenShare: 0.09 },
  ],
}
const byCost = plugin.__test.rankModels(modelTable, 'cost')
const byTokens = plugin.__test.rankModels(modelTable, 'tokens')
check('cost ordering leads with the expensive model', byCost.rows[0].model === 'big-bill' && byCost.key === 'costShare')
check('token ordering leads with the voluminous model', byTokens.rows[0].model === 'big-volume' && byTokens.key === 'tokenShare')
check('the two orderings really differ', byCost.rows.map((r) => r.model).join() !== byTokens.rows.map((r) => r.model).join())
check('ranking survives a missing model table', plugin.__test.rankModels(undefined, 'cost').rows.length === 0)
check('ranking truncates and counts the rest', plugin.__test.rankModels({ rows: modelTable.rows.concat(modelTable.rows, modelTable.rows, modelTable.rows) }, 'cost').more === 4)

/* ------------------------------------------------------------------ *
 * Render every state
 * ------------------------------------------------------------------ */

const { ReportView, LoadingPanel, AccountForm, UnknownAccountPanel, ErrorPanel, DICT } = plugin.__test
const dict = DICT.en
const t = (key, params) => {
  const template = dict[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

const render = (element) => renderToStaticMarkup(element)

function report(overrides = {}) {
  const daily = overrides.daily ?? [
    { date: '2026-09-25', tokens: 110_010_000, cost: 12.4, messages: 410, intensity: 3, input: 5_100_000, output: 520_000, cacheRead: 104_000_000, cacheWrite: 0, reasoning: 90_000 },
    { date: '2026-09-26', tokens: 284_870_000, cost: 35.18, messages: 900, intensity: 4, input: 12_400_000, output: 1_200_000, cacheRead: 271_000_000, cacheWrite: 0, reasoning: 270_000 },
    { date: '2026-09-27', tokens: 0, cost: 0, messages: 0, intensity: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { date: '2026-09-28', tokens: 63_020_000, cost: 7.1, messages: 250, intensity: 2, input: 3_000_000, output: 210_000, cacheRead: 59_000_000, cacheWrite: 0, reasoning: 40_000 },
    { date: '2026-09-29', tokens: 260_500_000, cost: 30.2, messages: 810, intensity: 4, input: 11_000_000, output: 980_000, cacheRead: 248_000_000, cacheWrite: 0, reasoning: 180_000 },
    { date: '2026-09-30', tokens: 63_450_000, cost: 6.9, messages: 240, intensity: 2, input: 3_100_000, output: 190_000, cacheRead: 60_000_000, cacheWrite: 0, reasoning: 30_000 },
    { date: '2026-10-01', tokens: 18_160_000, cost: 2.02, messages: 90, intensity: 1, input: 900_000, output: 60_000, cacheRead: 17_000_000, cacheWrite: 0, reasoning: 12_000 },
  ]
  const tokens = daily.reduce((sum, day) => sum + day.tokens, 0)
  const cost = daily.reduce((sum, day) => sum + day.cost, 0)
  return {
    configured: true,
    username: 'winniesi',
    displayName: undefined,
    avatarUrl: 'https://avatars.githubusercontent.com/u/13885511?v=4',
    verified: false,
    joinedAt: '2026-10-01T09:33:38.494Z',
    profileUrl: 'https://tokens.ci/u/winniesi',
    period: 'week',
    fetchedAt: new Date(Date.now() - 120_000).toISOString(),
    source: 'live',
    window: daily.length === 0
      ? { start: '2026-09-25', end: '2026-10-01' }
      : { start: daily[0].date, end: daily[daily.length - 1].date },
    totals: {
      tokens,
      cost,
      input: 35_500_000,
      output: 3_160_000,
      cacheRead: 759_000_000,
      cacheWrite: 0,
      reasoning: 622_000,
      messages: 2_700,
      activeDays: daily.filter((day) => day.tokens > 0).length,
      sessions: undefined,
      submissions: 2,
      cacheHitRate: 0.955,
      costPerMillion: tokens === 0 ? 0 : (cost / tokens) * 1_000_000,
      averagePerActiveDay: daily.filter((day) => day.tokens > 0).length === 0
        ? 0
        : tokens / daily.filter((day) => day.tokens > 0).length,
    },
    daily,
    best: daily.length === 0 ? undefined : { date: '2026-09-26', tokens: 284_870_000, cost: 35.18 },
    streak: 2,
    weekday: [0, 0, 0, 0, 0, 0, 0],
    models: {
      rows: [
        { model: 'glm-5.3', tokens: 131_320_000, cost: 42.96, costShare: 0.646, tokenShare: 0.242 },
        { model: 'gemini-3.8-flash-high', tokens: 71_120_000, cost: 10.08, costShare: 0.152, tokenShare: 0.131 },
        { model: 'glm-5.3-flash', tokens: 127_510_000, cost: 4.86, costShare: 0.073, tokenShare: 0.235 },
        { model: 'gemini-3.8-flash', tokens: 29_930_000, cost: 5.36, costShare: 0.081, tokenShare: 0.055 },
        { model: 'deepseek-v4.1-flash', tokens: 4_100_000, cost: 0.42, costShare: 0.006, tokenShare: 0.008 },
        { model: 'hy3', tokens: 9_300_000, cost: 0.44, costShare: 0.007, tokenShare: 0.017 },
        { model: 'kimi-k3-1', tokens: 332_100, cost: 0.56, costShare: 0.008, tokenShare: 0.001 },
        { model: 'claude-opus-4-6-thinking', tokens: 138_600, cost: 0.72, costShare: 0.011, tokenShare: 0.0003 },
        { model: 'claude-sonnet-4-6', tokens: 502_400, cost: 0.84, costShare: 0.013, tokenShare: 0.001 },
        { model: 'deepseek-v4-pro', tokens: 1_100_000, cost: 0.04, costShare: 0.001, tokenShare: 0.002 },
      ],
      total: 10,
    },
    clients: [
      { client: 'zcode', tokens: 389_050_000, cost: 40.1, messages: 1_800, share: 0.72 },
      { client: 'dsh', tokens: 153_950_000, cost: 22.3, messages: 900, share: 0.28 },
    ],
    standing: {
      position: 151,
      of: 272,
      networkTokens: 580_978_139_083,
      networkCost: 251_427.9,
      networkUsers: 272,
      url: 'https://tokens.ci/leaderboard?period=week',
      sameWindow: true,
      share: tokens / 580_978_139_083,
      aheadOf: (272 - 151) / 272,
      tableTokens: tokens,
      tableCost: cost,
    },
    freshness: { lastUpdated: new Date(Date.now() - 60_000).toISOString(), cliVersion: '27.1.1', schemaVersion: 2, isStale: false, backfilled: false },
    ...overrides,
  }
}

console.log('\n=== rendered states ===')
const cases = [
  ['live week', h(ReportView, { report: report(), period: 'week', metric: 'tokens', busy: false, t })],
  ['cost metric', h(ReportView, { report: report(), period: 'week', metric: 'cost', busy: false, t })],
  ['busy', h(ReportView, { report: report(), period: 'week', metric: 'tokens', busy: true, t })],
  ['snapshot', h(ReportView, { report: report({ source: 'snapshot', stale: true, error: 'cannot reach tokens.ci' }), period: 'week', metric: 'tokens', busy: false, t })],
  ['month with a different table window', h(ReportView, {
    report: report({ period: 'month', standing: { ...report().standing, sameWindow: false, position: 167, of: 182 } }),
    period: 'month',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['all time with sessions', h(ReportView, {
    report: report({ period: 'all', totals: { ...report().totals, sessions: 1447 } }),
    period: 'all',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['stale account', h(ReportView, {
    report: report({ daily: report().daily.map((day, index) => ({ ...day, date: `2026-06-${String(index + 1).padStart(2, '0')}` })), window: { start: '2026-06-01', end: '2026-06-07' } }),
    period: 'week',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['verified with a chosen account', h(ReportView, {
    report: report({ verified: true, account: { name: 'winniesi', origin: 'saved in this page' } }),
    period: 'week',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['no standing', h(ReportView, { report: report({ standing: undefined }), period: 'week', metric: 'tokens', busy: false, t })],
  ['no models or clients', h(ReportView, {
    report: report({ models: { rows: [], total: 0, more: 0, totalTokens: 0, totalCost: 0 }, clients: [] }),
    period: 'week',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['all zeros', h(ReportView, {
    report: report({
      daily: [{ date: '2026-10-01', tokens: 0, cost: 0, messages: 0, intensity: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }],
      best: { date: '2026-10-01', tokens: 0, cost: 0 },
      streak: 0,
      models: { rows: [], total: 0, more: 0, totalTokens: 0, totalCost: 0 },
      clients: [],
      totals: { tokens: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, messages: 0, activeDays: 0, sessions: undefined, submissions: 0, cacheHitRate: 0, costPerMillion: 0, averagePerActiveDay: 0 },
      standing: undefined,
    }),
    period: 'week',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['empty window', h(ReportView, { report: report({ daily: [] }), period: 'week', metric: 'tokens', busy: false, t })],
  ['missing totals', h(ReportView, { report: { ...report(), totals: undefined }, period: 'week', metric: 'tokens', busy: false, t })],
  ['bare identity', h(ReportView, {
    report: report({ username: undefined, displayName: undefined, avatarUrl: undefined, joinedAt: undefined, profileUrl: undefined, verified: undefined, freshness: undefined, window: undefined, streak: undefined }),
    period: 'week',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['malformed day', h(ReportView, {
    report: report({ daily: [{ ...report().daily[0], date: 'not-a-date' }] }),
    period: 'week',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['absurd magnitudes', h(ReportView, {
    report: report({
      displayName: 'A Display Name Long Enough To Be Truncated Somewhere In This Column',
      models: { rows: [{ model: 'x'.repeat(140), tokens: 1e15, cost: 1_234_567.89, costShare: 0.99, tokenShare: 0.99 }], total: 1 },
      totals: { ...report().totals, tokens: 1e15, cost: 1_234_567.89, messages: 1e9, activeDays: 94, cacheHitRate: 1, costPerMillion: 1.23 },
    }),
    period: 'all',
    metric: 'cost',
    busy: false,
    t,
  })],
  ['long history', h(ReportView, {
    report: report({
      period: 'all',
      daily: Array.from({ length: 94 }, (_, index) => ({
        date: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
        tokens: index * 3_100_000,
        cost: index * 0.4,
        messages: index * 7,
        intensity: index % 5,
        input: index * 100_000,
        output: index * 9_000,
        cacheRead: index * 2_900_000,
        cacheWrite: 0,
        reasoning: index * 4_000,
      })),
    }),
    period: 'all',
    metric: 'tokens',
    busy: false,
    t,
  })],
  ['loading', h(LoadingPanel, { t })],
  ['account form', h(AccountForm, { probed: ['git config github.user', 'gh api user'], onSubmit: () => {}, t })],
  ['account form with a bad value', h(AccountForm, { initial: 'not a handle', onSubmit: () => {}, t })],
  ['account form while saving', h(AccountForm, { initial: 'winniesi', busy: true, onSubmit: () => {}, onCancel: () => {}, t })],
  ['account form with an error', h(AccountForm, { onSubmit: () => {}, error: 'cannot reach tokens.ci: fetch failed', t })],
  ['unknown account', h(UnknownAccountPanel, { report: { username: 'nobody' }, onChange: () => {}, t })],
  ['error', h(ErrorPanel, { message: 'cannot reach tokens.ci: fetch failed', onRetry: () => {}, t })],
  ['error with no message', h(ErrorPanel, { onRetry: () => {}, t })],
  ['host half not loaded', h(ErrorPanel, { message: 'transport failure for /api/tokens-ci/report: HTTP 404', onRetry: () => {}, t })],
]

const markup = new Map()
for (const [label, element] of cases) {
  try {
    const html = render(element)
    markup.set(label, html)
    const problems = []
    if (html.includes('NaN')) problems.push('NaN')
    if (html.includes('undefined')) problems.push('undefined')
    if (html.includes('>null<')) problems.push('null')
    if (html.includes('{')) problems.push('uninterpolated placeholder')
    // A page state is only a title and a body; a drawn report carries the
    // whole chart, stat grid and card furniture.
    const statePanels = ['loading', 'account form', 'account form with a bad value', 'account form while saving', 'account form with an error', 'unknown account', 'error', 'error with no message', 'host half not loaded', 'empty window']
    if (!statePanels.includes(label)) {
      if (!html.includes('tci-bar')) problems.push('no chart bars')
      if (!html.includes('tci-stats')) problems.push('no stat grid')
      if (!html.includes('tci-card')) problems.push('no cards')
    }
    if (statePanels.includes(label) && html.length < 180) problems.push(`panel rendered almost nothing (${html.length})`)
    check(`renders ${label}`, problems.length === 0, problems.join(', '))
  } catch (error) {
    check(`renders ${label}`, false, error instanceof Error ? error.message : String(error))
  }
}

console.log('\n=== content ===')
{
  // Every declared class must appear in the markup of at least one rendered
  // state — a rule nobody uses is dead weight that survives review silently.
  const declared = [...new Set([...css.matchAll(/\.(tci-[a-z0-9-]+)/g)].map((match) => match[1]))]
  const rendered = [...markup.values()].join('\n')
  // `tci-readout-day` styles the readout once a bar is hovered or focused, a
  // state static rendering never enters; everything else must be reachable.
  const interactionOnly = new Set(['tci-readout-day'])
  const orphans = declared.filter((name) => !interactionOnly.has(name) && !rendered.includes(name))
  check(`no stylesheet rule is dead (${declared.length} classes)`, orphans.length === 0, orphans.join(', '))
}
const week = markup.get('live week') ?? ''
check('shows the account handle', week.includes('@winniesi'))
check('surfaces today beside the window', week.includes('Today') && week.includes('Joined Oct 2026'))
check('labels the join month', week.includes('Joined'))
check('shows the window dates', week.includes('Sep 25') && week.includes('Oct 1'))
check('shows the token total', week.includes('800.0M'))
check('shows the cost', week.includes('$93.80'))
check('shows the rank', week.includes('#151'))
check('shows the field share', week.includes('0.138%'))
check('every day is a focusable button', (week.match(/class="tci-bar"/g) ?? []).length === 7, String((week.match(/class="tci-bar"/g) ?? []).length))
check('today carries its own marker', week.includes('data-today="true"'))
check('zero days are marked', week.includes('data-zero="true"'))
check('the chart exposes one tab stop', (week.match(/tabindex="0"/g) ?? []).length === 1, String((week.match(/tabindex="0"/g) ?? []).length))
check('every bar has an accessible name', (week.match(/aria-label="[^"]*tokens[^"]*messages"/g) ?? []).length === 7)
check('the mix legend names each series', week.includes('Cache read') && week.includes('Input') && week.includes('Output'))
check('model rows carry the cost share', week.includes('64.6%'))
check('the model card offers both orderings', week.includes('By cost') && week.includes('By tokens'))
check('the model card names the share it draws', week.includes('Share of the window’s cost'))
check('the model card counts what it did not show', week.includes('2 more not shown'))
check('model rows are ordered by cost', week.indexOf('glm-5.3<') < week.indexOf('gemini-3.8-flash-high'))
check('client chips carry the client name', week.includes('zcode'))
check('period switch marks the active scope', week.includes('aria-pressed="true"'))
check('external links are safe', (week.match(/rel="noreferrer"/g) ?? []).length >= 2)

const verified = markup.get('verified with a chosen account') ?? ''
check('a verified account carries its badge', verified.includes('tci-badge') && verified.includes('aria-label="Verified"'))
check('one who chose an account can change it', verified.includes('Change account'))
check('the change control explains where the name came from', verified.includes('saved in this page'))

const month = markup.get('month with a different table window') ?? ''
check('a mismatched table window is explained', month.includes('calendar month to date') && month.includes('last 30 days'))

const snapshot = markup.get('snapshot') ?? ''
check('a snapshot reading is dimmed', snapshot.includes('tci-dim'))
check('a snapshot reading shows its age and the error', snapshot.includes('last saved reading') && snapshot.includes('cannot reach tokens.ci'))

const zeros = markup.get('all zeros') ?? ''
check('an all-zero report still renders its totals', zeros.includes('>0<') && zeros.includes('$0'))
check('an all-zero report hides the empty mix', !zeros.includes('tci-mix'))

const empty = markup.get('empty window') ?? ''
check('an empty window explains itself', empty.includes('No activity in this window'))

const form = markup.get('account form') ?? ''
check('the account form offers one text field', (form.match(/<input/g) ?? []).length === 1 && form.includes('type="text"'))
check('the account form labels its field', form.includes('aria-label="GitHub handle"'))
check('the account form starts empty, not pre-filled with a guess', form.includes('value=""') && form.includes('placeholder="your-github-handle"'))
check('the account form cannot be submitted while empty', form.includes('disabled=""'))
check('the account form names what the host looked at', form.includes('Looked in:') && form.includes('gh api user'))
check('the account form carries no cancel on first use', !form.includes('>Cancel<'))

const badForm = markup.get('account form with a bad value') ?? ''
check('an invalid handle is refused before the request', badForm.includes('letters, digits, dot, dash and underscore') && badForm.includes('aria-invalid="true"'))
check('an invalid handle cannot be saved', /<button[^>]*disabled[^>]*>Save/.test(badForm), badForm.slice(0, 0) || 'save was enabled')

const savingForm = markup.get('account form while saving') ?? ''
check('a saving form reports progress and locks', savingForm.includes('Saving…') && savingForm.includes('disabled'))
check('a correcting form offers a way back', savingForm.includes('>Cancel<') && savingForm.includes('value="winniesi"'))

const errorForm = markup.get('account form with an error') ?? ''
check('a refused account explains why on the form', errorForm.includes('cannot reach tokens.ci'))

const unknown = markup.get('unknown account') ?? ''
check('an unknown handle offers another one', unknown.includes('Which tokens.ci account?'))

const unloaded = markup.get('host half not loaded') ?? ''
check('a missing host endpoint says what fixes it', unloaded.includes('restart dsh'))

const bare = markup.get('bare identity') ?? ''
check('a report without an identity leaks no placeholder text', !/undefined|NaN/.test(bare))

const malformed = markup.get('malformed day') ?? ''
check('an unparseable day falls back to its raw value', malformed.includes('not-a-date') && !malformed.includes('Invalid Date'))

const absurd = markup.get('absurd magnitudes') ?? ''
check('absurd magnitudes still format', absurd.includes('1000.0T') && absurd.includes('$1,234,568'))
check('a long model name is elided by CSS, not by dropping it', absurd.includes('x'.repeat(140)))

const stale = markup.get('stale account') ?? ''
check('a window that ended before today claims no "Today"', !stale.includes('>Today<') && !stale.includes('Today '), stale.slice(0, 0) || 'today chip leaked')

const allTime = markup.get('all time with sessions') ?? ''
check('all time adds the session count', allTime.includes('1,447 sessions'))

console.log(failures === 0 ? '\nALL RENDER CHECKS PASSED' : `\n${failures} RENDER CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)

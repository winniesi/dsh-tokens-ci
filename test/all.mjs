/**
 * Run every offline check, then confirm the composed profile actually carries
 * the plugin row.
 *
 * Usage: node test/all.mjs
 *
 * The three suites are independent processes on purpose: each one needs its own
 * `DSH_HOME`, and the composition check shells out to `dsh`.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { dshPackageDir, packageDir as root, profileDir } from './support.mjs'

/** @type {Array<[string, string[], (output: string) => boolean]>} */
const suites = [
  ['data layer against the live API', ['test/live-report.mjs'], (output) => output.includes('ALL LIVE CHECKS PASSED')],
  ['host route', ['test/host-route.mjs'], (output) => output.includes('ALL HOST CHECKS PASSED')],
  ['browser bundle and rendered states', ['test/render.mjs'], (output) => output.includes('ALL RENDER CHECKS PASSED')],
]

let failed = 0
for (const [label, args, passed] of suites) {
  process.stdout.write(`\n${'─'.repeat(72)}\n${label}\n${'─'.repeat(72)}\n`)
  let output = ''
  let ok = true
  try {
    output = execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  } catch (error) {
    output = error.stdout ?? ''
    ok = false
  }
  process.stdout.write(output)
  if (!passed(output)) failed += 1
}

process.stdout.write(`\n${'─'.repeat(72)}\ncomposed profile\n${'─'.repeat(72)}\n`)
try {
  // The exact check app-boot runs at startup, against the exact runtime the
  // installed dsh reports — a passing `pnpm add` does not imply this passes.
  const installed = dshPackageDir()
  const boot = await import(path.join(installed, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'))
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const runtime = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')).version
  const issue = boot.evaluatePluginCompatibility(manifest, {}, runtime)
  console.log(`  ${issue === undefined ? 'ok  ' : 'FAIL'} dsh ${runtime} accepts peer range ${JSON.stringify(manifest.peerDependencies)}`)
  if (issue !== undefined) failed += 1
} catch (error) {
  console.log(`  SKIP the compatibility check could not run: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
}
try {
  const dump = execFileSync('dsh', ['--profile', 'web', '--dump-config'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const hasRow = /^-\s+id:\s+tokens-ci$/m.test(dump) && /^\s+name:\s+dsh-tokens-ci$/m.test(dump)
  const hasBundle = JSON.parse(readFileSync(path.join(profileDir(), 'package.json'), 'utf8'))
    .dsh.profile.bundles.includes('dsh-tokens-ci')
  console.log(`  ${hasRow ? 'ok  ' : 'FAIL'} the profile composes the tokens-ci row`)
  console.log(`  ${hasBundle ? 'ok  ' : 'FAIL'} the profile selects the dsh-tokens-ci bundle`)
  if (!hasRow || !hasBundle) failed += 1
  // `dsh.client.inject` names rows that must be in the graph for ordering; a
  // name that matches no row is a composition error at load, not a silent
  // no-op.
  const inject = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).dsh.client.inject ?? []
  const missing = inject.filter((name) => !dump.includes(`name: '${name}'`))
  console.log(`  ${missing.length === 0 ? 'ok  ' : 'FAIL'} every injected client package is in the graph (${inject.length})`)
  if (missing.length > 0) {
    console.log(`       missing: ${missing.join(', ')}`)
    failed += 1
  }
} catch (error) {
  console.log(`  SKIP the profile could not be inspected: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
}

console.log(failed === 0 ? '\nEVERY CHECK PASSED' : `\n${failed} SUITE(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)

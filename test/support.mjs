/**
 * Where the checks find the things that are not part of this package.
 *
 * The plugin itself has no dependencies, but two checks need something from
 * the machine it runs on: React (to render the browser half) and the installed
 * `dsh` (to run its own compatibility evaluator). Both are resolved by looking
 * in the places a `dsh` installation actually puts them, so the suite runs on
 * a contributor's machine instead of only on the one it was written on.
 *
 * @module test/support
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The directory holding this package. */
export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** `$DSH_HOME`, defaulting to `~/.dsh` the way dsh itself does. */
export function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** The profile directory under test, from the environment or the web default. */
export function profileDir() {
  return process.env.DSH_PROFILE_DIR ?? path.join(dshHome(), 'profiles', 'web')
}

/**
 * Places a module the plugin does not depend on could live, most specific
 * first: the active profile, the web profile, then this package.
 * @returns candidate `node_modules` directories.
 */
export function moduleDirs() {
  return [
    path.join(profileDir(), 'node_modules'),
    path.join(dshHome(), 'profiles', 'web', 'node_modules'),
    path.join(packageDir, 'node_modules'),
  ]
}

/**
 * Require one module from whichever candidate directory has it.
 *
 * React is not a dependency of this package on purpose — the browser module
 * table supplies it, and adding a second copy would be the bug this plugin's
 * own notes warn about. The checks borrow the profile's copy instead, which is
 * the exact instance the page runs against.
 *
 * @param specifier - module to resolve, for example `react`.
 * @returns the module.
 * @throws with every path tried, because "cannot find module 'react'" alone
 *   does not say where to look.
 */
export function requireFromProfile(specifier) {
  const tried = []
  for (const dir of moduleDirs()) {
    if (!existsSync(dir)) {
      tried.push(`${dir} — no such directory`)
      continue
    }
    try {
      return createRequire(path.join(dir, 'resolve-from-here.js'))(specifier)
    } catch (error) {
      tried.push(`${dir} — ${error?.code ?? error?.message ?? String(error)}`)
    }
  }
  throw new Error(
    `cannot resolve ${JSON.stringify(specifier)}. Install this plugin into a profile first:\n` +
    `  dsh plugin --profile web add ${packageDir}\nTried:\n  ${tried.join('\n  ')}`,
  )
}

/**
 * The installed `@deepseek-ai/dsh` package directory.
 *
 * Derived from the `dsh` on `PATH` rather than from a fixed install layout:
 * the launcher resolves into `<package>/lib/bin.js`, so the package is two
 * levels up from its real path. That works for a global npm install, a mise
 * shim, or a linked checkout alike.
 *
 * @returns the absolute package directory.
 */
export function dshPackageDir() {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const found = execFileSync(finder, ['dsh'], { encoding: 'utf8' }).split('\n')[0].trim()
  const real = realpathSync(found)
  return path.dirname(path.dirname(real))
}

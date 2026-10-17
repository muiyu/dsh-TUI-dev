/**
 * Host-first `sharp` loader.
 *
 * dsh-tui runs inside the dsh process, and the host attachment service
 * (`@deepseek-ai/dsh-attachment-local`) already loads its own `sharp`. Loading
 * a second copy from this package's optional dependency puts two libvips
 * dylibs into one process; on macOS the Objective-C runtime reports the
 * duplicate classes on stderr, and that text lands on the alternate screen
 * (0.1.2-rc.1 ships sharp 0.35.4 while this package pins 0.35.3).
 *
 * Resolve `sharp` from the host tree first, fall back to our own optional
 * copy, and cache the outcome so the process holds one instance. A missing
 * module resolves to `undefined`; callers keep their text fallback.
 *
 * Two host-anchor strategies are tried in order, stopping at the first hit:
 *   1. Resolve `@deepseek-ai/dsh-session/package.json` from this module's
 *      location and walk that tree. Works in dev and test (dsh-session is
 *      hoisted into the local node_modules) and must be tried first so the
 *      split-tree regression test can inject its own fixture trees.
 *   2. Walk PATH to find the first `dsh` binary, follow its realpath to the
 *      `@deepseek-ai/dsh` package root, and resolve `sharp` from there.
 *      This is the fallback for installed-profile builds where no
 *      `@deepseek-ai/*` package is present in the profile's node_modules.
 * The Set deduplicates when both strategies land on the same entry file.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type SharpModule = Awaited<typeof import('sharp')>['default']

let loader: Promise<SharpModule | undefined> | undefined

/** Load `sharp` once per process, preferring the host's copy. */
export function loadSharp(): Promise<SharpModule | undefined> {
  loader ??= resolveSharp()
  return loader
}

/**
 * Walk from `start` upward until a directory whose package.json has
 * `name === '@deepseek-ai/dsh'` is found, or the filesystem root is reached.
 */
function findDshPackageDir(start: string): string | undefined {
  let dir = dirname(start)
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const manifest = JSON.parse(readFileSync(pkg, 'utf8')) as unknown
        if (
          typeof manifest === 'object' &&
          manifest !== null &&
          (manifest as Record<string, unknown>)['name'] === '@deepseek-ai/dsh'
        ) {
          return dir
        }
      } catch {
        // unreadable or non-JSON; keep climbing
      }
    }
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  return undefined
}

/**
 * Resolve `sharp` from the host dsh package by following the first `dsh`
 * binary on PATH to its realpath, then climbing to the package root.
 * Returns the resolved entry file path, or undefined if not found.
 * Only called when the module-anchor strategy fails (installed-profile builds).
 */
function hostSharpViaPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.ps1', 'dsh'] : ['dsh']
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (!existsSync(candidate)) continue
      let real: string
      try {
        real = realpathSync(candidate)
      } catch {
        continue
      }
      const dshPkg = findDshPackageDir(real)
      if (dshPkg === undefined) break // first dsh on PATH is the host or there is none
      try {
        return createRequire(join(dshPkg, 'package.json')).resolve('sharp')
      } catch {
        // host dsh has no sharp — our own copy is the right fallback
        return undefined
      }
    }
  }
  return undefined
}

/**
 * Candidate `sharp` entry files, host first. Two anchor strategies are tried
 * in order (see module-level comment); the Set deduplicates overlapping results.
 */
export function sharpCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const local = createRequire(import.meta.url)
  const paths: string[] = []

  // Strategy 1: module-anchor via @deepseek-ai/dsh-session (dev/test).
  // Tried first so the split-tree regression test can inject fixture trees.
  let anchorSucceeded = false
  try {
    const anchor = local.resolve('@deepseek-ai/dsh-session/package.json')
    paths.push(createRequire(anchor).resolve('sharp'))
    anchorSucceeded = true
  } catch {
    // No dsh-session visible from this module; try PATH strategy next.
  }

  // Strategy 2: PATH-based — follow the dsh binary to its package root.
  // Only runs when strategy 1 failed (installed-profile builds lack the alias).
  if (!anchorSucceeded) {
    try {
      const via = hostSharpViaPath(env)
      if (via !== undefined) paths.push(via)
    } catch {
      // PATH walk failed entirely; own optional copy is all that remains.
    }
  }

  // Strategy 3: own optional copy as final fallback.
  try {
    paths.push(local.resolve('sharp'))
  } catch {
    // Optional dependency not installed.
  }

  return [...new Set(paths)]
}

async function resolveSharp(): Promise<SharpModule | undefined> {
  for (const path of sharpCandidatePaths()) {
    try {
      const mod = await import(pathToFileURL(path).href) as { default?: unknown }
      const candidate = mod.default ?? mod
      if (typeof candidate === 'function') return candidate as SharpModule
    } catch {
      // A broken native build in one tree must not hide a working one.
    }
  }
  return undefined
}

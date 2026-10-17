/**
 * The assembly point (Stage D-1 / roadmap §4.7): the `Backend` declarations of the
 * bundles a profile composes become registry entries, so that installing a
 * third-party backend bundle and restarting puts that backend in the kernel
 * picker.
 *
 * Three properties decide the shape of this file.
 *
 *  - **Discovery precedes parsing, synchronously.** The boot parses a backend
 *    choice through the registry (`parseBackendChoice`, membership is the second
 *    half of the parse — P0 D1), and an id that is not registered yet reads as an
 *    unknown value: dsh plus a warning, never the backend the user installed.
 *    Nothing that waits for a fiber to activate can satisfy that: a third-party
 *    bundle's rows are composed *after* this row (the profile's own bundles come
 *    before `cordis.patch.yml`), so an event or timer would fire after the parse.
 *    The discovery therefore reads **files** — the profile's own manifest — and
 *    registers before anything is parsed. The import of the backend module stays
 *    lazy (an installed backend nobody selects is never imported, D4).
 *
 *  - **One reading of "what is installed".** `/plugin install` and the CLI both
 *    record an installed bundle in the profile manifest's `dsh.profile.bundles`
 *    (the manager's own `reconcile()` writes it), and the profile manifest is what
 *    the Loader composes. So the scan reads that file, not the plugin-manager
 *    service: the service's `listBundles()` is asynchronous, and a service answer
 *    would arrive after the parse. The predicate is the same one
 *    `./plugin-manager.ts`'s `extraBundles()` uses — the composition's own packages
 *    are not plugins a person installed — so the list and the assembly cannot
 *    disagree about whom they are talking about.
 *
 *  - **Judgement, never a guess.** A bundle's declaration is read only through the
 *    identity rule #1568 established: the entry is resolved by the Loader's own ESM
 *    resolver and the `dsh-plugin.json` counts only beside the `package.json` that
 *    establishes that entry's package root. A Loader without Node internals cannot
 *    answer that question, and this module then refuses to answer it too, saying
 *    so, instead of falling back to a second path resolver of its own.
 *
 * A refusal is contained, never silent and never fatal: notes 0009 requires a
 * failure to be attributable to the entry it belongs to, without taking the rest
 * of the composition down. Registration errors therefore become one warning line
 * naming the bundle and the reason (the registry's own checks stay as loud as they
 * are — this catches them one level out), and every other bundle is still
 * assembled.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { logForDebugging } from '../utils/debug.js'
import { findManifest, loadThroughLoader, compositionLoader, resolveEntryUrl, type LoaderLike } from './admission-loader.js'
import { backendManifestOf } from './backend-contribution.js'
import { registerBackend } from './backend-registry.js'
import { declaredBackendsIn, isCompositionOwned } from './plugin-declaration.js'

/** One bundle whose `Backend` declaration did not become a registry entry. */
export interface BackendAssemblyRefusal {
  readonly bundle: string
  readonly reason: string
}

/** What one assembly pass did. Returned rather than only logged, so the
 *  regression can assert the pass without reading the logs. */
export interface BackendAssembly {
  /** The profile manifest the pass read, when this boot has one. */
  readonly profile: string | undefined
  /** Bundle layers the pass looked at (composition-owned packages excluded). */
  readonly scanned: readonly string[]
  /** Backend ids registered by this pass, in scan order. The built-in seed is
   *  registered before it and is not part of the report. */
  readonly registered: readonly string[]
  /** Bundles that announced a backend this host could not assemble. */
  readonly refused: readonly BackendAssemblyRefusal[]
}

/**
 * Register every backend an installed bundle declares.
 *
 * Synchronous by contract (see the module comment): the caller runs this before
 * the boot parses a backend choice. A second pass over the same composition is a
 * no-op for the entries the first pass registered (see {@link assemblyStateOf}) —
 * two callers exist on purpose: the entry decides which kernel to boot *before*
 * `apply` runs, and both questions ("is this bundle a layer" for the route, "which
 * backend is this id" for the session) are answered by the same registry.
 */
export function assembleBackendsFromProfile(ctx: Context): BackendAssembly {
  const profile = profileManifestPathOf(ctx)
  const refused: BackendAssemblyRefusal[] = []
  const registered: string[] = []
  const done = (scanned: readonly string[]): BackendAssembly => ({ profile, scanned, registered, refused })
  if (profile === undefined) {
    logForDebugging('dsh-tui: backend assembly skipped — this composition has no profile directory to read (no baseUrl)')
    return done([])
  }
  const bundles = installedBundlesOf(profile)
  if (bundles === undefined) return done([])
  const scanned = bundles.filter(name => !isCompositionOwned(name))
  if (scanned.length === 0) return done(scanned)
  const baseUrl = (ctx as { baseUrl?: string }).baseUrl
  const loader = compositionLoader(ctx)
  if (loader?.internal === undefined) {
    // The Loader runs plugins through plain `import()` when it has no Node
    // internals, but that path resolves relative to *this* module: an answer
    // computed here would name a module the Loader never executes. Refuse.
    logForDebugging(
      `dsh-tui: backend assembly skipped — the Loader ESM resolver is unavailable, so the entry of `
      + `${scanned.length} installed bundle(s) cannot be established: ${scanned.join(', ')}`,
    )
    return done(scanned)
  }
  const state = assemblyStateOf(ctx)
  for (const bundle of scanned) {
    for (const refusal of assembleBundle(bundle, loader, baseUrl, registered, state.owners)) refused.push(refusal)
  }
  if (registered.length > 0) {
    logForDebugging(`dsh-tui: registered ${registered.length} backend(s) from installed bundles: ${registered.join(', ')}`)
  }
  for (const refusal of refused) {
    // Attributable and loud for the person who installed it — a backend that
    // silently never appears is the one outcome nobody can debug. Said once per
    // composition: the second pass (the entry assembles, `apply` assembles again)
    // reports the same refusals and must not repeat them to the reader.
    const said = `${refusal.bundle}\u0000${refusal.reason}`
    if (state.warned.has(said)) continue
    state.warned.add(said)
    ctx.logger.warn(`dsh-tui: bundle "${refusal.bundle}" declares a backend that was not registered: ${refusal.reason}`)
  }
  return done(scanned)
}

/** What one composition's earlier passes did, so a second pass is a no-op.
 *
 *  `owners` needs the owner of an id, not just the id: an id this bundle already
 *  registered is the same entry, while an id another bundle claims is a conflict
 *  the registry must still answer. Keyed by the context, so the regressions can
 *  compose several in one process. */
interface AssemblyState {
  readonly owners: Map<string, string>
  readonly warned: Set<string>
}
const assemblyStateOf = (ctx: Context): AssemblyState => {
  const existing = assembled.get(ctx as object)
  if (existing !== undefined) return existing
  const fresh: AssemblyState = { owners: new Map(), warned: new Set() }
  assembled.set(ctx as object, fresh)
  return fresh
}
const assembled = new WeakMap<object, AssemblyState>()

/** One bundle's declarations → registry entries. Returns the refusals it owns. */
function assembleBundle(
  bundle: string,
  loader: LoaderLike,
  baseUrl: string | undefined,
  registered: string[],
  owned: Map<string, string>,
): BackendAssemblyRefusal[] {
  const refuse = (reason: string): BackendAssemblyRefusal[] => [{ bundle, reason }]
  const url = resolveEntryUrl(loader, bundle, baseUrl)
  if (url === undefined) {
    return refuse('its entry module could not be resolved through the Loader resolver')
  }
  let entryFile: string
  try {
    entryFile = fileURLToPath(url)
  } catch {
    return refuse(`its entry resolved to ${url}, which is not a file`)
  }
  const manifestPath = findManifest(entryFile)
  // No package-root declaration: this bundle is not a TUI plugin at all, which
  // is the normal case and not a problem to report.
  if (manifestPath === undefined) return []
  let source: string
  try {
    source = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    return refuse(`its declaration at ${manifestPath} could not be read (${messageOf(error)})`)
  }
  const { backends, problems } = declaredBackendsIn(source)
  const refusals = problems.map(problem => ({ bundle, reason: problem }))
  if (backends.length === 0 && problems.length === 0) return []
  // The public declaration has no export selector: all entries would load the
  // same `backend` object, which can carry only one session/data-directory id.
  if (backends.length > 1) return [...refusals, { bundle, reason: 'only one Backend per bundle can bind the fixed backend export' }]
  for (const declared of backends) {
    // A second pass over the same composition (the entry assembles before the
    // route and `apply` assembles again) must be a no-op, not a storm of
    // "already registered". An id this very bundle registered is the same entry;
    // an id another bundle claimed is a conflict, and the registry answers it.
    if (owned.get(declared.spec.id) === bundle) continue
    let manifest
    try {
      manifest = backendManifestOf(declared.spec)
    } catch (error) {
      refusals.push({ bundle, reason: `its Backend declaration could not be projected (${messageOf(error)})` })
      continue
    }
    try {
      // `load` is the module namespace, resolved once here and imported only if
      // this backend is ever selected. The registry reads `backendExport`
      // (default `backend`) and `unloadExport` out of that namespace, exactly as
      // it does for the built-in index.
      registerBackend({ manifest, load: () => loadThroughLoader(loader, bundle, url, baseUrl) })
      registered.push(manifest.id)
      owned.set(manifest.id, bundle)
    } catch (error) {
      refusals.push({ bundle, reason: messageOf(error) })
    }
  }
  return refusals
}

/**
 * The profile manifest this boot reads and composes: the `package.json` of the
 * directory the Loader resolves module specifiers against (`Context.baseUrl`, set
 * by the host to the profile directory — every row's context inherits it). No
 * `baseUrl` means no profile (a bare Cordis root, a `--config` overlay, a source
 * checkout), and then no bundle was installed into anything either.
 */
function profileManifestPathOf(ctx: Context): string | undefined {
  const baseUrl = (ctx as { baseUrl?: string }).baseUrl
  if (typeof baseUrl !== 'string' || baseUrl === '') return undefined
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'file:') return undefined
    return join(fileURLToPath(url), 'package.json')
  } catch {
    return undefined
  }
}

/**
 * The bundle layers this profile composes: `dsh.profile.bundles` in its manifest,
 * which is what `/plugin install`, `enable` and the CLI all write (the manager's
 * `reconcile()` appends every newly installed bundle that declares `dsh.bundle`;
 * a disabled one leaves the list without being uninstalled). `undefined` when the
 * file cannot be read or parsed — a broken profile is not an empty one.
 */
function installedBundlesOf(profile: string): string[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(profile, 'utf8'))
  } catch (error) {
    logForDebugging(`dsh-tui: backend assembly skipped — ${profile} could not be read (${messageOf(error)})`)
    return undefined
  }
  const declared = (parsed as { dsh?: { profile?: { bundles?: unknown } } })?.dsh?.profile?.bundles
  if (!Array.isArray(declared)) return []
  return declared.filter((name): name is string => typeof name === 'string' && name !== '')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

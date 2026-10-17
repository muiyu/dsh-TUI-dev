/**
 * The first-party feed: the curated list of plugin packages this project
 * publishes, pinned per release (Stage C-4; the file's own README is
 * `tui-profile/feed/README.md`).
 *
 * The feed is a packaged **data** file, not a protocol artifact. It answers one
 * question for gate 3's trust routing — "is this exact artifact one we
 * published?" — offline, with no registry round trip. It never replaces the
 * admission registry (`tui-profile/registry/`); a miss only means the caller
 * asks the person to confirm, which is what any third-party install does.
 *
 * Two policies here are deliberate:
 *
 * - A missing or malformed file is NOT the same as "no entry matched". The
 *   loader answers `unavailable` with a reason, so a caller can say what is
 *   wrong instead of quietly trusting everything — or refusing everything
 *   without saying why. (A silent `undefined`, the `loadSpecData()` posture, is
 *   the anti-pattern this avoids: for a trust input, "absent" and "unreadable"
 *   must stay distinguishable.)
 * - Every uncertain answer is third-party (fail closed). A spec without a
 *   version resolves to "latest" at install time, which is not the artifact the
 *   feed pinned, so that is a version mismatch rather than a hit.
 *
 * Provenance is a seam, not an implementation: the host service's published
 * surface carries no provenance/publisher/attestation API at all, and this
 * package has no registry client, so the first-party branch records
 * `corroboration: 'unavailable'`. The rule that keeps the seam honest — a
 * source that ever contradicts an entry must demote the verdict to
 * third-party (one vote to veto, never a vote to allow) — is written down in
 * the feed README and `tui-profile/notes/0009-backend-contribution.md`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The shipped feed, relative to the package root. */
export const FIRST_PARTY_FEED_FILE = 'tui-profile/feed/first-party.json'

/** One curated entry: the exact artifact this project vouches for. */
export interface FirstPartyEntry {
  /**
   * The full package name, scope included. Matched verbatim. `feedVersion: 1`
   * carries scoped names only: an unscoped name has no publisher a file can
   * assert offline, so admitting one is a deliberate format decision (a new
   * feedVersion), not an entry somebody adds.
   */
  readonly name: string
  /**
   * The expected publisher. Must equal the name's own scope — npm lets only
   * that scope's owners publish under it, which is the whole offline publisher
   * argument the feed can make. The gate holds the two fields together; the
   * verdict itself reads the name, because the name already carries the scope.
   */
  readonly scope: string
  /** The exact version. Ranges are rejected by the gate, never resolved here. */
  readonly version: string
}

export interface FirstPartyFeed {
  readonly feedVersion: 1
  readonly entries: readonly FirstPartyEntry[]
}

/** Why an artifact is not on the feed. Every value is a fail-closed answer. */
export type FirstPartyReason =
  /** The feed file is missing or unreadable: nothing can be vouched for. */
  | 'no-feed'
  /** The spec named no package (a path, a git URL the upstream left unnamed). */
  | 'unidentified'
  /** The feed carries entries, but not this name. */
  | 'not-listed'
  /** The name is listed, but not at this exact version (or at no version). */
  | 'version-mismatch'
  /**
   * The artifact is not a published one: a directory, tarball or git checkout
   * can call itself anything, and its manifest is the artifact vouching for
   * itself. The feed lists what we published, so it has nothing to say here.
   */
  | 'unverifiable-source'

export type FirstPartyVerdict =
  | {
    readonly kind: 'first-party'
    readonly entry: FirstPartyEntry
    /**
     * The provenance seam. Any future source of publisher identity starts
     * here: an answer that contradicts {@link entry} must demote this verdict
     * to the third-party branch (one vote to veto); it may never upgrade a
     * third-party verdict to this one.
     */
    readonly corroboration: 'unavailable'
  }
  | {
    readonly kind: 'third-party'
    readonly reason: FirstPartyReason
    /** What the loader said when the feed itself was the problem. */
    readonly detail?: string
  }

/** The feed as the loader found it: present and shaped, or not usable at all. */
export type FirstPartyFeedLoad =
  | { readonly kind: 'ok'; readonly path: string; readonly feed: FirstPartyFeed }
  | { readonly kind: 'unavailable'; readonly reason: string }

/**
 * Where the feed lives, in both the `src/` (tsx) and the compiled npm layouts —
 * the same pair `packagedPresetRoot()` uses, for the same reason.
 */
export function firstPartyFeedCandidates(moduleUrl: string = import.meta.url): string[] {
  const directory = dirname(fileURLToPath(moduleUrl))
  return [join(directory, '../../', FIRST_PARTY_FEED_FILE), join(directory, '../../../', FIRST_PARTY_FEED_FILE)]
}

/** One entry, structurally. `undefined` for anything the feed must not carry. */
function asEntry(value: unknown): FirstPartyEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 3 || !keys.includes('name') || !keys.includes('scope') || !keys.includes('version')) return undefined
  const { name, scope, version } = record
  if (typeof name !== 'string' || name.length === 0) return undefined
  if (typeof scope !== 'string' || scope.length === 0) return undefined
  if (typeof version !== 'string' || version.length === 0) return undefined
  if (!/^@[^/]+\/[^/]+$/u.test(name) || scope !== name.slice(0, name.indexOf('/'))) return undefined
  return { name, scope, version }
}

/**
 * Read the shipped feed. Tolerant about the world, strict about the file: an
 * absent, unreadable, unparsable or unrecognized feed answers `unavailable`
 * with a readable reason, and never throws — the caller decides what to say
 * and always falls back to "third-party".
 */
export function loadFirstPartyFeed(moduleUrl: string = import.meta.url): FirstPartyFeedLoad {
  const candidates = firstPartyFeedCandidates(moduleUrl)
  const path = candidates.find(candidate => existsSync(candidate))
  if (path === undefined) return { kind: 'unavailable', reason: `feed file is missing (checked ${candidates.join(', ')})` }
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    return { kind: 'unavailable', reason: `feed file is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    return { kind: 'unavailable', reason: `feed file is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof value !== 'object' || value === null) return { kind: 'unavailable', reason: 'feed file is not an object' }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 2 || !keys.includes('feedVersion') || !keys.includes('entries')) {
    return { kind: 'unavailable', reason: `feed file carries unexpected top-level fields: ${keys.join(', ')}` }
  }
  if (record.feedVersion !== 1) return { kind: 'unavailable', reason: `feed file has an unknown feedVersion: ${String(record.feedVersion)}` }
  if (!Array.isArray(record.entries)) return { kind: 'unavailable', reason: 'feed file entries is not an array' }
  const entries: FirstPartyEntry[] = []
  for (const candidate of record.entries) {
    const entry = asEntry(candidate)
    if (entry === undefined) return { kind: 'unavailable', reason: `feed file carries an unrecognized entry: ${JSON.stringify(candidate)}` }
    entries.push(entry)
  }
  if (entries.length === 0) return { kind: 'unavailable', reason: 'feed file carries no entries' }
  return { kind: 'ok', path, feed: { feedVersion: 1, entries } }
}

/**
 * Whether an artifact is the exact one the feed pins. Pure: the feed is an
 * argument, so a caller can answer the same question for a fixture, and the
 * gate can drive every branch without a filesystem.
 *
 * Only a registry artifact can be first-party. A directory or git checkout is
 * inspected from the manifest it ships, so treating its `name`/`version` as
 * evidence would let whoever wrote that directory claim any feed entry and skip
 * the trust confirmation — the one decision this verdict makes.
 */
export function firstPartyVerdict(
  load: FirstPartyFeedLoad,
  artifact: { readonly name?: string | undefined; readonly version?: string | undefined; readonly kind?: string | undefined },
): FirstPartyVerdict {
  if (load.kind !== 'ok') return { kind: 'third-party', reason: 'no-feed', detail: load.reason }
  if (artifact.kind !== undefined && artifact.kind !== 'registry') return { kind: 'third-party', reason: 'unverifiable-source' }
  const name = artifact.name
  if (typeof name !== 'string' || name.length === 0) return { kind: 'third-party', reason: 'unidentified' }
  const entry = load.feed.entries.find(candidate => candidate.name === name)
  if (entry === undefined) return { kind: 'third-party', reason: 'not-listed' }
  if (artifact.version !== entry.version) return { kind: 'third-party', reason: 'version-mismatch' }
  return { kind: 'first-party', entry, corroboration: 'unavailable' }
}

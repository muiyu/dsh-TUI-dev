/**
 * Experimental per-launch network-failure log (`net-error.log`).
 *
 * Why this exists (personal debug branch): when a model request fails, the
 * stock classifier collapses very different situations — a truncated SSE
 * stream, an idle timeout, a corrupt frame, a genuine 429 — into one coarse
 * verdict (`RATE_LIMIT` for anything that merely mentions a rate limit or
 * carries an unexpected status), which is useless when you want to know
 * AFTER the fact which of them actually happened. This module writes what
 * really happened, one NDJSON record per failed attempt, into
 * `net-error.log` in the launch directory:
 *
 * - the harness's own facts, verbatim and unmodified: `code`, `status`,
 *   `message`, `requestId`, `providerRetryAfterMs`;
 * - a `kind` RE-DERIVED here from the evidence (HTTP status first, then the
 *   failure code, then message wording, then the stream's own shape), plus
 *   `misclassified: true` when the harness code disagrees with that derivation
 *   — so a truncated stream the harness called `RATE_LIMIT` is logged as
 *   `stream_closed` and flagged;
 * - the decoded stream that actually arrived: chunk count, block sequence,
 *   whether a terminal `finish` chunk ever landed, and the tail of the text.
 *   `incomplete: true` marks the answer-was-cut-off case directly, so it is
 *   greppable without reading the nested stream object;
 * - with `DSH_TUI_NET_RAW=1`, the raw HTTP body tail captured by a scoped
 *   `globalThis.fetch` wrapper (off by default: patching fetch touches every
 *   request in the process, so it is opt-in).
 *
 * One record per failed attempt as the HARNESS reports it. Note that an
 * adapter's own internal retries (`retryProviderRequest`, the pi-ai and
 * DeepSeek adapters' transient-failure loops) collapse into a single record:
 * only the attempt that finally surfaces to the agent loop raises
 * `agent/request-error`. The stream evidence therefore describes that last
 * attempt, not the earlier ones the adapter swallowed.
 *
 * The file is truncated on every dsh-tui start, so one launch's failures
 * never mix with the previous one's. Location: `$DSH_TUI_NET_ERROR_LOG` when
 * set, otherwise `net-error.log` in the process working directory.
 *
 * This is a file-only diagnostic. It renders nothing, prints nothing, and
 * never throws into the request path: a failure to log must never become a
 * failure to run.
 *
 * @module @deepseek-harness-tui/dsh-tui/net-error-log
 */

import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** File name used when `DSH_TUI_NET_ERROR_LOG` is not set. */
export const NET_ERROR_LOG_FILE = 'net-error.log'

/** Captured tail sizes, in characters (the log is text, not bytes). */
const MAX_TEXT_TAIL = 4000
const MAX_RAW_TAIL = 8000

/** How many recent requests keep a stream buffer around for matching. */
const MAX_RECENT_STREAMS = 8
/** How many recent raw HTTP bodies may stay buffered. */
const MAX_RECENT_RAW = 8
/** A raw body older than this cannot belong to the failure being recorded. */
const RAW_MATCH_WINDOW_MS = 180_000
/** A captured stream this large has clearly run away; stop buffering text. */
const MAX_CAPTURED_CHARS = 4_000_000

/** The precise failure class this log names, independent of the harness code. */
export type NetErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'stream_closed'
  | 'malformed_body'
  | 'empty_response'
  | 'server_error'
  | 'upstream_unavailable'
  | 'transport'
  | 'quota'
  | 'auth'
  | 'invalid_request'
  | 'context_overflow'
  | 'aborted'
  | 'unknown'

/** The serializable facts the harness attaches to a failed model request. */
export interface NetFailureFacts {
  /** Provider-neutral machine code the harness assigned (`RATE_LIMIT`, …). */
  readonly code?: string
  /** Human-readable provider or transport failure. */
  readonly message?: string
  /** HTTP status returned by the provider, when available. */
  readonly status?: number
  /** Opaque provider-issued request id. */
  readonly requestId?: string
  /** Provider-requested delay, when valid. */
  readonly providerRetryAfterMs?: number
}

/** What the failed attempt's own stream delivered before it died. */
export interface StreamEvidence {
  /** Chunks observed, terminal ones included. */
  readonly chunks: number
  /** Visible text characters observed. */
  readonly textChars: number
  /** Ordered block types as they opened (`text`/`reasoning`/`tool-call`/…). */
  readonly blocks: readonly string[]
  /** The terminal `finish` reason, absent when the stream died before one. */
  readonly finish?: string
  /** The iterator stopped (finished, errored, or was abandoned). */
  readonly closed: boolean
  /** The error the stream itself threw, when it threw. */
  readonly errorText?: string
  /** Wall-clock time from `next` to the last chunk. */
  readonly elapsedMs: number
  /** Tail of the visible text that did arrive. */
  readonly tail: string
}

/** The verdict this module reaches about one failure. */
export interface NetVerdict {
  readonly kind: NetErrorKind
  /** Which evidence decided it — one short phrase for the log. */
  readonly because: string
  /** True when the harness code names a different class than the evidence. */
  readonly misclassified: boolean
}

/** Message wording the classifier keys on, most specific first. */
const TIMEOUT_PATTERN = /\btime(?:d)?[\s_-]*out\b|\btimeout\b|idle watchdog/i
const STREAM_CLOSED_PATTERN = /stream (?:ended|closed|terminated)\s+(?:before|without|prematurely)|\bno terminal (?:event|chunk|message)\b|premature close|other side closed|socket hang ?up|unexpected end of (?:stream|sse|input)/i
const MALFORMED_PATTERN = /\b(?:json|sse|payload|frame|chunk|body)\b.{0,40}\b(?:invalid|malformed|corrupt|unparsable|decode|parse|truncated|broken)\b|\b(?:invalid|malformed|corrupt|unparsable|truncated|broken)\b.{0,20}\b(?:json|sse|payload|frame|chunk|body)\b|unexpected token|unexpected end of json|json at position/i
const CONTEXT_PATTERN = /\bcontext[\s_-](?:length|window)\b|maximum context|too (?:long|large) for (?:this|the) model|prompt is too long/i
const QUOTA_PATTERN = /\binsufficient[\s_-]+(?:quota|balance|credits?)\b|\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b|\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b|balance/i
const AUTH_PATTERN = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|invalid[_\s-]?credential|authentication/i
const RATE_PATTERN = /\b429\b|rate[_\s-]?limit|too many requests|slow down/i
const SERVER_PATTERN = /\b5\d\d\b|internal server|bad gateway|service unavailable|gateway time-?out|overloaded/i
const TRANSPORT_PATTERN = /\bECONN[A-Z]+\b|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|\b(?:network|connection|socket|dns)\b|fetch failed|terminated/i

/**
 * Codes that already name exactly one class, so no message guess is needed.
 *
 * The vocabulary is the union the shipped adapters actually raise, read off
 * `dsh-llm-deepseek`, `dsh-llm-pi-ai` and `dsh-llm` — not a list invented
 * here. Codes this map does not name fall through to message wording, then to
 * stream shape, then to `unknown`; they are never guessed into `rate_limit`.
 */
const KIND_BY_CODE: Readonly<Record<string, NetErrorKind>> = {
  // Transient upstream faults.
  RATE_LIMIT: 'rate_limit',
  TIMEOUT: 'timeout',
  STREAM_CLOSED: 'stream_closed',
  TRANSPORT: 'transport',
  SERVER: 'server_error',
  EMPTY_RESPONSE: 'empty_response',
  // Capacity and account state.
  QUOTA: 'quota',
  ACCOUNT_QUOTA: 'quota',
  AUTH: 'auth',
  MISSING_CREDENTIAL: 'auth',
  INVALID_CREDENTIAL: 'auth',
  NO_CREDENTIAL_STORE: 'auth',
  CONTEXT_WINDOW_EXCEEDED: 'context_overflow',
  // A response the adapter could not decode: corrupt, truncated, or not the
  // envelope it expects. `MALFORMED_RESPONSE` is the deepseek adapter's own
  // code for exactly the "损坏/不完整" case this log exists for.
  MALFORMED_RESPONSE: 'malformed_body',
  INVALID_RESPONSE: 'malformed_body',
  // Requests the route refused outright.
  INVALID_REQUEST: 'invalid_request',
  UNSUPPORTED_CONTENT: 'invalid_request',
  UNSUPPORTED_OPTION: 'invalid_request',
  UNSUPPORTED_REASONING_EFFORT: 'invalid_request',
  IMAGE_OFFLOAD_REQUIRED: 'invalid_request',
  NO_ADAPTER: 'invalid_request',
  UNKNOWN_MODEL: 'invalid_request',
  ABORTED: 'aborted',
}

/**
 * Codes that are only a bucket, not a diagnosis: the harness reaches them for
 * more than one real situation, so the evidence decides. `RATE_LIMIT` is the
 * important one — it is the code almost every upstream hiccup used to land on.
 */
const COARSE_CODES: ReadonlySet<string> = new Set(['RATE_LIMIT', 'PI_AI_ERROR', 'UNKNOWN', ''])

/** `HTTP_<status>` codes carry their status inline; treat them as coarse too. */
function isCoarseCode(code: string): boolean {
  return COARSE_CODES.has(code) || /^HTTP_\d+$/.test(code)
}

/**
 * Derive the failure class from the evidence, in a fixed order: structural
 * facts (HTTP status) outrank the harness code, which outranks message
 * wording. The derivation is deliberately independent of the harness's own
 * classifier — that is the whole point of this log.
 * @param facts - The harness failure facts for this attempt.
 * @param evidence - What the attempt's stream delivered, when one was seen.
 * @returns The verdict, including whether the harness code disagrees.
 */
export function classifyNetError(facts: NetFailureFacts, evidence?: StreamEvidence): NetVerdict {
  const code = (facts.code ?? '').toUpperCase()
  const message = facts.message ?? ''
  const detail = `${message} ${evidence?.errorText ?? ''}`
  const status = facts.status
  const harnessKind = KIND_BY_CODE[code]
  const verdict = (kind: NetErrorKind, because: string): NetVerdict => ({
    kind,
    because,
    // "Misclassified" means: the harness named a class, and the evidence says
    // a different, more specific one. Only disagreements count.
    misclassified: harnessKind !== undefined && harnessKind !== kind,
  })

  // An explicit HTTP status is the strongest signal there is.
  if (status === 429) return verdict('rate_limit', 'http 429')
  if (status === 408 || status === 504) return verdict('timeout', `http ${status}`)
  if (status === 402) return verdict('quota', 'http 402')
  if (status === 401 || status === 403) return verdict('auth', `http ${status}`)
  if (status === 502 || status === 503) return verdict('upstream_unavailable', `http ${status}`)
  if (status !== undefined && status >= 500) return verdict('server_error', `http ${status}`)
  if (status === 400 || status === 413 || status === 422) return verdict('invalid_request', `http ${status}`)

  // A code that names one class exactly, with no contradicting message.
  if (harnessKind !== undefined && !isCoarseCode(code)) return verdict(harnessKind, `code ${code}`)

  // Message wording. Order matters: a message mentioning both "429" and
  // "stream ended" is far more likely a truncated stream than a rate limit,
  // because a real 429 arrives as a status, not as prose.
  if (TIMEOUT_PATTERN.test(detail)) return verdict('timeout', 'message: timeout')
  if (STREAM_CLOSED_PATTERN.test(detail)) return verdict('stream_closed', 'message: stream ended early')
  if (CONTEXT_PATTERN.test(detail)) return verdict('context_overflow', 'message: context limit')
  if (MALFORMED_PATTERN.test(detail)) return verdict('malformed_body', 'message: unparsable body')
  if (AUTH_PATTERN.test(detail)) return verdict('auth', 'message: auth')
  if (QUOTA_PATTERN.test(detail)) return verdict('quota', 'message: quota')
  if (RATE_PATTERN.test(detail)) return verdict('rate_limit', 'message: rate limit')
  if (SERVER_PATTERN.test(detail)) return verdict('server_error', 'message: server')
  if (TRANSPORT_PATTERN.test(detail)) return verdict('transport', 'message: transport')

  // No words left: read the stream itself. A stream that closed with content
  // but no terminal chunk is the classic "incomplete response".
  if (evidence !== undefined && evidence.chunks > 0 && evidence.finish === undefined && evidence.closed) {
    return verdict('stream_closed', 'stream closed without a terminal chunk')
  }
  if (evidence !== undefined && evidence.chunks > 0 && evidence.textChars === 0 && evidence.finish === 'stop') {
    return verdict('empty_response', 'completed with no content')
  }
  if (code === 'EMPTY_RESPONSE') return verdict('empty_response', 'code EMPTY_RESPONSE')
  // Nothing contradicts the harness's own claim, so keep it — but say that it
  // is only a claim. This is the one place RATE_LIMIT survives, and it is
  // labelled as unverified rather than presented as a diagnosis.
  if (code === 'RATE_LIMIT') return verdict('rate_limit', 'harness code only (unverified)')
  // Never fall back to `rate_limit` just because nothing else matched: an
  // unclassified failure is honest, a wrong label is not.
  return verdict('unknown', code === '' ? 'no evidence' : `code ${code}`)
}

/** One failed attempt, as written to the log. */
interface FailureRecord {
  readonly at: string
  readonly kind: NetErrorKind
  readonly because: string
  readonly misclassified: boolean
  harnessCode?: string
  status?: number
  requestId?: string
  provider?: string
  /** Model the attempt asked for (from its stream, when one was seen). */
  model?: string
  turn?: number
  step?: number
  message?: string
  providerRetryAfterMs?: number
  /**
   * The attempt delivered content but never a terminal chunk: an INCOMPLETE
   * response, whatever the harness code calls it. This is the flag to grep for
   * when the question is "did the answer get cut off?".
   */
  incomplete?: boolean
  stream?: StreamEvidence
  raw?: RawCaptureRecord
}

/** The raw body slice attached to a record (never the live capture). */
interface RawCaptureRecord {
  readonly url: string
  readonly status: number
  readonly contentType: string
  readonly body: string
}

/** A raw HTTP response body (or its tail) held for the next failure. */
interface RawCapture {
  readonly url: string
  readonly status: number
  readonly contentType: string
  readonly body: string
  readonly at: number
  claimed: boolean
}

/** A live or finished attempt's stream, kept so its evidence can be attached. */
interface StreamCapture {
  readonly provider: string
  readonly model: string
  readonly purpose: string
  readonly startedAt: number
  chunks: number
  textChars: number
  blocks: string[]
  tail: string
  finish?: string
  closed: boolean
  errorText?: string
  endedAt?: number
  claimed: boolean
}

/** Everything one armed log holds; one instance per process. */
interface State {
  readonly path: string
  readonly streams: StreamCapture[]
  readonly raw: RawCapture[]
  records: number
}

let state: State | undefined

/**
 * The log path this launch writes to: `$DSH_TUI_NET_ERROR_LOG` when set,
 * otherwise `net-error.log` beside the working directory the TUI was started
 * in.
 * @returns An absolute or cwd-relative path, as configured.
 */
export function netErrorLogPath(): string {
  const override = process.env.DSH_TUI_NET_ERROR_LOG
  if (override !== undefined && override.trim() !== '') return override
  return join(process.cwd(), NET_ERROR_LOG_FILE)
}

/**
 * Truncate the log for this launch and write its header. Called once at
 * startup, before any request can fail, so every launch's records stand
 * alone.
 * @returns The path that was prepared, for callers that want to report it.
 */
export function resetNetErrorLog(): string {
  const path = netErrorLogPath()
  state = { path, streams: [], raw: [], records: 0 }
  try {
    mkdirSync(dirname(path), { recursive: true })
    const header = {
      at: new Date().toISOString(),
      event: 'launch',
      pid: process.pid,
      cwd: process.cwd(),
      rawBodies: rawBodiesEnabled(),
      note: 'cleared at dsh-tui startup; one launch per file',
    }
    writeFileSync(path, `${JSON.stringify(header)}\n`)
  } catch {
    // A read-only working directory must not fail the launch: this log is a
    // diagnostic, never a boot precondition.
  }
  return path
}

/** True when the opt-in raw HTTP body capture is requested. */
function rawBodiesEnabled(): boolean {
  const value = process.env.DSH_TUI_NET_RAW
  return value !== undefined && value !== '' && value !== '0' && value !== 'false'
}

/** Append one record; a write failure stays silent by design. */
function appendRecord(record: unknown): void {
  const active = state
  if (active === undefined) return
  try {
    appendFileSync(active.path, `${JSON.stringify(record)}\n`)
    active.records += 1
  } catch {
    // See resetNetErrorLog: logging must never become a failure to run.
  }
}

/** Keep the last `limit` characters of an ever-growing text buffer. */
function tailOf(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** Describe a thrown value without trusting its shape. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : ` (cause: ${describeError(error.cause)})`
    return `${error.name}: ${error.message}${cause}`
  }
  try {
    return String(error)
  } catch {
    return '<unrenderable error>'
  }
}

/** Translate one stream chunk into the attempt's running evidence. */
function observeChunk(capture: StreamCapture, chunk: StreamChunk): void {
  capture.chunks += 1
  switch (chunk.type) {
    case 'block-start':
      if (capture.blocks.length < 64) capture.blocks.push(String(chunk.blockType))
      return
    case 'text-delta':
      capture.textChars += chunk.text.length
      if (capture.textChars <= MAX_CAPTURED_CHARS) capture.tail = tailOf(capture.tail + chunk.text, MAX_TEXT_TAIL)
      return
    case 'reasoning-delta':
      capture.textChars += chunk.text.length
      return
    case 'finish':
      capture.finish = String((chunk.reason as { kind?: unknown }).kind ?? 'unknown')
      return
    default:
      return
  }
}

/** The evidence view of a capture, for the classifier and the record. */
function evidenceOf(capture: StreamCapture): StreamEvidence {
  return {
    chunks: capture.chunks,
    textChars: capture.textChars,
    blocks: [...capture.blocks],
    ...(capture.finish === undefined ? {} : { finish: capture.finish }),
    closed: capture.closed,
    ...(capture.errorText === undefined ? {} : { errorText: capture.errorText }),
    elapsedMs: Math.max(0, (capture.endedAt ?? Date.now()) - capture.startedAt),
    tail: capture.tail,
  }
}

/** A captured stream older than this cannot belong to the failure being recorded. */
const STREAM_MATCH_WINDOW_MS = 180_000

/**
 * The most recent attempt that no record has claimed yet and that is still
 * recent enough to be this failure's own stream.
 *
 * Selection order, most to least specific: same provider and an ordinary
 * turn request; same provider; then the newest unclaimed turn capture, then
 * anything unclaimed. Provider matching is a preference rather than a filter
 * because a route can be renamed between the stream and the failure, and
 * losing the evidence would defeat the log. `purpose` is preferred over
 * `compaction` because a compaction call is a side request that never raises
 * `agent/request-error` — its capture would otherwise be claimed by a later
 * turn failure. Stale captures are never attached: evidence from an unrelated
 * earlier request is worse than no evidence.
 * @param provider - The provider the failing request named, when known.
 * @returns The claimed capture, or undefined when nothing recent is unclaimed.
 */
function claimStream(provider: string | undefined): StreamCapture | undefined {
  const active = state
  if (active === undefined) return undefined
  const now = Date.now()
  const fresh = (candidate: StreamCapture): boolean =>
    !candidate.claimed && now - (candidate.endedAt ?? candidate.startedAt) <= STREAM_MATCH_WINDOW_MS
  const tiers: ((candidate: StreamCapture) => boolean)[] = [
    candidate => candidate.purpose === 'turn' && (provider === undefined || candidate.provider === provider),
    candidate => (provider === undefined || candidate.provider === provider),
    candidate => candidate.purpose === 'turn',
    () => true,
  ]
  for (const accept of tiers) {
    for (let index = active.streams.length - 1; index >= 0; index -= 1) {
      const candidate = active.streams[index]!
      if (!fresh(candidate) || !accept(candidate)) continue
      candidate.claimed = true
      return candidate
    }
  }
  return undefined
}

/** The newest raw body close enough in time to belong to this failure. */
function claimRaw(): RawCapture | undefined {
  const active = state
  if (active === undefined) return undefined
  const now = Date.now()
  for (let index = active.raw.length - 1; index >= 0; index -= 1) {
    const candidate = active.raw[index]!
    if (candidate.claimed || now - candidate.at > RAW_MATCH_WINDOW_MS) continue
    candidate.claimed = true
    return candidate
  }
  return undefined
}

/** The finish reasons that mean the response arrived whole. */
const COMPLETE_FINISHES: ReadonlySet<string> = new Set(['stop', 'tool-calls'])

/**
 * True when an attempt delivered content but did not end normally — the
 * "the answer was cut off" signal, independent of which error class the
 * harness picked. A `max-tokens` finish counts: the answer genuinely stops
 * mid-thought. Recorded beside the class rather than as one, so a truncated
 * frame keeps the adapter's own `malformed_body` verdict and still shows up
 * when searching for cut-off answers.
 * @param evidence - What the attempt's stream delivered.
 * @returns Whether content arrived without a normal completion.
 */
function isIncomplete(evidence: StreamEvidence): boolean {
  if (!evidence.closed || evidence.textChars === 0) return false
  return evidence.finish === undefined || !COMPLETE_FINISHES.has(evidence.finish)
}

/** Record one failed model attempt. */
function recordFailure(
  facts: NetFailureFacts,
  context: { provider?: string; turn?: number; step?: number },
): void {
  if (state === undefined) return
  const capture = claimStream(context.provider)
  const evidence = capture === undefined ? undefined : evidenceOf(capture)
  const verdict = classifyNetError(facts, evidence)
  // A user cancel is not a network problem and would only add noise to a
  // file meant for flaky-upstream forensics.
  if (verdict.kind === 'aborted') return
  const record: FailureRecord = {
    at: new Date().toISOString(),
    kind: verdict.kind,
    because: verdict.because,
    misclassified: verdict.misclassified,
  }
  if (facts.code !== undefined) record.harnessCode = facts.code
  if (facts.status !== undefined) record.status = facts.status
  if (facts.requestId !== undefined) record.requestId = facts.requestId
  if (facts.message !== undefined) record.message = facts.message
  if (facts.providerRetryAfterMs !== undefined) record.providerRetryAfterMs = facts.providerRetryAfterMs
  if (context.provider !== undefined) record.provider = context.provider
  if (capture !== undefined) record.model = capture.model
  if (context.turn !== undefined) record.turn = context.turn
  if (context.step !== undefined) record.step = context.step
  if (evidence !== undefined) record.stream = evidence
  if (evidence !== undefined && isIncomplete(evidence)) record.incomplete = true
  const raw = claimRaw()
  if (raw !== undefined) record.raw = { url: raw.url, status: raw.status, contentType: raw.contentType, body: raw.body }
  appendRecord(record)
}

/** Read a response body's tail without disturbing the real consumer. */
async function readBodyTail(response: Response, limit: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) buffer += decoder.decode(value, { stream: true })
      if (buffer.length > limit * 2) buffer = tailOf(buffer, limit)
    }
    buffer += decoder.decode()
  } catch {
    // A clone that fails to drain must not disturb the original response.
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Nothing to release.
    }
  }
  return tailOf(buffer, limit)
}

/** True for a URL the model adapters actually talk to. */
function looksLikeModelEndpoint(url: string): boolean {
  return /\/(?:messages|chat\/completions|completions|responses)\b/.test(url)
}

/** Snapshot a response for the raw-body ring, off the request path. */
function captureRawBody(url: string, response: Response): void {
  const active = state
  if (active === undefined) return
  const contentType = response.headers.get('content-type') ?? ''
  const interesting = !response.ok || /event-stream|json/i.test(contentType)
  if (!interesting) return
  // The clone tees the body; the real consumer is unaffected, and the tail is
  // all this keeps.
  const clone = response.clone()
  void readBodyTail(clone, MAX_RAW_TAIL).then((body) => {
    active.raw.push({ url, status: response.status, contentType, body, at: Date.now(), claimed: false })
    while (active.raw.length > MAX_RECENT_RAW) active.raw.shift()
  }).catch(() => {
    // The ring is best effort.
  })
}

/**
 * Patch `globalThis.fetch` so model-endpoint bodies can be snapshotted. Only
 * installed when `DSH_TUI_NET_RAW` is truthy; the wrapper is transparent
 * (it returns the original Response untouched) and restores the original on
 * dispose.
 * @returns A disposer that puts the original `fetch` back.
 */
function installRawCapture(): () => void {
  const original = globalThis.fetch
  if (typeof original !== 'function') return () => undefined
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await original(input, init)
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (looksLikeModelEndpoint(url)) captureRawBody(url, response)
    } catch {
      // Observing must never fail the request.
    }
    return response
  }
  globalThis.fetch = patched as typeof globalThis.fetch
  return () => {
    if (globalThis.fetch === (patched as typeof globalThis.fetch)) globalThis.fetch = original
  }
}

/**
 * Arm the log for this launch: truncate the file, then subscribe to the two
 * seams that can describe a failed model response.
 *
 * - `agent/request-error` is where the harness itself decides an attempt
 *   failed; it fires per attempt, so retries each get their own record.
 * - `llm/stream` is wrapped (not replaced) to keep a bounded tail of the
 *   chunks each attempt actually delivered, which the record then reports.
 *
 * @param ctx - The plugin context; listeners ride it and are removed with it.
 * @returns A disposer for callers that do not own a Cordis effect.
 */
export function installNetErrorLog(ctx: Context): () => void {
  resetNetErrorLog()
  const disposers: (() => void)[] = []
  try {
    disposers.push(ctx.on('llm/stream', (options, next) => {
      const stream = next()
      const active = state
      if (active === undefined) return stream
      const capture: StreamCapture = {
        provider: options.provider,
        model: options.model,
        purpose: options.purpose ?? 'turn',
        startedAt: Date.now(),
        chunks: 0,
        textChars: 0,
        blocks: [],
        tail: '',
        closed: false,
        claimed: false,
      }
      active.streams.push(capture)
      while (active.streams.length > MAX_RECENT_STREAMS) active.streams.shift()
      return (async function* observedAttempt(): AsyncGenerator<StreamChunk> {
        try {
          for await (const chunk of stream) {
            observeChunk(capture, chunk)
            yield chunk
          }
        } catch (error) {
          capture.errorText = describeError(error)
          throw error
        } finally {
          capture.closed = true
          capture.endedAt = Date.now()
        }
      })()
    }))
  } catch {
    // Hosts without the llm/stream event keep the failure facts only.
  }
  try {
    // Waterfall: record, then delegate unchanged so retry policy still runs.
    disposers.push(ctx.on('agent/request-error', (payload, next) => {
      try {
        recordFailure(payload.failure, {
          provider: payload.provider,
          turn: payload.turn,
          step: payload.step,
        })
      } catch {
        // A log write must never break the request path.
      }
      return next()
    }))
  } catch {
    // Hosts without the agent event still get the launch header.
  }
  if (rawBodiesEnabled()) disposers.push(installRawCapture())
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Teardown is best effort; the process is leaving anyway.
      }
    }
    state = undefined
  }
}

/** Test seam: the path the last reset prepared. */
export function netErrorLogState(): { readonly path: string; readonly records: number } | undefined {
  return state === undefined ? undefined : { path: state.path, records: state.records }
}

/**
 * net-error.log gate (`node --import tsx/esm scripts/verify-net-error-log.ts`).
 *
 * The experimental per-launch network-failure log (src/dsh-adapter/net-error-log.ts)
 * has one job that is easy to get subtly wrong: it must name the failure class
 * the EVIDENCE supports, and must not inherit the harness's habit of calling
 * every unexplained upstream hiccup a rate limit. This gate pins:
 *
 *  1. Classification order — an explicit HTTP status outranks the harness
 *     code, which outranks message wording, which outranks stream shape.
 *  2. The three failures this branch exists for are named for what they are:
 *     a truncated stream reported as `RATE_LIMIT`, an idle timeout, and a
 *     corrupt body — each flagged `misclassified` when the harness disagrees.
 *  3. An unclassifiable failure stays `unknown` instead of collapsing to
 *     `rate_limit` (the whole point of the log).
 *  4. The file contract: `resetNetErrorLog` truncates, `installNetErrorLog`
 *     records one NDJSON line per failed attempt with the stream evidence
 *     that attempt delivered, and a user abort is not recorded at all.
 *  5. The log never throws into the request path (unwritable path, missing
 *     host events).
 *
 * Everything runs against a fake Cordis context and a temp directory, so no
 * real request, terminal or profile is touched.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  classifyNetError,
  installNetErrorLog,
  netErrorLogPath,
  resetNetErrorLog,
  type NetErrorKind,
  type StreamEvidence,
} from '../src/dsh-adapter/net-error-log.js'

let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}

const kindOf = (facts: Parameters<typeof classifyNetError>[0], evidence?: StreamEvidence): NetErrorKind =>
  classifyNetError(facts, evidence).kind

/** A stream that delivered text and then died with no terminal chunk. */
const TRUNCATED: StreamEvidence = {
  chunks: 3,
  textChars: 12,
  blocks: ['text'],
  closed: true,
  elapsedMs: 900,
  tail: 'partial ans',
}

// ── 1. HTTP status is the strongest signal ──────────────────────────────
check('http 429 is a rate limit', kindOf({ code: 'RATE_LIMIT', status: 429 }) === 'rate_limit')
check('http 504 is a timeout even when the code says RATE_LIMIT', kindOf({ code: 'RATE_LIMIT', status: 504 }) === 'timeout')
check('http 503 is upstream_unavailable, not SERVER', kindOf({ code: 'SERVER', status: 503 }) === 'upstream_unavailable')
check('http 402 is quota', kindOf({ code: 'RATE_LIMIT', status: 402 }) === 'quota')
check('http 401 is auth', kindOf({ code: 'AUTH', status: 401 }) === 'auth')
check('http 413 is invalid_request', kindOf({ code: 'INVALID_REQUEST', status: 413 }) === 'invalid_request')

// ── 2. The three cases this log exists for ──────────────────────────────
const closedVerdict = classifyNetError(
  { code: 'RATE_LIMIT', message: 'pi-ai stream ended before the terminal event' },
  TRUNCATED,
)
check('a truncated stream the harness called RATE_LIMIT is logged as stream_closed', closedVerdict.kind === 'stream_closed', closedVerdict)
check('…and flagged misclassified', closedVerdict.misclassified)
check('a real rate limit is not flagged', !classifyNetError({ code: 'RATE_LIMIT', status: 429 }).misclassified)

const timeoutVerdict = classifyNetError({ code: 'RATE_LIMIT', message: 'pi-ai stream idle timeout after 300000ms' })
check('an idle timeout is a timeout, not a rate limit', timeoutVerdict.kind === 'timeout', timeoutVerdict)
check('…and flagged misclassified', timeoutVerdict.misclassified)

const corruptVerdict = classifyNetError({ code: 'PI_AI_ERROR', message: 'Unexpected token < in JSON at position 0' })
check('a corrupt body is malformed_body', corruptVerdict.kind === 'malformed_body', corruptVerdict)

const truncatedJson = classifyNetError({ code: 'RATE_LIMIT', message: 'truncated JSON payload in SSE frame' })
check('a truncated payload is malformed_body, not a rate limit', truncatedJson.kind === 'malformed_body', truncatedJson)

// ── 3. No silent collapse to rate_limit ────────────────────────────────
check('an unclassifiable failure stays unknown', kindOf({ code: 'PI_AI_ERROR', message: 'something odd happened' }) === 'unknown')
check('a bare RATE_LIMIT code with no evidence is still a rate limit', kindOf({ code: 'RATE_LIMIT' }) === 'rate_limit')
check('an exact code wins over absent wording', kindOf({ code: 'QUOTA' }) === 'quota')
check('EMPTY_RESPONSE stays empty_response', kindOf({ code: 'EMPTY_RESPONSE' }) === 'empty_response')
check('a stream that closed with content and no finish chunk is stream_closed',
  kindOf({ code: 'PI_AI_ERROR', message: 'no details' }, TRUNCATED) === 'stream_closed')

// ── 3b. Codes the shipped adapters really raise ─────────────────────────
check('MALFORMED_RESPONSE is malformed_body', kindOf({ code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages expected a JSON object' }) === 'malformed_body')
check('MISSING_CREDENTIAL is auth, not unknown', kindOf({ code: 'MISSING_CREDENTIAL' }) === 'auth')
check('CONTEXT_WINDOW_EXCEEDED is context_overflow', kindOf({ code: 'CONTEXT_WINDOW_EXCEEDED' }) === 'context_overflow')
check('a transport failure stays transport', kindOf({ code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' }) === 'transport')

// ── 4. File contract ───────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-net-error-'))
const logPath = join(dir, 'net-error.log')
process.env.DSH_TUI_NET_ERROR_LOG = logPath
try {
  check('the configured path is honoured', netErrorLogPath() === logPath)

  // A stale file from a previous launch must be gone after reset.
  writeFileSync(logPath, '{"stale":true}\n')
  resetNetErrorLog()
  const header = readFileSync(logPath, 'utf8')
  check('reset truncates the previous launch', !header.includes('stale') && header.includes('"event":"launch"'), header)
  check('the header records whether raw bodies are on', header.includes('"rawBodies":false'))

  // A fake context with the two seams the log subscribes to.
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const disposers: string[] = []
  const ctx = {
    on(event: string, listener: (...args: never[]) => unknown) {
      listeners.set(event, listener)
      return () => { listeners.delete(event); disposers.push(event) }
    },
  }
  const dispose = installNetErrorLog(ctx as never)

  // One attempt: the stream delivers two chunks then throws, exactly like a
  // dropped upstream link; the harness then reports RATE_LIMIT.
  const streamHook = listeners.get('llm/stream') as unknown as (
    options: { provider: string; model: string },
    next: () => AsyncIterable<StreamChunk>,
  ) => AsyncIterable<StreamChunk>
  check('llm/stream is observed', typeof streamHook === 'function')
  const observed = streamHook(
    { provider: 'deepseek', model: 'deepseek-v4' },
    () => (async function* upstream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'partial ans' }
      throw new Error('pi-ai stream ended before the terminal event')
    })(),
  )

  const errorHook = listeners.get('agent/request-error') as unknown as (
    payload: { provider: string; turn: number; step: number; failure: { code: string; message: string } },
    next: () => Promise<unknown>,
  ) => Promise<unknown>

  let delegated = 0
  const run = async (): Promise<void> => {
    try {
      for await (const _chunk of observed) {
        // Drain the observed stream: the throw lands here, as it does in the loop.
      }
    } catch {
      // Expected: the upstream link dropped.
    }
    await errorHook(
      { provider: 'deepseek', turn: 2, step: 1, failure: { code: 'RATE_LIMIT', message: 'pi-ai stream ended before the terminal event' } },
      () => { delegated += 1; return Promise.resolve(undefined) },
    )
  }
  await run()

  const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
  check('the launch header plus one failure line', lines.length === 2, lines)
  const record = JSON.parse(lines[1]!) as Record<string, unknown>
  check('the record names the real failure class', record.kind === 'stream_closed', record)
  check('the harness code is preserved beside it, not replaced', record.harnessCode === 'RATE_LIMIT', record)
  check('the disagreement is flagged', record.misclassified === true, record)
  check('the attempt position is recorded', record.turn === 2 && record.step === 1, record)
  const evidence = record.stream as StreamEvidence
  check('the delivered stream is recorded', evidence.chunks === 1 && evidence.textChars === 11, evidence)
  check('the stream error text is captured', typeof evidence.errorText === 'string' && evidence.errorText.includes('ended before'), evidence)
  check('no terminal chunk is claimed', evidence.finish === undefined, evidence)
  check('content without a terminal chunk is flagged incomplete', record.incomplete === true, record)
  check('the model is recorded from the attempt stream', record.model === 'deepseek-v4', record)
  check('the waterfall still delegated to the real handler', delegated === 1)

  // A user abort is not a network failure and must not be logged.
  const before = readFileSync(logPath, 'utf8').trimEnd().split('\n').length
  await errorHook(
    { provider: 'deepseek', turn: 3, step: 1, failure: { code: 'ABORTED', message: 'pi-ai request aborted by caller' } },
    () => Promise.resolve(undefined),
  )
  const after = readFileSync(logPath, 'utf8').trimEnd().split('\n').length
  check('a user abort writes no record', after === before)

  dispose()
  check('dispose unsubscribes both seams', disposers.length === 2, disposers)

  // ── 4b. Opt-in raw HTTP body capture ─────────────────────────────────
  {
    process.env.DSH_TUI_NET_RAW = '1'
    resetNetErrorLog()
    const rawListeners = new Map<string, (...args: never[]) => unknown>()
    const originalFetch = globalThis.fetch
    // A stand-in transport: the model endpoint answers with an error body,
    // every other URL with an ordinary one. The patched fetch wraps THIS.
    const stubFetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('/messages')) return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
      return new Response('{"error":{"type":"overloaded_error","message":"busy"}}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    globalThis.fetch = stubFetch
    try {
      const rawDispose = installNetErrorLog({
        on(event: string, listener: (...args: never[]) => unknown) {
          rawListeners.set(event, listener)
          return () => { rawListeners.delete(event) }
        },
      } as never)
      check('raw capture keeps fetch patched', globalThis.fetch !== originalFetch)

      await globalThis.fetch('https://api.example.com/v1/messages', { method: 'POST' })
      await globalThis.fetch('https://api.example.com/health')
      // The body tail is read off the request path; let that promise settle.
      await new Promise(resolve => setTimeout(resolve, 20))

      const rawErrorHook = rawListeners.get('agent/request-error') as unknown as (
        payload: { provider: string; turn: number; step: number; failure: { code: string; message: string; status?: number } },
        next: () => Promise<unknown>,
      ) => Promise<unknown>
      await rawErrorHook(
        { provider: 'deepseek', turn: 4, step: 1, failure: { code: 'SERVER', message: 'busy', status: 503 } },
        () => Promise.resolve(undefined),
      )
      const rawLines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
      const rawRecord = JSON.parse(rawLines[1]!) as Record<string, unknown>
      const raw = rawRecord.raw as { url: string; status: number; body: string } | undefined
      check('the raw provider body is attached', raw !== undefined && raw.body.includes('overloaded_error'), rawRecord)
      check('the raw capture records the real status', raw?.status === 503, raw)
      check('only the model endpoint is captured', raw?.url.includes('/messages') === true, raw)

      rawDispose()
      check('dispose restores the wrapped fetch', globalThis.fetch === stubFetch)
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.DSH_TUI_NET_RAW
    }
  }

  // ── 5. Never throws into the request path ────────────────────────────
  process.env.DSH_TUI_NET_ERROR_LOG = join(dir, 'no-such-dir', 'nested', 'net-error.log')
  let threw = false
  try {
    resetNetErrorLog()
  } catch {
    threw = true
  }
  check('an unwritable path is created, not thrown', !threw)

  process.env.DSH_TUI_NET_ERROR_LOG = logPath
  let bareThrew = false
  try {
    const bare = installNetErrorLog({ on() { throw new Error('host has no such event') } } as never)
    bare()
  } catch {
    bareThrew = true
  }
  check('a host without the seams still installs and disposes', !bareThrew)
} finally {
  delete process.env.DSH_TUI_NET_ERROR_LOG
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\nverify-net-error-log: ${passed} checks passed`)

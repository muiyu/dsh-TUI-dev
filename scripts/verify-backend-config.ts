/**
 * Config-stage backend choice regression (PR #1577 review R2).
 *
 * Cordis validates a row's `Config` **before** its `apply` runs, while the
 * backends an installed bundle declares register only *inside* `apply`
 * (`assembleBackendsFromProfile`, plugin.ts). A Config schema that answered
 * registry membership at validation time therefore erased a statically
 * configured third-party id before the assembly that could admit it — the boot
 * then followed the remembered kernel (or dsh) while the user's own Config row
 * silently named another backend.
 *
 * This regression drives the real `Config` schema through a real Cordis
 * composition: a Loader based at a throwaway profile, a probe row that runs the
 * documented order (assemble, then parse) inside its `apply`, and a
 * bundle-shaped fixture under the profile's `node_modules` that declares one
 * backend. It pins the split the fix establishes — syntax at schema time
 * (`parseBackendId`), membership after the assembly (`parseBackendChoice`) —
 * and the no-widening half: an id no installed bundle answers to keeps the old
 * semantics (no pin; the memory/env chain still decides). The whole matrix runs
 * in a fresh child process with a unique id and an isolated HOME/DSH_HOME, so
 * the process-global registry never leaks into the parent or a sibling
 * regression.
 *
 * Run: node --import tsx/esm scripts/verify-backend-config.ts
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import './lib/fake-home.mjs' // 必须最先：DATA_DIR 在 import 时定死

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// Deterministic UI language: nothing here asserts text, but the modules under
// test resolve a locale at import time.
process.env.DSH_TUI_LANG = 'en'
// Isolated harness home too: DSH_HOME decides where credentials/session logs
// would live, and this regression must never read a real one.
const SANDBOX = mkdtempSync(join(tmpdir(), 'verify-backend-config-'))
process.env.DSH_HOME = join(SANDBOX, 'dsh-home')
process.on('exit', () => rmSync(SANDBOX, { recursive: true, force: true }))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (extra === '' || ok ? '' : '  (' + extra + ')'))
  if (!ok) failed += 1
}

/** The bundle package the throwaway profile installs. */
const BUNDLE = '@dsh-tui-verify/config-bundle'

interface Fixture {
  /** The Loader's `baseUrl` for this profile. */
  readonly profileUrl: string
  /** Written by the backend module when it is evaluated (D4 laziness probe). */
  readonly marker: string
}

/**
 * One installed bundle under the profile's `node_modules`: a package.json that
 * makes it a profile layer (`dsh.bundle`), a package-root `dsh-plugin.json`
 * declaring one `Backend`, and the entry module. The module writes a marker on
 * evaluation, so an eager import by the schema or the assembly is observable.
 */
function writeBundleFixture(profileDir: string, backendId: string): Fixture {
  const bundleDir = join(profileDir, 'node_modules', ...BUNDLE.split('/'))
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: BUNDLE,
    version: '0.1.0',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    exports: { '.': './main.js' },
  }, null, 2))
  writeFileSync(join(bundleDir, 'dsh-plugin.json'), JSON.stringify({
    $schema: 'urn:dsh-std:community-draft:dsh-plugin:0.15',
    manifestVersion: '0.15',
    id: 'com.example.config-bundle',
    name: 'Config Bundle',
    version: '0.1.0',
    facets: { host: { entry: 'main.js', apiVersion: 'v1alpha1' } },
    requires: { contracts: [] },
    permissions: [],
    contributes: {
      commands: [],
      'x-dsh-tui': [{
        apiVersion: 'tui.dsh/v1alpha1',
        kind: 'Backend',
        id: `com.example.${backendId}`,
        name: 'config_backend',
        spec: {
          id: backendId,
          label: { text: 'Config Agent' },
          shortLabel: 'Config',
          capabilities: [],
          grants: [],
        },
      }],
    },
    subscriptions: [],
    license: 'MIT',
    source: { repository: 'https://example.com/verify-backend-config' },
  }, null, 2))
  writeFileSync(join(bundleDir, 'main.js'), `import { writeFileSync } from 'node:fs'
writeFileSync(new URL('./imported.txt', import.meta.url), '1')
export const backend = { id: 'config-handler', detect: async () => undefined, open: async () => undefined }
export default function plugin() {}
`)
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-verify-backend-config',
    private: true,
    dependencies: { [BUNDLE]: '0.1.0' },
    dsh: { profile: { bundles: [BUNDLE], patchReload: 'live' } },
  }, null, 2))
  return { profileUrl: pathToFileURL(profileDir).href + '/', marker: join(bundleDir, 'imported.txt') }
}

/** A profile with no installed bundle: the cases that must register nothing. */
function writePlainFixture(profileDir: string): string {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-verify-backend-config-plain',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patchReload: 'live' } },
  }, null, 2))
  return pathToFileURL(profileDir).href + '/'
}

interface ProbeObservation {
  /** `config.backend` as the real schema handed it to `apply`. */
  readonly raw: string | null
  /** The membership parse inside `apply`, before the assembly ran. */
  readonly beforeAssembly: string | null
  /** The membership parse after the assembly ran. */
  readonly afterAssembly: string | null
  /** Backend ids this pass registered (the built-in seed is not reported). */
  readonly registered: readonly string[]
  readonly warnings: number
}

/**
 * Mount a real composition and run one Config row through it. The probe row
 * carries the production `Config` schema, so Cordis validates the value before
 * `apply` — the exact ordering the fix depends on. Inside `apply` the probe
 * mirrors plugin.ts: read what survived the schema, assemble the installed
 * bundles, then parse membership.
 */
async function probeConfigRow(input: { readonly profileUrl: string; readonly config: unknown }): Promise<ProbeObservation> {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  const { Config } = await import('../src/dsh-adapter/index.js')
  const { assembleBackendsFromProfile } = await import('../src/dsh-adapter/backend-assembly.js')
  const { parseBackendChoice } = await import('../src/dsh-adapter/backend-registry.js')

  const root = new Context()
  const warnings: string[] = []
  root.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof root.logger.warn
  root.logger.info = () => undefined
  ;(root as { baseUrl?: string }).baseUrl = input.profileUrl
  await root.plugin(Loader, { baseUrl: input.profileUrl })

  let observed: ProbeObservation | undefined
  let settle: (() => void) | undefined
  const applied = new Promise<void>(resolve => { settle = resolve })
  await root.plugin({
    name: 'dsh-tui-config-probe',
    Config,
    apply: (ctx: unknown, config: { backend?: unknown }) => {
      const raw = config.backend
      const beforeAssembly = parseBackendChoice(raw) ?? null
      const assembly = assembleBackendsFromProfile(ctx as never)
      observed = {
        raw: typeof raw === 'string' ? raw : null,
        beforeAssembly,
        afterAssembly: parseBackendChoice(raw) ?? null,
        registered: assembly.registered,
        warnings: warnings.length,
      }
      settle?.()
    },
  }, input.config)
  await applied
  await root.fiber.dispose()
  if (observed === undefined) throw new Error('the Config probe row never applied')
  return observed
}

/** `resolveRememberedBackend` with only the fields a case wants to name. */
async function rememberedKernel(id: string | null, rest: Record<string, unknown>): Promise<string> {
  const { resolveRememberedBackend } = await import('../src/kernelPrefs.js')
  return (resolveRememberedBackend as (input: Record<string, unknown>) => string)({
    ...(id === null ? {} : { configured: id }),
    ...rest,
  })
}

/** The fresh process: build the fixtures, run the matrix, write the report. */
async function runChild(reportFile: string, thirdPartyId: string, unknownId: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'verify-backend-config-run-'))
  const lines: string[] = []
  const record = (name: string, fields: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ name, ...fields }))
  }
  try {
    // The no-bundle profile first: none of these cases may register anything,
    // so the later bundle case is the only pass that owns its id.
    const plainUrl = writePlainFixture(join(dir, 'plain'))

    const unknown = await probeConfigRow({ profileUrl: plainUrl, config: { backend: unknownId } })
    record('unknown', {
      ...unknown,
      pinned: unknown.afterAssembly !== null,
      memoryWins: await rememberedKernel(unknown.afterAssembly, { memory: 'claude' }),
      envWins: await rememberedKernel(unknown.afterAssembly, { envRaw: 'claude', envKnown: () => true }),
      // Negative control: the raw Config value (what a membership-free schema
      // keeps) would outrank the memory — the boot must pass the membership
      // parse into the resolver, which is what makes "no pin" hold.
      rawWouldWin: await rememberedKernel(unknownId, { memory: 'claude' }),
    })

    const invalid = await probeConfigRow({ profileUrl: plainUrl, config: { backend: 'has:colon' } })
    record('invalid', { ...invalid, pinned: invalid.afterAssembly !== null })

    const absent = await probeConfigRow({ profileUrl: plainUrl, config: {} })
    record('absent', { ...absent, pinned: absent.afterAssembly !== null })

    const builtin = await probeConfigRow({ profileUrl: plainUrl, config: { backend: ' Codex ' } })
    record('builtin', {
      ...builtin,
      pinned: builtin.afterAssembly !== null,
      backendChoice: await rememberedKernel(builtin.afterAssembly, { memory: 'dsh' }),
    })

    const fixture = writeBundleFixture(join(dir, 'profile'), thirdPartyId)
    const thirdParty = await probeConfigRow({
      profileUrl: fixture.profileUrl,
      config: { backend: ` ${thirdPartyId.toUpperCase()} ` },
    })
    record('third-party', {
      ...thirdParty,
      pinned: thirdParty.afterAssembly !== null,
      backendChoice: await rememberedKernel(thirdParty.afterAssembly, { memory: 'claude' }),
      moduleImported: existsSync(fixture.marker),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  writeFileSync(reportFile, lines.join('\n') + '\n')
}

if (process.env.DSH_TUI_CONFIG_CHILD === '1') {
  await runChild(
    process.env.DSH_TUI_CONFIG_REPORT ?? join(SANDBOX, 'report.jsonl'),
    process.env.DSH_TUI_CONFIG_THIRD_PARTY_ID ?? '',
    process.env.DSH_TUI_CONFIG_UNKNOWN_ID ?? '',
  )
  process.exit(0)
}

// ── the fresh child: unique ids keep the process-global registry private ──────
const suffix = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const THIRD_PARTY_ID = `cfg-agent-${suffix}`
const UNKNOWN_ID = `cfg-absent-${suffix}`
const reportFile = join(SANDBOX, 'child-report.jsonl')
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DSH_TUI_CONFIG_CHILD: '1',
  DSH_TUI_CONFIG_REPORT: reportFile,
  DSH_TUI_CONFIG_THIRD_PARTY_ID: THIRD_PARTY_ID,
  DSH_TUI_CONFIG_UNKNOWN_ID: UNKNOWN_ID,
}
// These cases isolate Config from the other production selection sources.
for (const key of ['DSH_TUI_BACKEND', 'DSH_TUI_BACKEND_HANDOFF', 'DSH_TUI_RESUME_SESSION', 'DSH_TUI_RESUME_BACKEND', 'DSH_TUI_RESUME_RETRY']) delete childEnv[key]
const child = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url)], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
  env: childEnv,
})
check('the fresh-child regression ran', child.status === 0,
  (child.stdout + child.stderr + String(child.error ?? '')).trim().slice(-1500))

const rows: Record<string, unknown>[] = existsSync(reportFile)
  ? readFileSync(reportFile, 'utf8').trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>)
  : []
const rowOf = (name: string): Record<string, unknown> => rows.find(row => row.name === name) ?? {}
check('the child reported every case', JSON.stringify(rows.map(row => row.name)) === JSON.stringify(['unknown', 'invalid', 'absent', 'builtin', 'third-party']),
  JSON.stringify(rows.map(row => row.name)))

// ── the regression itself: a statically configured third-party backend ────────
const thirdParty = rowOf('third-party')
check('a statically configured third-party id survives the Config schema normalized (trim + lowercase) — the R2 regression',
  thirdParty.raw === THIRD_PARTY_ID, JSON.stringify(thirdParty))
check('at Config-validation time the id is not registered yet — the assembly runs inside apply',
  thirdParty.beforeAssembly === null, JSON.stringify(thirdParty))
check('after the assembly the same id is the membership parse and the registered entry',
  thirdParty.afterAssembly === THIRD_PARTY_ID && JSON.stringify(thirdParty.registered) === JSON.stringify([THIRD_PARTY_ID]),
  JSON.stringify(thirdParty))
check('the configured id is pinned and reaches the kernel decision',
  thirdParty.pinned === true && thirdParty.backendChoice === THIRD_PARTY_ID, JSON.stringify(thirdParty))
check('the schema and the assembly never import the backend module (D4 laziness)',
  thirdParty.moduleImported === false, JSON.stringify(thirdParty))

// ── the no-widening half: an id nothing installed still falls back ────────────
const unknown = rowOf('unknown')
check('a well-formed uninstalled id survives the schema, but has no membership before or after the assembly',
  unknown.raw === UNKNOWN_ID && unknown.beforeAssembly === null && unknown.afterAssembly === null, JSON.stringify(unknown))
check('an uninstalled Config value does not pin the boot (the old "not configured" semantics)',
  unknown.pinned === false, JSON.stringify(unknown))
check('the remembered kernel and the env chain still win for an uninstalled Config value',
  unknown.memoryWins === 'claude' && unknown.envWins === 'claude', JSON.stringify(unknown))
check('negative control: the raw Config value would outrank the memory — the boot must pass the membership parse',
  unknown.rawWouldWin === UNKNOWN_ID, JSON.stringify(unknown))

const invalid = rowOf('invalid')
check('a malformed id is still dropped by the schema (undefined, never preserved)',
  invalid.raw === null && invalid.afterAssembly === null && invalid.pinned === false, JSON.stringify(invalid))

const absent = rowOf('absent')
check('an absent backend key reads as not configured and never pins',
  absent.raw === null && absent.afterAssembly === null && absent.pinned === false, JSON.stringify(absent))

const builtin = rowOf('builtin')
check('an ordinary registered choice still normalizes, pins and selects',
  builtin.raw === 'codex' && builtin.afterAssembly === 'codex'
  && builtin.pinned === true && builtin.backendChoice === 'codex', JSON.stringify(builtin))

// ── the wiring of both call sites, in the real sources ────────────────────────
// The behavioral cases above prove the schema; these prove that the row still
// orders the two halves the way the boot does. A schema that calls the
// membership parse, or a pin keyed on the raw Config value, is the R2 failure.
const indexSource = readFileSync(join(ROOT, 'src', 'dsh-adapter', 'index.ts'), 'utf8')
const SYNTAX_ONLY_FIELD = /backend:\s*Schema\.transform\(\s*Schema\.string\(\),\s*value => parseBackendId\(value\)\s*\)/u
check('the Config schema keeps the syntax half only and leaves membership to the boot',
  SYNTAX_ONLY_FIELD.test(indexSource),
  JSON.stringify(indexSource.match(/backend:\s*Schema\.transform\([^\n]*/u)?.[0] ?? ''))
check('the wiring check bites: the old membership-calling field is red',
  !SYNTAX_ONLY_FIELD.test(indexSource.replace('value => parseBackendId(value)', 'value => normalizeBackendChoice(value)')))

const pluginSource = readFileSync(join(ROOT, 'src', 'dsh-adapter', 'plugin.ts'), 'utf8')
check('backendPinned is keyed on the post-assembly membership parse, not the raw Config value',
  /const backendPinned = configuredBackend !== undefined/u.test(pluginSource)
  && !/const backendPinned = config\.backend !== undefined/u.test(pluginSource),
  JSON.stringify(pluginSource.match(/const backendPinned = [^\n]*/u)?.[0] ?? ''))

console.log(failed === 0 ? 'verify-backend-config ALL PASS' : `verify-backend-config ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

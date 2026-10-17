/**
 * The entry module of the D-5 dogfood bundle.
 *
 * Everything here is written against the **published** surface and nothing else:
 * no `@deepseek-ai/*` import, no `src/` import, no host service. That is the point
 * of the fixture — a third-party backend is a package on disk that
 *
 *   1. ships a package-root `dsh-plugin.json` declaring
 *      `contributes['x-dsh-tui'] = [{ apiVersion: 'tui.dsh/v1alpha1', kind:
 *      'Backend', id, name, spec }]`,
 *   2. exports its handler from this module under the documented name `backend`
 *      (the registry's `backendExport` default), and
 *   3. names, in `spec.unloadExport`, the module-level pool hook the host closes
 *      after the composition is disposed — if it has one.
 *
 * The host resolves this module through the Loader's own ESM resolver and only
 * imports it when a session actually selects the backend, so nothing above may
 * have a side effect at import time.
 */

/** How many times the host closed the pool. Module-local on purpose: the
 *  regression reads it through the Loader's own instance of this module, so the
 *  count proves the host's unload call reached *this* module without writing any
 *  host state (no file, no service, no shared location). */
let echoPoolCloses = 0

/** The pool hook `spec.unloadExport` names. The host closes a backend's
 *  module-level pool only if it actually imported the module, and only after the
 *  composition was disposed (D4) — a fixture with a runtime would close its
 *  handles here. */
export async function closeEchoPool() {
  echoPoolCloses += 1
}

/** Read-only count of {@link closeEchoPool} calls. Not part of the published
 *  backend surface — a bundle may export whatever else it likes — it exists so
 *  the dogfood regression can observe exactly-once closing from outside. */
export function echoPoolCloseCount() {
  return echoPoolCloses
}

export const backend = {
  id: 'echo-agent',
  descriptor: { label: 'Echo Agent' },
  /**
   * Never throws: an unavailable state is a detection, not a failure. This
   * fixture has no runtime behind it, so it reports exactly that — the picker row
   * still appears (the assembly chain is what the fixture proves) and says where
   * it stops instead of offering a session that cannot open.
   */
  async detect() {
    return {
      installed: false,
      hint: 'dsh-tui fixture: the echo backend ships a declaration, not a runtime',
    }
  },
  /** The boundary this fixture does not implement: everything past the assembly
   *  chain belongs to a real backend's own session implementation. */
  async open() {
    throw new Error('dsh-tui fixture: the echo backend stops at the assembly chain (declaration → admission → registry → picker)')
  },
}

/** A bundle is a Cordis plugin package; this one contributes no row, so its
 *  default export does nothing. */
export default function echoBackendBundle() {}

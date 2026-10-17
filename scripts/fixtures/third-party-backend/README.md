# `third-party-backend` — the D-5 dogfood bundle

A third-party backend bundle **as it would be published**: written against the
frozen `tui.dsh/v1alpha1` `Backend` contribution family and nothing else — no
`@deepseek-ai/*` dependency, no `src/` import, no host service. It is never
published; `scripts/verify-backend-assembly.ts` installs it into a throwaway
profile and drives the real assembly chain over it.

What a bundle must get right, and where each piece lives here:

| Piece | Why | File |
|---|---|---|
| `dsh.bundle.patch` | Only an installed package whose `package.json` declares it becomes a profile *layer* (`dsh.profile.bundles`), and that list is what the D-1 assembly reads | `package.json`, `cordis.patch.yml` |
| package-root `dsh-plugin.json` | The declaration the host admits; it counts only beside the `package.json` that establishes the entry's package root (#1568) | `dsh-plugin.json` |
| `contributes['x-dsh-tui']` with `kind: 'Backend'` | The writing surface: `apiVersion` + `kind` + contribution `id` + `name` + `spec` (`spec.id` is the backend id) | `dsh-plugin.json` |
| handler export named `backend` | The registry's documented default (`backendExport` is in-tree only, so a declaration cannot name another export) | `backend.js` |
| `spec.unloadExport` | Module-level/process-wide pools only; session-scoped resources belong to `session.dispose()` | `dsh-plugin.json` → `backend.js` |
| `exports: { ".": "./backend.js" }` | Resolution goes through the entry the Loader's own resolver picks — an `exports` map that hides `./package.json` is fine on purpose | `package.json` |

A bundle currently declares one backend: the fixed `backend` export must pass
the handler assertion and carry the same id as `spec.id`. Multiple declarations
are refused, as are manifests whose canonical projection rejects duplicate
contribution identities. Entries awaiting authorization are not probed or loaded.

The full field semantics are in
[`notes/0009-backend-contribution.md`](../../../tui-profile/notes/0009-backend-contribution.md)
and the seam write-up in
[`docs/plugin-admission-and-development.md`](../../../tui-profile/docs/plugin-admission-and-development.md)
(接缝十四). The published type face is exported from this package's entry
(`BackendSpec`, `validateBackendSpec`, `backendAdmission`, …).

This fixture stops at the picker: `detect()` says honestly that it ships no
runtime, and `open()` refuses. Everything past the assembly chain — detection,
sessions, catalogs, the install wizard — is a real backend's own work.

`closeEchoPool()` is inert (there is no runtime to close) but counts its calls,
and `echoPoolCloseCount()` exposes that count read-only. The regression reads it
through the Loader's own module instance, so it observes that the host closes the
declared pool exactly once, only for a backend it actually loaded.

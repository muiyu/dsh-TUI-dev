// The reference implementation's coordinate index, kept dependency-free so the
// host-side mirror gate (`scripts/verify-plugin-spec.ts`) can compare it with the
// production `registryEntries()` without pulling in @dsh-std.
//
// The sections must match the host (`src/adapter/standard/registry.ts`): imports +
// definitions + extensions. W-2 made `extensions` load-bearing — a bundle's
// `requires.contracts` may name a manifest extension coordinate
// (`tui.dsh/v1alpha1#Backend`) and the host resolves it against that section.
// Indexing only imports + definitions made this reference implementation throw
// "not admitted by this profile" where the host answered
// `REQUIRED_PROTOCOL_UNAVAILABLE` — the two sides disagreed on a valid manifest
// (D-4 gap 6).
export function profileEntriesOf(profile) {
  return [...profile.imports, ...profile.definitions, ...(profile.extensions ?? [])]
}

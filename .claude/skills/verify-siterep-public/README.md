# verify-siterep-public

Proves a siterep-public change works the way a user sees it. `SKILL.md` says how
to launch the local Worker, check its health, drive it and keep the evidence.
`features/` is the feature map: one file per user-facing feature, with the route,
how a user reaches it, how to drive it, and what proves it works.

## Keeping the map true

- A PR that adds or changes a user-facing feature updates its file in
  `features/` in the same PR, or adds a new file and a row in `SKILL.md`.
- Run `/maintain-verification-skill` (pstack) after a run of feature PRs, or when
  a drive fails because the map is wrong. It reads each feature from source,
  drives every feature once against `npm run cf:dev`, and opens at most one PR
  that fixes only this folder. A broken feature is reported, never hidden in
  the docs.

## Switch it off

Delete this folder. Nothing in CI or the app reads it.

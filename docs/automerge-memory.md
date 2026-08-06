# Automerge wasm memory: rules, ownership, and known leaks

Verified against `@automerge/automerge` 3.4.0 on node 22 (2026-08-05), during
the poisoned-document hardening (commits 9a01334..d57e7e7).

## The ground rule

**Automerge documents live in wasm memory and are never reclaimed by the
JavaScript garbage collector.** Forced GC (`node --expose-gc`, `global.gc()`)
frees nothing. Every `Automerge.clone`, `load`, `init`, or `from` allocates a
wasm-side document (~the doc's full size — measured ~0.8MB for a 20k-char
text doc) that survives until `Automerge.free(doc)` is called explicitly.
The wasm module has a 4GB memory cap; when allocation fails the module
aborts (`rust_oom` → every subsequent call on any doc throws
`Module terminated`) and takes every document in the process down with it.
~4,000 leaked clones of a 20k-char doc reach that cap.

Corollaries:

- A clone-per-keystroke (or per-signal) pattern is a guaranteed eventual
  OOM, not a slow leak. Hot paths must operate **in place** on the live
  handle (`Automerge.change`, `applyChanges`, `receiveSyncMessage`,
  `generateSyncMessage` all return a new proxy over the *same* wasm handle
  — they allocate nothing).
- In-place operations make the previous proxy **stale**: reads still work,
  but `Automerge.change` on a stale proxy throws "Attempting to change an
  outdated document". Any store holding a doc must be re-pointed at the
  newest proxy *before* any subsequent operation that can throw — otherwise
  a contained error wedges the store permanently (see
  `SessionStore.change()` and `handleSyncRequest`).
- `Automerge.getHeads` on a freed doc does **not** throw (it reads a
  JS-side cache), so it is useless as a liveness check.
- `Automerge.initSyncState()` is a plain JS object — not a leak class.
- `Automerge.view` shares the handle — no allocation.

## Ownership rules used in `packages/store`

- `freeDoc(doc)` (`automerge-safe.ts`) releases a doc, tolerating
  double-frees. Call it **only** on docs with clearly local ownership:
  intermediates you created and that nothing else can reference
  (`saveSince` clones, merge scaffolding, pre-round-trip handles,
  serialized-and-done states, `leaveSession`'s finished live docs).
- **Never free a handle that was recently the live `_state`/`_ephemeral`
  handle.** Async readers (a commit in flight, a signal handler) may still
  hold proxies of it; freeing produces "null pointer passed to rust" at
  their next touch. On the rare paths where the live handle is superseded
  by a rebuilt doc (`stripParked` fallbacks), the old handle is
  deliberately leaked — bounded, and only on should-never-happen paths.
- `applyAvailableChanges` applies **in place**; its result's ownership
  semantics are documented on `SafeApplyResult`.

## The state getter (fixed)

`SessionStore.state` used to compute `Automerge.clone(doc)` per store
update per subscriber (plus one per transient `get(store.state)`) — clones
syn could never free because ownership passed to the consumer, OOMing a
bound UI in a few thousand updates. It now serves a **materialized plain-JS
snapshot** (`Automerge.toJS`): reads are unchanged, snapshots are ordinary
GC-managed objects, and the leak class is gone. Measured: 4,000 getter
updates on a 20k-char doc hold a flat 174MB RSS, where the clone version
was at 3.2GB by 4,000 and module-dead by ~4,500. The getters are
memoized on the store, so the toJS walk runs once per update no matter
how many consumers subscribe.

The trade-off is CPU, not memory: `toJS` walks the whole document, and the
walk is much slower than the wasm-side clone it replaces (measured per
update: 3ms at 1k chars, 13ms at 5k, 54ms at 20k — vs ~0.5ms for the old
clone). Fine for polling and modest documents; a hot subscriber on a large
document should use `docState` (zero-copy, zero-cost) instead.

Consumers that need automerge **object identity** — the text editor
resolves cursor element ids via `Automerge.getObjectId` — use the new
`docState` readable instead: a zero-copy view of the live document,
read-only by contract. **Never pass `docState`'s value to
`Automerge.change` or any consuming API** — that would advance the live
handle out from under the store and wedge the session; all edits go
through `SliceStore.change()`. `state` values are not Automerge documents;
passing them into Automerge APIs fails loudly.

**Teardown order:** `leaveSession` frees the live documents (after a
bounded wait for any in-flight commit; on timeout the release is deferred
to the commit queue's settlement), so a still-mounted `docState` consumer
that re-renders afterwards reads a freed handle and throws. Unmount
`docState` consumers **before** calling `leaveSession`. Additionally,
`docState` values captured before a commit adoption become invalid once
the superseded handle's grace window (~30s, `FREE_GRACE_MS`) elapses —
subscribers that follow updates are unaffected; only long-held stale
references are.

## latestSnapshot (fixed)

`WorkspaceStore.latestSnapshot` used to hand each subscriber the freshly
resolved Automerge doc per tip update — the same consumer-owned-clone
leak shape the state getter had. It now materializes a plain-JS snapshot
and frees the resolved doc immediately; `latestState`
(session-or-snapshot) is therefore uniformly plain `S` in both branches.
`joinSession` resolves its own document directly (the session owns it and
frees it on leave), and the in-sync checks compare materialized content
instead of Docs.

## Superseded live handles (fixed, grace-window release)

When a commit adoption, tip merge, or parked-fallback rebuild replaces
the live document with a NEW handle, the superseded handle is released
via `freeDocLater` — a deferred `freeDoc` after `FREE_GRACE_MS` (30s),
generously longer than any internal async hold of a live doc (a commit
holds one across its network calls for seconds). This converts what was
a leak-per-adopted-commit into a bounded 30s residency, at the cost that
an async reader holding a doc reference across a >30s stall would throw
on resume — contained by the surrounding catches, and far outside normal
operating behavior.

## Known remaining leaks

None, as of the latestSnapshot materialization and the grace-window
release of superseded live handles (see above). If a new recurring
allocation is introduced, it must come with an ownership story: freed at
a clearly-local site, materialized to plain JS, or released through
`freeDocLater` when it was recently live.

## Upstream context

The ChangeCollector `MissingOps` panic (automerge#1327) is unfixed as of
3.4.0; the workarounds in this codebase (save/load round-trips, the
no-parked-changes invariant, dependency-filtered applies) must stay until
it lands. 3.4.0 builds with `panic=unwind`, so panics surface as catchable
JS exceptions instead of aborting the module — but a handle that panicked
should never be reused, and OOM aborts (`rust_oom`) are NOT catchable: the
module is gone.

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
GC-managed objects, and the leak class is gone. Measured: 8,000 getter
updates on a 20k-char doc hold a flat RSS, where the clone version was at
3.2GB by 4,000 and module-dead by ~4,500.

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

## Known remaining leaks (documented, not yet fixed)

1. **`WorkspaceStore.latestSnapshot`**: resolves a fresh doc per tip
   update and hands it to subscribers — the ownership shape the state
   getter used to have. It cannot be blindly materialized: `joinSession`
   consumes its value as the session's initial live document. Needs a
   split like `state`/`docState`.
2. **Superseded live handles on commit-adoption swaps** (`_state.set(next)`
   in the NewCommit paths): the old handle leaks (one doc per adopted
   commit). Freeing there looks safe — readers appear synchronous — but
   needs the async-reader audit described above before anyone adds it.

## Upstream context

The ChangeCollector `MissingOps` panic (automerge#1327) is unfixed as of
3.4.0; the workarounds in this codebase (save/load round-trips, the
no-parked-changes invariant, dependency-filtered applies) must stay until
it lands. 3.4.0 builds with `panic=unwind`, so panics surface as catchable
JS exceptions instead of aborting the module — but a handle that panicked
should never be reused, and OOM aborts (`rust_oom`) are NOT catchable: the
module is gone.

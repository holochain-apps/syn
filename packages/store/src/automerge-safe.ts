import * as Automerge from '@automerge/automerge';

/**
 * Helpers for keeping a long-lived Automerge document safe from the
 * ChangeCollector MissingOps panic (automerge#1327, unfixed as of 3.4.0).
 *
 * A document that internally holds changes whose dependencies are missing
 * ("parked" changes — applyChanges enqueues them by contract) can panic
 * inside any operation that reconstructs changes by hash (generateSyncMessage,
 * getChanges, saveSince, clone/fork, transaction commit). On automerge 3.2.x
 * the panic aborts mid-call and leaves the wasm handle's RefCell borrowed:
 * every later call on that handle throws "recursive use of an object
 * detected" and the document is permanently unusable.
 *
 * The invariant these helpers maintain: the live session document never
 * carries parked changes and is never the target of a risky operation —
 * risky work happens on a clone (a separate wasm handle, so a panic poisons
 * only the clone) and the result is swapped in on success.
 */

/** True when the doc internally holds changes whose dependencies are
 *  missing. Cheap: a single getMissingDeps call. */
export function hasParkedChanges<T>(doc: Automerge.Doc<T>): boolean {
  return Automerge.getMissingDeps(doc, []).length > 0;
}

/** Rebuild the doc through an actor-preserving save/load round-trip.
 *  Automerge.save() does not use the ChangeCollector and preserves parked
 *  changes (automerge#595), so this succeeds even on a doc whose in-memory
 *  index is inconsistent; the loaded doc has clean indices. This is the
 *  community-confirmed workaround for automerge#1327. */
export function rebuildConsistent<T>(doc: Automerge.Doc<T>): Automerge.Doc<T> {
  const actor = Automerge.getActorId(doc);
  return Automerge.load(Automerge.save(doc), { actor }) as Automerge.Doc<T>;
}

/** Return a doc guaranteed free of parked changes; no-op when already clean.
 *  Parked changes survive both clone and save/load (verified against
 *  automerge 3.2.6), so the only way to drop them is to rebuild a fresh doc
 *  from the changes actually in history (getAllChanges never includes
 *  parked entries). If the doc's indices are too inconsistent for
 *  getAllChanges, normalize through save/load first and retry once. */
export function stripParked<T>(doc: Automerge.Doc<T>): Automerge.Doc<T> {
  if (!hasParkedChanges(doc)) return doc;
  const actor = Automerge.getActorId(doc);
  const rebuildFromHistory = (source: Automerge.Doc<T>) =>
    Automerge.applyChanges(
      Automerge.init<T>({ actor }),
      Automerge.getAllChanges(source)
    )[0];
  try {
    return rebuildFromHistory(doc);
  } catch (e) {
    const consistent = rebuildConsistent(doc);
    try {
      return rebuildFromHistory(consistent);
    } finally {
      freeDoc(consistent);
    }
  }
}

export interface SafeApplyResult<T> {
  /** Free of parked changes. Identical to the input doc when nothing was
   *  applied. When appliedCount > 0, this is the successor proxy of the
   *  input's wasm handle (the apply ran in place — the input proxy is
   *  stale and the caller must swap to this one), unless `rebuilt`. */
  doc: Automerge.Doc<T>;
  appliedCount: number;
  /** Change bytes whose dependencies are not present yet; hold and retry */
  deferred: Uint8Array[];
  /** True when `doc` is a NEW handle (parked-fallback rebuild) and the
   *  input's handle is superseded — the caller owns releasing it (e.g.
   *  via freeDocLater when it was the live doc). False when `doc` shares
   *  the input's handle. */
  rebuilt: boolean;
}

/** Apply only the changes whose dependencies the doc already has (directly
 *  or via other changes in the batch); return the rest as `deferred` instead
 *  of letting applyChanges park them inside the doc. Duplicates already in
 *  the doc's history are dropped.
 *
 *  The selection runs entirely in JS (decode + one getMissingDeps call);
 *  the apply then runs IN PLACE on the doc's handle. In place matters:
 *  automerge wasm documents are never reclaimed by the JS garbage
 *  collector (verified against 3.4.0 — forced GC frees nothing and the
 *  module aborts at its 4GB cap after ~4000 leaked clones of a 20k-char
 *  doc), so a clone-per-call pattern on a hot path is a guaranteed OOM.
 *  Applying a dependency-closed batch cannot park anything, which is what
 *  keeps the ChangeCollector panic precondition (automerge#1327) away. */
export function applyAvailableChanges<T>(
  doc: Automerge.Doc<T>,
  changes: Uint8Array[]
): SafeApplyResult<T> {
  if (changes.length === 0) {
    return { doc, appliedCount: 0, deferred: [], rebuilt: false };
  }

  // Decode per change so one malformed entry (this is the network boundary:
  // change bytes come from arbitrary peers) discards only itself, not the
  // valid changes traveling in the same batch
  const decoded: Array<{ bytes: Uint8Array; hash: string; deps: string[] }> =
    [];
  for (const bytes of changes) {
    try {
      const { hash, deps } = Automerge.decodeChange(bytes);
      decoded.push({ bytes, hash, deps });
    } catch (error) {
      console.error('syn: dropping undecodable remote change:', error);
    }
  }

  // Deduplicate within the batch
  const byHash = new Map<string, { bytes: Uint8Array; hash: string; deps: string[] }>();
  for (const c of decoded) {
    if (!byHash.has(c.hash)) byHash.set(c.hash, c);
  }

  // A dependency is satisfied when the doc's history has it or another
  // selected change in the batch provides it. One getMissingDeps call —
  // over the deps and the candidates' own hashes — tells us which of all
  // referenced hashes the doc does NOT have.
  const candidateHashes = [...byHash.keys()];
  const allDeps = [...new Set([...byHash.values()].flatMap(c => c.deps))];
  const missingFromDoc = new Set(
    Automerge.getMissingDeps(doc, [...allDeps, ...candidateHashes])
  );
  const inHistory = (hash: string) => !missingFromDoc.has(hash);

  const selected = new Map<string, { bytes: Uint8Array; deps: string[] }>();

  // Greedy fixpoint: keep admitting changes whose deps are all satisfied.
  // Changes already in the doc's history are skipped up front: applying
  // them would be a no-op, and skipping means a duplicate-only batch (the
  // common broadcast/sync overlap) returns the input doc unchanged instead
  // of paying a clone-and-swap that notifies every subscriber.
  let progress = true;
  while (progress) {
    progress = false;
    for (const [hash, c] of byHash) {
      if (selected.has(hash) || inHistory(hash)) continue;
      if (c.deps.every(d => inHistory(d) || selected.has(d))) {
        selected.set(hash, c);
        progress = true;
      }
    }
  }

  // Neither applied nor already known: waiting on dependencies. In-history
  // duplicates must not land here or they'd cycle through the caller's
  // pending buffer forever.
  const deferred = [...byHash.values()]
    .filter(c => !selected.has(c.hash) && !inHistory(c.hash))
    .map(c => c.bytes);

  if (selected.size === 0) {
    return { doc, appliedCount: 0, deferred, rebuilt: false };
  }

  const [applied] = Automerge.applyChanges(
    doc,
    [...selected.values()].map(c => c.bytes)
  );
  // The selected set is dependency-closed, so nothing can have parked; a
  // violation here means the dependency reasoning above is wrong — rebuild
  // from history rather than returning a doc that breaks the
  // no-parked-changes invariant. The input handle (the apply ran in place,
  // so `applied` shares it) is superseded; the caller owns releasing it
  // (`rebuilt: true` → typically freeDocLater, since async readers may
  // still hold proxies of a live store doc).
  if (hasParkedChanges(applied)) {
    const rebuilt = stripParked(applied);
    return { doc: rebuilt, appliedCount: selected.size, deferred, rebuilt: true };
  }
  return { doc: applied, appliedCount: selected.size, deferred, rebuilt: false };
}

/** Release a wasm document's memory immediately. The JS GC never reclaims
 *  automerge documents, so every doc that stops being referenced without
 *  an explicit free leaks its full wasm-side size permanently. Only call
 *  on docs with clearly local ownership — using a freed doc (or any stale
 *  wrapper of it) afterwards throws from the wasm boundary. */
export function freeDoc(doc: Automerge.Doc<unknown>): void {
  try {
    Automerge.free(doc);
  } catch (e) {
    // double-free or an already-invalid handle: nothing to release
  }
}

/** Grace window for releasing a handle that was recently the live session
 *  document: generously longer than any internal async hold of a live doc
 *  (a commit holds one across its network calls for seconds). */
export const FREE_GRACE_MS = 30_000;

/** Deferred freeDoc for superseded live handles. Freeing a
 *  just-superseded live doc immediately risks a use-after-free in an
 *  async reader that captured it before the swap; waiting out the grace
 *  window lets every in-flight reader finish first. The timer is unref'd
 *  where the runtime supports it so pending frees don't hold a process
 *  open. */
export function freeDocLater(
  doc: Automerge.Doc<unknown>,
  delayMs: number = FREE_GRACE_MS
): void {
  const timer = setTimeout(() => freeDoc(doc), delayMs);
  (timer as any).unref?.();
}

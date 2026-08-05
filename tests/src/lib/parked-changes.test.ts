import { assert, test } from 'vitest';

import * as Automerge from '@automerge/automerge';
import {
  applyAvailableChanges,
  hasParkedChanges,
  rebuildConsistent,
  stripParked,
} from '@holochain-syn/store';

// Invariant coverage for the automerge-safe helpers (this is NOT the
// reproduction of the poisoned-doc incident — see poisoned-doc.test.ts).
// The helpers exist so the live session doc never internally parks changes
// with missing dependencies, the precondition for the ChangeCollector
// MissingOps panic (automerge#1327).

interface T {
  t: string;
}

/** A base doc plus a chain of three sequential changes made by a fork */
function chainFixture() {
  let base = Automerge.from<T>({ t: 'r' });
  base = Automerge.change(base, d => {
    d.t = 'root';
  });
  let fork = Automerge.clone(base);
  const changes: Uint8Array[] = [];
  for (const w of ['one', 'two', 'three']) {
    const prev = fork;
    fork = Automerge.change(fork, d => {
      d.t = d.t + ' ' + w;
    });
    changes.push(Automerge.getChanges(prev, fork)[0]);
  }
  return { base, fork, changes };
}

test('raw applyChanges parks out-of-order changes; the helpers detect and recover', () => {
  const { base, changes } = chainFixture();

  // Deliver the head of the chain alone — this is what handleChangeNotice
  // did before the fix, and what the helpers must prevent
  const [parked] = Automerge.applyChanges(Automerge.clone(base), [changes[2]]);
  assert.isTrue(hasParkedChanges(parked));

  // save() tolerates the parked state (it does not use ChangeCollector)...
  const bytes = Automerge.save(parked);
  assert.isAbove(bytes.length, 0);

  // ...so both recovery primitives return operable docs
  const rebuilt = rebuildConsistent(parked);
  Automerge.generateSyncMessage(rebuilt, Automerge.initSyncState());
  const stripped = stripParked(parked);
  assert.isFalse(hasParkedChanges(stripped));
  Automerge.generateSyncMessage(stripped, Automerge.initSyncState());
  Automerge.change(stripped, d => {
    d.t = 'still-writable';
  });

  // actor ids survive both round-trips
  assert.equal(Automerge.getActorId(rebuilt), Automerge.getActorId(parked));
  assert.equal(Automerge.getActorId(stripped), Automerge.getActorId(parked));
});

test('applyAvailableChanges applies only dependency-satisfied changes and defers the rest', () => {
  const { base, fork, changes } = chainFixture();
  let doc = Automerge.clone(base);
  let pending: Uint8Array[] = [];

  // Head first: nothing applicable, everything deferred, doc untouched
  let r = applyAvailableChanges(doc, [changes[2]]);
  assert.equal(r.appliedCount, 0);
  assert.equal(r.deferred.length, 1);
  assert.isFalse(hasParkedChanges(r.doc));
  assert.strictEqual(r.doc, doc);
  pending = r.deferred;

  // First chain link arrives: applies, head still deferred
  r = applyAvailableChanges(doc, [...pending, changes[0]]);
  doc = r.doc;
  assert.equal(r.appliedCount, 1);
  assert.equal(r.deferred.length, 1);
  assert.isFalse(hasParkedChanges(doc));

  // Middle link arrives: the batch is now dependency-closed, everything
  // applies transitively and the doc converges with the fork
  r = applyAvailableChanges(doc, [...r.deferred, changes[1]]);
  doc = r.doc;
  assert.equal(r.appliedCount, 2);
  assert.equal(r.deferred.length, 0);
  assert.isFalse(hasParkedChanges(doc));
  assert.equal((doc as any).t, (fork as any).t);

  // The result doc is fully operable for every risky op syn performs
  Automerge.generateSyncMessage(doc, Automerge.initSyncState());
  Automerge.getChanges(base, doc);
  Automerge.saveSince(doc, Automerge.getHeads(base));
  Automerge.clone(doc);
});

test('duplicate and already-known changes are harmless', () => {
  const { base, changes } = chainFixture();
  let doc = Automerge.clone(base);

  let r = applyAvailableChanges(doc, [changes[0], changes[0], changes[0]]);
  doc = r.doc;
  assert.equal(r.deferred.length, 0);
  assert.isFalse(hasParkedChanges(doc));
  const headsAfter = Automerge.getHeads(doc);

  // Re-delivering an already-applied change changes nothing
  r = applyAvailableChanges(doc, [changes[0]]);
  assert.deepEqual(Automerge.getHeads(r.doc), headsAfter);
  assert.isFalse(hasParkedChanges(r.doc));
});

test('a permanently withheld dependency leaves the change deferred and the doc clean', () => {
  const { base, changes } = chainFixture();
  const doc = Automerge.clone(base);

  // changes[1] depends on changes[0], which never arrives
  const r = applyAvailableChanges(doc, [changes[1], changes[2]]);
  assert.equal(r.appliedCount, 0);
  assert.equal(r.deferred.length, 2);
  assert.isFalse(hasParkedChanges(r.doc));
  // the doc keeps working regardless
  Automerge.change(Automerge.clone(r.doc), d => {
    d.t = 'unaffected';
  });
});

test('seeded shuffle of interleaved changes from two forks always converges clean', () => {
  // Deterministic PRNG so failures are reproducible
  let seed = 42;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };

  let base = Automerge.from<T>({ t: '' });
  base = Automerge.change(base, d => {
    d.t = 'r';
  });
  let forkA = Automerge.clone(base);
  let forkB = Automerge.clone(base);
  const all: Uint8Array[] = [];
  for (let i = 0; i < 10; i++) {
    let prev = forkA;
    forkA = Automerge.change(forkA, d => {
      d.t += 'A';
    });
    all.push(Automerge.getChanges(prev, forkA)[0]);
    prev = forkB;
    forkB = Automerge.change(forkB, d => {
      d.t += 'B';
    });
    all.push(Automerge.getChanges(prev, forkB)[0]);
  }
  // shuffle
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }

  let doc = Automerge.clone(base);
  let pending: Uint8Array[] = [];
  for (const change of all) {
    const r = applyAvailableChanges(doc, [...pending, change]);
    doc = r.doc;
    pending = r.deferred;
    assert.isFalse(hasParkedChanges(doc));
  }
  assert.equal(pending.length, 0);

  const expected = Automerge.merge(Automerge.clone(forkA), forkB);
  assert.equal((doc as any).t, (expected as any).t);
  Automerge.generateSyncMessage(doc, Automerge.initSyncState());
  Automerge.saveSince(doc, Automerge.getHeads(base));
});

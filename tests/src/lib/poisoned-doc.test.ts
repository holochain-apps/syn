import { assert, test } from 'vitest';

import { dhtSync, runScenario } from '@holochain-open-dev/tryorama';

import { get, toPromise } from '@holochain-open-dev/stores';
import { SynStore } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';
import { AppBundleSource } from '@holochain/client';
import { encode } from '@msgpack/msgpack';
import * as Automerge from '@automerge/automerge';

import {
  assertSessionHealthy,
  delay,
  sampleGrammar,
  synHapp,
  waitForOtherParticipants,
  waitUntil,
} from '../common.js';
import { textEditorGrammar } from '../text-editor-grammar.js';

// Amplified reproduction of the poisoned-document flake observed in
// concurrent.test.ts: out-of-order ChangeNotice signals park changes with
// missing dependencies inside the live Automerge doc (applyChanges enqueues
// them by contract); a doc in that state can hit the ChangeCollector
// MissingOps panic (automerge#1327) inside a later automerge operation, and
// on automerge 3.2.x the panic leaves the wasm handle's RefCell borrowed —
// every subsequent call on the session doc throws "recursive use of an
// object detected" and the session is permanently dead.
//
// Amplification over the organic flake: fast typing on both agents, a low
// commit threshold so NewCommit merges and delta encoding interleave densely
// with signal traffic, and bursts of crafted ChangeNotice signals delivered
// dependency-last over the real signal path (no mocks) so the parked-changes
// window keeps reopening.
test(
  'rapid out-of-order ChangeNotice traffic must not poison the live document',
  async () => {
    await runScenario(async scenario => {
      const appSource = {
        appBundleSource: { type: 'path', value: synHapp } as AppBundleSource,
      };

      const [alice, bob] = await scenario.addPlayersWithApps([
        appSource,
        appSource,
      ]);
      await scenario.shareAllAgents();

      const aliceSyn = new SynStore(new SynClient(alice.appWs as any, 'syn-test'));
      const bobSyn = new SynStore(new SynClient(bob.appWs as any, 'syn-test'));

      const aliceDocumentStore = await aliceSyn.createDocument(
        sampleGrammar.initialState()
      );
      const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
        'main',
        undefined
      );
      const workspaceHash = aliceWorkspaceStore.workspaceHash;

      // Low commit threshold: commits (delta saveSince + NewCommit merges on
      // the receiver) race the ChangeNotice storm as hard as possible
      const amplifiedConfig = {
        commitStrategy: {
          CommitEveryNDeltas: 10,
          CommitEveryNMs: 2000,
          SnapshotEveryNCommits: 5,
        },
      };

      const aliceSessionStore = await aliceWorkspaceStore.joinSession(
        amplifiedConfig
      );

      aliceSessionStore.change((state, eph) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(0, '\n')
      );

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      const bobDocumentStore = bobSyn.documents.get(
        aliceDocumentStore.documentHash
      );
      const bobWorkspaceStore = bobDocumentStore.workspaces.get(workspaceHash);
      const bobSessionStore = await bobWorkspaceStore.joinSession(
        amplifiedConfig
      );

      await waitForOtherParticipants(bobSessionStore, 1);
      await waitForOtherParticipants(aliceSessionStore, 1);

      await waitUntil(
        () =>
          get(bobSessionStore.state).body.text.join('') ===
          get(aliceSessionStore.state).body.text.join(''),
        30_000
      );

      // Fast typing on both agents. The exact interleaving doesn't matter —
      // the assertions below are health and mutual convergence, not a
      // specific final text.
      async function type(
        store: typeof aliceSessionStore,
        pubKey: Uint8Array,
        char: string,
        count: number
      ) {
        for (let i = 0; i < count; i++) {
          store.change((state, eph) =>
            textEditorGrammar.changes(pubKey as any, state.body, eph).insert(0, char)
          );
          await delay(10);
        }
      }

      const sendChanges = (
        fromSyn: SynStore,
        to: Uint8Array,
        changes: Uint8Array[]
      ) =>
        fromSyn.client.sendMessage([to as any], {
          workspace_hash: workspaceHash,
          payload: {
            type: 'ChangeNotice',
            state_changes: changes.map(c => encode(c) as any),
            ephemeral_changes: [],
          },
        });

      // Crafted out-of-order bursts over the real signal path (no mocks).
      // Each round builds a DIAMOND of phantom changes on a snapshot of
      // alice's doc: two divergent branch changes and a top change created
      // after merging them, so the top's dependency set fans out over two
      // paths that share an ancestor — the DAG shape upstream PR
      // automerge#1366 identifies as the MissingOps trigger (a dependency
      // scheduled twice during traversal). The top change is delivered to
      // bob FIRST (parks with two missing deps), the branches trickle in
      // later while typing, commits, and merges churn the doc. The same
      // changes go to alice in order (from bob's client, so provenance
      // differs from the recipient) to keep both agents convergeable.
      async function phantomStorm(rounds: number) {
        for (let i = 0; i < rounds; i++) {
          const base = get(aliceSessionStore.state);
          const prevA = Automerge.clone(base);
          const branchA = Automerge.change(prevA, (d: any) => {
            d.title = `phantom-a-${i}`;
          });
          const prevB = Automerge.clone(base);
          const branchB = Automerge.change(prevB, (d: any) => {
            d.title = `phantom-b-${i}`;
          });
          const merged = Automerge.merge(Automerge.clone(branchA), branchB);
          const top = Automerge.change(merged, (d: any) => {
            d.title = `phantom-top-${i}`;
          });
          const cA = Automerge.getChanges(prevA, branchA)[0];
          const cB = Automerge.getChanges(prevB, branchB)[0];
          const cTop = Automerge.getChanges(merged, top)[0];

          // deps-last to bob: the diamond top parks with two missing deps
          await sendChanges(aliceSyn, bob.agentPubKey, [cTop]);
          // in-order to alice so both sides eventually hold the phantoms
          await sendChanges(bobSyn, alice.agentPubKey, [cA, cB, cTop]);
          await delay(400);
          // one branch arrives; the top now waits on exactly one dep
          await sendChanges(aliceSyn, bob.agentPubKey, [cA]);
          await delay(400);
          await sendChanges(aliceSyn, bob.agentPubKey, [cB]);
          await delay(100);
        }
      }

      // Diagnostics on the LIVE docs. Parked changes survive clone (and
      // save/load), so probing the public state getter's clone would work
      // too — but reading the internal store is the direct measurement of
      // the handle whose poisoning kills the session, with no intermediate
      // operation that could itself be affected.
      let maxParkedBob = 0;
      let maxParkedAlice = 0;
      const probe = setInterval(() => {
        try {
          const bobLive = get((bobSessionStore as any)._state);
          const aliceLive = get((aliceSessionStore as any)._state);
          maxParkedBob = Math.max(
            maxParkedBob,
            Automerge.getMissingDeps(bobLive, []).length
          );
          maxParkedAlice = Math.max(
            maxParkedAlice,
            Automerge.getMissingDeps(aliceLive, []).length
          );
        } catch (e) {
          // a throw here IS the poisoned state; surface it via the health
          // assertions below rather than from inside the interval
        }
      }, 50);

      // ~45s of dense interleaved traffic: ~2000 keystrokes at 10ms,
      // diamond bursts every ~900ms, commits every ~10 deltas on both sides
      try {
        await Promise.all([
          type(aliceSessionStore, alice.agentPubKey, 'a', 1000),
          type(bobSessionStore, bob.agentPubKey, 'b', 1000),
          phantomStorm(50),
        ]);
      } finally {
        clearInterval(probe);
      }

      console.log(
        `poisoned-doc diagnostics: max parked changes — alice=${maxParkedAlice} bob=${maxParkedBob}`
      );
      // Before the hardening this storm parked up to 2 changes inside the
      // live doc every run (the MissingOps panic precondition); the pending
      // buffer now holds dependency-incomplete changes outside the wasm doc,
      // so the live documents must stay clean throughout
      assert.equal(
        maxParkedBob,
        0,
        'live doc parked changes with missing dependencies (panic precondition)'
      );
      assert.equal(
        maxParkedAlice,
        0,
        'live doc parked changes with missing dependencies (panic precondition)'
      );

      // The real incident manifests exactly here: a poisoned handle throws
      // "recursive use of an object detected" on the next read or write
      assertSessionHealthy(aliceSessionStore, alice.agentPubKey, 'alice');
      assertSessionHealthy(bobSessionStore, bob.agentPubKey, 'bob');

      // Both sessions must still converge to identical content
      const converged = await waitUntil(
        () =>
          get(bobSessionStore.state).body.text.join('') ===
            get(aliceSessionStore.state).body.text.join('') &&
          get(bobSessionStore.state).body.text.length > 0,
        120_000
      );
      assert.ok(
        converged,
        `alice and bob did not converge: alice=${get(
          aliceSessionStore.state
        ).body.text.join('').length} chars, bob=${get(
          bobSessionStore.state
        ).body.text.join('').length} chars`
      );

      assertSessionHealthy(aliceSessionStore, alice.agentPubKey, 'alice');
      assertSessionHealthy(bobSessionStore, bob.agentPubKey, 'bob');

      await aliceSessionStore.leaveSession();
      await bobSessionStore.leaveSession();
    });
  }
);

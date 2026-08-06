import { assert, test } from 'vitest';

import { dhtSync, runScenario } from '@holochain-open-dev/tryorama';

import { get, toPromise } from '@holochain-open-dev/stores';
import { SynStore } from '@holochain-syn/store';
import { Commit, SynClient } from '@holochain-syn/client';
import { encodeHashToBase64, AppBundleSource } from '@holochain/client';
import * as Automerge from '@automerge/automerge';

import {
  delay,
  sampleGrammar,
  synHapp,
} from '../common.js';
import { textEditorGrammar } from '../text-editor-grammar.js';

test('commits after the first are deltas and a later joiner reconstructs the chain', async () => {
  await runScenario(async scenario => {
    const appSource = { appBundleSource: { type: 'path', value: synHapp } as AppBundleSource };

    const [alice, bob] = await scenario.addPlayersWithApps([
      appSource,
      appSource,
    ]);

    const aliceSyn = new SynStore(new SynClient(alice.appWs as any, 'syn-test'));

    const aliceDocumentStore = await aliceSyn.createDeterministicDocument(
      sampleGrammar.initialState()
    );
    const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
      'main',
      undefined
    );
    const aliceSessionStore = await aliceWorkspaceStore.joinSession();

    const words = ['one ', 'two ', 'three ', 'four '];
    const payloads = [];
    for (const word of words) {
      aliceSessionStore.change((state, eph) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(get(aliceSessionStore.state).body.text.length, word)
      );
      await aliceSessionStore.commitChanges();
      const tip = get(aliceSessionStore.currentTip);
      assert.ok(tip);
      payloads.push(tip!.entry.state);
    }

    // The first commit of the document is a full snapshot, the following
    // ones only carry the changes since their parent
    assert.equal(payloads[0].kind, 'snapshot');
    for (let i = 1; i < payloads.length; i++) {
      assert.equal(payloads[i].kind, 'delta');
      if (payloads[i].kind === 'delta') {
        assert.equal((payloads[i] as any).depth, i);
      }
    }

    // Deltas are much smaller than snapshots
    const snapshotSize = (payloads[0] as any).data.length;
    const deltaSize = (payloads[1] as any).data.length;
    assert.isBelow(deltaSize, snapshotSize);

    await dhtSync([alice, bob], alice.cells[0].cell_id[0], 500, 120000);

    // Bob never participated in the session: his only path to the state is
    // reconstructing the snapshot + delta chain from his local DHT store
    const bobSyn = new SynStore(new SynClient(bob.appWs as any, 'syn-test'));
    const bobDocumentStore = bobSyn.documents.get(
      aliceDocumentStore.documentHash
    );
    const bobWorkspaceStore = bobDocumentStore.workspaces.get(
      aliceWorkspaceStore.workspaceHash
    );

    const bobState: any = await toPromise(bobWorkspaceStore.latestSnapshot);
    assert.equal(bobState.body.text.join(''), 'one two three four ');

    await aliceSessionStore.leaveSession();
  });
});

test('concurrent merges of the same tips produce the same commit entry', async () => {
  await runScenario(async scenario => {
    const appSource = { appBundleSource: { type: 'path', value: synHapp } as AppBundleSource };

    // Two live agents (no conductor restart): alice authors two divergent
    // tips; both agents then merge them and must produce the same entry,
    // since a merge commit is fully derived from the tips it merges and
    // never from the merging agent's identity.
    const [alice, bob] = await scenario.addPlayersWithApps([
      appSource,
      appSource,
    ]);
    await scenario.shareAllAgents();

    const aliceSyn = new SynStore(new SynClient(alice.appWs as any, 'syn-test'));
    const aliceDocumentStore = await aliceSyn.createDeterministicDocument(
      sampleGrammar.initialState()
    );
    const documentHash = aliceDocumentStore.documentHash;
    const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
      'main',
      undefined
    );
    const workspaceHash = aliceWorkspaceStore.workspaceHash;

    // Build two divergent tips that share a common root, so their merge
    // cleanly contains both edits. Authored entirely by alice and stored as
    // snapshot commits with no parent, so neither supersedes the other.
    const root = Automerge.from(sampleGrammar.initialState() as any);
    const docA = Automerge.change(Automerge.clone(root), (d: any) => {
      d.title = 'ALICE';
    });
    const docB = Automerge.change(Automerge.clone(root), (d: any) => {
      d.subtitle = 'BOB';
    });

    const snapshotCommit = (doc: Automerge.Doc<any>): Commit => ({
      authors: [alice.agentPubKey],
      meta: undefined,
      previous_commit_hashes: [],
      state: {
        kind: 'snapshot',
        data: Automerge.save(doc),
      },
      document_hash: documentHash,
    });

    const commitA = await aliceSyn.client.createCommit(snapshotCommit(docA));
    await aliceSyn.client.updateWorkspaceTip(
      workspaceHash,
      commitA.actionHash,
      []
    );
    const commitB = await aliceSyn.client.createCommit(snapshotCommit(docB));
    await aliceSyn.client.updateWorkspaceTip(
      workspaceHash,
      commitB.actionHash,
      []
    );
    const tipA = commitA.actionHash;
    const tipB = commitB.actionHash;

    // Bob sees both tips over the live DHT (no restart)
    await dhtSync([alice, bob], alice.cells[0].cell_id[0], 500, 120000);

    const bobSyn = new SynStore(new SynClient(bob.appWs as any, 'syn-test'));
    const bobDocumentStore = bobSyn.documents.get(documentHash);
    const bobWorkspaceStore = bobDocumentStore.workspaces.get(workspaceHash);

    // Both agents merge the same two tips, given in opposite orders
    const aliceMerge = await aliceWorkspaceStore.merge([tipA, tipB]);
    const bobMerge = await bobWorkspaceStore.merge([tipB, tipA]);

    // The merge commit is fully derived from the merged tips: identical
    // entries, deduped by the DHT, even though the actions differ
    assert.equal(
      encodeHashToBase64(aliceMerge.entryHash),
      encodeHashToBase64(bobMerge.entryHash)
    );

    // Both merge actions point at the same entry, so the workspace has a
    // single logical tip: no further merging is needed
    await dhtSync([alice, bob], alice.cells[0].cell_id[0], 500, 120000);
    const tipGroups = await aliceWorkspaceStore.getCurrentTipGroups();
    assert.equal(tipGroups.length, 1);

    // And the merged content contains both divergent edits, identically for
    // both agents
    const aliceMerged: any = await toPromise(
      aliceWorkspaceStore.latestSnapshot
    );
    const bobMerged: any = await toPromise(bobWorkspaceStore.latestSnapshot);
    assert.equal(aliceMerged.title, 'ALICE');
    assert.equal(aliceMerged.subtitle, 'BOB');
    assert.deepEqual(aliceMerged, bobMerged);

    await delay(100);
    await bob.conductor.shutDown();
    await alice.conductor.shutDown();
  });
});

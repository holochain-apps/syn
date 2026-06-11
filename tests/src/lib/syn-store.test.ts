import { assert, test } from 'vitest';

import { dhtSync, runScenario } from '@holochain/tryorama';
import { get, toPromise } from '@holochain-open-dev/stores';

import { SynStore, stateFromCommit } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';

import { textEditorGrammar } from '../text-editor-grammar.js';
import {
  waitForOtherParticipants,
  delay,
  sampleGrammar,
  synHapp,
} from '../common.js';
import { AppBundleSource } from '@holochain/client';

test('SynStore, DocumentStore, WorkspaceStore and SessionStore work', async () => {
  await runScenario(async scenario => {
    // Set up the app to be installed
    const appSource = { appBundleSource: { type:"path", value: synHapp } as AppBundleSource };

    // Add 2 players with the test app to the Scenario. The returned players
    // can be destructured.
    const [alice, bob] = await scenario.addPlayersWithApps([
      appSource,
      appSource,
    ]);
    await scenario.shareAllAgents();
    const aliceSyn = new SynStore(
      new SynClient(alice.appWs as any, 'syn-test')
    );
    const bobSyn = new SynStore(new SynClient(bob.appWs as any, 'syn-test'));

    const aliceDocumentStore = await aliceSyn.createDocument(
      sampleGrammar.initialState()
    );

    let authors = await toPromise(aliceDocumentStore.allAuthors);

    assert.equal(authors.length, 1);

    const documentHash = aliceDocumentStore.documentHash;

    await new Promise(async (resolve, reject) => {
      const unsubs = aliceSyn.documentsByTag.get('active').subscribe(value => {
        if (value.status === 'complete') {
          if (value.value.size === 1) {
            // The document was added to the active documents by tag store via receiving the signal
            resolve(undefined);
            unsubs();
          }
        }
      });

      await aliceSyn.client.tagDocument(documentHash, 'active');

      setTimeout(
        () => reject('Took too long to update the documents by tag'),
        1000
      );
    });

    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
    let documentsHashes = Array.from(
      (await toPromise(bobSyn.documentsByTag.get('active'))).keys()
    );
    assert.equal(documentsHashes.length, 1);

    await aliceSyn.client.removeDocumentTag(
      aliceDocumentStore.documentHash,
      'active'
    );
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);
    documentsHashes = Array.from(
      (await toPromise(bobSyn.documentsByTag.get('active'))).keys()
    );
    assert.equal(documentsHashes.length, 0);

    const workspaceName = 'main';

    const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
      workspaceName,
      undefined
    );
    const workspaceHash = aliceWorkspaceStore.workspaceHash;
    const aliceSessionStore = await aliceWorkspaceStore.joinSession();

    await delay(2000);

    const bobDocumentStore = bobSyn.documents.get(documentHash);
    const bobWorkspaceStore = bobDocumentStore.workspaces.get(workspaceHash);

    const bobSessionStore = await bobWorkspaceStore.joinSession();
    await waitForOtherParticipants(aliceSessionStore, 1);
    await waitForOtherParticipants(bobSessionStore, 1);

    aliceSessionStore.change(state => (state.title = 'A new title'));

    await delay(7000);

    let participants = get(aliceSessionStore.participants);
    // Bob hasn't made any changes yet, so he is idle rather than active
    assert.equal(participants.active.length + participants.idle.length, 2);

    let currentState = get(bobSessionStore.state);
    assert.equal(currentState.title, 'A new title');

    aliceSessionStore.change(state => (state.title = 'Another thing'));

    await delay(1000);

    currentState = get(bobSessionStore.state);
    assert.equal(currentState.title, 'Another thing');

    aliceSessionStore.change(state => (state.title = 'Bob is the boss'));

    await delay(1000);

    currentState = get(bobSessionStore.state);
    assert.equal(currentState.title, 'Bob is the boss');

    currentState = get(aliceSessionStore.state);
    assert.equal(currentState.title, 'Bob is the boss');

    bobSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(bob.agentPubKey, state.body, eph)
        .insert(0, 'Hi ')
    );
    bobSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(bob.agentPubKey, state.body, eph)
        .insert(3, 'there')
    );

    await delay(1000);

    currentState = get(aliceSessionStore.state);
    assert.equal(currentState.body.text.join(''), 'Hi there');

    currentState = get(bobSessionStore.state);
    assert.equal(currentState.body.text.join(''), 'Hi there');

    // Test concurrent

    aliceSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(alice.agentPubKey, state.body, eph)
        .insert(3, 'alice ')
    );

    bobSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(bob.agentPubKey, state.body, eph)
        .insert(3, 'bob ')
    );

    await delay(10000);

    const currentStateAlice = get(aliceSessionStore.state);
    const currentStateBob = get(bobSessionStore.state);
    assert.equal(
      currentStateAlice.body.text.join(''),
      currentStateBob.body.text.join('')
    );

    await aliceSessionStore.commitChanges();
    await delay(7000);
    const commitsLinks = await aliceSyn.client.getWorkspaceTips(workspaceHash);

    const commitHash = commitsLinks[commitsLinks.length - 1].target;
    const commit = await aliceSyn.client.getCommit(commitHash);

    assert.ok(commitHash);
    assert.ok(commit);
    const state = stateFromCommit(commit!.entry);
    assert.deepEqual(state, currentStateAlice);

    await bobSessionStore.leaveSession();

    await delay(1000);

    participants = get(aliceSessionStore.participants);

    // Alice may have gone idle herself by now; bob must be gone entirely
    assert.equal(participants.active.length + participants.idle.length, 1);

    let latestState = await toPromise(aliceWorkspaceStore.latestState);

    assert.deepEqual(latestState, state);

    await aliceSessionStore.leaveSession();

    authors = await toPromise(aliceDocumentStore.allAuthors);

    assert.equal(authors.length, 2);

    latestState = await toPromise(aliceWorkspaceStore.latestState);

    assert.deepEqual(latestState, state);
  });
});

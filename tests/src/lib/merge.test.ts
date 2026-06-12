import { assert, test } from 'vitest';

import { dhtSync, pause, runScenario } from '@holochain-open-dev/tryorama';

import { get } from '@holochain-open-dev/stores';
import { SynStore } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';

import {
  delay,
  sampleGrammar,
  synHapp,
  waitForOtherParticipants,
} from '../common.js';
import { textEditorGrammar } from '../text-editor-grammar.js';
import { AppBundleSource } from '@holochain/client';

test('check that the state of disconnected agents making changes converges after connecting', async () => {
  console.log('Running concurrent test...');
  await runScenario(async scenario => {
    // Set up the app to be installed
    const appSource = { appBundleSource: {type:"path", value: synHapp } as AppBundleSource };

    // Add 2 players with the test app to the Scenario. The returned players
    // can be destructured.
    const [alice] = await scenario.addPlayersWithApps([appSource]);

    let aliceSyn = new SynStore(new SynClient(alice.appWs as any, 'syn-test'));

    console.log('Alice agent pub key:', alice.agentPubKey);
    // Alice creates a root commit
    let aliceDocumentStore = await aliceSyn.createDeterministicDocument(
      sampleGrammar.initialState()
    );

    console.log('Alice document store:', aliceDocumentStore);
    // And a workspace with pointing to it
    let aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
      'main',
      undefined
    );
    console.log('Alice workspace store:', aliceWorkspaceStore);
    assert.ok(aliceWorkspaceStore.workspaceHash);
    console.log('Alice workspace hash:', aliceWorkspaceStore.workspaceHash.toString());
    let aliceSessionStore = await aliceWorkspaceStore.joinSession();
    console.log('Alice session store:', aliceSessionStore);
    // Alice requests the change 'Alice'
    aliceSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(alice.agentPubKey, state.body, eph)
        .insert(0, 'Alice')
    );

    // And commits it
    await aliceSessionStore.commitChanges();
    await delay(100);
    console.log('Alice committed changes');
    let currentState = get(aliceSessionStore.state);
    assert.equal(currentState.body.text.join(''), 'Alice');

    // Now Alice goes offline

    await aliceSessionStore.leaveSession();
    await alice.conductor.shutDown();

    console.log('Alice conductor shut down');
    await delay(100);
    const [bob] = await scenario.addPlayersWithApps([appSource]);
    const bobSyn = new SynStore(new SynClient(bob.appWs as any, 'syn-test'));

    console.log('Bob agent pub key:', bob.agentPubKey);
    // Bob goes online and joins the same workspace
    let bobDocumentStore = await bobSyn.createDeterministicDocument(
      sampleGrammar.initialState()
    );

    const workspaceName = 'main';

    let bobWorkspaceStore = await bobDocumentStore.createWorkspace(
      workspaceName,
      undefined
    );
    console.log('Bob document store:', bobDocumentStore);
    assert.equal(
      bobDocumentStore.documentHash.toString(),
      aliceDocumentStore.documentHash.toString()
    );
    assert.equal(
      bobWorkspaceStore.workspaceHash.toString(),
      aliceWorkspaceStore.workspaceHash.toString()
    );
    let bobSessionStore = await bobWorkspaceStore.joinSession();
    console.log('Bob session store:', bobSessionStore);
    currentState = get(bobSessionStore.state);
    assert.equal(currentState.body.text.join(''), '');

    bobSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(bob.agentPubKey, state.body, eph)
        .insert(0, 'Bob')
    );
    console.log('Bob made changes');
    currentState = get(bobSessionStore.state);
    assert.equal(currentState.body.text.join(''), 'Bob');

    await bobSessionStore.leaveSession();
    console.log('Bob session store left');
    await alice.conductor.startUp();
    const port = await alice.conductor.attachAppInterface();
    const adminWs = alice.conductor.adminWs();
    const issued = await adminWs.issueAppAuthenticationToken({
      installed_app_id: alice.appId,
    });
    const aliceAppWs = await alice.conductor.connectAppWs(issued.token, port);
    await scenario.shareAllAgents();
    console.log('Alice conductor started up');
    // Syncing after a conductor restart is slow because of a kitsune2 0.4.1
    // gossip limitation: Alice's restarted endpoint gets a new iroh node id,
    // and Bob's serial gossip-initiate loop blocks for connect_timeout (60s,
    // retried) dialing her dead pre-restart URL from the bootstrap server.
    // Gossip with the live Alice only proceeds in the gaps between those
    // blocking dials, so first sync lands shortly after the ~120s mark.
    await dhtSync([alice, bob], alice.cells[0].cell_id[0], 500, 300000);
    console.log('DHT sync done');
    aliceSyn = new SynStore(new SynClient(aliceAppWs, 'syn-test'));
    aliceDocumentStore = aliceSyn.documents.get(
      aliceDocumentStore.documentHash
    );
    aliceWorkspaceStore = aliceDocumentStore.workspaces.get(
      bobWorkspaceStore.workspaceHash
    );
    aliceSessionStore = await aliceWorkspaceStore.joinSession();
    console.log('Alice session store rejoined');
    bobSessionStore = await bobWorkspaceStore.joinSession();
    console.log('Bob session store rejoined');
    await waitForOtherParticipants(aliceSessionStore, 1);
    await waitForOtherParticipants(bobSessionStore, 1);
    console.log('Waiting for other participants done');
    await pause(1000);
    console.log('Pausing for 1 second');
    currentState = get(aliceSessionStore.state);

    const bobcurrentState = get(bobSessionStore.state);
    // Check that state converges
    assert.equal(
      currentState.body.text.join(''),
      bobcurrentState.body.text.join('')
    );

    await aliceSessionStore.leaveSession();
    await bobSessionStore.leaveSession();
    console.log('Alice and Bob session stores left');
    await bob.conductor.shutDown();
    await alice.conductor.shutDown();
  });
});

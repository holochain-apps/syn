import { assert, test } from 'vitest';

import { dhtSync, runScenario } from '@holochain/tryorama';
import { get, toPromise } from '@holochain-open-dev/stores';

import { SynStore } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';

import { textEditorGrammar } from '../text-editor-grammar.js';
import {
  waitForOtherParticipants,
  delay,
  sampleGrammar,
  synHapp,
} from '../common.js';
import { AppBundleSource } from '@holochain/client';

test('Data sync works with heartbeat disabled', async () => {
  await runScenario(async scenario => {
    const appSource = { appBundleSource: { type: 'path', value: synHapp } as AppBundleSource };

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
    const documentHash = aliceDocumentStore.documentHash;
    const workspaceName = 'main';
    const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
      workspaceName,
      undefined
    );
    const workspaceHash = aliceWorkspaceStore.workspaceHash;

    // Both join with heartbeat disabled
    const aliceSessionStore = await aliceWorkspaceStore.joinSession({
      enablePresenceHeartbeat: false,
      newPeersDiscoveryInterval: 2 * 1000,
    });

    await delay(2000);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const bobDocumentStore = bobSyn.documents.get(documentHash);
    const bobWorkspaceStore = bobDocumentStore.workspaces.get(workspaceHash);
    const bobSessionStore = await bobWorkspaceStore.joinSession({
      enablePresenceHeartbeat: false,
      newPeersDiscoveryInterval: 2 * 1000,
    });

    await waitForOtherParticipants(aliceSessionStore, 1);
    await waitForOtherParticipants(bobSessionStore, 1);

    // Make changes on Alice's side
    aliceSessionStore.change(state => (state.title = 'Hello from Alice'));
    await delay(3000);

    let bobState = get(bobSessionStore.state);
    assert.equal(bobState.title, 'Hello from Alice');

    // Make changes on Bob's side
    bobSessionStore.change(state => (state.title, 'Hello from Bob'));
    bobSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(bob.agentPubKey, state.body, eph)
        .insert(0, 'Synced')
    );
    await delay(3000);

    let aliceState = get(aliceSessionStore.state);
    let finalBobState = get(bobSessionStore.state);
    assert.equal(aliceState.body.text.join(''), finalBobState.body.text.join(''));

    await aliceSessionStore.leaveSession();
    await bobSessionStore.leaveSession();
  });
});

test('hearbeatInterval: 0 also disables heartbeat', async () => {
  await runScenario(async scenario => {
    const appSource = { appBundleSource: { type: 'path', value: synHapp } as AppBundleSource };

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
    const documentHash = aliceDocumentStore.documentHash;
    const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
      'main',
      undefined
    );
    const workspaceHash = aliceWorkspaceStore.workspaceHash;

    // Both join with hearbeatInterval: 0
    const aliceSessionStore = await aliceWorkspaceStore.joinSession({
      hearbeatInterval: 0,
      newPeersDiscoveryInterval: 2 * 1000,
    });

    await delay(2000);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const bobDocumentStore = bobSyn.documents.get(documentHash);
    const bobWorkspaceStore = bobDocumentStore.workspaces.get(workspaceHash);
    const bobSessionStore = await bobWorkspaceStore.joinSession({
      hearbeatInterval: 0,
      newPeersDiscoveryInterval: 2 * 1000,
    });

    await waitForOtherParticipants(aliceSessionStore, 1);
    await waitForOtherParticipants(bobSessionStore, 1);

    // Verify data sync still works
    aliceSessionStore.change(state => (state.title = 'Zero interval test'));
    await delay(3000);

    let bobState = get(bobSessionStore.state);
    assert.equal(bobState.title, 'Zero interval test');

    await aliceSessionStore.leaveSession();
    await bobSessionStore.leaveSession();
  });
});

test('Mixed mode: one peer with heartbeat, one without', async () => {
  await runScenario(async scenario => {
    const appSource = { appBundleSource: { type: 'path', value: synHapp } as AppBundleSource };

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
    const documentHash = aliceDocumentStore.documentHash;
    const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
      'main',
      undefined
    );
    const workspaceHash = aliceWorkspaceStore.workspaceHash;

    // Alice with heartbeat enabled, Bob without
    const aliceSessionStore = await aliceWorkspaceStore.joinSession({
      newPeersDiscoveryInterval: 2 * 1000,
    });

    await delay(2000);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const bobDocumentStore = bobSyn.documents.get(documentHash);
    const bobWorkspaceStore = bobDocumentStore.workspaces.get(workspaceHash);
    const bobSessionStore = await bobWorkspaceStore.joinSession({
      enablePresenceHeartbeat: false,
      newPeersDiscoveryInterval: 2 * 1000,
    });

    await waitForOtherParticipants(aliceSessionStore, 1);
    await waitForOtherParticipants(bobSessionStore, 1);

    // Verify both can discover each other and sync data
    aliceSessionStore.change(state => (state.title = 'Mixed mode'));
    await delay(3000);

    let bobState = get(bobSessionStore.state);
    assert.equal(bobState.title, 'Mixed mode');

    // Bob's changes should also reach Alice
    bobSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(bob.agentPubKey, state.body, eph)
        .insert(0, 'From Bob')
    );
    await delay(3000);

    let aliceState = get(aliceSessionStore.state);
    assert.equal(aliceState.body.text.join(''), 'From Bob');

    // Alice should see both participants as active (she has heartbeat)
    let aliceParticipants = get(aliceSessionStore.participants);
    assert.equal(aliceParticipants.active.length, 2);

    await aliceSessionStore.leaveSession();
    await bobSessionStore.leaveSession();
  });
});

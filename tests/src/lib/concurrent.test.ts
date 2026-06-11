import { assert, test } from 'vitest';

import { dhtSync, runScenario } from '@holochain-open-dev/tryorama';

import { get, toPromise } from '@holochain-open-dev/stores';
import { SynStore } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';

import {
  delay,
  sampleGrammar,
  synHapp,
  waitForOtherParticipants,
  waitUntil,
} from '../common.js';
import { textEditorGrammar } from '../text-editor-grammar.js';
import { AppBundleSource } from '@holochain/client';

const aliceLine = 'ALICE_HELLO_ALICE';
const bobLine = 'BOB_HI_BOB';

function alicePosition(text: string) {
  return text.split('\n')[0].length;
}
function bobPosition(text: string) {
  return text.length;
}

test('the state of two agents making lots of concurrent changes converges', async () => {
  await runScenario(async scenario => {
    // Set up the app to be installed
    const appSource = { appBundleSource: { type:"path", value:synHapp }  as AppBundleSource };

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

    const workspaceName = 'main';

    const aliceDocumentStore = await aliceSyn.createDocument(
      sampleGrammar.initialState()
    );
    const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
      workspaceName,
      undefined
    );

    const aliceSessionStore = await aliceWorkspaceStore.joinSession();

    aliceSessionStore.change((state, eph) =>
      textEditorGrammar
        .changes(alice.agentPubKey, state.body, eph)
        .insert(0, '\n')
    );

    //await delay(5000);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const bobDocumentStore = bobSyn.documents.get(
      aliceDocumentStore.documentHash
    );
    const workspaces = await toPromise(bobDocumentStore.allWorkspaces);
    if (Array.from(workspaces.values())[0] === undefined)
      assert.equal(false,true)
    assert.equal(
      Array.from(workspaces.values())[0].workspaceHash.toString(),
      aliceWorkspaceStore.workspaceHash.toString()
    );
    const bobWorkspaceStore = bobDocumentStore.workspaces.get(
      aliceWorkspaceStore.workspaceHash
    );
    const bobSessionStore = await bobWorkspaceStore.joinSession();

    await waitForOtherParticipants(bobSessionStore, 1);
    await waitForOtherParticipants(aliceSessionStore, 1);

    //await delay(2000);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    // Wait until bob's doc has actually received alice's initial content;
    // typing into a not-yet-synced doc anchors the first characters at the
    // head of the text and they end up interleaved with alice's line
    await waitUntil(
      () =>
        get(bobSessionStore.state).body.text.join('') ===
        get(aliceSessionStore.state).body.text.join(''),
      30_000
    );
    assert.equal(
      get(bobSessionStore.state).body.text.join(''),
      get(aliceSessionStore.state).body.text.join(''),
      'precondition: initial content synced to bob before typing starts'
    );

    async function simulateAlice() {
      for (let i = 0; i < aliceLine.length; i++) {
        aliceSessionStore.change((state, eph) =>
          textEditorGrammar
            .changes(alice.agentPubKey, state.body, eph)
            .insert(
              alicePosition(get(aliceSessionStore.state).body.text.join('')),
              aliceLine[i]
            )
        );
        await delay(1000);
      }
    }

    async function simulateBob() {
      for (let i = 0; i < bobLine.length; i++) {
        let content = get(bobSessionStore.state).body.text;
        bobSessionStore.change((state, eph) =>
          textEditorGrammar
            .changes(bob.agentPubKey, state.body, eph)
            .insert(bobPosition(content.toString()), bobLine[i])
        );
        await delay(1000);
      }
    }

    await Promise.all([simulateAlice(), simulateBob()]);
    await delay(4000);

    await Promise.all([simulateAlice(), simulateBob()]);
    await delay(4000);

    await Promise.all([simulateAlice(), simulateBob()]);
    //await delay(20000);
    await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

    const expectedText = `${aliceLine}${aliceLine}${aliceLine}
${bobLine}${bobLine}${bobLine}`;

    let currentState = get(bobSessionStore.state);
    assert.deepEqual(currentState.body.text.join(''), expectedText);

    currentState = get(aliceSessionStore.state);
    assert.deepEqual(currentState.body.text.join(''), expectedText);

    await aliceSessionStore.leaveSession();
    await bobSessionStore.leaveSession();

    const aliceTip = await toPromise(aliceWorkspaceStore.tip);
    assert.ok(aliceTip);
    const bobTip = await toPromise(bobWorkspaceStore.tip);
    assert.ok(bobTip);
  });
});

import { assert, test } from 'vitest';
import * as Automerge from '@automerge/automerge';
import { AppBundleSource, encodeHashToBase64 } from '@holochain/client';
import { EntryRecord } from '@holochain-open-dev/utils';
import { dhtSync, runScenario, Player } from '@holochain-open-dev/tryorama';
import { SynStore } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';

import { delay, sampleGrammar, synHapp } from '../common.js';

// Replacing a workspace tip writes the new tip link and then retracts the
// links it supersedes. A peer must never observe the retraction without the
// new link: its live tip set must go straight from the old tips to the new
// one, and the retractions must be valid everywhere (no warrants).

const b64 = (h: Uint8Array) => encodeHashToBase64(h);

function snapshot(state: Record<string, unknown>) {
  return { kind: 'snapshot' as const, data: Automerge.save(Automerge.from(state)) };
}

async function commitAndRetip(
  client: SynClient,
  author: Player,
  documentHash: Uint8Array,
  workspaceHash: Uint8Array,
  previous: Uint8Array[],
  title: string
) {
  // raw zome call: no signal wait, so the tip rewrite follows the commit as
  // closely as a real client can make it
  const commit = new EntryRecord<any>(
    await (client as any).callZome('create_commit', {
      state: snapshot({ title, body: { text: [] } }),
      document_hash: documentHash,
      previous_commit_hashes: previous,
      authors: [author.agentPubKey],
      meta: undefined,
    })
  );
  await client.updateWorkspaceTip(workspaceHash, commit.actionHash, previous);
  return commit.actionHash as Uint8Array;
}

/** Poll a peer's local tip set until it equals `expected`; fail if it is ever empty. */
async function watchTipsUntil(
  client: SynClient,
  workspaceHash: Uint8Array,
  expected: Uint8Array[],
  timeoutMs = 30_000
) {
  const want = expected.map(b64).sort().join(',');
  const start = Date.now();
  const seen: string[] = [];
  for (;;) {
    const links = await client.getWorkspaceTips(workspaceHash, true);
    const now = links.map(l => b64(l.target)).sort().join(',');
    if (seen[seen.length - 1] !== now) seen.push(now);
    assert.notEqual(links.length, 0, `tip set went empty; observed ${JSON.stringify(seen)}`);
    if (now === want) return seen;
    assert.ok(
      Date.now() - start < timeoutMs,
      `tip set never became [${want}]; observed ${JSON.stringify(seen)}`
    );
    await delay(10);
  }
}

async function warrantCount(player: Player) {
  const state: any = await player.conductor
    .adminWs()
    .dumpFullState({ cell_id: player.cells[0].cell_id, dht_ops_cursor: undefined } as any);
  const dump = state.integration_dump;
  return [...dump.integrated, ...dump.integration_limbo, ...dump.validation_limbo].filter(
    (op: any) => 'WarrantOp' in op
  ).length;
}

test('replacing the tip never leaves a peer without a tip, and the retractions are valid', async () => {
  await runScenario(async scenario => {
    const appSource = { appBundleSource: { type: 'path', value: synHapp } as AppBundleSource };
    const [alice, bob] = await scenario.addPlayersWithApps([appSource, appSource]);
    await scenario.shareAllAgents();
    const aliceClient = new SynClient(alice.appWs as any, 'syn-test');
    const bobClient = new SynClient(bob.appWs as any, 'syn-test');
    const aliceSyn = new SynStore(aliceClient);
    const dna = alice.cells[0].cell_id[0];

    const docStore = await aliceSyn.createDocument(sampleGrammar.initialState());
    const wsStore = await docStore.createWorkspace('main', undefined);
    const ws = wsStore.workspaceHash;
    const doc = docStore.documentHash;

    // first tip, by Alice
    const cA = await commitAndRetip(aliceClient, alice, doc, ws, [], 'a');
    await dhtSync([alice, bob], dna);
    await watchTipsUntil(bobClient, ws, [cA]);

    // Bob supersedes it: one retraction, whose previous action is the create
    const cB = await commitAndRetip(bobClient, bob, doc, ws, [cA], 'b');
    await watchTipsUntil(aliceClient, ws, [cB]);
    await dhtSync([alice, bob], dna);

    // two concurrent tips on top of cB, then Alice merges them: two
    // retractions in one write, the second following the first
    const c1 = await commitAndRetip(aliceClient, alice, doc, ws, [cB], 'c1');
    const c2 = await commitAndRetip(bobClient, bob, doc, ws, [cB], 'c2');
    await dhtSync([alice, bob], dna);
    await watchTipsUntil(aliceClient, ws, [c1, c2]);
    await watchTipsUntil(bobClient, ws, [c1, c2]);

    const cM = await commitAndRetip(aliceClient, alice, doc, ws, [c1, c2], 'merge');
    await watchTipsUntil(bobClient, ws, [cM]);
    await dhtSync([alice, bob], dna);
    await watchTipsUntil(aliceClient, ws, [cM]);

    assert.equal(await warrantCount(alice), 0, 'alice warranted a retraction');
    assert.equal(await warrantCount(bob), 0, 'bob warranted a retraction');
  });
});

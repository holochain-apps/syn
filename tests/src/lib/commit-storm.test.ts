import { assert, test } from 'vitest';

import { dhtSync, runScenario } from '@holochain/tryorama';

import { get } from '@holochain-open-dev/stores';
import { SynStore, stateFromCommit } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';
import {
  AgentPubKey,
  AnyDhtHash,
  AppBundleSource,
  encodeHashToBase64,
} from '@holochain/client';
import { decode, encode } from '@msgpack/msgpack';
import * as Automerge from '@automerge/automerge';

import {
  Content,
  delay,
  sampleGrammar,
  synHapp,
  waitForOtherParticipants,
} from '../common.js';
import { textEditorGrammar } from '../text-editor-grammar.js';

/**
 * Tests reproducing the commit storms observed in production (e.g. a kando
 * board with 1836 commits). They assert the *desired* behavior, so they FAIL
 * while the bugs are present and become regression tests once fixed.
 *
 * Bug A: commitChangesInternal merges multiple workspace tips but the merged
 *        doc never reaches the session's local state, and the very next
 *        commit overwrites the merge with the agent's pre-merge snapshot.
 * Bug B: on receiving a conflicting NewCommit, the tip is adopted without
 *        converging the local doc; convergence relies on a best-effort
 *        requestSync to a possibly-unreachable author.
 * Bug C: leader election is computed from heartbeats, which travel over the
 *        same signal channel as Automerge sync, so both fail together.
 * Bug D: the non-leader fallback fires on "no save in 60s", not on actual
 *        leader absence, so divergent non-leaders commit alongside a healthy
 *        leader.
 */

interface CommitRow {
  hash: string;
  author: string;
  timestamp: number;
  meta: string;
  prev: string;
}

async function fetchCommits(
  client: SynClient,
  documentHash: AnyDhtHash
): Promise<CommitRow[]> {
  const links = await client.getCommitsForDocument(documentHash);
  const seen = new Map<string, CommitRow>();
  for (const link of links) {
    const b64 = encodeHashToBase64(link.target);
    if (seen.has(b64)) continue;
    const record = await client.getCommit(link.target);
    if (!record) continue;
    seen.set(b64, {
      hash: b64.slice(-8),
      author: encodeHashToBase64(record.action.author).slice(-8),
      timestamp: record.action.timestamp,
      meta: record.entry.meta ? String(decode(record.entry.meta)) : '',
      prev: record.entry.previous_commit_hashes
        .map(h => encodeHashToBase64(h).slice(-8))
        .join(','),
    });
  }
  return Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function dumpCommits(rows: CommitRow[], label: string) {
  console.log(`\n=== ${label}: ${rows.length} commits ===`);
  for (const row of rows) {
    console.log(
      `${new Date(row.timestamp).toISOString()}  author=…${row.author}  commit=…${row.hash}  prev=[${row.prev}]  ${row.meta}`
    );
  }
}

/** Drop all session messages except the listed payload types, simulating a
 *  signal outage where commits still propagate but Automerge sync,
 *  change notices and heartbeats do not. */
function restrictSignals(client: SynClient, allowedTypes: string[]) {
  const original = client.sendMessage.bind(client);
  (client as any).sendMessage = (recipients: AgentPubKey[], message: any) => {
    if (allowedTypes.includes(message?.payload?.type)) {
      return original(recipients, message);
    }
    return Promise.resolve();
  };
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 500
) {
  const rounds = Math.ceil(timeoutMs / intervalMs);
  for (let i = 0; i < rounds; i++) {
    if (condition()) return true;
    await delay(intervalMs);
  }
  return condition();
}

test(
  'a merge commit feeds merged content into the next tip and the local session state (bug A: merge clobbering)',
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

      const aliceSyn = new SynStore(
        new SynClient(alice.appWs as any, 'syn-test')
      );
      const bobClient = new SynClient(bob.appWs as any, 'syn-test');

      const aliceDocumentStore = await aliceSyn.createDocument(
        sampleGrammar.initialState()
      );
      const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
        'main',
        undefined
      );
      const aliceSession = await aliceWorkspaceStore.joinSession();

      aliceSession.change((state, eph) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(0, 'ALICE')
      );
      await aliceSession.commitChanges();
      const c0 = get(aliceSession.currentTip);
      assert.ok(c0, 'precondition: alice has a tip after committing');

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      // Bob forks from c0 purely over the DHT: he is not in the session, so
      // no signals ever reach alice. This reproduces the sync gap that
      // creates forks in the wild.
      const c0Record = await bobClient.getCommit(c0!.actionHash);
      assert.ok(c0Record, 'precondition: bob can fetch the tip commit');
      const c0State = stateFromCommit(
        c0Record!.entry
      ) as Automerge.Doc<Content>;
      const bobDoc = Automerge.change(Automerge.clone(c0State), d => {
        d.title = 'BOB_TITLE';
      });
      const bobCommit = await bobClient.createCommit({
        authors: [bob.agentPubKey],
        meta: undefined,
        previous_commit_hashes: [c0!.actionHash],
        state: encode(Automerge.save(bobDoc)),
        witnesses: [],
        document_hash: aliceDocumentStore.documentHash,
      });
      await bobClient.updateWorkspaceTip(
        aliceWorkspaceStore.workspaceHash,
        bobCommit.actionHash,
        [c0!.actionHash]
      );

      // Alice commits her own fork, never having received bob's content
      aliceSession.change((state, eph) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(5, '_ONE')
      );
      await aliceSession.commitChanges();

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      const tipsBefore = await aliceWorkspaceStore.getCurrentTips();
      assert.equal(
        tipsBefore.length,
        2,
        'precondition: the workspace has two forked tips'
      );

      // Alice's next commit detects the two tips and goes through the merge
      // path in commitChangesInternal.
      aliceSession.change((state, eph) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(9, '_TWO')
      );
      await aliceSession.commitChanges();
      await delay(2000);

      const rows = await fetchCommits(
        aliceSyn.client,
        aliceDocumentStore.documentHash
      );
      dumpCommits(rows, 'bug A scenario');
      assert.ok(
        rows.some(r => r.meta === 'Merge commit'),
        'precondition: a merge commit was created'
      );

      const tips = await aliceWorkspaceStore.getCurrentTips();
      assert.equal(tips.length, 1, 'expected a single tip after the merge');
      const tipRecord = await aliceSyn.client.getCommit(tips[0]);
      const tipState = stateFromCommit(tipRecord!.entry) as Content;

      // The merged content must survive into the new tip and into alice's
      // own doc. Today the commit issued right after the merge carries
      // alice's pre-merge snapshot, erasing bob's fork from the tip.
      assert.equal(
        tipState.title,
        'BOB_TITLE',
        "the tip after the merge must still contain bob's fork content"
      );
      assert.include(
        tipState.body.text.join(''),
        '_TWO',
        "the tip must contain alice's latest change"
      );
      assert.equal(
        get(aliceSession.state).title,
        'BOB_TITLE',
        "alice's local state must absorb the merged content"
      );

      await aliceSession.leaveSession();
    });
  },
  240_000
);

test(
  'a signal outage between agents must not produce a commit storm (bugs B/C/D)',
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

      const aliceSyn = new SynStore(
        new SynClient(alice.appWs as any, 'syn-test')
      );
      const bobSyn = new SynStore(new SynClient(bob.appWs as any, 'syn-test'));

      // Sped-up timing so the offline transition (outOfSessionTimeout) and
      // the commit cadence play out within a reasonable test window. The
      // dynamics are the same as the defaults, just faster.
      const fastConfig = {
        heartbeatInterval: 2000,
        outOfSessionTimeout: 20 * 1000,
        inactiveSessionThreshold: 8 * 1000,
        commitStrategy: {
          CommitEveryNMs: 5000,
          CommitEveryNDeltas: undefined,
        },
      };

      const aliceDocumentStore = await aliceSyn.createDocument(
        sampleGrammar.initialState()
      );
      const aliceWorkspaceStore = await aliceDocumentStore.createWorkspace(
        'main',
        undefined
      );
      const aliceSession = await aliceWorkspaceStore.joinSession(fastConfig);

      aliceSession.change((state, eph) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(0, 'BASE')
      );

      await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

      const bobDocumentStore = bobSyn.documents.get(
        aliceDocumentStore.documentHash
      );
      const bobWorkspaceStore = bobDocumentStore.workspaces.get(
        aliceWorkspaceStore.workspaceHash
      );
      const bobSession = await bobWorkspaceStore.joinSession(fastConfig);

      // An edit from each side so both agents mark each other active
      bobSession.change(state => {
        state.title = 'shared';
      });
      aliceSession.change((state, eph) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(4, '!')
      );

      await waitForOtherParticipants(aliceSession, 1);
      await waitForOtherParticipants(bobSession, 1);

      // Wait until both docs converge and the leader's periodic commit has
      // established a shared tip.
      const inSync = () => {
        const a = get(aliceSession.state);
        const b = get(bobSession.state);
        return (
          a.title === b.title &&
          a.body.text.join('') === b.body.text.join('') &&
          get(aliceSession.currentTip) !== undefined &&
          get(bobSession.currentTip) !== undefined
        );
      };
      assert.ok(
        await waitUntil(inSync, 30_000),
        'precondition: agents are in sync with a shared tip before the outage'
      );

      const beforeRows = await fetchCommits(
        aliceSyn.client,
        aliceDocumentStore.documentHash
      );
      dumpCommits(beforeRows, 'before outage');
      const beforeCount = beforeRows.length;

      // SIGNAL OUTAGE: Automerge sync, change notices and heartbeats stop
      // flowing between the agents, but NewCommit signals (and the DHT)
      // still work. This is the correlated failure mode: the channel that
      // carries doc sync is the same one that carries leader heartbeats.
      restrictSignals(aliceSyn.client, ['NewCommit']);
      restrictSignals(bobSyn.client, ['NewCommit']);

      // One divergent edit on each side. No further user activity: any
      // sustained commit traffic from here on is the system fighting itself.
      aliceSession.change((state, eph) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(0, 'AAA')
      );
      bobSession.change((state, eph) =>
        textEditorGrammar
          .changes(bob.agentPubKey, state.body, eph)
          .insert(9999, 'BBB')
      );

      // Let the system run with no user activity.
      await delay(120_000);
      const midCount = (
        await fetchCommits(aliceSyn.client, aliceDocumentStore.documentHash)
      ).length;

      // Final observation window: by now everything should long be settled.
      await delay(60_000);
      const endRows = await fetchCommits(
        aliceSyn.client,
        aliceDocumentStore.documentHash
      );
      dumpCommits(endRows, 'after outage window');
      const endCount = endRows.length;

      console.log(
        `commits: before outage=${beforeCount}, after 120s=${midCount}, after 180s=${endCount}`
      );

      const aliceState = get(aliceSession.state);
      const bobState = get(bobSession.state);
      const aliceText = aliceState.body.text.join('');
      const bobText = bobState.body.text.join('');
      console.log(`alice doc: title='${aliceState.title}' text='${aliceText}'`);
      console.log(`bob doc:   title='${bobState.title}' text='${bobText}'`);

      // Desired behavior (all of these fail while the bugs are present):

      // 1. Commit traffic must die down once there is nothing new to save.
      assert.equal(
        endCount - midCount,
        0,
        `commit churn must stop: ${endCount - midCount} commits created in the final 60s with no user activity`
      );

      // 2. A handful of commits at most should be needed to settle two
      //    single-character-divergence forks.
      assert.isAtMost(
        endCount - beforeCount,
        6,
        `commit storm: ${endCount - beforeCount} commits since the outage began`
      );

      // 3. Both agents must converge on the same content.
      assert.equal(aliceText, bobText, 'agents must converge to the same text');

      // 4. No content may be lost: both divergent edits must survive.
      assert.include(aliceText, 'AAA', "alice's edit must survive");
      assert.include(aliceText, 'BBB', "bob's edit must survive");

      // 5. The final tip must contain the converged content.
      const tips = await aliceWorkspaceStore.getCurrentTips();
      assert.equal(tips.length, 1, 'a single tip must remain');
      const tipRecord = await aliceSyn.client.getCommit(tips[0]);
      const tipState = stateFromCommit(tipRecord!.entry) as Content;
      const tipText = tipState.body.text.join('');
      assert.include(tipText, 'AAA', "the tip must contain alice's edit");
      assert.include(tipText, 'BBB', "the tip must contain bob's edit");

      await aliceSession.leaveSession();
      await bobSession.leaveSession();
    });
  },
  420_000
);

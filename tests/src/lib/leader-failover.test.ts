import { assert, test } from 'vitest';

import { dhtSync, runScenario, Player } from '@holochain-open-dev/tryorama';

import { get } from '@holochain-open-dev/stores';
import { SynStore } from '@holochain-syn/store';
import { SynClient, Commit } from '@holochain-syn/client';
import { AppBundleSource, encodeHashToBase64 } from '@holochain/client';
import { encode } from '@msgpack/msgpack';

import {
  Content,
  delay,
  sampleGrammar,
  synHapp,
  waitUntil,
} from '../common.js';
import { textEditorGrammar } from '../text-editor-grammar.js';

/**
 * Regression tests for the failure modes found while reviewing the
 * commit-storm fixes:
 *
 * - An agent that crashes without leaving the session keeps its
 *   WorkspaceToParticipant link in the DHT forever; presence derived from
 *   that link must not let the ghost hold a leadership rank indefinitely,
 *   and pending changes of the survivors must still get committed promptly
 *   (within the rank's stagger window, not the old hardcoded 60s).
 * - A document that has never been committed has no lastSave timestamp;
 *   the takeover fallback must work anyway (it used to be disabled by the
 *   empty lastSave, losing all session edits when the leader was gone).
 * - Content-equal but history-divergent local state (type then delete) must
 *   not leave the session status stuck on 'syncing'.
 * - A commit whose state cannot be loaded must not wedge the document:
 *   merges supersede it instead of throwing forever.
 * - Overlapping explicit commitChanges() calls must not produce forked
 *   sibling commits.
 */

// Sped-up timing so leadership churn, takeover windows and the ghost
// timeout play out within a reasonable test window
const fastConfig = {
  heartbeatInterval: 1000,
  newPeersDiscoveryInterval: 4 * 1000,
  outOfSessionTimeout: 10 * 1000,
  inactiveSessionThreshold: 5 * 1000,
  viewSettlingWindow: 2 * 1000,
  commitStaggerWindow: 8 * 1000,
  ghostSignalTimeout: 30 * 1000,
  commitStrategy: {
    CommitEveryNMs: 2000,
    CommitEveryNDeltas: undefined,
  },
};

/** Simulate a crash: the conductor goes away, but the crashed player's
 *  in-process SessionStore keeps its intervals running. Park its zome calls
 *  on a never-resolving promise so the dead session doesn't flood the test
 *  with rejections from a closed websocket. */
async function crashPlayer(player: Player, session: any) {
  const client = session.workspace.documentStore.synStore.client;
  (client as any).callZome = () => new Promise(() => {});
  // Let zome calls that were already in flight settle against the live
  // conductor before it goes away
  await delay(500);
  await player.conductor.shutDown();
}

interface TwoPlayerSession {
  alice: Player;
  bob: Player;
  aliceSyn: SynStore;
  bobSyn: SynStore;
  aliceSession: any;
  bobSession: any;
  documentHash: any;
}

async function setUpTwoPlayerSession(scenario: any): Promise<TwoPlayerSession> {
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
  const aliceSession = await aliceWorkspaceStore.joinSession(fastConfig);

  await dhtSync([alice, bob], alice.cells[0].cell_id[0]);

  const bobDocumentStore = bobSyn.documents.get(
    aliceDocumentStore.documentHash
  );
  const bobWorkspaceStore = bobDocumentStore.workspaces.get(
    aliceWorkspaceStore.workspaceHash
  );
  const bobSession = await bobWorkspaceStore.joinSession(fastConfig);

  // Wait until both agents see each other in the session (active or idle):
  // membership is what leadership ranking is computed from
  const seesOther = (session: any) => {
    const p = get(session.participants);
    return p.active.length + p.idle.length >= 2;
  };
  assert.ok(
    await waitUntil(
      () => seesOther(aliceSession) && seesOther(bobSession),
      60_000
    ),
    'precondition: both agents see each other in the session'
  );

  return {
    alice,
    bob,
    aliceSyn,
    bobSyn,
    aliceSession,
    bobSession,
    documentHash: aliceDocumentStore.documentHash,
  };
}

test(
  'a crashed leader is demoted and the survivor commits pending changes within its stagger window',
  async () => {
    await runScenario(async scenario => {
      const s = await setUpTwoPlayerSession(scenario);

      // Both edit so both are active, then wait for a shared committed tip
      s.aliceSession.change((state: Content, eph: any) =>
        textEditorGrammar
          .changes(s.alice.agentPubKey, state.body, eph)
          .insert(0, 'BASE')
      );
      s.bobSession.change((state: Content) => {
        state.title = 'shared';
      });
      assert.ok(
        await waitUntil(
          () =>
            get(s.aliceSession.currentTip) !== undefined &&
            get(s.bobSession.currentTip) !== undefined &&
            get(s.aliceSession.state).body.text.join('') ===
              get(s.bobSession.state).body.text.join(''),
          60_000
        ),
        'precondition: agents share a committed tip'
      );

      // Crash the leader's conductor: no LeaveSession signal, and its
      // session link stays in the DHT forever
      const aliceIsLeader =
        encodeHashToBase64(s.alice.agentPubKey) <
        encodeHashToBase64(s.bob.agentPubKey);
      const crashed = aliceIsLeader ? s.alice : s.bob;
      const crashedSession = aliceIsLeader ? s.aliceSession : s.bobSession;
      const survivorSession = aliceIsLeader ? s.bobSession : s.aliceSession;
      const survivor = aliceIsLeader ? s.bob : s.alice;
      await crashPlayer(crashed, crashedSession);

      // The survivor keeps editing; its changes must reach the DHT within
      // the rank-1 stagger window (8s) plus a couple of commit ticks — not
      // the old hardcoded 60 seconds, and not never.
      survivorSession.change((state: Content, eph: any) =>
        textEditorGrammar
          .changes(survivor.agentPubKey, state.body, eph)
          .insert(0, 'SURVIVOR')
      );

      const tipHasSurvivorEdit = async () => {
        const tip = get(survivorSession.currentTip);
        if (!tip) return false;
        try {
          // The tip may be a delta commit: reconstruct its full state
          const state = (await survivorSession.workspace.documentStore.resolveCommitState(
            tip
          )) as Content;
          return state.body.text.join('').includes('SURVIVOR');
        } catch (e) {
          return false;
        }
      };
      assert.ok(
        await waitUntil(tipHasSurvivorEdit, 30_000),
        "survivor's edit must be committed despite the crashed leader"
      );

      // Once the ghost has gone signal-silent past ghostSignalTimeout it
      // must stop occupying a leadership rank
      assert.ok(
        await waitUntil(
          () => survivorSession.leadershipRank() === 0,
          fastConfig.ghostSignalTimeout + 20_000
        ),
        'survivor must become leader once the crashed agent goes ghost'
      );

      await survivorSession.leaveSession();
    });
  },
  { timeout: 240_000 }
);

test(
  'a never-committed document still gets committed when the leader crashes (empty lastSave)',
  async () => {
    await runScenario(async scenario => {
      const s = await setUpTwoPlayerSession(scenario);

      // No edits and no commits yet: lastSave has no timestamp. Crash the
      // leader before the first commit ever happens.
      const aliceIsLeader =
        encodeHashToBase64(s.alice.agentPubKey) <
        encodeHashToBase64(s.bob.agentPubKey);
      const crashed = aliceIsLeader ? s.alice : s.bob;
      const crashedSession = aliceIsLeader ? s.aliceSession : s.bobSession;
      const survivorSession = aliceIsLeader ? s.bobSession : s.aliceSession;
      const survivor = aliceIsLeader ? s.bob : s.alice;

      assert.isUndefined(
        get(survivorSession.currentTip),
        'precondition: nothing has been committed yet'
      );

      await crashPlayer(crashed, crashedSession);

      survivorSession.change((state: Content, eph: any) =>
        textEditorGrammar
          .changes(survivor.agentPubKey, state.body, eph)
          .insert(0, 'FIRST')
      );

      const tipHasEdit = async () => {
        const tip = get(survivorSession.currentTip);
        if (!tip) return false;
        try {
          // The tip may be a delta commit: reconstruct its full state
          const state = (await survivorSession.workspace.documentStore.resolveCommitState(
            tip
          )) as Content;
          return state.body.text.join('').includes('FIRST');
        } catch (e) {
          return false;
        }
      };
      assert.ok(
        await waitUntil(tipHasEdit, 30_000),
        'the first-ever commit must happen even though lastSave was never set'
      );

      await survivorSession.leaveSession();
    });
  },
  { timeout: 240_000 }
);

test(
  'content-equal but history-divergent edits do not leave the session stuck on syncing',
  async () => {
    await runScenario(async scenario => {
      const appSource = {
        appBundleSource: { type: 'path', value: synHapp } as AppBundleSource,
      };
      const [alice] = await scenario.addPlayersWithApps([appSource]);

      const aliceSyn = new SynStore(
        new SynClient(alice.appWs as any, 'syn-test')
      );
      const documentStore = await aliceSyn.createDocument(
        sampleGrammar.initialState()
      );
      const workspaceStore = await documentStore.createWorkspace(
        'main',
        undefined
      );
      const session = await workspaceStore.joinSession(fastConfig);

      // Establish a committed tip
      session.change((state: Content, eph: any) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(0, 'BASE')
      );
      assert.ok(
        await waitUntil(
          () =>
            get(session.currentTip) !== undefined &&
            get(session.sessionStatus).code === 'ok',
          30_000
        ),
        'precondition: initial edit is committed'
      );

      // Type a character and delete it again: the content now equals the
      // tip but the history differs, so there is nothing worth committing —
      // the status must still return to ok instead of staying on syncing
      session.change((state: Content, eph: any) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(4, 'X')
      );
      session.change((state: Content, eph: any) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .delete(4, 1)
      );

      assert.ok(
        await waitUntil(
          () => get(session.sessionStatus).code === 'ok',
          20_000
        ),
        'session status must return to ok after net-zero edits'
      );

      await session.leaveSession();
    });
  },
  { timeout: 120_000 }
);

test(
  'an unloadable commit does not wedge the document: merges supersede it',
  async () => {
    await runScenario(async scenario => {
      const appSource = {
        appBundleSource: { type: 'path', value: synHapp } as AppBundleSource,
      };
      const [alice, mallory] = await scenario.addPlayersWithApps([
        appSource,
        appSource,
      ]);
      await scenario.shareAllAgents();

      const aliceSyn = new SynStore(
        new SynClient(alice.appWs as any, 'syn-test')
      );
      const malloryClient = new SynClient(mallory.appWs as any, 'syn-test');

      const documentStore = await aliceSyn.createDocument(
        sampleGrammar.initialState()
      );
      const workspaceStore = await documentStore.createWorkspace(
        'main',
        undefined
      );
      const session = await workspaceStore.joinSession(fastConfig);

      // Establish a committed tip
      session.change((state: Content, eph: any) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(0, 'BASE')
      );
      assert.ok(
        await waitUntil(() => get(session.currentTip) !== undefined, 30_000),
        'precondition: initial edit is committed'
      );

      await dhtSync([alice, mallory], alice.cells[0].cell_id[0]);

      // A buggy client writes a commit whose state is not a loadable
      // automerge document, as an additional workspace tip
      const corrupt: Commit = {
        authors: [mallory.agentPubKey],
        meta: encode('corrupt'),
        previous_commit_hashes: [],
        state: { kind: 'snapshot', data: new Uint8Array([1, 2, 3]) },
        document_hash: documentStore.documentHash,
      };
      const corruptCommit = await malloryClient.createCommit(corrupt);
      await malloryClient.updateWorkspaceTip(
        workspaceStore.workspaceHash,
        corruptCommit.actionHash,
        []
      );
      await dhtSync([alice, mallory], alice.cells[0].cell_id[0]);

      // Alice keeps editing: her commit path now sees two tips and must
      // merge them — skipping the unloadable one — instead of throwing on
      // every tick and never committing again
      session.change((state: Content, eph: any) =>
        textEditorGrammar
          .changes(alice.agentPubKey, state.body, eph)
          .insert(4, ' AFTER')
      );

      const committedAfterCorrupt = async () => {
        const tip = get(session.currentTip);
        if (!tip) return false;
        try {
          // The tip may be a delta commit: reconstruct its full state
          const state = (await session.workspace.documentStore.resolveCommitState(
            tip
          )) as Content;
          return (
            state.body.text.join('').includes('AFTER') &&
            get(session.sessionStatus).code === 'ok'
          );
        } catch (e) {
          return false;
        }
      };
      assert.ok(
        await waitUntil(committedAfterCorrupt, 30_000),
        "alice's edits must still get committed after a corrupt tip appears"
      );

      const tips = await workspaceStore.getCurrentTips();
      assert.equal(
        tips.length,
        1,
        'the corrupt tip must be superseded by the merge'
      );

      await session.leaveSession();
    });
  },
  { timeout: 120_000 }
);

test(
  'overlapping explicit commits never fork the commit graph',
  async () => {
    await runScenario(async scenario => {
      const appSource = {
        appBundleSource: { type: 'path', value: synHapp } as AppBundleSource,
      };
      const [alice] = await scenario.addPlayersWithApps([appSource]);

      const aliceSyn = new SynStore(
        new SynClient(alice.appWs as any, 'syn-test')
      );
      const documentStore = await aliceSyn.createDocument(
        sampleGrammar.initialState()
      );
      const workspaceStore = await documentStore.createWorkspace(
        'main',
        undefined
      );
      // Long commit interval so only the explicit calls below commit
      const session = await workspaceStore.joinSession({
        ...fastConfig,
        commitStrategy: { CommitEveryNMs: 60_000, CommitEveryNDeltas: undefined },
      });

      const commits: Promise<any>[] = [];
      for (let i = 0; i < 5; i++) {
        session.change((state: Content, eph: any) =>
          textEditorGrammar
            .changes(alice.agentPubKey, state.body, eph)
            .insert(0, `${i}`)
        );
        commits.push(session.commitChanges());
      }
      await Promise.all(commits);

      const tips = await workspaceStore.getCurrentTips();
      assert.equal(
        tips.length,
        1,
        'concurrent commitChanges calls must not create sibling tips'
      );

      // The commit graph must be linear: no commit may be the parent of
      // two different commits
      const links = await aliceSyn.client.getCommitsForDocument(
        documentStore.documentHash
      );
      const seen = new Set<string>();
      const childrenOf = new Map<string, number>();
      for (const link of links) {
        const b64 = encodeHashToBase64(link.target);
        if (seen.has(b64)) continue;
        seen.add(b64);
        const commit = await aliceSyn.client.getCommit(link.target);
        if (!commit) continue;
        for (const prev of commit.entry.previous_commit_hashes) {
          const prevB64 = encodeHashToBase64(prev);
          childrenOf.set(prevB64, (childrenOf.get(prevB64) ?? 0) + 1);
        }
      }
      for (const [parent, children] of childrenOf) {
        assert.isAtMost(
          children,
          1,
          `commit ${parent} has ${children} children: the graph forked`
        );
      }

      await session.leaveSession();
    });
  },
  { timeout: 120_000 }
);

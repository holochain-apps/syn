import {
  AsyncReadable,
  AsyncStatus,
  derived,
  deriveStore,
  immutableEntryStore,
  liveLinksStore,
  pipe,
  toPromise,
  uniquify,
  Writable,
  writable,
} from '@holochain-open-dev/stores';
import { ActionHash, AgentPubKey, encodeHashToBase64, EntryHash, HoloHashMap, Link } from '@holochain/client';
import {
  EntryRecord,
  HashType,
  retype,
} from '@holochain-open-dev/utils';
import { decode, encode } from '@msgpack/msgpack';
import { Commit } from '@holochain-syn/client';
import * as Automerge from '@automerge/automerge'

import { defaultConfig, LINKS_POLL_INTERVAL_MS, RecursivePartial, SynConfig } from './config.js';
import { DocumentStore } from './document-store.js';
import { SessionStore } from './session-store.js';
import { stateFromDocument } from './syn-store.js';
import { encodeCommitPayload } from './commit-payload.js';
import { freeDoc } from './automerge-safe.js';

/** Sorts hashes by their base64 encoding, the canonical order shared by all agents */
export const sortHashes = (hashes: Array<ActionHash>): Array<ActionHash> =>
  [...hashes].sort((h1, h2) => {
    const b1 = encodeHashToBase64(h1);
    const b2 = encodeHashToBase64(h2);
    if (b1 < b2) return -1;
    if (b1 > b2) return 1;
    return 0;
  });

export class WorkspaceStore<S, E> {
  private _merging = false;
  private _mergingPromise: Promise<EntryRecord<Commit>> | undefined;
  private _mergingCommitsKey: string | undefined;
  private _workspaceStoreId = Math.random().toString(36).substring(2);

  constructor(
    public documentStore: DocumentStore<S, E>,
    public workspaceHash: EntryHash
  ) { }

  record = immutableEntryStore(async () => this.documentStore.synStore.client.getWorkspace(
    this.workspaceHash
  ), 1000, 10);

  name = pipe(this.record, workspace => workspace.entry.name);

  private _session: Writable<SessionStore<S, E> | undefined> =
    writable(undefined);
  session = derived(this._session, i => i);

  /**
   * Keeps an up to date array of the all the agents that are currently participating in
   * the session for this workspace
   */
  sessionParticipants = pipe(
    liveLinksStore(
      this.documentStore.synStore.client,
      this.workspaceHash,
      () =>
        this.documentStore.synStore.client.getWorkspaceSessionParticipants(
          this.workspaceHash
        ),
      'WorkspaceToParticipant',
      LINKS_POLL_INTERVAL_MS,
      () =>
        this.documentStore.synStore.client.getWorkspaceSessionParticipants(
          this.workspaceHash, true
        ),
    ),
    links => uniquify(links.map(l => retype(l.target, HashType.AGENT)))
  );

  /**
   * Get the current workspace tips
   */
  async getCurrentTips(): Promise<Array<ActionHash>> {
    const commitsLinks = await this.documentStore.synStore.client.getWorkspaceTips(
      this.workspaceHash
    );

    const tipsLinks = new HoloHashMap<ActionHash, Link>();
    const tipsPrevious = new HoloHashMap<ActionHash, boolean>();

    for (const commitLink of commitsLinks) {
      tipsLinks.set(commitLink.target, commitLink);
      const previousCommitsHashes: Array<ActionHash> = decode(
        commitLink.tag
      ) as Array<ActionHash>;

      for (const previousCommitHash of previousCommitsHashes) {
        tipsPrevious.set(previousCommitHash, true);
      }
    }

    for (const overwrittenTip of tipsPrevious.keys()) {
      tipsLinks.delete(overwrittenTip);
    }

    return Array.from(tipsLinks.keys()) as ActionHash[];
  }

  /**
   * Current workspace tips grouped by commit entry hash.
   *
   * Tips sharing an entry hash are byte-identical commits authored
   * concurrently by different agents (e.g. two agents racing the same
   * deterministic merge): they carry the same state and need no merging.
   * Groups and their members are sorted by base64 hash, so every agent
   * computes the same canonical grouping.
   */
  async getCurrentTipGroups(): Promise<Array<Array<ActionHash>>> {
    const tips = await this.getCurrentTips();

    const groups = new HoloHashMap<EntryHash, Array<ActionHash>>();
    for (const tip of tips) {
      const record = await toPromise(this.documentStore.commits.get(tip)!);
      const group = groups.get(record.entryHash);
      if (group) {
        group.push(tip);
      } else {
        groups.set(record.entryHash, [tip]);
      }
    }

    return (Array.from(groups.values()) as Array<Array<ActionHash>>)
      .map(group => sortHashes(group))
      .sort((g1, g2) => {
        const b1 = encodeHashToBase64(g1[0]);
        const b2 = encodeHashToBase64(g2[0]);
        if (b1 < b2) return -1;
        if (b1 > b2) return 1;
        return 0;
      });
  }

  async merge(commitsHashes: Array<ActionHash>): Promise<EntryRecord<Commit>> {
    // Create a unique key for this merge operation
    const mergeKey = commitsHashes.map(h => encodeHashToBase64(h)).sort().join(',');
    
    // Check if already merging the same commits - return existing promise if so
    if (this._merging && this._mergingPromise && this._mergingCommitsKey === mergeKey) {
      console.log(this._workspaceStoreId, this.documentStore.documentStoreId, 'Merge already in progress for the same commits, waiting for existing merge to complete.');
      return this._mergingPromise;
    }
    
    // Check if merging different commits - wait for current merge to complete first
    if (this._merging && this._mergingPromise) {
      console.log(this._workspaceStoreId, this.documentStore.documentStoreId, 'Different merge in progress, waiting for it to complete before starting new merge.');
      await this._mergingPromise;
    }

    console.log(this._workspaceStoreId, this.documentStore.documentStoreId, "continuing with merge because no other merges are in progress. proof: ", { mergeKey, merging: this._merging, mergingCommitsKey: this._mergingCommitsKey });

    // Set lock and create promise
    this._merging = true;
    this._mergingCommitsKey = mergeKey;
    this._mergingPromise = this._performMerge(commitsHashes);
    
    try {
      const result = await this._mergingPromise;
      return result;
    } finally {
      this._merging = false;
      this._mergingPromise = undefined;
      this._mergingCommitsKey = undefined;
    }
  }

  // Every field of the merge commit is derived deterministically from the
  // merged tips, so concurrent agents merging the same tips produce
  // byte-identical entries that the DHT dedupes by content hash.
  private async _performMerge(commitsHashes: Array<ActionHash>): Promise<EntryRecord<Commit>> {
    const sortedHashes = sortHashes(commitsHashes);

    const commitRecords: EntryRecord<Commit>[] = [];
    for (const hash of sortedHashes) {
      commitRecords.push(await toPromise(this.documentStore.commits.get(hash)!));
    }

    // Tips with the same entry hash carry the same state: one per group
    const byEntryHash = new HoloHashMap<EntryHash, EntryRecord<Commit>>();
    for (const record of commitRecords) {
      byEntryHash.set(record.entryHash, record);
    }
    const uniqueRecords = Array.from(byEntryHash.values()) as EntryRecord<Commit>[];

    // A tip whose state can't be resolved (corrupt bytes, written by an
    // incompatible client, or a delta chain we don't hold yet) can never be
    // merged by anyone, and a single such commit must not wedge the document
    // forever. Merge the resolvable tips and supersede the unresolvable ones
    // as parents, so they stop being tips; live participants that hold their
    // content still converge over the sync channel and re-commit it.
    //
    // Known trade-off: resolvability is a LOCAL condition, so two agents
    // merging concurrently with different gossip coverage can produce
    // non-identical merge entries for the same parent set — a fork instead
    // of a DHT-deduped merge. The consequence is bounded: the sibling
    // merges themselves get merged in the next round, and the skipped
    // tip's content stays reachable through whichever agent resolved it
    // (an agent nobody can resolve is unrecoverable regardless). A
    // deterministic alternative (defer merging until every tip resolves,
    // with a liveness timeout) trades this bounded extra round for a
    // wedge risk during partitions; revisit if fork churn shows up in
    // practice.
    const resolvableRecords: EntryRecord<Commit>[] = [];
    const resolvableStates: Automerge.Doc<S>[] = [];
    for (const record of uniqueRecords) {
      try {
        resolvableStates.push(
          (await this.documentStore.resolveCommitState(
            record
          )) as Automerge.Doc<S>
        );
        resolvableRecords.push(record);
      } catch (error) {
        console.error(
          'Skipping unresolvable tip state during merge:',
          encodeHashToBase64(record.actionHash),
          error
        );
      }
    }
    if (resolvableStates.length === 0) {
      throw new Error('None of the tip states to merge could be loaded');
    }

    let mergeState: Automerge.Doc<S>;
    try {
      let merged: Automerge.Doc<S> = resolvableStates[0];
      for (let i = 1; i < resolvableStates.length; i++) {
        merged = Automerge.merge(merged, resolvableStates[i]);
      }
      // Rebuild through a save/load round-trip: canonicalizes the document
      // and works around automerge#1327 (index gaps after merge)
      mergeState = Automerge.load(Automerge.save(merged)) as Automerge.Doc<S>;
    } finally {
      // All merge inputs are locally resolved docs; release them on success
      // AND on a mid-merge throw (merge reuses resolvableStates[0]'s
      // handle, so freeing every entry covers the accumulated doc too) —
      // wasm docs are never GC-reclaimed
      for (const resolved of resolvableStates) {
        freeDoc(resolved);
      }
    }

    const documentHash = this.documentStore.documentHash;

    // Union of the tips' authors in base64 order, not the merging agent:
    // who performs the merge must not change the entry
    const authorsByB64 = new Map<string, AgentPubKey>();
    for (const record of resolvableRecords) {
      for (const author of record.entry.authors) {
        authorsByB64.set(encodeHashToBase64(author), author);
      }
    }
    const authors = Array.from(authorsByB64.keys())
      .sort()
      .map(b64 => authorsByB64.get(b64)!);

    const commit: Commit = {
      authors,
      meta: encode('Merge commit'),
      previous_commit_hashes: sortedHashes,
      state: encodeCommitPayload({
        kind: 'snapshot',
        data: Automerge.save(mergeState),
      }),
      witnesses: [],
      document_hash: documentHash,
    };

    // the merged state is fully serialized into the commit entry above
    freeDoc(mergeState);

    const newCommit = await this.documentStore.synStore.client.createCommit(
      commit
    );

    console.log(this._workspaceStoreId, this.documentStore.documentStoreId, 'Updating workspace tip to new merge commit:', encodeHashToBase64(newCommit.actionHash), 'from previous tips:', sortedHashes.map(h => encodeHashToBase64(h)));

    await this.documentStore.synStore.client.updateWorkspaceTip(
      this.workspaceHash,
      newCommit.actionHash,
      sortedHashes
    );
    return newCommit;
  }

  /**
   * Keeps an up to date copy of the tip for this workspace
   * When there's a session, returns the session's current tip
   * When there's no session, returns the first workspace tip (may be multiple if not yet merged)
   */
  tip = pipe(
    derived(
      this.session,
      s =>
      ({ status: 'complete', value: s } as AsyncStatus<
        SessionStore<S, E> | undefined
      >)
    ),
    session =>
      session
        ? session.currentTip
        : pipe(
          liveLinksStore(
            this.documentStore.synStore.client,
            this.workspaceHash,
            () =>
              this.documentStore.synStore.client.getWorkspaceTips(
                this.workspaceHash
              ),
            'WorkspaceToTip',
            LINKS_POLL_INTERVAL_MS,
            () =>
              this.documentStore.synStore.client.getWorkspaceTips(
                this.workspaceHash, true
              ),
          ),
          async (commitsLinks): Promise<ActionHash | undefined> => {
            const tipsLinks = new HoloHashMap<ActionHash, Link>();
            const tipsPrevious = new HoloHashMap<ActionHash, boolean>();

            for (const commitLink of commitsLinks) {
              tipsLinks.set(commitLink.target, commitLink);
              const previousCommitsHashes: Array<ActionHash> = decode(
                commitLink.tag
              ) as Array<ActionHash>;

              for (const previousCommitHash of previousCommitsHashes) {
                tipsPrevious.set(previousCommitHash, true);
              }
            }

            for (const overwrittenTip of tipsPrevious.keys()) {
              tipsLinks.delete(overwrittenTip);
            }
            const tipsHashes = Array.from(tipsLinks.keys()) as ActionHash[];
            if (tipsHashes.length === 0) return undefined;

            // Return the canonical (lowest base64) tip without auto-merging,
            // so every agent picks the same one.
            // Merging will happen during session commits
            return sortHashes(tipsHashes)[0];
          },
          (commit: ActionHash | undefined) =>
            commit ? this.documentStore.commits.get(commit) : undefined
        )
  );

  /**
   * Keeps an up to date copy of the state of the tip for this workspace,
   * as a materialized plain-JS snapshot. The resolved Automerge doc is
   * released immediately after materialization: handing Docs to
   * subscribers leaked one per tip update, since ownership passed to the
   * consumer and wasm docs are never GC-reclaimed (docs/automerge-memory.md).
   */
  latestSnapshot: AsyncReadable<S> = pipe(this.tip, commit =>
    commit
      ? this.documentStore.resolveCommitState(commit).then(doc => {
          const snapshot = Automerge.toJS(doc) as S;
          freeDoc(doc);
          return snapshot;
        })
      : pipe(this.documentStore.record, document => {
          const doc = stateFromDocument(document.entry);
          const snapshot = Automerge.toJS(doc) as S;
          freeDoc(doc);
          return snapshot;
        })
  );

  /**
   * Keeps an up to date copy of the state of the session if there is an active one,
   * or the latest snapshot if there isn't a session
   */
  latestState: AsyncReadable<S> = deriveStore(this.session, session => {
    if (session)
      return derived(
        session.state,
        s =>
        ({
          status: 'complete',
          value: s,
        } as AsyncStatus<S>)
      );

    return this.latestSnapshot;
  });

  /**
   * Joins the real-time collaborative session for this workspace
   * This will connect to all the active peers and start to synchronize with them
   */
  async joinSession(
    config?: RecursivePartial<SynConfig>
  ): Promise<SessionStore<S, E>> {
    const mergedConfig: SynConfig = {
      ...defaultConfig(),
      ...config,
      commitStrategy: {
        ...defaultConfig().commitStrategy,
        ...config?.commitStrategy,
      },
    };

    const session = await SessionStore.joinSession(
      this,
      () => this._session.set(undefined),
      mergedConfig
    );

    this._session.set(session);

    return session;
  }
}

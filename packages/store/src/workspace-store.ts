import {
  AsyncReadable,
  AsyncStatus,
  derived,
  deriveStore,
  immutableEntryStore,
  liveLinksStore,
  pipe,
  sliceAndJoin,
  toPromise,
  uniquify,
  Writable,
  writable,
} from '@holochain-open-dev/stores';
import { ActionHash, encodeHashToBase64, EntryHash, HoloHashMap, Link } from '@holochain/client';
import {
  EntryRecord,
  GetonlyMap,
  HashType,
  retype,
} from '@holochain-open-dev/utils';
import { decode, encode } from '@msgpack/msgpack';
import { Commit } from '@holochain-syn/client';
import * as Automerge from '@automerge/automerge'

import { defaultConfig, LINKS_POLL_INTERVAL_MS, RecursivePartial, SynConfig } from './config.js';
import { DocumentStore } from './document-store.js';
import { SessionStore } from './session-store.js';
import { stateFromCommit, stateFromDocument } from './syn-store.js';

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

  private async _performMerge(commitsHashes: Array<ActionHash>): Promise<EntryRecord<Commit>> {
    const commits = await toPromise(
      sliceAndJoin(
        this.documentStore.commits as GetonlyMap<ActionHash, AsyncReadable<EntryRecord<Commit> | undefined>>,
        commitsHashes
      )
    );
    // If there are more that one tip, merge them
    const commitValues: EntryRecord<Commit>[] = Array.from(commits.values()) as EntryRecord<Commit>[];

    // A tip whose state can't be loaded (corrupt bytes, or written by an
    // incompatible client) can never be merged by anyone, and a single such
    // commit must not wedge the document forever. Merge the loadable tips
    // and supersede the unloadable ones as parents, so they stop being
    // tips; live participants that hold their content still converge over
    // the sync channel and re-commit it.
    const loadableStates: Automerge.Doc<S>[] = [];
    for (const commitValue of commitValues) {
      try {
        loadableStates.push(stateFromCommit(commitValue.entry) as Automerge.Doc<S>);
      } catch (error) {
        console.error(
          'Skipping unloadable tip state during merge:',
          encodeHashToBase64(commitValue.actionHash),
          error
        );
      }
    }
    if (loadableStates.length === 0) {
      throw new Error('None of the tip states to merge could be loaded');
    }

    let mergeState: Automerge.Doc<S> = loadableStates[0];
    for (let i = 1; i < loadableStates.length; i++) {
      mergeState = Automerge.merge(mergeState, loadableStates[i]);
    }

    const documentHash = this.documentStore.documentHash;

    const commit: Commit = {
      authors: [this.documentStore.synStore.client.client.myPubKey],
      meta: encode('Merge commit'),
      previous_commit_hashes: commitsHashes,
      state: encode(Automerge.save(mergeState)),
      witnesses: [],
      document_hash: documentHash,
    };

    const newCommit = await this.documentStore.synStore.client.createCommit(
      commit
    );

    console.log(this._workspaceStoreId, this.documentStore.documentStoreId, 'Updating workspace tip to new merge commit:', encodeHashToBase64(newCommit.actionHash), 'from previous tips:', commitsHashes?.map(h => encodeHashToBase64(h)));

    await this.documentStore.synStore.client.updateWorkspaceTip(
      this.workspaceHash,
      newCommit.actionHash,
      commitsHashes
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

            // Return first tip without auto-merging
            // Merging will happen during session commits
            return tipsHashes[0];
          },
          (commit: ActionHash | undefined) =>
            commit ? this.documentStore.commits.get(commit) : undefined
        )
  );

  /**
   * Keeps an up to date copy of the state of the tip for this workspace
   */
  latestSnapshot: AsyncReadable<S> = pipe(this.tip, commit =>
    commit
      ? (stateFromCommit(commit.entry) as S)
      : pipe(
        this.documentStore.record,
        document => stateFromDocument(document.entry) as S
      )
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

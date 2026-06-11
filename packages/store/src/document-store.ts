import {
  ActionHash,
  AnyDhtHash,
  EntryHash,
  LazyHoloHashMap,
} from '@holochain/client';
import {
  AsyncReadable,
  immutableEntryStore,
  liveLinksStore,
  pipe,
  toPromise,
  uniquify,
} from '@holochain-open-dev/stores';
import * as Automerge from '@automerge/automerge';
import {
  EntryRecord,
  GetonlyMap,
  HashType,
  retype,
  slice,
} from '@holochain-open-dev/utils';
import { Commit } from '@holochain-syn/client';

import { SynStore } from './syn-store.js';
import { WorkspaceStore } from './workspace-store.js';
import { LINKS_POLL_INTERVAL_MS } from './config.js';
import { decodeCommitPayload } from './commit-payload.js';

export function sliceStrings<K extends string, V>(
  map: GetonlyMap<K, V>,
  keys: K[]
): ReadonlyMap<K, V> {
  const newMap = new Map<K, V>();

  for (const key of keys) {
    newMap.set(key, map.get(key));
  }
  return newMap;
}

export class DocumentStore<S, E> {
  private _workspaces: LazyHoloHashMap<EntryHash, WorkspaceStore<S, E>>;
  public documentStoreId = Math.random().toString(36).substring(2);

  constructor(public synStore: SynStore, public documentHash: AnyDhtHash) {
    this._workspaces = new LazyHoloHashMap<EntryHash, WorkspaceStore<S, E>>(
      (workspaceHash: EntryHash) => {
        return new WorkspaceStore<S, E>(this, workspaceHash);
      }
    );
  }

  record = immutableEntryStore(async () => this.synStore.client.getDocument(this.documentHash), 1000, 10);

  /**
   * Keeps an up to date map of all the workspaces for this document
   */
  allWorkspaces: AsyncReadable<ReadonlyMap<EntryHash, WorkspaceStore<S, E>>> = pipe(
    liveLinksStore(
      this.synStore.client,
      this.documentHash,
      () => this.synStore.client.getWorkspacesForDocument(this.documentHash),
      'DocumentToWorkspaces',
      LINKS_POLL_INTERVAL_MS,
      () => this.synStore.client.getWorkspacesForDocument(this.documentHash,true),
    ),
    links =>
      // the lazy map constructs entries on demand, so no value is undefined
      slice(
        this.workspaces,
        links.map(l => l.target)
      ) as ReadonlyMap<EntryHash, WorkspaceStore<S, E>>
  );

  /**
   * Keeps an up to date map of all the commits for this document
   */
  allCommits: AsyncReadable<ReadonlyMap<ActionHash, AsyncReadable<EntryRecord<Commit>>>> = pipe(
    liveLinksStore(
      this.synStore.client,
      this.documentHash,
      () => this.synStore.client.getCommitsForDocument(this.documentHash),
      'DocumentToCommits',
      LINKS_POLL_INTERVAL_MS,
      () => this.synStore.client.getCommitsForDocument(this.documentHash,true),
    ),
    links =>
      // the lazy map constructs entries on demand, so no value is undefined
      slice(this.commits, uniquify(links.map(l => l.target))) as ReadonlyMap<
        ActionHash,
        AsyncReadable<EntryRecord<Commit>>
      >
  );

  /**
   * Lazy map of all the commits in this network
   */
  commits = new LazyHoloHashMap<ActionHash, AsyncReadable<EntryRecord<Commit>>>(
    (commitHash: ActionHash) =>
      immutableEntryStore(
        async () => this.synStore.client.getCommit(commitHash),
        1000,
        10
      )
  );

  /**
   * Lazy map of all the workspaces in this network
   */
  get workspaces() {
    return this._workspaces;
  }

  /**
   * Keeps an up to date array of the all the agents that have participated in any commit in this document
   */
  allAuthors = pipe(
    liveLinksStore(
      this.synStore.client,
      this.documentHash,
      () => this.synStore.client.getAuthorsForDocument(this.documentHash),
      'DocumentToAuthors',
      LINKS_POLL_INTERVAL_MS,
      () => this.synStore.client.getAuthorsForDocument(this.documentHash, true),
    ),
    links => uniquify(links.map(l => retype(l.target, HashType.AGENT)))
  );

  /**
   * Reconstructs the full document state at the given commit.
   *
   * Snapshot commits load directly. Delta commits walk back through
   * `previous_commit_hashes` to the nearest snapshot and replay the deltas
   * forward. The walk is bounded by the commit strategy's snapshot cadence:
   * merge commits and every Nth commit are full snapshots.
   *
   * Commits are fetched from the locally integrated DHT store; if part of
   * the chain hasn't gossiped to us yet this throws after the underlying
   * store's retries, and the caller is expected to converge through the
   * session sync paths instead.
   */
  async resolveCommitState(
    commit: EntryRecord<Commit>
  ): Promise<Automerge.Doc<unknown>> {
    const deltas: Uint8Array[] = [];
    let current = commit;
    for (;;) {
      const payload = decodeCommitPayload(current.entry.state);
      if (payload.kind === 'snapshot') {
        let doc = Automerge.load(payload.data);
        for (const delta of deltas.reverse()) {
          doc = Automerge.loadIncremental(doc, delta);
        }
        if (deltas.length > 0) {
          // Rebuild through a save/load round-trip: incremental loads can
          // leave the doc in an internal state that makes later changes
          // panic in the wasm module (automerge#1327)
          doc = Automerge.load(Automerge.save(doc));
        }
        return doc;
      }
      deltas.push(payload.data);
      // Delta commits are only created on a linear tip: every hash in
      // previous_commit_hashes points to the same entry, so any parent works
      const parentHash = current.entry.previous_commit_hashes[0];
      if (!parentHash) {
        throw new Error('Delta commit has no previous commit');
      }
      current = await toPromise(this.commits.get(parentHash)!);
    }
  }

  async createWorkspace(
    workspaceName: string,
    initialTipHash: EntryHash | undefined
  ): Promise<WorkspaceStore<S, E>> {
    const workspace = await this.synStore.client.createWorkspace(
      {
        name: workspaceName,
        document_hash: this.documentHash,
      },
      initialTipHash
    );
    const workspaceStore = this.workspaces.get(workspace.entryHash);
    if (!workspaceStore) {
      throw new Error('Failed to create workspace store');
    }
    return workspaceStore;
  }
}

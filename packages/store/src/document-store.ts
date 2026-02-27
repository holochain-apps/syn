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
  uniquify,
} from '@holochain-open-dev/stores';
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
  allWorkspaces = pipe(
    liveLinksStore(
      this.synStore.client,
      this.documentHash,
      () => this.synStore.client.getWorkspacesForDocument(this.documentHash),
      'DocumentToWorkspaces',
      LINKS_POLL_INTERVAL_MS,
      () => this.synStore.client.getWorkspacesForDocument(this.documentHash,true),
    ),
    links =>
      slice(
        this.workspaces,
        links.map(l => l.target)
      )
  );

  /**
   * Keeps an up to date map of all the commits for this document
   */
  allCommits = pipe(
    liveLinksStore(
      this.synStore.client,
      this.documentHash,
      () => this.synStore.client.getCommitsForDocument(this.documentHash),
      'DocumentToCommits',
      LINKS_POLL_INTERVAL_MS,
      () => this.synStore.client.getCommitsForDocument(this.documentHash,true),
    ),
    links => slice(this.commits, uniquify(links.map(l => l.target)))
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

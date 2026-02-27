import {
  liveLinksStore,
  pipe,
  retryUntilSuccess,
  uniquify,
} from '@holochain-open-dev/stores';
import { Commit, Document, SynClient } from '@holochain-syn/client';
import { decode, encode } from '@msgpack/msgpack';
import * as Automerge from '@automerge/automerge'
import { slice } from '@holochain-open-dev/utils';
import { AnyDhtHash, EntryHash, LazyHoloHashMap } from '@holochain/client';

class LazyMap<K, V> {
  private map = new Map<K, V>();
  constructor(private factory: (key: K) => V) {}
  get(key: K): V {
    if (!this.map.has(key)) this.map.set(key, this.factory(key));
    return this.map.get(key)!;
  }
}

import { DocumentStore } from './document-store.js';
import { LINKS_POLL_INTERVAL_MS } from './config.js';

export const stateFromCommit = (commit: Commit) => {
  const commitState = decode(commit.state) as Uint8Array;
  const state = Automerge.load(commitState);
  return state;
};

export const stateFromDocument = (document: Document) => {
  const documentInitialState = decode(
    document.initial_state
  ) as Uint8Array;
  const state = Automerge.load(documentInitialState);
  return state;
};

export class SynStore {
  /** Public accessors */

  constructor(public client: SynClient, public localOnly = false) {}

  /**
   * Keeps an up to date array of the entry hashes for all the roots in this network
   */
  documentsByTag = new LazyMap((tag: string) =>
    pipe(
      this.tagsEntryHash.get(tag),
      tagPathEntryHash =>
        liveLinksStore(
          this.client,
          tagPathEntryHash,
          () => this.client.getDocumentsWithTag(tag, this.localOnly), // Only fetch local if specified
          'TagToDocument',
          LINKS_POLL_INTERVAL_MS,
          this.localOnly ? undefined : () => this.client.getDocumentsWithTag(tag, true), // Don't do initial local fetch if localOnly
        ),
      links => slice(this.documents, uniquify(links.map(l => l.target)))
    )
  );

  private tagsEntryHash = new LazyMap((tag: string) =>
    retryUntilSuccess(() => this.client.tagPathEntryHash(tag))
  );

  /**
   * Lazy map of all the documents in this network
   */
  documents = new LazyHoloHashMap<EntryHash, DocumentStore<any, any>>(
    (documentHash: AnyDhtHash) =>
      new DocumentStore<any, any>(this, documentHash)
  );

  async createDocument<S extends Record<string, unknown>>(initialState: S, meta?: any) {
    let doc: Automerge.Doc<any> = Automerge.from(initialState);

    const documentRecord = await this.client.createDocument({
      meta: meta ? encode(meta) : undefined,
      initial_state: encode(Automerge.save(doc)),
    });

    return this.documents.get(documentRecord.actionHash);
  }

  async createDeterministicDocument<S extends Record<string, unknown>>(initialState: S, meta?: any) {
    let doc: Automerge.Doc<any> = Automerge.init({
      actor: 'aa',
    });

    doc = Automerge.change(doc, { time: 0 }, d =>
      Object.assign(d, initialState)
    );

    const documentRecord = await this.client.createDocument({
      meta: meta ? encode(meta) : undefined,
      initial_state: encode(Automerge.save(doc)),
    });

    return this.documents.get(documentRecord.entryHash);
  }
}

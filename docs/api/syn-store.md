# SynStore

The entry point to syn. A `SynStore` wraps a `SynClient` and gives you access to every document in the network.

```ts
import { AppWebsocket } from '@holochain/client';
import { SynStore } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';

const client = await AppWebsocket.connect();
const synStore = new SynStore(new SynClient(client, 'YOUR_ROLE_NAME', 'YOUR_ZOME_NAME'));
```

## Constructor

```ts
new SynStore(client: SynClient, localOnly = false)
```

Pass `localOnly = true` to only ever read documents from the local conductor's store, skipping network fetches. Useful for offline-first UIs and tests.

## `client`

The underlying [`SynClient`](https://github.com/holochain-apps/syn/blob/main/packages/client/src/client.ts). Use it for the zome calls that the stores don't wrap, such as tagging:

```ts
await synStore.client.tagDocument(documentStore.documentHash, 'active');
await synStore.client.removeDocumentTag(documentStore.documentHash, 'active');
```

## `createDocument(initialState, meta?)`

```ts
createDocument<S extends Record<string, unknown>>(
  initialState: S,
  meta?: any
): Promise<DocumentStore<S, E>>
```

Creates a new document whose Automerge state starts as `initialState`, and returns the `DocumentStore` for it. `meta` is an arbitrary object stored alongside the document.

Note that a freshly created document has no workspaces yet — call `documentStore.createWorkspace('main', undefined)` before you can join a session.

## `createDeterministicDocument(initialState, meta?)`

Same as `createDocument`, but the resulting entry is a pure function of `initialState`: the Automerge actor id and change timestamp are fixed. Two agents that create the same deterministic document independently produce the same entry, which the DHT deduplicates — so it is identified by its entry hash rather than its action hash. Use this when a document's identity should follow from its content (a well-known "home" document, a document derived from an app identifier) rather than from who happened to create it first.

## `documents`

A lazy map from document hash to `DocumentStore`. Entries are constructed on demand, so getting one never fails and never hits the network by itself:

```ts
const documentStore = synStore.documents.get(documentHash);
```

## `documentsByTag`

A lazy map from tag to an `AsyncReadable` of all the documents carrying that tag. It polls the DHT for new links, so it stays live as other agents publish documents:

```ts
import { toPromise } from '@holochain-open-dev/stores';

// as a store
synStore.documentsByTag.get('active').subscribe(documents => {
  if (documents.status === 'complete') {
    console.log('active documents: ', documents.value);
  }
});

// or once
const documents = await toPromise(synStore.documentsByTag.get('active'));
```

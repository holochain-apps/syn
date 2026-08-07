# @holochain-syn/client

A thin wrapper around the `syn` zome: one method per zome function, plus the wire types.

Most applications don't use this package directly — they construct a `SynClient` and hand it to a [`SynStore`](https://npmjs.com/package/@holochain-syn/store), which is where the actual engine lives. Reach for the client directly when you want a zome call the stores don't wrap, such as tagging documents.

## Installing

```bash
npm install @holochain-syn/client
```

The minor version encodes the Holochain version a release targets: `0.700.x` targets Holochain `0.7.0`, `0.603.x` targets Holochain `0.6.3`. The two lines cannot share a network.

## Usage

```ts
import { AppWebsocket } from '@holochain/client';
import { SynClient } from '@holochain-syn/client';

const appClient = await AppWebsocket.connect();

// (client, roleName, zomeName) — zomeName defaults to 'syn'
const synClient = new SynClient(appClient, 'YOUR_ROLE_NAME', 'syn');
```

`SynClient` extends `ZomeClient` from [@holochain-open-dev/utils](https://npmjs.com/package/@holochain-open-dev/utils), so signals are subscribed to rather than passed to the constructor:

```ts
const unsubscribe = synClient.onSignal(signal => {
  // SynSignal
});
```

### Documents

```ts
const documentRecord = await synClient.createDocument({
  initial_state: encodedAutomergeBytes,
  meta: undefined,
  // A random nonce keeps otherwise-identical documents distinct; pass
  // undefined for a deterministic document that should converge on a
  // single entry hash
  nonce: crypto.getRandomValues(new Uint8Array(32)),
});

const document = await synClient.getDocument(documentHash);
const authors = await synClient.getAuthorsForDocument(documentHash);
```

A document's canonical identity is the entry hash of its `Document` entry.

Documents are discovered by tag:

```ts
await synClient.tagDocument(documentHash, 'active');
const links = await synClient.getDocumentsWithTag('active'); // Array<Link>
await synClient.removeDocumentTag(documentHash, 'active');
```

Note that `getDocumentsWithTag` returns links, not hashes — the document hashes are their targets. `SynStore.documentsByTag` wraps this in a live store and is usually what you want.

### Workspaces and commits

```ts
const workspace = await synClient.createWorkspace(
  { name: 'main', document_hash: documentHash },
  initialTipHash
);

const workspaces = await synClient.getWorkspacesForDocument(documentHash);

// Also links: the tip commits' action hashes are their targets. More than
// one tip means the workspace has diverged and needs a merge.
const tipLinks = await synClient.getWorkspaceTips(workspaceHash);

const commit = await synClient.createCommit({ /* Commit */ });
const commits = await synClient.getCommitsForDocument(documentHash);
```

### Session presence

```ts
await synClient.joinWorkspaceSession(workspaceHash);
await synClient.leaveWorkspaceSession(workspaceHash);
```

## Types

`Document`, `Commit`, `CommitState`, `Workspace`, `SynSignal`, and `SessionMessage` are all exported from this package. As of `0.700.0` `Commit.state` is a tagged union rather than an opaque blob:

```ts
type CommitState =
  | { kind: 'snapshot'; data: Uint8Array }
  | { kind: 'delta'; data: Uint8Array; heads: string[]; depth: number };
```

See the [store package](https://npmjs.com/package/@holochain-syn/store) for what that means in practice, and the [syn docs](https://holochain-apps.github.io/syn) for the whole picture.

# Quickstart

## Installation

::: warning
This quickstart assumes you are already familiar with Holochain hApp development. If this is your first time building a Holochain hApp you probably want to start with one of our [guides](/guides/setup)!
:::

```bash
npm install @holochain-syn/store @holochain-syn/client
```

The minor version encodes the Holochain version a release targets: `0.700.x` targets Holochain `0.7.0`, `0.603.x` targets Holochain `0.6.3`. The two lines cannot share a network — Holochain 0.7 has no data migration path.

## Initialization

You can initialize a new document like this:

```ts
import { AppWebsocket } from '@holochain/client';
import { SynStore } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';

const client = await AppWebsocket.connect();

// 'YOUR_ROLE_NAME' is the role syn's DNA is installed under in your hApp;
// the zome name defaults to 'syn'
const synStore = new SynStore(new SynClient(client, 'YOUR_ROLE_NAME', 'YOUR_ZOME_NAME'));

// Create a new document
const documentStore = await synStore.createDocument(
  // Initial state of the document
  { applicationDefinedField: 'somevalue' },
  // This is an optional object to be able to store arbitrary information in the document
  { meta: 'value' }
);

// Tag the document as "active" to allow other peers to discover it
await synStore.client.tagDocument(documentStore.documentHash, 'active');

// Create the workspace for the document
const workspaceStore = await documentStore.createWorkspace(
  'main',
  // Commit hash that will act as the initial tip for the workspace
  // Passing undefined means the workspace will be initialized with the document's initial state
  undefined
);
```

At this point, no synchronization is happening yet. This is because you haven't joined the session for the newly created workspace. Let's join the session:

```ts
const sessionStore = await workspaceStore.joinSession();
```

If you want another peer to discover that document and join the same session, you can do this:

```ts
import { EntryHash } from '@holochain/client';
import { DocumentStore, WorkspaceStore } from '@holochain-syn/store';
import { toPromise } from '@holochain-open-dev/stores';

// Fetch all the documents tagged "active"
const documents: ReadonlyMap<EntryHash, DocumentStore<any, any>> =
  await toPromise(synStore.documentsByTag.get('active'));

// Take the first one
const documentStore = Array.from(documents.values())[0];

// Fetch all workspaces for that document
const workspaces: ReadonlyMap<EntryHash, WorkspaceStore<any, any>> =
  await toPromise(documentStore.allWorkspaces);

// Find the workspace
const workspaceStore = Array.from(workspaces.values())[0];

// Join the session for the workspace
const sessionStore = await workspaceStore.joinSession();
```

## State and state changes

Now you are connected to all the peers in that same workspace, and can subscribe to the current state for the workspace and also request changes to the state:

```ts
sessionStore.state.subscribe(state => console.log('New State!', state));

// The input for the function needs to be a function that mutates the given javascript object state
sessionStore.change(state => {
  state.applicationDefinedField = 'Updated content!';
});
```

Alternatively, you can also get information about the current state of the workspace without joining the session:

```ts
workspaceStore.tip.subscribe(tip => {
  if (tip.status === 'complete') { // "status" can also be "pending" or "error"
    console.log('current tip of the workspace: ', tip);
  }
});

workspaceStore.latestSnapshot.subscribe(latestSnapshot => {
  if (latestSnapshot.status === 'complete') { // "status" can also be "pending" or "error"
    console.log('current state of the workspace: ', latestSnapshot);
  }
});

workspaceStore.sessionParticipants.subscribe(participants => {
  if (participants.status === 'complete') { // "status" can also be "pending" or "error"
    console.log('current participants of the workspace session: ', participants);
  }
});
```

This is useful to display information about the current state of the workspace without having to join the session.

## Leaving the session

When you are done with those changes, you need to explicitly leave the session:

```ts
await sessionStore.leaveSession();
```

If you don't, all other participants in the session will try to keep synchronizing with you.

## Committing

Changes are committed every 10 seconds or every 30 deltas by default, whichever comes first, and also when the last participant for the workspace leaves. You can also commit the changes manually:

```ts
await sessionStore.commitChanges(
  // This is an optional object to be able to store arbitrary information in the commit
  { applicationDefinedField: 'somevalue' }
);
```

Most commits only carry the Automerge changes since their parent. Every 20 commits — and for the first commit of a document, and for every merge commit — syn writes a full snapshot instead, so that reconstructing state never has to walk more than that many deltas back. All of this is configurable when you join a session:

```ts
const sessionStore = await workspaceStore.joinSession({
  commitStrategy: {
    CommitEveryNMs: 10 * 1000,
    CommitEveryNDeltas: 30,
    SnapshotEveryNCommits: 20,
  },
});
```

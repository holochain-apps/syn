# @holochain-syn/store

Reactive store that holds the state for the `syn` Holochain zome.

## High-level design

These are the high level concepts that `syn` implements:

- Each network that includes `syn` can manage multiple `document`s.
- Each `document` is identified by its root commit hash.
- Each `document` has multiple `workspaces` which can evolve independently of each other, and also fork and merge (eg. "main", "proposal"). 
- Each `workspace` has a latest "tip" commit, which represents the latest snapshot of the state of the document in that workspace.
- Finally, each `workspace` has a `session`, which you can join to edit the state of the workspace collaboratively with other agents.

And at the level of code, these concepts translate to these classes:

- `SynStore`: to create and fetch the documents in this network.
- `DocumentStore`: to create and fetch the workspaces for the given document, and also its commits.
- `WorkspaceStore`: to fetch the latest snaphshot and also the previous commits for the given workspace.
- `SessionStore`: to edit the state of the given workspace in a real-time collaborative session.

## Initialization

You can initialize a new document like this:

```ts
import { AppWebsocket, AppWebsocket } from '@holochain/client';
import { SynStore, DocumentStore, WorkspaceStore } from '@holochain-syn/store';
import { SynClient } from '@holochain-syn/client';

const appWs = await AppWebsocket.connect(url);
const client = await AppWebsocket.connect(appWs, 'YOUR_APP_ID')

const synStore = new SynStore(new SynClient(client, 'YOUR_ROLE_NAME', 'YOUR_ZOME_NAME'));

// Create a new document
const documentStore = await synStore.createDocument(
  // Initial state of the document
  { applicationDefinedField: 'somevalue' },
  // This is an optional object to be able to store arbitrary information in the commit
  { meta: 'value'}
);
// Tag the document as "active" to allow other peers to discover it
await synStore.client.tagDocument(documentHash, "active")

// Create the workspace for the document
const workspaceStore = new documentStore.createWorkspace(
  'main',
  // Commit hash that will act as the initial tip for the workspace
  // Passing undefined means the workspace will be initialized with the document's initial state
  undefined
);
```

At this point, no synchronization is happening yet. This is because you haven't joined the session for the newly created workspace. Let's join the session:

```ts
const sessionStore: SessionStore = await sessionStore.joinSession();
```

If you want another peer to discover that document and join the same session, you can do this:

```ts
import { AnyDhtHash } from '@holochain/client'
import { Commit } from '@holochain-syn/client';
import { EntryRecord, EntryHashMap } from '@holochain-open-dev/utils';
import { DocumentStore, WorkspaceStore } from '@holochain-syn/store';
import { toPromise, joinAsyncMap, pipe } from '@holochain-open-dev/stores';

// Fetch all the active documents
const documentsHashes: Array<AnyDhtHash> = await synStore.client.getDocumentsWithTag("active");

// Build the documentStore for the document with the first document
const documentStore = synStore.documents.get(documentsHashes[0]);

// Fetch all workspaces for that document
const workspaces: ReadonlyMap<EntryHash, WorkspaceStore> = await toPromise(documentStore.allWorkspaces);

// Find the workspace
const workspaceStore = Array.from(workspaces.entries())[0];

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

Changes are committed every 10 seconds by default, and also when the last participant for the workspaces leaves the workspace. You can also commit the changes manually:

```ts
await sessionStore.commitChanges(
    // This is an optional object to be able to store arbitrary information in the commit
  { applicationDefinedField: 'somevalue'} 
);
```

## Migration notes (0.601.x → this release)

Breaking or behavior-affecting changes for existing callers:

- **`SynConfig`**: the misspelled `hearbeatInterval` was renamed to
  `heartbeatInterval` (a caller still passing the old key silently gets
  the default — there is no type error through `RecursivePartial`), and
  `enableHeartbeatInterval` was removed. `CommitStrategy` gained a
  required `SnapshotEveryNCommits` (default 20), so code constructing a
  full `CommitStrategy` object must add it; `joinSession(config)` callers
  passing partial configs are unaffected. New optional tuning fields:
  `viewSettlingWindow`, `commitStaggerWindow`, `ghostSignalTimeout`.
- **`state` and `latestSnapshot` serve plain snapshots** (`Automerge.toJS`
  output), not Automerge documents. Reads are unchanged; passing the
  values into Automerge APIs now fails. Consumers needing automerge
  object identity (e.g. cursor element ids) use the new read-only
  `docState` on `SliceStore`. See `docs/automerge-memory.md` for why.
- **Delta commits are a one-way format change**: clients older than this
  release read every commit as a bare snapshot binary and fail on the
  first delta commit written to a shared DHT. Upgrade all clients of a
  shared network before relying on delta commits.
- **`leaveSession` invalidates the store**: it releases the session's
  wasm documents; unmount `docState` consumers before calling it.

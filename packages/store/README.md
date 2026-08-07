# @holochain-syn/store

The syn engine: reactive stores over the `syn` Holochain zome that give you a real-time collaborative document, backed by [Automerge](https://automerge.org).

You mutate a plain JavaScript object; syn synchronizes it with every other agent in the session and periodically commits it to the DHT.

## Installing

```bash
npm install @holochain-syn/store @holochain-syn/client
```

The minor version encodes the Holochain version a release targets: `0.700.x` targets Holochain `0.7.0`, `0.603.x` targets Holochain `0.6.3`. The two lines cannot share a network — Holochain 0.7 has no data migration path.

Syn depends on Automerge, which is a WebAssembly module. Bundlers generally need to be told about that; for Vite, add [`vite-plugin-wasm`](https://npmjs.com/package/vite-plugin-wasm) to your dev dependencies and register it in `vite.config.ts`.

## High-level design

- Each network that includes `syn` can manage multiple `document`s.
- Each `document` holds an Automerge document as its state, and is identified by the entry hash of the `Document` entry that created it. Documents can be tagged (eg. "active") so other agents can discover them.
- Each `document` has multiple `workspaces` which can evolve independently, and also fork and merge (eg. "main", "proposal").
- Each `workspace` has one or more latest "tip" `commit`s. More than one tip means the workspace diverged and the tips need merging.
- Finally, each `workspace` has a `session`, which you join to edit the state collaboratively with other agents.

At the level of code:

- `SynStore`: create and fetch the documents in this network.
- `DocumentStore`: create and fetch the workspaces for a document, and its commits.
- `WorkspaceStore`: fetch the latest state and previous commits for a workspace, and merge divergent tips.
- `SessionStore`: edit the state of a workspace in a real-time collaborative session.

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

`state` gives you a plain snapshot (`Automerge.toJS` output), which is what you want for rendering. If you need Automerge object identity — element ids for cursor positions, say — read the live document through `docState` instead, which is strictly read-only. See [the Automerge memory model](https://holochain-apps.github.io/syn/automerge-memory) for why the distinction matters.

## Ephemeral state

A session carries a second Automerge document alongside the committed state: the **ephemeral** state. It syncs between participants exactly like the main state, but is never written to the DHT and disappears when the session ends. Cursor positions, selections, "who is looking at what" — anything that should be live but not durable — belongs here.

Both documents are typed on the store, `SessionStore<S, E>`, and `change` hands you both:

```ts
const sessionStore: SessionStore<DocumentState, CursorState> =
  await workspaceStore.joinSession();

sessionStore.ephemeral.subscribe(cursors => renderCursors(cursors));

sessionStore.change((state, ephemeral) => {
  ephemeral[myAgentKeyB64] = { position: 42 };
});
```

If a component only cares about part of the state, `extractSlice` narrows both documents at once and gives back something with the same interface, so the component never needs to know it isn't holding a whole session:

```ts
import { extractSlice } from '@holochain-syn/store';

const bodySlice = extractSlice(
  sessionStore,
  state => state.body,
  ephemeral => ephemeral
);
```

## Reading a workspace without joining

You can also get information about the current state of the workspace without joining the session:

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

If you don't, all other participants in the session will try to keep synchronizing with you. `leaveSession` also releases the session's Automerge documents, so unmount anything reading `docState` before calling it.

## Committing

Changes are committed every 10 seconds or every 30 deltas by default, whichever comes first, and also when the last participant for the workspace leaves. You can also commit manually:

```ts
await sessionStore.commitChanges(
  // This is an optional object to be able to store arbitrary information in the commit
  { applicationDefinedField: 'somevalue' }
);
```

Most commits carry only the Automerge changes since their parent. Every 20 commits — and for a document's first commit, and for every merge commit — syn writes a full snapshot instead, bounding how far state reconstruction ever has to walk back. All of it is configurable when you join:

```ts
const sessionStore = await workspaceStore.joinSession({
  commitStrategy: {
    CommitEveryNMs: 10 * 1000,
    CommitEveryNDeltas: 30,
    SnapshotEveryNCommits: 20,
  },
});
```

Within a session, participants derive a **leadership rank** from the participant list — all of them computing it the same way — and rank 0 does the committing, so the workspace doesn't fill with one redundant entry per participant. Higher ranks take over in staggered windows if changes stay uncommitted, which covers the leader disappearing mid-session. Merge commits are exempt: they are derived entirely from the tips being merged, so two agents merging the same tips produce byte-identical entries that the DHT deduplicates.

## Migration notes (0.603.x → 0.700.0)

**Another fully breaking release, and this time the break is wider than the
DNA.** Holochain 0.7 has no data migration path at all: a 0.7 conductor
cannot read a 0.6 database, and 0.6 and 0.7 agents form disjoint networks.
Every user and dev environment needs its conductor state cleared (`hc
sandbox clean`, or a fresh profile directory) — this is by design upstream,
not something syn can paper over.

Toolchain: holochain **0.7.0** (hdk 0.7.0 / hdi 0.8.0), `@holochain/client`
`^0.21.0`, `@holochain-open-dev/*` `^0.700.0`. As on 0.603.0, the ranges are
permissive and nothing in the published chain is hard-pinned: npm dedupes to
a single `@holochain/client` copy with no `overrides` block.

API and wire changes for existing callers:

- **`Commit.state` is a tagged `CommitState`**, not an opaque msgpack
  envelope: `{ kind: 'snapshot', data }` or `{ kind: 'delta', data, heads,
  depth }`. The separate commit-payload envelope module is gone, and code
  that decoded it by hand should read `commit.entry.state` directly.
  `Commit.witnesses` was dropped.
- **`Document` gained an optional `nonce`** and its canonical identity is
  the **entry hash**. Ordinary `createDocument` calls get random 32-byte
  nonces so otherwise-identical documents stay distinct; deterministic
  documents omit the nonce and still converge on one entry hash.
- **Validation is stricter**, so malformed input now fails the commit
  instead of landing: syn entries are immutable (updates and deletes are
  invalid), delta `depth` must be the parent's plus one, participant links
  are self-create/self-delete only, and workspace tip tags must parse.
  Missing dependencies still surface as retryable errors rather than
  invalidity.
- **Raw record access moved**: in client 0.21 the common action fields live
  under `action.header` (`author`, `timestamp`, …) and variant fields under
  `action.data`. Only code touching records directly is affected — the store
  and element APIs are unchanged.

## Migration notes (0.601.x → 0.603.0)

**This is a fully breaking release with a new DNA.** Rebuilding the syn
zomes against holochain 0.6.3 (hdk 0.6.3 / hdi 0.7.3) changes the
integrity wasm and therefore the **DNA hash** — verified, same zome
source under hdk 0.6.0 vs 0.6.3 yields two different hashes. A different
DNA hash is a different DHT: existing networks and the data in them are
not migrated, not readable from the new DNA, and not corrupted either —
they simply stay where they are, reachable only by the old version.

Consequences, all deliberate:

- **Ship a full version bump of your UI together with the new DNA.**
  There is no supported path that upgrades the client packages while
  keeping an existing DNA, and no in-place migration of existing DHT
  data. Plan a fresh network (or an application-level export/import) for
  content you need to carry over.
- Old and new clients can never meet on the same DHT, so the delta-commit
  format change below cannot strand an old client mid-network.

The minor encodes the holochain version this release is built and tested
against: **holochain 0.6.3**. There is no 0.602.x — we never shipped
against holochain 0.6.2.

Dependency ranges are deliberately permissive: `@holochain/client` is
`^0.20.5`, so anything from 0.20.5 through the 0.20 line (0.20.8 is what
CI tests against) resolves to a single copy. Nothing in the published
dependency chain is hard-pinned.

API changes for existing callers:

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
- **Delta commits are a one-way format change**: clients older than
  0.603.0 read every commit as a bare snapshot binary and cannot
  interpret a delta commit. This release's new DNA hash keeps old and
  new clients on separate networks, so it only matters if you
  deliberately reuse commit data across versions.
- **`leaveSession` invalidates the store**: it releases the session's
  wasm documents; unmount `docState` consumers before calling it.


## High-level design

These are the high level concepts that `syn` implements:

- Each network that includes `syn` can manage multiple `document`s.
- Each `document` holds an [Automerge](https://automerge.org) document as its state, and is identified by the **entry hash** of its `Document` entry. Ordinary documents carry a random nonce so that otherwise-identical content stays distinct; deterministic documents omit it, which lets several agents create "the same" document independently and converge on one entry. Documents can be tagged (eg. "active") so that other agents can discover them.
- Each `document` has multiple `workspaces` which can evolve independently of each other, and also fork and merge (eg. "main", "proposal").
- Each `workspace` has one or more latest "tip" `commit`s. More than one tip means the workspace has diverged and the tips need merging.
- Finally, each `workspace` has a `session`, which you can join to edit the state of the workspace collaboratively with other agents.

And at the level of code, these concepts translate to these classes:

- [`SynStore`](/api/syn-store): to create and fetch the documents in this network.
- `DocumentStore`: to create and fetch the workspaces for the given document, and also its commits.
- `WorkspaceStore`: to fetch the latest snaphshot and also the previous commits for the given workspace.
- `SessionStore`: to edit the state of the given workspace in a real-time collaborative session.

## Sessions

Within a session, agents exchange Automerge changes directly over remote signals, so every participant converges on the same state without any of them being authoritative. Membership is tracked by links in the DHT (which prove that an agent joined) combined with a heartbeat signal (which proves it is still alive), so an agent that crashes without leaving eventually drops out of the participant list.

Writing commits to the DHT, on the other hand, should be done by one agent at a time — otherwise every participant writes the same state and the workspace fills with redundant entries. Participants therefore derive a **leadership rank** from the participant list, which all of them compute the same way. Rank 0 does the committing; higher ranks take over in staggered windows if the changes stay uncommitted, which covers the leader going away mid-session. A rank is only exercised once the participant view has been stable for a settling window, so that a partition or a burst of rejoins doesn't elect several leaders at once.

## Ephemeral state

A session actually carries two Automerge documents. The first is the state that gets committed. The second is **ephemeral state**: it syncs between participants over the same signals, but is never written to the DHT and is gone once the session ends.

That split is what makes good collaborative UX possible without polluting the document's history. Cursor positions, text selections, "Alice is looking at this card" — all of it is worth broadcasting live and worthless a minute later. Committing it would mean a DHT write per keystroke.

Both documents are reflected in the store's type, `SessionStore<S, E>`, and `change` gives you both at once, so an edit and the cursor move that accompanies it are one atomic change:

```ts
sessionStore.change((state, ephemeral) => {
  state.text.splice(position, 0, character);
  ephemeral[myAgentKeyB64] = { position: position + 1 };
});
```

Components rarely want the whole document. `extractSlice` narrows the state and the ephemeral state together and returns something with the same interface, so a component that edits one field can be handed a slice and never know the difference.

## Commits

A commit records the state of a workspace at a point in time. Most commits are **deltas**: they carry only the Automerge changes since their parent commit, plus that parent's heads and how many deltas deep the commit is. Periodically — for the first commit of a document, for every merge commit, and after a configurable number of consecutive deltas — syn writes a full **snapshot** instead. Reconstructing the state of any commit is then a matter of walking back to the nearest snapshot ancestor and replaying the deltas forward, which the snapshot interval bounds.

Merge commits are derived entirely from the tips they merge — sorted parents, the union of the tips' authors, a canonical merge order — so two agents that independently merge the same tips produce byte-identical entries, which the DHT deduplicates by content hash. That means merging doesn't need a leader at all.

## Memory

Automerge documents are WASM-backed handles that JavaScript's garbage collector doesn't reclaim, so syn is explicit about their lifetimes. See [the Automerge memory model](/automerge-memory) for what that means if you hold on to state yourself.

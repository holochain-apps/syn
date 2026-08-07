
## High-level design

These are the high level concepts that `syn` implements:

- Each network that includes `syn` can manage multiple `document`s.
- Each `document` holds an [Automerge](https://automerge.org) document as its state, and is identified by the hash of the `Document` record that created it (the action hash for an ordinary document, the entry hash for a deterministic one, which lets several agents arrive at the same document independently). Documents can be tagged (eg. "active") so that other agents can discover them.
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

## Commits

A commit records the state of a workspace at a point in time. Most commits are **deltas**: they carry only the Automerge changes since their parent commit, plus that parent's heads and how many deltas deep the commit is. Periodically — for the first commit of a document, for every merge commit, and after a configurable number of consecutive deltas — syn writes a full **snapshot** instead. Reconstructing the state of any commit is then a matter of walking back to the nearest snapshot ancestor and replaying the deltas forward, which the snapshot interval bounds.

Merge commits are derived entirely from the tips they merge — sorted parents, the union of the tips' authors, a canonical merge order — so two agents that independently merge the same tips produce byte-identical entries, which the DHT deduplicates by content hash. That means merging doesn't need a leader at all.

## Memory

Automerge documents are WASM-backed handles that JavaScript's garbage collector doesn't reclaim, so syn is explicit about their lifetimes. See [the Automerge memory model](/automerge-memory) for what that means if you hold on to state yourself.

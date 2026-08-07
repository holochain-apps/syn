# Building an app with ephemeral state

Some of what makes a collaborative app feel alive should never be saved. Where someone's cursor is, what they have selected, which card they are dragging, whether they are typing — all of it matters right now and is noise ten seconds later.

Syn gives every session a second Automerge document for exactly this. It syncs between participants over the same signals as the committed state, and it is never written to the DHT. When the session ends, it is gone.

This guide assumes you have been through [the setup guide](/guides/setup).

## The two documents

A session store is typed `SessionStore<S, E>`: `S` is the state that gets committed, `E` is the ephemeral state that doesn't.

```ts
interface BoardState {
  cards: { [id: string]: { title: string; column: string } };
}

interface BoardPresence {
  // keyed by agent pub key, base64
  [agentB64: string]: { hoveringCard: string | undefined };
}

const sessionStore: SessionStore<BoardState, BoardPresence> =
  await workspaceStore.joinSession();
```

Nothing about `E` is special to syn — it is whatever shape you want, subject to the same merge semantics as any Automerge document. Keying it by agent is the usual pattern, because it means two participants updating their own presence never conflict.

## Reading and writing it

`change` hands you both documents, so an edit and the presence update that goes with it are a single atomic change:

```ts
import { encodeHashToBase64 } from '@holochain/client';

const me = encodeHashToBase64(sessionStore.myPubKey);

sessionStore.change((state, ephemeral) => {
  state.cards[cardId].column = 'done';
  ephemeral[me] = { hoveringCard: undefined };
});
```

Presence-only updates are the same call with the state left alone:

```ts
sessionStore.change((_state, ephemeral) => {
  ephemeral[me] = { hoveringCard: cardId };
});
```

Subscribe to it like any other store:

```ts
sessionStore.ephemeral.subscribe(presence => {
  for (const [agent, { hoveringCard }] of Object.entries(presence)) {
    highlight(hoveringCard, agent);
  }
});
```

## Don't commit it, and don't try

There is no API to commit ephemeral state, deliberately. If something turns out to belong in the permanent record — a comment, a completed drag — move it into `S` in the same `change` call that clears it from `E`. That way there is never a moment where it exists in both or neither.

The reverse mistake is more common: putting live UI state in `S` because it is easier to reach. Every keystroke of it becomes DHT traffic and shows up in the commit history forever.

## Cleaning up after departed agents

Ephemeral state is a plain document, so an agent that leaves without tidying up leaves its entry behind for the rest of the session. Two approaches, both fine:

**Render defensively.** Cross-reference against the live participant list and ignore entries for agents who aren't there. `sessionStore.participants` is a store of `{ active, idle, offline }`, each an array of agent keys:

```ts
import { encodeHashToBase64 } from '@holochain/client';
import { get } from '@holochain-open-dev/stores';

const { active, idle } = get(sessionStore.participants);
const here = new Set([...active, ...idle].map(encodeHashToBase64));

const live = Object.entries(presence).filter(([agentB64]) => here.has(agentB64));
```

**Clear on the way out.** Drop your own entry before leaving:

```ts
sessionStore.change((_state, ephemeral) => {
  delete ephemeral[me];
});
await sessionStore.leaveSession();
```

Do both if the state is expensive to render. Neither is required for correctness — the whole document disappears when the session does.

## Slicing it

Components usually want one part of the state and one part of the presence. `extractSlice` narrows both at once and returns something with the same interface, so a component can be handed a slice and never learn it isn't holding a whole session:

```ts
import { extractSlice } from '@holochain-syn/store';

const columnSlice = extractSlice(
  sessionStore,
  state => state.cards,
  ephemeral => ephemeral
);
```

This is exactly how [`<syn-markdown-editor>`](/guides/building-app-with-text-editors) works: it is written against a slice of text state plus cursor state, and doesn't care whether that is the entire document or one field of a much larger one.

## A note on Automerge identity

If your ephemeral state refers to positions inside the committed state — a cursor sitting between two characters, say — you can't store an index. Indices shift under concurrent edits, which is the whole problem CRDTs exist to solve.

Store an Automerge object id instead, resolved from the live document:

```ts
const elementId = Automerge.getObjectId(state.text, position);
```

Reading the live document means `docState`, not `state`. `state` is a materialized snapshot, which is the right thing for rendering and useless for identity. `docState` is strictly read-only — never pass it to `Automerge.change`. See [the Automerge memory model](/automerge-memory) for the full picture.

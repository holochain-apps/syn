# Building a simple kanban board app

The text editor guide uses syn's prebuilt grammar and element. This one is the other case: an app whose data model is entirely your own. A kanban board is a good example because it has structure — columns, cards, ordering — and because concurrent edits to it are genuinely interesting.

This guide assumes you have been through [the setup guide](/guides/setup).

## Modeling the board

Syn state is a plain JavaScript object, so the model is just a type:

```ts
interface Card {
  title: string;
  description: string;
}

interface BoardState {
  name: string;
  columns: string[];                      // ordered
  cards: { [id: string]: Card };          // keyed, unordered
  columnCards: { [column: string]: string[] };  // ordered card ids per column
}

const initialState = (): BoardState => ({
  name: 'Untitled board',
  columns: ['todo', 'doing', 'done'],
  cards: {},
  columnCards: { todo: [], doing: [], done: [] },
});
```

The shape here isn't arbitrary. Cards live in a map keyed by id, and their *placement* lives in separate ordered arrays. If you instead nested each card object directly in a column array, then two people moving the same card to different columns would produce two copies of it. Keeping identity (the map) separate from arrangement (the arrays) means a concurrent move resolves to one card in one column, which is what a person would expect.

That is the general rule for modeling syn state: **give anything with an identity a stable key, and describe position by reference.**

## Creating the board

```ts
import { SynStore, SynClient } from '@holochain-syn/core';
import { AppWebsocket } from '@holochain/client';

const synStore = new SynStore(new SynClient(await AppWebsocket.connect(), 'syn-test'));

const documentStore = await synStore.createDocument(initialState());
await synStore.client.tagDocument(documentStore.documentHash, 'board');

const workspaceStore = await documentStore.createWorkspace('main', undefined);
const sessionStore = await workspaceStore.joinSession();
```

Tags are how other agents find the board. Use a tag per kind of document (`'board'` here) rather than one `'active'` bucket for everything, so a client can list only what it can render.

Other agents then find it:

```ts
import { toPromise } from '@holochain-open-dev/stores';

const boards = await toPromise(synStore.documentsByTag.get('board'));
```

## Editing

Every mutation is a mutation:

```ts
function addCard(column: string, title: string) {
  const id = crypto.randomUUID();
  sessionStore.change(state => {
    state.cards[id] = { title, description: '' };
    state.columnCards[column].push(id);
  });
}

function moveCard(id: string, from: string, to: string, index: number) {
  sessionStore.change(state => {
    const i = state.columnCards[from].indexOf(id);
    if (i >= 0) state.columnCards[from].splice(i, 1);
    state.columnCards[to].splice(index, 0, id);
  });
}
```

Two things worth noticing. First, there is no request/response — `change` is synchronous and local, and syn propagates it. Second, everything inside one `change` callback is one atomic change: removing the card from one column and adding it to another can't be observed half-done by anyone.

Rendering is an ordinary subscription:

```ts
sessionStore.state.subscribe(state => {
  render(state.columns.map(c => ({
    column: c,
    cards: state.columnCards[c].map(id => state.cards[id]),
  })));
});
```

## Showing who is doing what

Card drags and hover highlights belong in the session's ephemeral state, which syncs live and is never committed:

```ts
sessionStore.change((_state, ephemeral) => {
  ephemeral[myAgentB64] = { draggingCard: id };
});
```

See [building an app with ephemeral state](/guides/building-an-ephemeral-state-app) for the details.

## Proposals, as workspaces

A board doesn't have to have one timeline. Workspaces fork from a commit and evolve independently — useful for a "what if we reorganised the sprint" version that nobody sees until it's ready:

```ts
const tips = await workspaceStore.getCurrentTips();
const proposal = await documentStore.createWorkspace('sprint-reshuffle', tips[0]);
```

Agents join `proposal`'s session and edit it without touching `main`. When it's agreed on, merge the two tips:

```ts
const groups = await mainWorkspace.getCurrentTipGroups();
if (groups.length > 1) {
  await mainWorkspace.merge(groups.map(g => g[0]));
}
```

`getCurrentTipGroups` groups tips that are the same commit reached by different paths, so `groups.length > 1` is the real test for "has this diverged" — a plain tip count over-reports. The merge itself is derived entirely from the tips being merged, so if two agents merge the same divergence at the same time they produce identical entries and the DHT keeps one.

## Committing

Syn commits on its own every 10 seconds or 30 changes. Commit by hand at moments that mean something:

```ts
await sessionStore.commitChanges({ label: 'Sprint 4 planned' });
```

The `meta` object you pass is stored with the commit, so a history view can label it. `<commit-history>` from `@holochain-syn/core` renders the commit graph if you want that for free.

## Leaving

```ts
await sessionStore.leaveSession();
```

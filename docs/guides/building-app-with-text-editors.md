# Building an app with text editors

Collaborative text is the shortest path from "syn is installed" to "two browser windows are editing the same thing." This guide builds up the document that [the SynText demo](https://github.com/holochain-apps/syn/tree/main/demo) uses: a title plus a body, where the body is a shared text editor with live remote cursors.

It assumes you have been through [the setup guide](/guides/setup).

```bash
npm install @holochain-syn/core @holochain-syn/text-editor
```

## The document shape

Syn documents are plain JavaScript objects. The text editor contributes one field's worth of shape, and you decide where it sits:

```ts
import { textEditorGrammar, TextEditorState } from '@holochain-syn/text-editor';

interface DocumentState {
  title: string;
  body: TextEditorState;   // { text: string[] }
}

const initialState = (): DocumentState => ({
  title: '',
  body: textEditorGrammar.initialState(),
});
```

`textEditorGrammar` is not a plugin system — it is a handful of helpers over an Automerge document. There is no delta type to declare and no `applyDelta` to write. Text is stored as an array of characters because that is what lets Automerge merge two people typing in the same paragraph without either one clobbering the other.

## Creating the document

```ts
import { SynStore, SynClient } from '@holochain-syn/core';
import { AppWebsocket } from '@holochain/client';

const synStore = new SynStore(new SynClient(await AppWebsocket.connect(), 'syn-test'));

const documentStore = await synStore.createDocument(initialState());
await synStore.client.tagDocument(documentStore.documentHash, 'active');

const workspaceStore = await documentStore.createWorkspace('main', undefined);
const sessionStore = await workspaceStore.joinSession();
```

Tagging the document is what makes it discoverable — without it, a second agent has no way to find the document you just made. Creating the workspace and joining its session are separate steps because a workspace is durable and a session is not: you can read a workspace's state without joining, and only joining starts real-time sync.

## Editing the title

The title is an ordinary field, so editing it is an ordinary mutation:

```ts
sessionStore.change(state => {
  state.title = 'Meeting notes';
});
```

Every other participant sees it within a signal round-trip. Nothing else is required — no request, no acknowledgement, no reconciliation.

## Wiring up the editor element

The editor element edits the *body*, not the whole document, so hand it a slice — a narrowed view with the same interface:

```ts
import { extractSlice } from '@holochain-syn/core';

const textSlice = extractSlice(
  sessionStore,
  state => state.body,
  ephemeral => ephemeral   // the editor's cursors are the whole ephemeral state here
);
```

Define the element and give it that slice:

```ts
import '@holochain-syn/core/dist/elements/syn-context.js';
import '@holochain-syn/text-editor/dist/elements/syn-markdown-editor.js';
```

```html
<syn-context>
  <syn-markdown-editor id="editor"></syn-markdown-editor>
</syn-context>
```

```ts
document.getElementById('editor').slice = textSlice;
```

That is the whole integration. The element reads the text out of the slice, writes edits back through `slice.change`, and renders every other participant's cursor from the ephemeral state — including a coloured caret that moves as they type. The cursors work because the editor reads `docState` rather than `state`: restoring a cursor position means resolving an Automerge object id, which needs the live document, not a materialized snapshot.

## Showing who else is here

```ts
import '@holochain-syn/core/dist/elements/session-participants.js';
```

```html
<session-participants></session-participants>
```

If you have a `ProfilesStore` in context, this renders names and avatars instead of raw agent keys.

## Committing

You don't have to do anything: syn commits every 10 seconds or every 30 changes, and again when the last participant leaves. Commit by hand when there is a moment worth naming:

```ts
await sessionStore.commitChanges({ label: 'Draft complete' });
```

## Leaving

```ts
await sessionStore.leaveSession();
```

Call this. It tells the other participants to stop syncing with you, and it releases the session's Automerge documents — so unmount the editor first, since it is reading `docState`.

## Try it

The demo in this repository is this guide as a working Svelte app, including profile prompts and a commit-history drawer:

```bash
npm run start
```

Three windows open. Type in one.

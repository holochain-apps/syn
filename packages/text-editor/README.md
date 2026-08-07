# @holochain-syn/text-editor

Collaborative text editing for [syn](https://holochain-apps.github.io/syn): a text grammar plus an editor element with live remote cursors.

Text can be the entire state of your syn document, or one field inside a larger document.

## Installing

```bash
npm install @holochain-syn/text-editor @holochain-syn/core
```

The minor version encodes the Holochain version a release targets: `0.700.x` targets Holochain `0.7.0`, `0.603.x` targets Holochain `0.6.3`.

## The grammar

`textEditorGrammar` is a small helper over an Automerge document. It defines two shapes:

```ts
type TextEditorState = { text: string[] };            // committed
type TextEditorEphemeralState = { [agentB64: string]: AgentSelection };  // cursors, never committed
```

and gives you `initialState()` plus `changes(myPubKey, state, ephemeral)`, which returns the edit operations. There is no `applyDelta` and no delta type to define — you mutate the state inside `sessionStore.change` and syn takes care of merging.

### As the only state in your app

```ts
import { textEditorGrammar } from '@holochain-syn/text-editor';

const documentStore = await synStore.createDocument(textEditorGrammar.initialState());
const workspaceStore = await documentStore.createWorkspace('main', undefined);
const sessionStore = await workspaceStore.joinSession();

sessionStore.change((state, ephemeral) =>
  textEditorGrammar
    .changes(sessionStore.myPubKey, state, ephemeral)
    .insert(0, 'Hello, world')
);
```

### As one field of a larger document

Nest the text state inside your own, then use `extractSlice` to hand components a view that looks exactly like a whole session:

```ts
import { extractSlice } from '@holochain-syn/store';
import { textEditorGrammar, TextEditorState } from '@holochain-syn/text-editor';

interface DocumentState {
  title: string;
  body: TextEditorState;
}

const initialState = (): DocumentState => ({
  title: '',
  body: textEditorGrammar.initialState(),
});

// A slice over just the body, with the cursors passed through
const textSlice = sessionStore =>
  extractSlice(
    sessionStore,
    state => state.body,
    ephemeral => ephemeral
  );
```

Editing the title and the body are then the same kind of operation:

```ts
sessionStore.change(state => {
  state.title = 'New title';
});
```

## The `<syn-markdown-editor>` element

1. Set up the syn context as described in [@holochain-syn/core](https://npmjs.com/package/@holochain-syn/core).

2. Define the element:

```ts
import '@holochain-syn/text-editor/dist/elements/syn-markdown-editor.js';
```

3. Include it in your html and give it a slice:

```html
<syn-context>
  <syn-markdown-editor id="text-editor"></syn-markdown-editor>
</syn-context>
```

```ts
document.getElementById('text-editor').slice = textSlice(sessionStore);
```

The element expects a `SliceStore<TextEditorState, TextEditorEphemeralState>` — a `SessionStore` typed that way works directly, and `extractSlice` produces one for a nested field. It renders every other participant's cursor from the ephemeral state, and writes your own back as you type and select.

It also accepts an `autotype` boolean, which types random text on a timer. That is a load-testing aid, not something to ship enabled.

## See also

- [@holochain-syn/store](https://npmjs.com/package/@holochain-syn/store) — the engine, including how ephemeral state works
- [@holochain-syn/core](https://npmjs.com/package/@holochain-syn/core) — contexts and elements for syn UIs
- The [SynText demo](https://github.com/holochain-apps/syn/tree/main/demo) — a working app built on exactly this

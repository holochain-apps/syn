# @holochain-syn/core

Core package to easily build `syn` Holochain applications.

## Installing

Install the necessary dependencies:

```bash
npm install @holochain-open-dev/profiles @holochain-syn/core
```

**Note:** Syn uses Automerge, which depends on WebAssembly (WASM). Some build tools and bundlers require additional configuration to properly handle WASM modules.

**For Vite users:**
Add the WASM plugin to your development dependencies in `package.json`:
```json
{
  "devDependencies": {
    "vite-plugin-wasm": "^3.5.0"
  }
}
```

Configure the plugin in your `vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
});
```

## Usage

First, you need to have instantiated a `SynStore` from [@holochain-syn/store](https://npmjs.com/package/@holochain-syn/store) and a `ProfilesStore` from [@holochain-open-dev/profiles](https://holochain-open-dev.github.io/profiles/guides/frontend/profiles-store/).

### Defining the Context Providers

```ts
// Define the <profiles-context> element
import '@holochain-open-dev/profiles/dist/elements/profiles-context.js';

// Define the <syn-context> element
import '@holochain-syn/core/dist/elements/syn-context.js';
```

Now define the `<profiles-context>` and the `<syn-context>` element and add them to your html, wrapping the whole section of your page in which you are going to be placing syn elements:

```html
<profiles-context id="profiles-context"> 
  <syn-context>
    <!-- The rest of your application goes here -->
  </syn-context>
</profiles-context>
```

### Connect the Store to the Context Providers

Go to [this page](https://holochain-open-dev.github.io/reusable-modules/frontend/frameworks/), select the framework you are using, and follow its example in order to:

- Connect the `ProfilesStore` to the `<profiles-context>` with `id="profiles-context"`.
- Connect the `SynStore` to the `<syn-context>`.

## Elements

Import each element from its `dist/elements/` path to define it:

| Element | What it does |
| --- | --- |
| `<syn-context>` | Provides the `SynStore` to everything inside it |
| `<syn-document-context>` | Provides a `DocumentStore` for a given document hash |
| `<syn-workspace-context>` | Provides a `WorkspaceStore` for a given workspace hash |
| `<syn-session-context>` | Provides a joined `SessionStore` |
| `<commit-history>` | Renders the commit graph for a document |
| `<session-participants>` | Renders the agents currently in a session |
| `<workspace-session-participants>` | Same, scoped to a workspace |

This package also re-exports everything from [@holochain-syn/store](https://npmjs.com/package/@holochain-syn/store) and [@holochain-syn/client](https://npmjs.com/package/@holochain-syn/client), so a UI can depend on `@holochain-syn/core` alone.

For a working app built on these pieces, see the [SynText demo](https://github.com/holochain-apps/syn/tree/main/demo).
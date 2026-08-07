# SynText

A [syn](https://github.com/holochain-apps/syn) sample app for collaborative text editing.

This UI is built with [Svelte](https://svelte.dev) and Vite, and uses the `<syn-text-editor>` element from [`@holochain-syn/text-editor`](../packages/text-editor/).

## Get started

Run it from the repo root, inside the `nix develop` shell. That builds the hApp and the syn libraries, then launches several agents with `hc-spin`, each with this UI attached:

```bash
npm install
npm run start
```

The demo has no standalone dev server of its own — `npm run start -w demo` expects `UI_PORT` to be set and a conductor to already be running, which is what the root script arranges.

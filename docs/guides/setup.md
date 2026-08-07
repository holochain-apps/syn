# Setting Up A Syn hApp

## Assumptions

These guides assume that:
  1.  you have little to zero Holochain experience, i.e. this may be your first Holochain app ever!
  2.  but, that you are quite familiar with JavaScript front-end development

## Installing the Holochain dev environment

The first step is to install [the Holochain developer environment](https://developer.holochain.org/get-started/). Follow it through the nix installation — syn's own toolchain comes from a flake, so you don't need a separate Holochain install.

## What a syn hApp is made of

A syn hApp has two halves:

- **The syn DNA.** You don't write this. It is the same generic zome for every syn app: it stores documents, workspaces, and commits, and routes session signals between agents. Your application's data model lives *inside* the documents it stores, not in the zome.
- **Your UI**, which talks to that DNA through the syn packages and renders whatever your document state means.

This is the part that surprises people coming from ordinary Holochain development: building a collaborative app with syn usually means writing **no Rust at all**. If your app also needs conventional persistent data — user profiles, an index of documents, permissions — that goes in your own zomes alongside syn's, as a separate role in the same hApp.

## Getting the DNA

The quickest path is to build it from this repository:

```bash
git clone https://github.com/holochain-apps/syn && cd ./syn
nix develop
npm install
npm run build:happ
```

That produces `workdir/syn-test.dna` and `workdir/syn-test.happ`. The DNA is what you add as a role in your own hApp's manifest; the packed hApp is the demo app this repo runs. Note that the DNA bundles the `profiles` zomes alongside `syn`, so the participant elements work out of the box.

Make sure the DNA you ship matches your client packages: the syn packages' minor version encodes the Holochain version they target (`0.700.x` → Holochain 0.7.0), and a DNA built against a different Holochain version has a different DNA hash, which means a different network.

## Setting up the UI

```bash
npm install @holochain-syn/core @holochain-open-dev/profiles
```

`@holochain-syn/core` re-exports the store and client packages, so it is the only syn dependency most UIs need. `@holochain-open-dev/profiles` is not strictly required, but syn's participant elements use it to put a name and a colour to the agent keys in a session.

Syn's state engine is [Automerge](https://automerge.org), which ships as WebAssembly, so your bundler needs to be told how to handle it. For Vite:

```bash
npm install --save-dev vite-plugin-wasm
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
});
```

## Connecting

```ts
import { AppWebsocket } from '@holochain/client';
import { SynStore, SynClient } from '@holochain-syn/core';

const client = await AppWebsocket.connect();
// SynClient(appClient, roleName, zomeName) — roleName is from your happ.yaml,
// zomeName defaults to 'syn' and rarely needs changing
const synStore = new SynStore(new SynClient(client, 'syn-test'));
```

From here, [the quickstart](/quickstart) walks through creating a document, opening a workspace, and joining a session.

## Running it during development

`hc-spin` launches several agents against a local conductor, each in its own window, which is how you actually see collaboration working:

```bash
hc-spin -n 3 workdir/syn-test.happ --ui-port 8888
```

This repository's own `npm run start` does exactly that for the [SynText demo](https://github.com/holochain-apps/syn/tree/main/demo), which is worth reading as a complete working example.

## Where to go next

- [Building an app with text editors](/guides/building-app-with-text-editors) — collaborative text, the shortest path to something real
- [Building an app with ephemeral state](/guides/building-an-ephemeral-state-app) — live cursors and presence that never hit the DHT

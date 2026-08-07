# syn

> Generalized DNA for building real-time shared-state hApps on holochain

Syn: Etymology. From Ancient Greek συμ- (sum-), variant of συν- (sun-), from σύν (sún, “with, in company with, together with”).

## Design

This project makes it easy to build collaborative apps in the distributed peer-to-peer context of Holochain. The shared state of a document is an [Automerge](https://automerge.org) CRDT: participants exchange changes directly over Holochain's peer-to-peer signals as they type, and periodically commit the state to the DHT, which provides durability and data integrity.

Because the CRDT does the merging, an app developer doesn't define a delta format or a function to apply one. You need only:

1. A shape for your document's state, as a plain JavaScript object
2. A renderer for it
3. User interactions that mutate it inside `sessionStore.change(...)`

Anything that should be live but not durable — cursor positions, selections, presence — goes in the session's separate *ephemeral* state, which syncs the same way but is never committed.

For more details read the [design overview](docs/design.md), read the [article](https://blog.holochain.org/decentralized-next-level-collaboration-apps-with-syn/), and check out the example app, SynText, in the [/demo](demo/) directory.

## Packages

Syn ships as four npm packages:

| Package | What it is |
| --- | --- |
| [`@holochain-syn/client`](packages/client/) | Thin zome client and wire types |
| [`@holochain-syn/store`](packages/store/) | The engine: documents, workspaces, sessions, commits |
| [`@holochain-syn/core`](packages/core/) | Lit elements and contexts for building syn UIs |
| [`@holochain-syn/text-editor`](packages/text-editor/) | Collaborative text editing element |

```bash
npm install @holochain-syn/store @holochain-syn/client
```

### Versioning

The minor version encodes the Holochain version the release targets: `0.700.x` targets Holochain `0.7.0`, `0.603.x` targets Holochain `0.6.3`.

Holochain 0.7 has no data migration path, so `0.700.x` and `0.603.x` agents cannot share a network and a 0.7 conductor cannot read a 0.6 database. Clear your conductor state (`hc sandbox clean`, or a fresh profile directory) when moving between the two.

## Development

1. Install [nix with flakes enabled](https://developer.holochain.org/get-started/).
2. Clone this repo: `git clone https://github.com/holochain-apps/syn && cd ./syn`
3. Enter the dev shell: `nix develop`.
4. Run `npm install`

## Building the DNA

Build the DNA (assumes you are still in the dev shell for correct rust/cargo versions from the step above):

```bash
npm run build:happ
```

## UI

We have provided a sample UI that implements collaborative text editing in a minimal editor. To run it:

```bash
npm run start
```

This builds the hApp, watches the libraries for changes, and launches three agents via `hc-spin`, each in its own window. Edit text in one window and you should see it appear in the others. Set `AGENTS` to change the number of agents:

```bash
AGENTS=2 npm run start
```

### Testing

```bash
npm run test
```

This rebuilds the hApp and the libraries before running the tryorama tests. To re-run the tests against an already-built hApp:

```bash
npm run test-quick
```

## Documentation

The docs site is built with VitePress from the [/docs](docs/) directory and published to <https://holochain-apps.github.io/syn>.

```bash
npm run docs:dev
```

## License

[![License: CAL 1.0](https://img.shields.io/badge/License-CAL%201.0-blue.svg)](https://github.com/holochain/cryptographic-autonomy-license)

Copyright (C) 2020-2026, Holochain Foundation

This program is free software: you can redistribute it and/or modify it under the terms of the license
provided in the LICENSE file (CAL-1.0). This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

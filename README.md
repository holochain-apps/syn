# syn

> Generalized DNA for building real-time shared-state hApps on holochain

Syn: Etymology. From Ancient Greek συμ- (sum-), variant of συν- (sun-), from σύν (sún, “with, in company with, together with”).

## Design

This project makes it easy to build collaborative apps in the distributed peer-to-peer context of Holochain. Syn uses Holochain's infrastructure for data integrity and peer-to-peer networking to store regular "commits" of the shared content's state, while coordinating batches of delta's that comprise those commits between nodes. The approach is generalized for many different use-cases, where the app-developer need only define:

1. A renderer for content state
2. A patch-grammar for applying deltas to content
3. A function to apply deltas to the content state
4. Any user interaction that should generate those deltas in the given grammar

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

The minor version encodes the Holochain version the release targets: `0.603.x` targets Holochain `0.6.3`. There is no `0.602.x` — nothing shipped against `0.6.2`.

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

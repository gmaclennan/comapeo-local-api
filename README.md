# @comapeo/local-api

[![npm version](https://img.shields.io/npm/v/@comapeo/local-api.svg)](https://www.npmjs.com/package/@comapeo/local-api)
[![CI](https://github.com/digidem/comapeo-local-api/actions/workflows/test.yml/badge.svg)](https://github.com/digidem/comapeo-local-api/actions/workflows/test.yml)
[![codecov](https://codecov.io/github/digidem/comapeo-local-api/graph/badge.svg)](https://codecov.io/github/digidem/comapeo-local-api)

Local socket API exposing CoMapeo project data to other programs on the same computer. It serves a running `MapeoManager` read-only over a Unix socket (macOS, Linux) or named pipe (Windows), so that tools such as the CoMapeo QGIS plugin can show a project's observations, tracks, categories and media. The wire contract is [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Installation

```sh
npm install @comapeo/local-api
```

`@comapeo/core` 7.5.2 or later (7.x) is a peer dependency. The manager's media server (its Fastify instance) must be listening, because attachment URLs and icons are served from it.

## Usage

```js
import { createLocalApiServer } from '@comapeo/local-api'

const server = createLocalApiServer({
  manager, // a MapeoManager
  discoveryDir: appDataFolder,
  app: { name: 'CoMapeo Desktop', version: '1.2.3' },
})
const { socketPath, discoveryFilePath } = await server.listen()

// later
await server.close()
```

`listen()` creates a socket in a new private directory under the system temp directory (or a random named pipe on Windows), generates a secret, and writes `comapeo-local-api.json` (mode `0600`) into `discoveryDir`. Clients read that file to find the socket and the secret. `close()` disconnects clients and removes the socket and the discovery file.

### Dev server

The dev server serves generated test projects from a throwaway core (in-memory database, cores in a temporary directory removed on exit), for building and testing clients without CoMapeo Desktop. It is not part of the published package: run it from a checkout of this repository after `npm install`, with Node 22.18 or later (Node runs the TypeScript source directly):

```sh
npm run dev -- --discovery-dir /tmp/comapeo-dev
# or: node src/dev/cli.ts --discovery-dir /tmp/comapeo-dev
```

It prints `READY <discovery file path>` on stdout when the server is listening, and runs until interrupted. Type `help` on stdin for commands that create, update or delete an observation, or add a category; each prints an `OK {…}` or `ERROR …` line. Options: `--observations`, `--tracks`, `--photos`, `--projects` (1 or 2), `--seed`.

## API

### `createLocalApiServer(options)`

- `options.manager`: the `MapeoManager` to read from.
- `options.discoveryDir`: directory for the discovery file; created if missing.
- `options.app`: `{ name, version }` of the host app, sent to clients in the handshake and discovery file.
- `options.socketPath` (optional): a socket path or `\\.\pipe\…` name to use instead of a generated one. Unix paths must be under 100 bytes.

Returns `{ listen, close }`:

- `listen()`: resolves to `{ socketPath, discoveryFilePath }`. Can be called once.
- `close()`: idempotent; disconnects clients, abandons slow media server calls, waits for running requests to stop, and resolves when everything is released.

Also exported: `PROTOCOL_VERSIONS`, `DISCOVERY_FILE_NAME`, the `DiscoveryFile` type and the error classes below.

## Errors

Thrown to the host:

| Class                  | Code                     | When                                 |
| ---------------------- | ------------------------ | ------------------------------------ |
| `ServerAlreadyStarted` | `SERVER_ALREADY_STARTED` | `listen()` called twice              |
| `ServerClosed`         | `SERVER_CLOSED`          | `listen()` after `close()`           |
| `SocketPathTooLong`    | `SOCKET_PATH_TOO_LONG`   | the socket path is 100 bytes or more |

Sent to clients in a response's `error.code` (see PROTOCOL.md): `UnsupportedProtocolVersion`, `MethodNotFound`, `InvalidParams`, `ProjectNotFound`, `LayerNotFound`, `InvalidCursor`, `InternalError`.

## License

MIT

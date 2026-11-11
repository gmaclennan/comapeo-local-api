# @comapeo/local-api

[![npm version](https://img.shields.io/npm/v/@comapeo/local-api.svg)](https://www.npmjs.com/package/@comapeo/local-api)
[![CI](https://github.com/digidem/comapeo-local-api/actions/workflows/test.yml/badge.svg)](https://github.com/digidem/comapeo-local-api/actions/workflows/test.yml)
[![codecov](https://codecov.io/github/digidem/comapeo-local-api/graph/badge.svg)](https://codecov.io/github/digidem/comapeo-local-api)

Local socket API exposing CoMapeo project data to other programs on the same computer. It serves a running `MapeoManager` over a Unix socket (macOS, Linux) or named pipe (Windows), so that tools such as the CoMapeo QGIS plugin can show a project's observations, tracks, categories and media. When the host allows it, clients can also change observations' field values, notes and category, and delete observations. The wire contract is [docs/PROTOCOL.md](docs/PROTOCOL.md).

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

It prints `READY <discovery file path>` on stdout when the server is listening, and runs until interrupted. Options: `--observations`, `--tracks`, `--photos`, `--projects` (1 or 2), `--seed`, and for editing:

- `--allow-edits`: start the server with `allowEdits`. Without it, editing is switched off.
- `--as-member`: a second, in-process device creates the first project, invites the served device as a member, makes most of its observations (the served device makes a few) and syncs with it. `READY` is printed once the served device holds everything.
- `--edit-delay <ms>`: hold back the reply to each edit by this long, after the edit is written, for testing a client's timeouts.

Every project also gets three categories with the kinds of field the default categories lack: "Survey plot" (a number, a date, a multi-choice and a single-choice field with numeric options) and "Well" and "Spring", which are told apart by the `water-source` tag that their shared single-choice field sets, so that changing that field would change the category. Only "Well" has a "Well depth" field. Unless `--observations 0` is given, each of the three also gets an example observation with every field answered, one from each device with `--as-member`, so that a member always has one of its own to edit.

Commands on stdin run one at a time, in order, and each prints one `OK {…}` or `ERROR …` line; `OK` is printed only once the served device has indexed the change. An optional project number (1-based, default 1) can follow the command name. Type `help` for the list:

| Command                                                           | What it does                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`, `update [docId]`, `delete [docId]`                      | Change an observation on the served device, as CoMapeo itself would.                                                                                                      |
| `category`                                                        | Add a category with a new field.                                                                                                                                          |
| `fork [docId]`                                                    | Write two versions of an observation from the same version on the served device, so that it is forked (`forks` lists one version).                                        |
| `list own\|other\|nolocation [n]`                                 | Print the ids (in `ids`) of up to `n` (default 5) observations made by the served device, made by another device, or without a location.                                  |
| `remote-create`, `remote-update [docId]`, `remote-delete [docId]` | With `--as-member`: change an observation on the other device; `update` and `delete` pick one the served device did not make.                                             |
| `role member\|coordinator`                                        | With `--as-member`: the other device gives the served device that role.                                                                                                   |
| `fork-prepare [docId]`                                            | With `--as-member`: stop sync, change the observation on the other device and then on the served device, and print the served device's new version. Picks one of its own. |
| `fork-release`                                                    | With `--as-member`: restart sync, and print once the other device's version has arrived as a losing fork: `versionId` unchanged, the other version in `forks`.            |
| `quit`                                                            | Stop, as Ctrl-C does. Shutting down gives up after a few seconds.                                                                                                         |

## API

### `createLocalApiServer(options)`

- `options.manager`: the `MapeoManager` to read from.
- `options.discoveryDir`: directory for the discovery file; created if missing.
- `options.app`: `{ name, version }` of the host app, sent to clients in the handshake and discovery file.
- `options.socketPath` (optional): a socket path or `\\.\pipe\…` name to use instead of a generated one. Unix paths must be under 100 bytes.
- `options.allowEdits` (optional): `true` lets clients change and delete observations (`features.update` and `features.delete`). Off unless given, and fixed for the life of the server: to change it, close the server and start another. Edits are written as this device, so a member can change only observations made on this device, as in CoMapeo.

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

Sent to clients in a response's `error.code` (see PROTOCOL.md): `UnsupportedProtocolVersion`, `MethodNotFound`, `InvalidParams`, `ProjectNotFound`, `LayerNotFound`, `InvalidCursor`, `InternalError`, and from the editing methods `EditingDisabled`, `NotEditable`, `FeatureNotFound`, `NotPermitted`, `Conflict` and `InvalidValue`, which carry the error's `data`.

## License

MIT

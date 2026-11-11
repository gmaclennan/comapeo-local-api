# @comapeo/local-api

Local socket API exposing CoMapeo project data to other programs on the same computer

## Commands

```sh
npm test            # types, lint, unused (knip), unit tests
npm run coverage    # unit tests with lcov + text coverage
npm run check:pkg   # publint + attw on the packed tarball
npm run format      # prettier
npm run dev -- --discovery-dir <dir>   # dev server with generated projects
```

`docs/PROTOCOL.md` is the wire contract and the source of truth; change its meaning only by adding a protocol version.

## Layout

`src/server.ts` (sockets, handshake, dispatch), `src/project-data.ts` (reads from `MapeoManager`), `src/columns.ts`, `src/categories.ts`, `src/subscriptions.ts`, `src/discovery.ts`. `src/dev/` holds the dev command and the generated test data; tests reuse `src/dev/manager.ts` for a real in-memory `MapeoManager` with a listening media server.

## Gotchas

- `@comapeo/core` is a peer dependency: code must work with 7.5.2 (what desktop ships). Inspect old versions with `git show v7.5.2:<path>` in a comapeo-core checkout, and run the suite against it with `npm install --no-save @comapeo/core@7.5.2`.
- `package.json` `overrides` pins `better-sqlite3` to 12.x for development only: 11.x built from source against Node 24.21+ headers aborts in GC (`RemoveEnvironmentCleanupHook ... (env) != nullptr`). It does not affect consumers.
- In core 7.5.2 and 7.7.0 a second `updated-docs` listener on a DataType attaches the datastore handler again and only one is ever removed, so `src/subscriptions.ts` keeps exactly one listener per DataType per project (observation, track, preset, field and `$translation.dataType`).
- Once a project is left, core's `project.observation`, `.track`, `.preset` and `.field` getters return a proxy whose every method returns a rejected promise (7.5.2 and 7.7.0). Keep the DataType references captured before the leave, and never let such a call's promise go uncaught: in the host it is an unhandled rejection. `test/peers.test.ts` covers this with two managers.
- A connection runs one request at a time and reads the next frame only after the reply, error replies included, has been flushed. This keeps a connection's requests in order and stops a client that does not read from filling the host's memory with replies. Notifications are not held back: a subscriber that never reads grows the host's write buffer by the ids of changed documents. `test/backpressure.test.ts` checks this by watching the non-reading client's own writes stall.
- `close()` aborts slow work (icon fetches, media server lookups) and waits for running handlers before it resolves. Without that, an icon fetch still in flight leaves a keep-alive connection that holds the host's media server open for about 70 s.
- `layers.getFeatures` ends a page early once it holds about 4 MiB, and keeps the sorted id list for 60 s so later pages fetch documents by id instead of reading the whole layer again.
- Field column names do not depend on field order: when tag keys sanitise to the same name, only a key already equal to that name keeps it, and the rest get a hash of the key. Names are capped at 63 characters.
- Tags and properties are read with `Object.hasOwn` and built on `Object.create(null)`, because tag keys such as `constructor` or `__proto__` can occur.
- `Observation`, `Preset` etc. from `@comapeo/core/schema.js` are full documents; use `ObservationValue` and friends for values passed to `create()`.
- Unix socket paths must stay under 100 bytes.

## Conventions

TypeScript with erasable syntax only (no enums, namespaces or parameter properties): Node runs `src/` and `test/` directly by stripping types. Relative imports use `.ts` extensions; `tsc -p tsconfig.build.json` rewrites them to `.js` in `dist/`.
ESM only. No default exports (enforced by ESLint). `#private` class fields.
Errors via `custom-error-creator`, exported from `src/errors`. Prettier with
tabs, no semicolons, single quotes. Conventional Commits, `!` for breaking changes.
Every user-facing change gets a changeset (`npx changeset`); never run
`changeset version` on a branch.

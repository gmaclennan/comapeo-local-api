# CoMapeo local API: protocol version 1

This document is the contract between `@comapeo/local-api` (server) and its clients (first: the CoMapeo QGIS plugin). Server and clients are built and released separately, so anything here changes only by adding a new protocol version.

## Transport

- Unix domain socket on macOS and Linux; named pipe (`\\.\pipe\<name>`) on Windows.
- Each frame is a 4-byte unsigned little-endian length, then that many bytes of UTF-8 JSON.
- Frame size limits, enforced by the server: 4 KiB until the handshake succeeds, 16 MiB afterwards. An over-length frame closes the connection. Frames the server sends also stay within 16 MiB.

## Discovery file

The server owns the secret and the discovery file, so every host (CoMapeo Desktop, the dev command, tests) behaves the same.

On `listen()` the server generates a random secret (32 bytes, base64url), then writes `comapeo-local-api.json` into the discovery directory it was given, readable only by the current user (mode `0600` on Unix), written atomically. It removes the file on `close()`.

```json
{
  "discoveryVersion": 1,
  "socketPath": "/tmp/comapeo-1a2b3c/api.sock",
  "secret": "<base64url>",
  "protocolVersions": [1],
  "pid": 12345,
  "app": { "name": "CoMapeo Desktop", "version": "1.2.3" }
}
```

- Default socket path on Unix: `api.sock` inside a freshly created directory with mode `0700` under the system temp directory (the path must stay under 100 bytes). On Windows: `\\.\pipe\comapeo-local-api-<random>`.
- A client that finds a discovery file but cannot connect treats the app as not running (the file may be stale after a crash).

## Messages

JSON-RPC in style, not JSON-RPC 2.0 compliant.

| Kind                           | Shape                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Request                        | `{ "id": <number>, "method": <string>, "params": <object, optional; null means absent> }`         |
| Success                        | `{ "id": <number>, "result": <object> }`                                                          |
| Failure                        | `{ "id": <number>, "error": { "code": <string>, "message": <string>, "data": <any, optional> } }` |
| Notification (server → client) | `{ "method": <string>, "params": <object> }`                                                      |

Clients must ignore unknown properties in results and notifications, and unknown notification methods. Servers must ignore unknown properties in params. This is what allows additions within a protocol version.

Error codes: `UNSUPPORTED_PROTOCOL_VERSION`, `METHOD_NOT_FOUND`, `INVALID_PARAMS`, `PROJECT_NOT_FOUND`, `LAYER_NOT_FOUND`, `INVALID_CURSOR`, `INTERNAL_ERROR`.

## Handshake

The server sends nothing until the client authenticates.

1. The client's first frame must be a `hello` request:
   `{ "id": 1, "method": "hello", "params": { "secret": "<from discovery file>", "protocolVersions": [1], "client": { "name": "comapeo-qgis", "version": "0.1.0" } } }`
2. The server checks the secret first, with a constant-time comparison. If the first frame is not a well-formed `hello`, or the secret is wrong, or no frame arrives within 5 seconds, the server closes the connection without sending anything.
3. If no protocol version is shared, the server replies with error `UNSUPPORTED_PROTOCOL_VERSION` and `data: { "supported": [1] }`, then closes.
4. Otherwise it replies `{ "protocolVersion": 1, "server": { "name": "@comapeo/local-api", "version": "…" }, "app": { "name": "…", "version": "…" } }`.

The `hello` request and its replies can never change shape, because they are exchanged before a version is agreed.

## Methods

All ids are opaque strings. `lang` is an optional BCP 47 tag; the server falls back to the project default, also when the tag is not valid (`pt_BR` is read as `pt-BR`).

### `projects.list`

Result: `{ "projects": [ { "projectId", "name", "color"?, "description"? } ] }`. Only projects the device has joined.

### `layers.list`

Params: `{ projectId, lang? }`.

Result:

```json
{
  "layers": [
    {
      "layerId": "observations",
      "title": "Observations",
      "docType": "observation",
      "geometryType": "Point",
      "schemaVersion": "<changes whenever columns change>",
      "columns": [
        { "name": "id", "type": "string", "label": "ID", "role": "builtin" },
        {
          "name": "building_type",
          "type": "string",
          "label": "Building type",
          "role": "field",
          "options": [{ "value": "school", "label": "School" }]
        },
        { "name": "tags", "type": "json", "label": "All tags", "role": "tags" }
      ]
    }
  ]
}
```

- A layer is a definition: a document type, a filter and a set of columns. Version 1 of the server returns exactly two layers per project, `observations` (`Point`) and `tracks` (`LineString`). Clients must cope with any number of layers and must not assume these ids.
- `geometryType`: `Point` or `LineString`.
- Column `type`: `string`, `number`, `integer`, `boolean`, `datetime` (ISO 8601 string), `string_list`, `json`. Clients treat an unknown type as `string`.
- Column `role`: `builtin`, `field` (one per field defined in the project's categories, named by its tag key) or `tags` (one catch-all column holding every tag as an object).
- Column names are unique within a layer, stable across languages, and safe to use unquoted in QGIS expressions (`[a-z_][a-z0-9_]*`, never an expression keyword such as `end` or `null`); the server resolves collisions (a built-in column gets a `comapeo_` prefix when a tag key takes its name) and sanitises tag keys.
- Built-in columns for `observations`: `id`, `category`, `created_at`, `updated_at`, `created_by`, `updated_by` (device names, falling back to the device id), `accuracy`, `altitude`, `photo_count`, `audio_count`.
- Built-in columns for `tracks`: `id`, `category`, `created_at`, `updated_at`, `created_by`, `updated_by`, `start_time`, `end_time`.

### `layers.getFeatures`

Params: `{ projectId, layerId, lang?, limit?, cursor?, ids? }`.

- `limit` defaults to 1000, maximum 5000.
- `cursor` continues a previous call. A cursor that the server can no longer honour gives `INVALID_CURSOR`; the client starts again.
- A page can hold fewer features than `limit`, because the server keeps each reply well under the frame limit; only `nextCursor: null` marks the end. Documents created while a client is paging may be missing from later pages; a subscribed client hears about them through `layer.changed`.
- `ids`, when given, restricts the result to those feature ids (used after a change notification). Paging still applies.

Result:

```json
{
  "features": [
    {
      "id": "<docId>",
      "version": "<versionId>",
      "geometry": { "type": "Point", "coordinates": [-58.1, -3.2] },
      "properties": {
        "id": "…",
        "category": "School",
        "building_type": "school",
        "tags": {}
      },
      "categoryId": "<id or null>",
      "attachments": [
        {
          "type": "photo",
          "name": "…",
          "key": "<stable across app restarts; use as cache key>",
          "urls": {
            "thumbnail": "http://127.0.0.1:…",
            "preview": "…",
            "original": "…"
          }
        }
      ]
    }
  ],
  "removed": ["<id>"],
  "nextCursor": null
}
```

- Deleted documents are never returned as features. `removed` is present only when `ids` was given, and lists the requested ids that are deleted or no longer exist.
- `geometry` is a GeoJSON geometry in WGS 84, or `null` (an observation with no location). Point coordinates are `[lon, lat]`.
- For `LineString` features an extra member `"times": [<ISO 8601>, …]`, on the feature beside `geometry` (not inside it), runs parallel to `coordinates`.
- `properties` has a value (possibly `null`) for every column in the layer definition.
- `categoryId` matches an entry in `categories.list`, or is `null`. The server resolves the category the way CoMapeo Desktop does: by matching tags first, then by the document's category reference.
- Attachment `type`: `photo`, `audio` or `video`. `urls` holds the variants that exist for the type (`original` always; `thumbnail` and `preview` for photos). URLs point at the app's local media server; the port changes each launch, so clients cache downloaded files by `key` + variant, never by URL. A `404` from a media URL means the file has not synced to this device yet.
- `tracks` features have `"attachments": []`.

### `categories.list`

Params: `{ projectId, lang? }`.

Result: `{ "categories": [ { "categoryId", "name", "color"?, "icon"?: { "mimeType": "image/svg+xml" | "image/png", "data": "<base64>" } } ] }`.

The icon is inline so that clients can embed it without an HTTP request. SVG is preferred; PNG is the fallback.

### `subscribe` / `unsubscribe`

Params: `{ projectId }`. Result: `{}`.

While subscribed, the server sends:

- `layer.changed` with params `{ projectId, layerId, ids: ["<feature id>", …] }` when documents in that layer are created, updated or deleted, locally or through sync. The client calls `layers.getFeatures` with those `ids`.
- `layer.schemaChanged` with params `{ projectId, layerId }` when the layer's columns or the project's categories change. The client calls `layers.list` and `categories.list` again and refetches the layer.

Notifications may be batched and delayed by up to a second. Subscriptions end when the connection closes. A subscription also ends, without a notification, if this device leaves the project; requests for that project then give `PROJECT_NOT_FOUND`.

## Reserved for later versions

`features.update` and `features.delete` (editing), each carrying the `version` the client last saw so that a stale save is refused.

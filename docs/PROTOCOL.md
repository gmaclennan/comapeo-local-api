# CoMapeo local API: protocol version 1

This document is the contract between `@comapeo/local-api` (server) and its clients (first: the CoMapeo QGIS plugin). Server and clients are built and released separately, so anything here changes only by adding a new protocol version, or by an addition that the rules in [Changes within a version](#changes-within-a-version) allow.

Editing (`features.update`, `features.delete`) is such an addition. A server may be older than it, or may have it switched off; [Editing](#editing) says how a client tells.

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

The server answers the requests of one connection in the order it received them, one at a time. A client may send further requests without waiting for replies. Notifications are not held back behind replies, and a client that is slow to read never delays another connection.

Error codes: `UNSUPPORTED_PROTOCOL_VERSION`, `METHOD_NOT_FOUND`, `INVALID_PARAMS`, `PROJECT_NOT_FOUND`, `LAYER_NOT_FOUND`, `INVALID_CURSOR`, `INTERNAL_ERROR`.

Returned only by the editing methods: `EDITING_DISABLED`, `NOT_EDITABLE`, `FEATURE_NOT_FOUND`, `NOT_PERMITTED`, `CONFLICT`, `INVALID_VALUE`. Their `data` is set out under [Checks and errors](#checks-and-errors). `message` is English text for logs; clients word their own messages from `code` and `data`.

## Handshake

The server sends nothing until the client authenticates.

1. The client's first frame must be a `hello` request:
   `{ "id": 1, "method": "hello", "params": { "secret": "<from discovery file>", "protocolVersions": [1], "client": { "name": "comapeo-qgis", "version": "0.1.0" } } }`
2. The server checks the secret first, with a constant-time comparison. If the first frame is not a well-formed `hello`, or the secret is wrong, or no frame arrives within 5 seconds, the server closes the connection without sending anything.
3. If no protocol version is shared, the server replies with error `UNSUPPORTED_PROTOCOL_VERSION` and `data: { "supported": [1] }`, then closes.
4. Otherwise it replies `{ "protocolVersion": 1, "server": { "name": "@comapeo/local-api", "version": "…" }, "app": { "name": "…", "version": "…" } }`.

The `hello` request and its replies can never change shape, because they are exchanged before a version is agreed. For that reason nothing about editing is said in `hello`: a client learns it from `layers.list`.

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
      "editable": true,
      "editOperations": ["properties", "category", "delete"],
      "columns": [
        { "name": "id", "type": "string", "label": "ID", "role": "builtin" },
        {
          "name": "notes",
          "type": "string",
          "label": "Notes",
          "role": "builtin",
          "editable": true
        },
        {
          "name": "building_type",
          "type": "string",
          "label": "Building type",
          "role": "field",
          "editable": true,
          "categoryIds": ["<categoryId>"],
          "options": [{ "value": "school", "label": "School" }]
        },
        { "name": "tags", "type": "json", "label": "All tags", "role": "tags" }
      ]
    },
    {
      "layerId": "tracks",
      "title": "Tracks",
      "docType": "track",
      "geometryType": "LineString",
      "schemaVersion": "…",
      "editable": false,
      "readOnlyReason": "unsupported",
      "editOperations": [],
      "columns": [
        { "name": "id", "type": "string", "label": "ID", "role": "builtin" }
      ]
    }
  ]
}
```

- A layer is a definition: a document type, a filter and a set of columns. Version 1 of the server returns exactly two layers per project, `observations` (`Point`) and `tracks` (`LineString`). Clients must cope with any number of layers and must not assume these ids.
- `geometryType`: `Point` or `LineString`.
- Column `type`: `string`, `number`, `integer`, `boolean`, `datetime` (ISO 8601 string: a date, or a date and time), `string_list`, `json`. Clients treat an unknown type as `string`.
- Column `role`: `builtin`, `field` (one per field defined in the project's categories, named by its tag key) or `tags` (one catch-all column holding every tag as an object).
- Column names are unique within a layer, stable across languages, and safe to use unquoted in QGIS expressions (`[a-z_][a-z0-9_]*`, never an expression keyword such as `end` or `null`); the server resolves collisions (a built-in column gets a `comapeo_` prefix when a tag key takes its name) and sanitises tag keys.
- Built-in columns for `observations`: `id`, `category`, `notes`, `created_at`, `updated_at`, `created_by`, `updated_by` (device names, falling back to the device id), `accuracy`, `altitude`, `photo_count`, `audio_count`. `notes` holds the observation's notes (the `notes` tag). When the project defines a field whose tag key is `notes`, that field's column is the notes column and there is no built-in one; it keeps the field's type and options, and like the built-in one it carries no `categoryIds`.
- Built-in columns for `tracks`: `id`, `category`, `created_at`, `updated_at`, `created_by`, `updated_by`, `start_time`, `end_time`.
- `editable`, `editOperations`, `readOnlyReason` and the column members `editable` and `categoryIds` describe editing; see [What can be edited](#what-can-be-edited). They are absent from a server that predates editing. `schemaVersion` does not cover them: it changes only with the columns' names, types, labels, roles and options.

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
      "forks": [],
      "editable": true,
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
- `version` names the version of the document that CoMapeo shows.
- `forks` lists the other versions of the document that this device holds and that nothing has merged, in sorted order; `[]` when there are none, which is the usual case. See [Conflicts](#conflicts). A feature's `forks` can change while its `version` stays the same. An edit carries both. Absent from a server that predates editing.
- `editable` says whether this device's role lets it edit this feature; see [What can be edited](#what-can-be-edited). Absent means `false`.
- `geometry` is a GeoJSON geometry in WGS 84, or `null` (an observation with no location). Point coordinates are `[lon, lat]`.
- For `LineString` features an extra member `"times": [<ISO 8601>, …]`, on the feature beside `geometry` (not inside it), runs parallel to `coordinates`.
- `properties` has a value (possibly `null`) for every column in the layer definition.
- `categoryId` matches an entry in `categories.list`, or is `null`. The server resolves the category the way CoMapeo Desktop does: by matching tags first, then by the document's category reference.
- Attachment `type`: `photo`, `audio` or `video`. `urls` holds the variants that exist for the type (`original` always; `thumbnail` and `preview` for photos). URLs point at the app's local media server; the port changes each launch, so clients cache downloaded files by `key` + variant, never by URL. A `404` from a media URL means the file has not synced to this device yet.
- `tracks` features have `"attachments": []`.

### `categories.list`

Params: `{ projectId, lang? }`.

Result: `{ "categories": [ { "categoryId", "name", "color"?, "geometryTypes"?: ["Point", "LineString"], "icon"?: { "mimeType": "image/svg+xml" | "image/png", "data": "<base64>" } } ] }`.

The icon is inline so that clients can embed it without an HTTP request. SVG is preferred; PNG is the fallback.

`geometryTypes` lists the layer geometry types the category is meant for. A category can be given to a feature only in a layer whose `geometryType` is listed. A client that finds the member absent (an older server) offers every category.

### `subscribe` / `unsubscribe`

Params: `{ projectId }`. Result: `{}`.

While subscribed, the server sends:

- `layer.changed` with params `{ projectId, layerId, ids: ["<feature id>", …] }` when documents in that layer are created, updated or deleted, locally or through sync, or through this API. That includes a version arriving from another device that changes a feature's `forks` and not its `version`. The client calls `layers.getFeatures` with those `ids`.
- `layer.schemaChanged` with params `{ projectId, layerId }` when the layer's columns or the project's categories change, or when what this device may edit changes (its role in the project changed). The client calls `layers.list` and `categories.list` again and refetches the layer.

Notifications may be batched and delayed by up to a second. Subscriptions end when the connection closes. A subscription also ends, without a notification, if this device leaves the project; requests for that project then give `PROJECT_NOT_FOUND`.

## Editing

A client can change column values (answers to a category's fields, and notes), change the category and delete a feature. It cannot create features, change attachments, move a point, give a location to a feature that has none or take one away, or edit `tracks`.

Moving a point is described below so that a later server can offer it within version 1 (as the `move` edit operation), but no server offers it yet. Everything in this document about `move`, the `geometry` param of `features.update` and the checks and reasons that concern a geometry applies only to a server that lists `move` in a layer's `editOperations`. Today's server refuses every `geometry` with `NOT_EDITABLE`, as check 4 says.

The server offers editing only when its host starts it with editing allowed (`allowEdits` in the server's options; off unless given). This is fixed for the life of the server: a host that changes its mind closes the server and starts another, and clients reconnect.

### What can be edited

`layers.list` and `layers.getFeatures` say what this server will accept. Everything here is advice for the client's interface; the server checks each edit itself and its answer is the one that counts.

| Member                 | Meaning                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| layer `editable`       | `true` when features of this layer can be edited through this connection: the layer supports it, the host allows it, and this device's role lets it edit at least its own features. Absent means `false`.                     |
| layer `readOnlyReason` | Present when `editable` is `false`: `unsupported` (this layer cannot be edited through the API), `disabled` (the host has not allowed editing) or `role` (this device's role in the project lets it edit nothing).            |
| layer `editOperations` | The kinds of edit the layer supports: `properties`, `category`, `delete`, and `move` on a later server. Absent or empty means none. Clients ignore values they do not know and do not attempt a kind that is not listed.      |
| column `editable`      | `true` when the layer supports changing this column's value with `features.update`. Absent means `false`.                                                                                                                     |
| column `categoryIds`   | On an editable column: the categories whose features can be given a value in it, because the column's field belongs to them. Absent means the column can be changed on any feature, whatever its category (the notes column). |
| feature `editable`     | In `layers.getFeatures`: `true` when this device's role lets it edit this feature. Absent means `false`.                                                                                                                      |
| feature `forks`        | In `layers.getFeatures`: the other versions of the feature that have not been merged. An edit sends them back, so that the server can tell what the client had seen; see [Conflicts](#conflicts).                             |

- `editOperations`, column `editable` and `categoryIds` describe the layer. They do not depend on the host's setting or on this device's role. Layer `editable` does, so a client looks at it first and offers no editing where it is not `true`.
- When more than one `readOnlyReason` applies the server gives the first of `unsupported`, `disabled`, `role`, so that a client never suggests a remedy that would not help. Clients treat a value they do not know, here and in the `data` of `NOT_EDITABLE` and `NOT_PERMITTED`, as a general refusal.
- In version 1 of the server only `observations` is editable. Its editable columns are the notes column and the `field` columns, with the exceptions under [Column values](#column-values); every other built-in column, and the `tags` column, is read-only. The category is changed with `categoryId`, not through the `category` column.
- A field's column can be changed only on a feature whose category has that field, as in CoMapeo Desktop, which shows and edits only the fields of an observation's category. A feature with no category (`categoryId` is `null`) can have its notes changed and nothing else.
- Feature `editable` carries CoMapeo's rule for roles. A coordinator or the project's creator may edit every observation. A participant (the member role) may edit only observations created on this device. The rule is about devices, not people, as it is in CoMapeo.
- When this device's role changes, or the categories or their fields change, the server sends `layer.schemaChanged` for the project's layers, and the client reads the flags again.
- A client that predates editing ignores these members and never calls the editing methods. Nothing changes for it, except that it now sees a `notes` column.
- A server that predates editing sends none of these members, so a client treats every layer as read-only. It answers `features.update` and `features.delete` with `METHOD_NOT_FOUND`. A client can tell such a server (no `editable` member at all: "update CoMapeo") from one with editing switched off (`readOnlyReason: "disabled"`).

### `features.update`

Params: `{ projectId, layerId, id, version, forks?, properties?, categoryId?, geometry?, lang? }`.

```json
{
  "projectId": "…",
  "layerId": "observations",
  "id": "<docId>",
  "version": "<the version this client last fetched>",
  "forks": [],
  "properties": { "building_type": "clinic", "notes": null },
  "categoryId": "<categoryId>"
}
```

- `id` and `version` are required. `version` and `forks` are the feature's `version` and `forks` as the client last fetched them, from the same fetch. `forks` left out means `[]`; its order does not matter.
- At least one of `categoryId`, `geometry` and a `properties` with at least one column is required.
- `properties` holds only the columns to change, by column name. Columns left out are not touched. A client must not send back values it has not changed: what it read was converted to the column's type, and a stored value that did not fit the type reads as `null`.
- `categoryId` is an entry of `categories.list`. `null` is not accepted: a category cannot be removed.
- `geometry` is a GeoJSON `Point` with `[lon, lat]` in WGS 84. A third coordinate is ignored. `null` is not accepted. It is for a server that offers `move`; today's server refuses it with `NOT_EDITABLE` (`target: "geometry"`), even when the coordinates are the feature's own.
- When several are given they are applied as one change, in this order: category, then column values, then position.
- `lang` is used for the feature in the reply.

Result: `{ "feature": { … }, "concurrent"?: true }`.

- `feature` is the feature as `layers.getFeatures` would now return it, with its new `version` and `forks`. The client replaces its copy with it and needs no further call.
- Parts of a request that change nothing are ignored: a `categoryId` that is already the feature's `categoryId`, a column value equal to the one stored, and, on a server that offers `move`, a `geometry` whose coordinates are the feature's own (a move to where the point already is does not count as a move). If nothing is left, the server writes nothing and returns the feature as it stands, `version` unchanged.
- `concurrent` is explained under [Conflicts](#conflicts).

### `features.delete`

Params: `{ projectId, layerId, id, version, forks? }`, with `version` and `forks` as for `features.update`.

Result: `{ "id": "<docId>", "concurrent"?: true }`. The client removes the feature, unless `concurrent` is set (see [Conflicts](#conflicts)). Deleting does not touch tracks that refer to the observation, as in CoMapeo Desktop.

### Column values

Each value in `properties` is `null` or a JSON value of the column's type.

| Column `type` | Value                                                                              | What is stored                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `string`      | string                                                                             | The string with white space trimmed from both ends, as CoMapeo Desktop does. An empty string is stored as one. |
| `number`      | number (finite)                                                                    | The number.                                                                                                    |
| `integer`     | whole number                                                                       | The number.                                                                                                    |
| `boolean`     | `true` or `false`                                                                  | The boolean.                                                                                                   |
| `datetime`    | `YYYY-MM-DD`, or `YYYY-MM-DDThh:mm` with optional seconds, fraction and `Z`/offset | The string as sent.                                                                                            |
| `string_list` | array of strings                                                                   | The array. An empty array is stored as one.                                                                    |

- `null` removes the tag from the observation. The column then reads `null`. A stored `null` and a missing tag read the same through this API, so an option whose value is `null` is chosen by sending `null`.
- For a column with `options`, each value must be the `value` of one of the options, and the server stores the option's own value. (Option values are sent as strings in `string` and `string_list` columns even when the field defines a number or a boolean; the server turns them back.)
- The `datetime` forms are the ones the server reads; anything else that is stored reads as `null`. CoMapeo Desktop stores a date field as a full date and time in UTC.
- The built-in notes column is an ordinary `string` column.
- Only the tags named by the columns sent are changed. Every other tag is kept, including answers to fields the feature's category does not have.
- These columns are never editable: `json` columns; columns of a field whose type the server does not know; columns of a choice field that defines no options; and columns in which two options have the same `value` as sent (the server could not tell which was meant).
- When fields of different categories share a tag, they share a column, described by the first of them. `categoryIds` then lists only the categories whose own field has the same type and options as the column describes.

### Changing the category

The server sets the observation's category reference to the new category and works out its tags the way CoMapeo Desktop does, with the two differences given below:

1. Start from the observation's tags.
2. Remove each tag that the old category put there (same key and value as an entry of the old category's `tags` or `addTags`), and each tag that matches an entry of the new category's `removeTags`.
3. Add the new category's `tags` and `addTags`; where a key is already present the new category's value wins.

The old category is the one this API reports for the feature (`categoryId`), and also the one the observation refers to, when the two differ. Answers to fields are not removed, including answers to fields the new category does not have; the one exception is an answer stored under a tag that the old category itself sets, which goes with the old category in step 2.

This differs from CoMapeo Desktop in two places. Desktop removes only the tags of the category the observation refers to, so when that reference is missing or out of step with the tags, the old category's tags stay and the old category goes on showing. And Desktop lets a tag that is kept override the new category's tag of the same key, which can leave the observation without the new category's own tag. Where neither arises, the result is the same as Desktop's.

One rule covers every update, whether or not it asks for a category: afterwards the feature's `categoryId` is the one requested, or, when none was requested, the one it had. If the tags that would result make CoMapeo show another category, the server refuses with `INVALID_VALUE` and writes nothing. So a category changes only through `categoryId`, never as a side effect of a column value, and a category change that would not show is not written.

### Moving a point

Not offered yet: no server lists `move` in `editOperations`, and today's server refuses every `geometry`. This section says what a later server that offers it will do.

The server sets the observation's latitude and longitude, and records the position as entered by hand, the way CoMapeo Mobile records a position that was typed in: `metadata.manualLocation` becomes `true`, `metadata.position` is replaced by the new coordinates and the time of the edit, and `metadata.positionProvider` is dropped. Other metadata is kept.

Because of that the `accuracy` and `altitude` columns of a moved observation read `null`: they described the GPS fix, which no longer describes where the point is. CoMapeo Mobile shows such an observation as "manually entered".

Only an observation that has a location can be moved. Attachments keep their own recorded positions.

### Checks and errors

The server makes these checks in this order and answers with the first that fails, so the same request always fails with the same code.

| Order | Code                                   | When                                                                                                                                                                                                                                  | `data`                                                                                                                  |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1     | `INVALID_PARAMS`                       | The request is malformed: a required param is missing, `forks` is not an array of strings, `properties` is not an object, `geometry` is not a GeoJSON `Point`, there is nothing to change.                                            | none                                                                                                                    |
| 2     | `EDITING_DISABLED`                     | The host has not allowed editing.                                                                                                                                                                                                     | none                                                                                                                    |
| 3     | `PROJECT_NOT_FOUND`, `LAYER_NOT_FOUND` | As for the reading methods.                                                                                                                                                                                                           | none                                                                                                                    |
| 4     | `NOT_EDITABLE`                         | The layer does not support what is asked, whatever this device's role: the layer itself, a column named in `properties` (also a column the layer does not have), or the kind of edit (a `geometry` sent where `move` is not offered). | `{ "target": "layer" \| "column" \| "category" \| "geometry" \| "delete", "column"?: "<name>" }`                        |
| 5     | `FEATURE_NOT_FOUND`                    | The layer has no feature with this id, or it has been deleted.                                                                                                                                                                        | `{ "deleted": true \| false }`                                                                                          |
| 6     | `NOT_PERMITTED`                        | This device's role does not allow it to edit this feature.                                                                                                                                                                            | `{ "reason": "not-own" \| "role" }`                                                                                     |
| 7     | `CONFLICT`                             | `version` is not the version CoMapeo now shows, or `forks` is not the set of other versions it now holds: the feature changed after the client fetched it.                                                                            | `{ "feature": { … } }`, the feature as it now stands, in the request's `lang`                                           |
| 8     | `NOT_EDITABLE`                         | This feature cannot take the change: `geometry` was sent and it has no location, or a column was sent whose field its category (the requested one, when the request changes it) does not have.                                        | `{ "target": "geometry", "reason": "no-location" }` or `{ "target": "column", "column", "reason": "not-in-category" }`  |
| 9     | `INVALID_VALUE`                        | A value cannot be stored.                                                                                                                                                                                                             | `{ "target": "column" \| "category" \| "geometry", "column"?: "<name>", "reason": "<see below>", "detail"?: "<text>" }` |

- Check 4 looks only at what the layer offers (`editOperations` and column `editable`), so its answer is the same for every device. Every refusal that comes from this device's role is `NOT_PERMITTED`.
- `NOT_PERMITTED` comes before `CONFLICT` so that an edit this device may not make is always answered the same way, whatever version it carries. `reason` is `not-own` when the role allows editing only observations created on this device, and `role` when it allows no editing at all (the layer's `readOnlyReason` is then `role`).
- `NOT_EDITABLE` carries a `reason` only from check 8. Without one, the layer does not offer the thing at all.
- Check 4 looks at the layer first, then a `categoryId`, then a `geometry`, then the columns in `properties`; the first that is not offered is the one reported. The `geometry` cases of checks 8 and 9 (`no-location`, `out-of-range`) arise only on a server that offers `move`.
- `INVALID_VALUE` reasons: `type` (not a value of the column's type), `not-an-option` (the column has options and the value is not one), `format` (not a date in one of the forms accepted), `out-of-range` (longitude outside −180 to 180 or latitude outside −90 to 90), `unknown-category`, `category-not-for-layer`, `category-would-not-show` (the category asked for would not be the one shown), `would-change-category` (a column value would change the category shown; `column` names it when one column alone is responsible), and `schema` (CoMapeo's own check of the whole observation refused it; `detail` says why). When several values are bad the server reports one of them. Clients treat a reason they do not know as a general refusal.
- CoMapeo can store an observation that its own check refuses. Such an observation can be deleted but not changed: every update that would write something gives `INVALID_VALUE` with reason `schema`, `target` `column` when the request sends columns and `category` otherwise, even when the fault lies in a part of the observation the request did not touch. An update that changes nothing still returns the feature.
- A refused edit changes nothing. After `CONFLICT` the client replaces its copy with `data.feature`; after `FEATURE_NOT_FOUND` it removes the feature. After the others its copy is still right.
- For `features.delete`, checks 8 and 9 do not apply.

### Conflicts

CoMapeo keeps every version of a document. When two devices change the same version without having seen each other's change, it keeps both, shows the one saved later, and calls the document forked: `forks` lists the versions not shown. A version from another device can arrive long after it was made. If it is older than the one shown, the feature's `version` stays as it was and only `forks` grows.

This API must not write over a change the client has not seen, and must not fork a document itself. What the server does:

- It applies edits to a project one at a time, across all connections.
- For each edit it reads the feature as CoMapeo now holds it, and refuses with `CONFLICT` unless the version shown is the `version` the client sent and the other versions are exactly the `forks` the client sent. It then writes without waiting on anything else of its own.
- An observation that the client knew to be forked can be edited. An update is written on top of the version shown only, as CoMapeo Desktop does; the other versions are not merged into it and are left as they are. The reply's `forks` says which of them CoMapeo still lists. A delete goes through CoMapeo's own delete, which covers every version.

What it cannot do:

- The check is against what this device has received. A change made on another device that has not yet reached this one cannot be seen. When it arrives, CoMapeo keeps both versions and shows the later one, as for any two devices that edit while apart. The client hears of it through `layer.changed`.
- CoMapeo offers no way to check and write in one step, so a change from another device, or one made in CoMapeo itself on this device, can land in the few milliseconds between the server's check and its write. The server looks for this after writing and reports it with `"concurrent": true` in the result. For an update, both versions are kept, and `feature` is the one CoMapeo now shows, with the other in its `forks`; the one shown is whichever was saved later, normally the client's. If what landed was a deletion, the update brings the observation back and the deletion is listed in its `forks`. For a delete, a change that landed before CoMapeo's own delete began is covered by the deletion, but one that overlapped it is kept beside it and may be the version shown, so the observation may still be there. In no case can the write be withdrawn. When `concurrent` is set, on an update or a delete, the client fetches the feature again by id rather than trusting the result, and tells the user that another change was made at the same moment.

### Many edits at once

There is no batch method. A client that saves many features sends one request per feature, without waiting between them, and the server applies them in the order received.

- Each edit stands alone. One that is refused does not stop the ones after it, and the ones before it are not undone. CoMapeo cannot write several documents as one unit, so a batch method could not promise more.
- If the connection closes before all replies have arrived, the edits without a reply may or may not have been applied. The client finds out by fetching those features once it has reconnected.
- Sending an edit again with the same `version` and `forks` is safe: it can never make a fork. If the first attempt was applied, the second is answered with `CONFLICT`, and `data.feature` already holds the values that were sent.

### Notifications after an edit

An edit made through this API produces `layer.changed` like any other change, and every subscribed connection receives it, the one that made the edit included. The server does not leave the writer out: one rule for all changes means a client can never miss one.

There is no order between the reply to an edit and the `layer.changed` that follows from it; either may arrive first, and during a long save a `layer.changed` for the first edits can arrive before the replies to the last. A client avoids a pointless refresh by comparing what it fetches with what it holds, not by guessing which notifications are its own: when it fetches the ids named in `layer.changed` and finds a feature with the `version` and `forks` it already holds, it has nothing to write.

## Changes within a version

Within protocol version 1 these may be added, because clients ignore unknown properties and notification methods, and servers ignore unknown properties in params:

- New methods. A server that lacks one answers `METHOD_NOT_FOUND`.
- New optional properties in params, results and notifications. Absence must have a defined meaning.
- New error codes, returned only by methods or for params that an older client never sends.
- New notification methods.
- New values where this document says clients ignore or fall back on unknown ones (column `type`, `editOperations`, `readOnlyReason`, and the `target` and `reason` values in error `data`).
- New columns and layers, which clients must already cope with.

These need a new protocol version: removing or renaming anything, changing the meaning or type of an existing property, changing what an existing method does for params an older client sends, changing the framing, and making a client's existing behaviour unsafe. `hello` and its replies cannot change even then.

Added so far within version 1: `features.update` and `features.delete`; the six editing error codes; `editable`, `editOperations` and `readOnlyReason` on layers; `editable` and `categoryIds` on columns; `editable` and `forks` on features; the `notes` built-in column; `geometryTypes` on categories; `layer.schemaChanged` when this device's role changes.

## Not offered yet

Creating features, changing attachments, editing tracks, moving a point (see [Moving a point](#moving-a-point)), and giving a location to an observation that has none. Each could be added within version 1, as a new method or a new `editOperations` value.

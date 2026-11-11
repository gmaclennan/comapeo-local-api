---
'@comapeo/local-api': minor
---

Let clients edit observations when the host passes `allowEdits: true`: `features.update` changes field values, notes and the category, and `features.delete` deletes, within protocol version 1. Layers, columns and features say what can be edited, observations gain a `notes` column, categories list their `geometryTypes`, and a change of this device's role sends `layer.schemaChanged`.

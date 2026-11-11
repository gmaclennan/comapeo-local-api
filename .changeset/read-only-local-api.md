---
'@comapeo/local-api': minor
---

Serve CoMapeo project data read-only over a local socket (protocol version 1): handshake with a secret from the discovery file, `projects.list`, `layers.list`, `layers.getFeatures`, `categories.list` and `subscribe`/`unsubscribe` with change notifications. Includes the `comapeo-local-api-dev` command, which serves generated test projects.

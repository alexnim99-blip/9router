---
title: My 9 Router API
emoji: 🐢
colorFrom: indigo
colorTo: green
sdk: docker
app_port: 20128
pinned: false
---

Private 9router Docker Space using the upstream 0.5.112 image.

Configure `INITIAL_PASSWORD` and `JWT_SECRET` as Space secrets before use.
For API requests to this private Space, send the Hugging Face access token in
`Authorization: Bearer ...` and the 9router API key in `X-API-Key: ...`.

The Space filesystem is temporary without persistent storage. Back up settings and
provider credentials before rebuilding or restarting the Space.

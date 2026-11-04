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

## Configure the Space

Keep the Space visibility **Private**. Configure these Space secrets before use:

- `INITIAL_PASSWORD`: the dashboard's initial password.
- `JWT_SECRET`: a stable secret for dashboard sessions.
- `ROUTER_API_KEY`: an active 9router API key from the dashboard.
- `CLINE_HF_TOKEN_SHA256`: the SHA-256 hex digest of the Hugging Face access
  token used by API clients. The name is historical; it also applies to Chatbox.

The proxy gives the dashboard session cookie iframe-compatible attributes so
login works within the Hugging Face Space page.

## Connect Cline

In Cline for VS Code, select **OpenAI Compatible** and enter:

- Base URL: `https://sumnim747-my-9-router-api.hf.space/v1`
- API Key: a dedicated read-only Hugging Face token with access to this private
  Space, without `Bearer`. Never use a write-capable deployment token in a client.
- Model ID: a model returned by `/v1/models`, such as `ag/gemini-3.8-flash`.

## Connect Chatbox AI

In the Chatbox AI app, open **Settings → Model Provider → Add** and select
**OpenAI API Compatible**. Use these fields, including for Gemini models:

| Field | Value |
| --- | --- |
| API Host | `https://sumnim747-my-9-router-api.hf.space/v1` |
| API Key | A dedicated read-only Hugging Face token with access to this private Space, without `Bearer` |
| API Path | Leave blank or use the default |

Tap **Fetch** to load the model list, then select a model. Do not append
`/models` or `/chat/completions` to the API Host. If the app reports a network
error, try its **Improve Network Compatibility** setting.

The private Space requires the Hugging Face token in the `Authorization: Bearer`
header. The proxy verifies its digest and supplies the 9router key from the
Space secret. A 9router `sk-...` key alone cannot pass the Hugging Face access
gate; a Hugging Face HTML 404 response usually means the token is missing or
invalid. Clients that support two headers can also send the Hugging Face token
in `Authorization: Bearer ...` and the 9router API key in `X-API-Key: ...`.

## Persistent data

The Space uses a private Hugging Face Storage Bucket mounted at `/app/persist`.
9router keeps its active SQLite database on local disk for WAL support. The proxy
creates an online SQLite snapshot after successful writes, every 60 seconds,
and when the app exits. On startup, it restores the latest valid snapshot from
the bucket before starting 9router. It retains the three newest snapshots.

The database includes dashboard preferences, provider connections and
credentials, API keys, model aliases, and usage history. The `JWT_SECRET` Space
secret must remain stable so dashboard sessions continue to work. If the bucket
is missing or unavailable, the Space fails to start rather than silently
starting with an empty database. Changes made immediately before a hard stop
may be absent from the most recent snapshot.

The bucket is private and contains unencrypted, sensitive database contents. Keep it private
and restrict access to the Space owner. No Cloudflare credentials are needed in
Space Variables or Secrets for this storage setup. Cloudflare D1 cannot replace
the app's local SQLite file without changing 9router's database layer.

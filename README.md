# opencode-cloudflare-ai-gateway-auth

English | [简体中文](https://github.com/4sh0u0/opencode-cloudflare-ai-gateway-auth/blob/main/README.zh-CN.md) | [日本語](https://github.com/4sh0u0/opencode-cloudflare-ai-gateway-auth/blob/main/README.ja.md)

A [magpie](https://usemagpie.ai) provider plugin that sends your requests through
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) and pays for
them with the provider keys stored in your gateway (BYOK), not Cloudflare's Unified
Billing. It also lists the models your gateway can reach.

> Not affiliated with or endorsed by Cloudflare.

## What you need

- A Cloudflare AI Gateway with authentication on, and provider keys stored under
  **Provider Keys** (BYOK). Turning on **Require provider credentials** (`byok_only`)
  is recommended.
- A Cloudflare API token with **Account → AI Gateway → Run** and
  **Account → AI Gateway → Read**. REST mode only: also **Workers AI → Read**.
- magpie 0.1.1110 or later.

## Install

```sh
magpie plugin add github:4sh0u0/opencode-cloudflare-ai-gateway-auth
```

or, in the app, find it under **Plugins → Discover → Unofficial**. A local copy works
too: `magpie plugin add /path/to/folder`, or **Plugins → Add a plugin** with the folder.

## Sign in

```sh
magpie plugin login cloudflare-ai-gateway
```

| Field | What to enter |
|---|---|
| Cloudflare API token | The token above |
| Cloudflare account ID | 32 hex characters, from the dashboard's account home |
| AI Gateway ID | Your gateway's name, e.g. `my-gateway` |
| Upstream endpoint | **Native provider endpoints** (recommended) or **Cloudflare REST API** |
| BYOK key alias | Native mode only; leave empty for the `default` key |

Each sign-in is one gateway, key alias and mode, named
`<gateway>[/<alias>] · <account ID's first 8>[ · REST]`. Sign in again for another
one; magpie fails over between them. Failover works between sign-ins of the same
mode: native and REST sign-ins name models differently and REST serves only OpenAI
and Anthropic, so don't pair them. Signing in again with the same gateway, alias
and mode replaces that sign-in, e.g. to rotate the token. The sign-in is kept in
magpie's `plugin-auth.json` (mode 600).

## Models

Models are named `<vendor>/<model>`; agents reach them as
`cloudflare-ai-gateway/<vendor>/<model>`, e.g.
`cloudflare-ai-gateway/anthropic/claude-sonnet-5-5` in native mode and
`cloudflare-ai-gateway/anthropic/claude-sonnet-5.5` in REST mode.

| Vendor | Prefix | Native mode API | REST mode API |
|---|---|---|---|
| OpenAI | `openai/` | Responses | Responses |
| Anthropic | `anthropic/` | Messages | Messages |
| Google AI Studio | `google/` | Chat Completions | — |
| DeepSeek | `deepseek/` | Chat Completions | — |
| xAI | `xai/` | Chat Completions | — |

REST mode reaches OpenAI and Anthropic only. Over REST, Cloudflare serves Google
models through Vertex AI and DeepSeek through Fireworks, and doesn't use a stored xAI
key, so the keys in your gateway don't serve these three. REST also takes only the IDs in
Cloudflare's [model catalog](https://developers.cloudflare.com/ai/models/), so REST
mode lists only the OpenAI and Anthropic models in that catalog, under the catalog's
IDs. These can differ from the vendor's own: Anthropic models with a minor version,
such as `claude-sonnet-5-5`, are `claude-sonnet-5.5` there. Native mode uses each
vendor's own IDs.

Only vendors your gateway holds a key for are listed. In native mode each vendor's
list comes from the vendor itself, through the gateway; when that fails, from
[models.dev](https://models.dev). In REST mode the list comes from Cloudflare's
catalog page, or from models.dev's copy of the catalog when the page can't be read.
models.dev also supplies context windows, reasoning levels and prices.

## Native vs REST mode

- **Native** sends each vendor's own API to
  `gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>/…`. Nothing is
  translated, so prompt caching, extended thinking and the Responses API reach the
  vendor as they are. Use this for Claude Code and Codex.
- **REST** sends to `api.cloudflare.com/client/v4/accounts/<account>/ai/v1/…` with
  `cf-aig-gateway-id`. It has no key aliases, and lists only the OpenAI and Anthropic
  models in Cloudflare's catalog, under the catalog's IDs (see above).

## Billing safety

Every request carries `cf-aig-no-wholesale: true`, so a vendor without a stored key
fails instead of falling back to Unified Billing. On the native endpoints that is a
400, verified live. In REST mode a gateway without the key answered 402 (code 7007)
and billed nothing, but that check couldn't rule out the account simply having no
Unified Billing credits, so keep **Require provider credentials** on: REST then
answers 403 (code 2049). To allow the fallback:

```sh
magpie plugin options opencode-cloudflare-ai-gateway-auth '{"allowUnifiedBilling": true}'
```

## Troubleshooting

| You see | Meaning |
|---|---|
| The account asks to sign in again | Cloudflare refused the API token: check it hasn't expired and has AI Gateway Run and Read (REST mode: also Workers AI Read) |
| 400 from a model (REST mode: 402 or 403) | The gateway holds no key for that vendor under your alias (native mode: code 2044). A 400 can also be the plugin refusing the request before sending it, e.g. an unknown vendor prefix, a model ID that isn't `<vendor>/<model>`, or Google, DeepSeek or xAI in REST mode; its message says which |
| 404 or 500 from a model in REST mode | Cloudflare's model catalog has no model by that ID (e.g. a vendor's own `claude-sonnet-5-5` for the catalog's `claude-sonnet-5.5`): pick a listed model, or use native mode |
| 401 from a vendor, account still signed in | The vendor refused the key stored in the gateway |
| A model is missing | Its vendor has no key in the gateway, or it isn't a chat model; in REST mode, also any model that isn't in Cloudflare's catalog |

## Development

```sh
bun test
bun --env-file=.env.local scripts/probe.mjs   # live checks, needs .env.local
scripts/sandbox.sh native anthropic/<model>   # magpie in a throwaway HOME
```

## License

MIT

# opencode-cloudflare-ai-gateway-auth

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
magpie plugin add opencode-cloudflare-ai-gateway-auth
```

or, in the app, **Plugins → Add a plugin**.

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
one; magpie fails over between them. Signing in again with the same gateway, alias
and mode replaces that sign-in, e.g. to rotate the token. The sign-in is kept in
magpie's `plugin-auth.json` (mode 600).

## Models

Models are named `<vendor>/<model>`; agents reach them as
`cloudflare-ai-gateway/<vendor>/<model>`, e.g.
`cloudflare-ai-gateway/anthropic/claude-sonnet-5.5`.

| Vendor | Prefix | Native mode API | REST mode API |
|---|---|---|---|
| OpenAI | `openai/` | Responses | Responses |
| Anthropic | `anthropic/` | Messages | Messages |
| Google AI Studio | `google/` | Chat Completions | Chat Completions |
| DeepSeek | `deepseek/` | Chat Completions | Chat Completions |
| xAI | `xai/` | Chat Completions | Chat Completions |

REST mode follows Cloudflare's documented model naming; it has not been verified live yet.

Only vendors your gateway holds a key for are listed. Each vendor's list comes from
the vendor itself, through the gateway; when that fails, from
[models.dev](https://models.dev), which also supplies context windows, reasoning
levels and prices.

## Native vs REST mode

- **Native** sends each vendor's own API to
  `gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>/…`. Nothing is
  translated, so prompt caching, extended thinking and the Responses API reach the
  vendor as they are. Use this for Claude Code and Codex.
- **REST** sends to `api.cloudflare.com/client/v4/accounts/<account>/ai/v1/…` with
  `cf-aig-gateway-id`. It has no key aliases.

## Billing safety

Every request carries `cf-aig-no-wholesale: true`, so a vendor without a stored key
fails with 400 instead of falling back to Unified Billing. This is verified on the
native endpoints; in REST mode it hasn't been verified live yet, so keep
**Require provider credentials** on. To allow the fallback:

```sh
magpie plugin options opencode-cloudflare-ai-gateway-auth '{"allowUnifiedBilling": true}'
```

## Troubleshooting

| You see | Meaning |
|---|---|
| The account asks to sign in again | Cloudflare refused the API token: check it hasn't expired and has AI Gateway Run and Read (REST mode: also Workers AI Read) |
| 400 from a vendor | The gateway has no key for it under your alias, or it isn't allowed |
| 401 from a vendor, account still signed in | The vendor refused the key stored in the gateway |
| A model is missing | Its vendor has no key in the gateway, or it isn't a chat model |

## Development

```sh
bun test
bun --env-file=.env.local scripts/probe.mjs   # live checks, needs .env.local
scripts/sandbox.sh native anthropic/<model>   # magpie in a throwaway HOME
```

## License

MIT

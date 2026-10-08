# opencode-cloudflare-ai-gateway-auth

[English](https://github.com/4sh0u0/opencode-cloudflare-ai-gateway-auth/blob/main/README.md) | [简体中文](https://github.com/4sh0u0/opencode-cloudflare-ai-gateway-auth/blob/main/README.zh-CN.md) | 日本語

[magpie](https://usemagpie.ai) 用のプロバイダープラグインです。リクエストを [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) 経由で送信し、その料金は Cloudflare の Unified Billing ではなく、ゲートウェイに保存したプロバイダーキー（BYOK）で支払います。ゲートウェイから利用できるモデルの一覧も表示します。

> 本プロジェクトは Cloudflare とは無関係であり、Cloudflare による承認や推奨を受けたものではありません。

## 必要なもの

- 認証を有効にし、**Provider Keys** にプロバイダーキーを保存した（BYOK）Cloudflare AI Gateway。**Require provider credentials**（`byok_only`）を有効にすることをおすすめします。
- **Account → AI Gateway → Run** と **Account → AI Gateway → Read** の権限を持つ Cloudflare API トークン。REST モードでのみ、**Workers AI → Read** も必要です。
- magpie 0.1.1110 以降。

## インストール

```sh
magpie plugin add opencode-cloudflare-ai-gateway-auth
```

アプリでは **Plugins → Discover → Unofficial**（日本語 UI では「プラグイン → 発見 → 非公式 · GitHub」）からも見つけられます。GitHub から直接インストールする場合は `magpie plugin add github:4sh0u0/opencode-cloudflare-ai-gateway-auth` を実行してください。ローカルのコピーも使えます。`magpie plugin add /path/to/folder` を実行するか、**Plugins → Add a plugin**（日本語 UI では「プラグイン → プラグインを追加」）でフォルダーを指定してください。

## サインイン

```sh
magpie plugin login cloudflare-ai-gateway
```

| 項目 | 入力する内容 |
|---|---|
| Cloudflare API token | 上記のトークン |
| Cloudflare account ID | 16 進数 32 文字。ダッシュボードのアカウントホーム（Account home）で確認できます |
| AI Gateway ID | ゲートウェイの名前（例：`my-gateway`） |
| Upstream endpoint | **Native provider endpoints**（推奨）または **Cloudflare REST API** |
| BYOK key alias | ネイティブモードのみ。`default` キーを使う場合は空欄のままにします |

1 回のサインインは、1 つのゲートウェイ・キーエイリアス・モードの組み合わせに対応し、`<gateway>[/<alias>] · <account ID's first 8>[ · REST]` という名前になります（`<account ID's first 8>` はアカウント ID の先頭 8 文字です）。別の組み合わせを追加するには、もう一度サインインしてください。magpie はそれらの間で自動的にフェイルオーバーします。フェイルオーバーが機能するのは同じモードのサインイン同士だけです。ネイティブと REST ではモデルの名前が異なり、REST は OpenAI と Anthropic しか扱わないため、両者を組み合わせないでください。同じゲートウェイ・エイリアス・モードでもう一度サインインすると、そのサインインが置き換わります。トークンのローテーションなどに利用できます。サインイン情報は magpie の `plugin-auth.json`（パーミッション 600）に保存されます。

## モデル

モデルは `<vendor>/<model>` という名前で、エージェントからは `cloudflare-ai-gateway/<vendor>/<model>` として指定します。たとえばネイティブモードでは `cloudflare-ai-gateway/anthropic/claude-sonnet-5-5`、REST モードでは `cloudflare-ai-gateway/anthropic/claude-sonnet-5.5` です。

| ベンダー | プレフィックス | ネイティブモードの API | REST モードの API |
|---|---|---|---|
| OpenAI | `openai/` | Responses | Responses |
| Anthropic | `anthropic/` | Messages | Messages |
| Google AI Studio | `google/` | Chat Completions | — |
| DeepSeek | `deepseek/` | Chat Completions | — |
| xAI | `xai/` | Chat Completions | — |

REST モードで使えるのは OpenAI と Anthropic だけです。REST 経由の場合、Cloudflare は Google のモデルを Vertex AI 経由で、DeepSeek を Fireworks 経由で提供し、保存された xAI キーも使いません。そのため、ゲートウェイ内のキーはこの 3 社には使われません。また、REST は Cloudflare の[モデルカタログ](https://developers.cloudflare.com/ai/models/)にある ID しか受け付けないため、REST モードではこのカタログにある OpenAI と Anthropic のモデルだけを、カタログの ID で一覧表示します。これらの ID はベンダー自身の ID と異なる場合があります。マイナーバージョンを持つ Anthropic のモデル（`claude-sonnet-5-5` など）は、カタログでは `claude-sonnet-5.5` です。ネイティブモードでは各ベンダー自身の ID を使います。

一覧に表示されるのは、ゲートウェイにキーが保存されているベンダーだけです。ネイティブモードでは、各ベンダーの一覧をゲートウェイ経由でベンダー自身から取得し、失敗した場合は [models.dev](https://models.dev) から取得します。REST モードでは、Cloudflare のカタログページから一覧を取得し、ページを読み込めない場合は models.dev にあるカタログのコピーを使います。コンテキストウィンドウ、推論レベル、料金も models.dev から取得します。

## ネイティブモードと REST モード

- **ネイティブ（Native）** は、各ベンダー自身の API を `gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>/…` に送ります。変換は一切行わないため、prompt caching、extended thinking、Responses API がそのままベンダーに届きます。Claude Code と Codex にはこちらを使ってください。
- **REST** は `cf-aig-gateway-id` を付けて `api.cloudflare.com/client/v4/accounts/<account>/ai/v1/…` に送ります。キーエイリアスは使えず、Cloudflare のカタログにある OpenAI と Anthropic のモデルだけを、カタログの ID で一覧表示します（前述のとおりです）。

## 課金の安全性

すべてのリクエストに `cf-aig-no-wholesale: true` が付くため、キーが保存されていないベンダーへのリクエストは、Unified Billing にフォールバックせずに失敗します。ネイティブエンドポイントでは 400 になることを実環境で確認済みです。REST モードでは、キーのないゲートウェイが 402（code 7007）を返し、課金はされませんでした。ただし、この確認ではアカウントに Unified Billing のクレジットがなかっただけという可能性を排除できないため、**Require provider credentials** は有効のままにしてください。その場合、REST は 403（code 2049）を返します。フォールバックを許可するには、次のコマンドを実行します。

```sh
magpie plugin options opencode-cloudflare-ai-gateway-auth '{"allowUnifiedBilling": true}'
```

## トラブルシューティング

| 症状 | 意味 |
|---|---|
| アカウントが再サインインを求める | Cloudflare が API トークンを拒否しました。トークンの有効期限が切れていないか、AI Gateway Run と Read の権限（REST モードでは Workers AI Read も）があるかを確認してください |
| モデルから 400（REST モードでは 402 または 403） | ゲートウェイのあなたのエイリアスに、そのベンダーのキーがありません（ネイティブモードでは code 2044）。400 は、プラグインがリクエストを送信する前に拒否した場合にも返ります。たとえば、未知のベンダープレフィックス、`<vendor>/<model>` 形式でないモデル ID、REST モードでの Google・DeepSeek・xAI です。どれに当たるかはメッセージに示されます |
| REST モードでモデルから 404 または 500 | Cloudflare のモデルカタログにその ID のモデルがありません（例：カタログの `claude-sonnet-5.5` ではなく、ベンダー自身の `claude-sonnet-5-5` を指定した）。一覧にあるモデルを選ぶか、ネイティブモードを使ってください |
| ベンダーから 401、ただしアカウントはサインインしたまま | ベンダーが、ゲートウェイに保存されたキーを拒否しました |
| モデルが見つからない | そのベンダーのキーがゲートウェイにないか、チャットモデルではありません。REST モードでは、Cloudflare のカタログにないモデルも表示されません |

## 開発

```sh
bun test
bun --env-file=.env.local scripts/probe.mjs   # live checks, needs .env.local
scripts/sandbox.sh native anthropic/<model>   # magpie in a throwaway HOME
```

## ライセンス

MIT

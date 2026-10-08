# Cloudflare AI Gateway BYOK 插件设计

- 日期：2026-10-08
- 状态：待审
- npm 包名：`opencode-cloudflare-ai-gateway-auth`
- magpie 供应商 ID：`cloudflare-ai-gateway`
- 目标宿主：magpie（≥ 0.1.1110）。OpenCode 兼容不作保证。

## 1. 背景与目标

### 1.1 问题

1. **BYOK 不生效**：magpie 的自定义供应商只要填了 Key，就会发送 `Authorization: Bearer <key>` 和 `x-api-key: <key>`；自定义请求头只能覆盖，不能删除。Cloudflare AI Gateway 的凭证优先级规定，请求自带厂商认证头时原样透传，不再使用网关托管的 key（BYOK）。所以用自定义供应商无法走 BYOK。
2. **拿不到模型列表**：Cloudflare 没有列出第三方模型（`openai/…`、`anthropic/…`）的 API。`GET /accounts/{acct}/ai/models/search` 只返回 Workers AI 的 `@cf/…` 模型（已用真实账号实测）。

### 1.2 目标

做一个 magpie 插件，用户添加一个账号（CF API Token + 账号 ID + 网关 ID）后：

- 通过指定网关，用网关里托管的厂商 key 调用模型，不走统一计费（Unified Billing）；
- 自动列出网关上配了 key 的厂商的可用模型；
- Claude Code（Anthropic Messages）、Codex（OpenAI Responses）、magpie 内置 Agent、其它 OpenAI 兼容客户端都能使用，且上游尽量使用厂商原生协议。

### 1.3 成功标准

1. `magpie plugin --json` 中，该账号列出 5 家支持厂商里所有已配 key 厂商的文本模型；
2. `magpie provider test cloudflare-ai-gateway <model>` 对每家厂商、两种模式都通过；
3. Cloudflare 网关日志显示这些请求使用 BYOK（非 wholesale / 统一计费）；
4. 在真实 magpie 中，Claude Code 与 Codex 经该供应商完成一次带工具调用的对话。

### 1.4 非目标（v1 不做）

- 自定义厂商（`custom-*`）、Hugging Face、Workers AI `@cf/` 模型；
- `auth.usage` 用量钩子（网关花费上限、日志统计）；
- 响应流改写（模型名回写等）；
- 提交到 magpie-community 的 `registry.json`（后续可选）。

## 2. 外部事实与依据

| 编号 | 事实 | 状态 | 来源 |
|---|---|---|---|
| F1 | 凭证优先级：请求带厂商认证 → 透传；否则用别名 `default` 的托管 key；否则走统一计费，除非网关 `byok_only` 或请求带 `cf-aig-no-wholesale: true`（此时 400） | 文档确认 | https://developers.cloudflare.com/ai-gateway/features/unified-billing/#credential-precedence |
| F2 | 原生入口：`https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/{provider}/…`，认证网关用 `cf-aig-authorization: Bearer <token>`，非默认别名用 `cf-aig-byok-alias` | 文档确认 | https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/ |
| F3 | REST API：`POST https://api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/{chat/completions｜responses｜messages}`，`Authorization: Bearer <CF token>`，`cf-aig-gateway-id` 选网关，模型 `provider/model` | 文档确认 | https://developers.cloudflare.com/ai-gateway/usage/rest-api/ |
| F4 | 认证网关的 token 需要 AI Gateway Run 权限 | 文档确认 | https://developers.cloudflare.com/ai-gateway/configuration/authentication/ |
| F5 | 网关 BYOK 配置可读：`GET /accounts/{acct}/ai-gateway/gateways/{gw}/provider_configs`；网关详情 `GET /accounts/{acct}/ai-gateway/gateways/{gw}`（含 `authentication`、`byok_only`） | 账号实测 | Cloudflare OpenAPI |
| F6 | 网关 BYOK 的 xAI 标识是 `grok`，models.dev `cloudflare-ai-gateway` 目录前缀是 `xai`；该目录无 Google 模型 | 实测 | models.dev api.json |
| F7 | magpie 插件：基础地址优先级 `loader.baseURL` > 模型 `provider.api` > 供应商 `api`；npm 包决定协议与路径后缀；请求体 `model` = 模型的 API id | 文档确认 | https://usemagpie.ai/docs/zh/plugins |

## 3. 架构

### 3.1 文件与职责

不引入运行时依赖，全部为 ES Module（`.mjs`），由 Bun 运行。

| 文件 | 职责 | 依赖 |
|---|---|---|
| `index.mjs` | 唯一导出插件函数，组装 `config` / `auth` / `provider` 钩子；测试辅助挂在 `export const _internal` | 其余模块 |
| `vendors.mjs` | 厂商映射表（纯数据 + 查询函数） | 无 |
| `route.mjs` | `route(input, init, account, options)` → `{url, init}`，纯函数，负责 URL、请求头、请求体改写 | `vendors.mjs` |
| `models.mjs` | 厂商发现、实时列表、models.dev 回退、元数据合并、过滤；模式 B 按 Cloudflare 模型目录列模型（6.2） | `vendors.mjs`、`cf.mjs`、`cfcatalog.mjs`、`cache.mjs`、`errors.mjs`（读错误码）、`route.mjs`（只取常量） |
| `cfcatalog.mjs` | 读取 Cloudflare 模型目录页面（Markdown），解析其中的 Text Generation 模型，缓存为 `cf-catalog.json`（6.2） | `cache.mjs` |
| `cache.mjs` | 磁盘缓存：6 小时有效期、刷新失败用过期副本、失败后 10 分钟不重试、形状校验；models.dev 与 Cloudflare 目录共用 | 无 |
| `cf.mjs` | Cloudflare API 小客户端：读 `provider_configs`，统一错误分类 | `route.mjs`（只取 API 常量） |
| `errors.mjs` | 上游错误 → `X-Magpie-Sign-In` 判定；按协议格式构造本地错误响应 | 无 |
| `test/*.test.mjs` | `bun test` 单元测试，fetch 全部模拟 | 被测模块 |

### 3.2 模型命名

- 插件内部模型键 = `<统一前缀>/<原生ID>`，例如 `anthropic/claude-sonnet-5-5`（Anthropic 原生 ID 用连字符）、`openai/gpt-5.5`、`xai/grok-4.3`。
- 模式 B 例外：模型键的 ID 部分是 Cloudflare 模型目录的 ID，例如 `anthropic/claude-sonnet-5.5`（目录里带小版本号的 Anthropic 模型用点），见 6.2。
- agent 中写作 `cloudflare-ai-gateway/<模型键>`。
- 模型的 API id（`api.id`）等于模型键，所以 `fetch` 收到的请求体 `model` 永远带厂商前缀，路由据此判断厂商。

### 3.3 数据流

```
agent ──(任意协议)──> magpie 网关 ──(翻译成模型声明的协议)──> 插件 fetch
                                                            │ route()：解析厂商 → 改写 URL/头/体
                                                            ▼
                     模式 A：gateway.ai.cloudflare.com/v1/{acct}/{gw}/{slug}/…（原生协议）
                     模式 B：api.cloudflare.com/client/v4/accounts/{acct}/ai/v1/…（REST）
                                                            │ 响应原样流式返回
                                                            ▼
                                       errors.mjs 只在非 2xx 时加 X-Magpie-Sign-In
```

## 4. 登录与配置

### 4.1 登录方法

一个 `type: "api"` 方法，key 字段 = CF API Token。`prompts` 依次为：

| key | 类型 | 说明 | 校验 |
|---|---|---|---|
| `account` | text | Cloudflare Account ID | `/^[0-9a-f]{32}$/` |
| `gateway` | text | Gateway ID，示例 `my-gateway` | 不超过 64 字符，且符合 Cloudflare OpenAPI 中的网关 ID 规则 `/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/` |
| `mode` | select | `native`（原生入口，推荐）/ `rest`（REST API） | — |
| `alias` | text | BYOK key 别名，留空即 `default`；仅 `mode == native` 时询问 | 可空，否则须符合 `/^[A-Za-z0-9_-]{1,64}$/`（会作为 `cf-aig-byok-alias` 请求头发送）；`authorize` 与读取已保存的登录时同样校验 |

### 4.2 `authorize(inputs)`

magpie 不把 key 字段的值传给 `api` 方法的 `authorize`（`internal/plugin/host.js` 的 `apiKey()` 只调用 `m.authorize(inputs)`，key 由宿主自己保存），所以登录时无法用 token 调 CF API。`authorize` 只做：

1. 再次校验并规范化 `account`（trim、转小写）、`gateway`（trim）、`mode`（缺省 `native`）、`alias`（trim，`default` 视为空）；不合法返回 `{type: "failed", error}`。
2. 返回 `{type: "success", metadata: {account, gateway, mode, alias, email}}`，不返回 `key`（宿主用用户填写的 key 保存）。`email` 只用于账号显示名：magpie 按 `accountId` → `metadata.email` → `email` 取名，而 api 账号只保存 `metadata`。格式为 `<gateway>[/<alias>] · <account 前 8 位>[ · REST]`：别名非空时接在网关后，REST 模式在末尾加 ` · REST`。magpie 宿主的 `settle()` 登录时会替换同名账号（api 账号没有 uid），所以名称必须包含区分两次登录的全部字段（网关、别名、模式），否则同一网关的不同别名或不同模式会互相覆盖；同一（网关、账号、别名、模式）重新登录仍替换旧账号，正好用于轮换 token。
3. token 有效性在第一次 `provider.models` 时验证（见第 6 节第 1 步）：CF API 返回 401 → 抛出带 `signIn: "expired"` 的错误，账号显示需要重新登录并附原因。
4. 多网关 / 多账号 = 多次登录；magpie 自动对它们做故障切换。

### 4.3 Token 权限

- 必需：AI Gateway Run（调用）、AI Gateway Read（登录校验、厂商发现）。
- 模式 B 另需 Workers AI Read：V4 已实测证实（见 11.2、11.6），已写入 README。

### 4.4 插件选项（`plugins.json` 的 `options`）

| 选项 | 默认 | 作用 |
|---|---|---|
| `allowUnifiedBilling` | `false` | 为 `false` 时，每个请求（含第 6 节的模型列表请求）带 `cf-aig-no-wholesale: true`，没有托管 key 时直接 400，绝不回落统一计费 |

## 5. 请求路由

### 5.1 占位基础地址

`loader` 返回 `baseURL: "https://cloudflare-ai-gateway.invalid"`（占位，永不直连）和自定义 `fetch`。magpie 拼出的 `input` = 占位地址 + 协议路径，`fetch` 内调用 `route()` 改写后再发出。

`route()` 从 `input` 取协议路径：`/messages`、`/responses`、`/chat/completions`，或 Gemini 的 `/models/<id>:(stream)GenerateContent`。从请求体 `model`（Gemini 从 URL 路径，兼容 `/` 与 `%2F` 两种写法）解析出 `厂商前缀/原生ID`。

### 5.2 厂商映射表（`vendors.mjs`）

| 厂商 | `prefix`（统一前缀） | `slug`（网关标识） | 模式 A 默认协议（npm） | 模式 A 各协议原生路径（接在 `{gw}/{slug}` 后） | 模式 B 协议 | 实时列表路径 | models.dev 目录 |
|---|---|---|---|---|---|---|---|
| OpenAI | `openai` | `openai` | `@ai-sdk/openai`（Responses） | `/responses`、`/chat/completions` | Responses | `/models` | `openai` |
| Anthropic | `anthropic` | `anthropic` | `@ai-sdk/anthropic`（Messages） | `/v1/messages`、`/v1/chat/completions` | Messages | `/v1/models?limit=1000` | `anthropic` |
| Google | `google` | `google-ai-studio` | `@ai-sdk/openai-compatible`（Chat；magpie 把 `@ai-sdk/google` 当 Code Assist，见 11 节 V8） | `/v1beta/openai/chat/completions`、`/v1beta`（Gemini 分支保留） | 无（`rest: null`，见 11.6） | `/v1beta/models?pageSize=1000` | `google` |
| DeepSeek | `deepseek` | `deepseek` | `@ai-sdk/openai-compatible`（Chat） | `/chat/completions` | 无（`rest: null`，见 11.6） | `/models` | `deepseek` |
| xAI | `xai` | `grok` | `@ai-sdk/openai-compatible`（Chat） | `/v1/chat/completions`、`/v1/responses` | 无（`rest: null`，见 11.6） | `/v1/models` | `xai` |

路由按（厂商, 协议路径）查表，不按「每厂商一种协议」硬编码，所以即使模型声明了非默认协议（例如 models.dev 回退数据带来的 npm），只要该厂商支持该协议路径就能正确转发。表中查不到的组合返回 400（见 7.2）。

### 5.3 模式 A（原生入口）改写规则

- URL：`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{slug}{原生路径}`，保留原查询串（如 Gemini 的 `alt=sse`）。
- 请求体：`model` 改为原生 ID；Gemini 的模型 ID 在路径里，请求体不动。
- 删除请求头：`authorization`、`x-api-key`、`x-goog-api-key`（大小写不敏感）。
- 设置请求头：
  - `cf-aig-authorization: Bearer <token>`
  - `alias` 非空且不为 `default` 时：`cf-aig-byok-alias: <alias>`
  - `allowUnifiedBilling == false` 时：`cf-aig-no-wholesale: true`
- 其余头原样保留（`anthropic-version`、`anthropic-beta`、`content-type`、`accept` 等）。

### 5.4 模式 B（REST API）改写规则

- URL：`https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1{协议路径}`；协议路径只允许 `/messages`、`/responses`、`/chat/completions`。
- 请求体：`model` 改为 `<restPrefix>/<模型键中的 ID>`（`openai`、`anthropic` 的 `restPrefix` 与前缀相同）。模式 B 列出的就是目录 ID（6.2），所以原样发送，请求时不做 ID 转换。
- 删除请求头：`x-api-key`、`x-goog-api-key`；`authorization` 覆盖为 `Bearer <token>`。
- 设置请求头：`cf-aig-gateway-id: <gateway>`；`cf-aig-no-wholesale` 规则同模式 A。
- 模式 B 下 `models()` 给每个模型声明的协议见 5.2「模式 B 协议」列；该列为「无」的厂商在模式 B 下不列出，请求在本地返回 400（7.2）。
- REST 只接受 Cloudflare 模型目录（https://developers.cloudflare.com/ai/models/）里的模型 ID，它与厂商原生 ID 不一定相同；目录外的 ID 失败（见 11.6）。因此模式 B 只列目录里的模型（6.2）。

## 6. 模型列表（`provider.models`）

对每个账号（模式 A 依次走第 1～7 步；模式 B 走第 1、5、6、7 步，第 2～4 步换成 6.2，不请求厂商实时列表）：

1. **厂商发现**：`GET /accounts/{account}/ai-gateway/gateways/{gateway}/provider_configs`（分页 `page`/`per_page`），取 `alias` 与账号别名（空即 `default`）匹配的条目的 `provider_slug`，与映射表的 5 家取交集。
   - 401：token 无效 → 抛出带 `signIn: "expired"` 的错误；
   - 403（缺少 AI Gateway Read）或其他失败：日志提示，按 5 家全部处理。
2. **实时列表**（仅模式 A；各厂商并行，每个 8 秒超时，经原生入口获取。模式 B 不请求实时列表：REST API 没有列表端点，且只接受目录 ID，见 6.2）：`GET {gw}/{slug}{实时列表路径}`，头同 5.3（无请求体）：`cf-aig-authorization`、非默认别名的 `cf-aig-byok-alias`，以及 `allowUnifiedBilling` 不为 `true` 时的 `cf-aig-no-wholesale: true`（`listModels` 从 `index.mjs` 接收插件选项，缺省即带该头）。返回 400 且错误码（与 `errors.mjs` 同一解析）含 2044（该别名下没有这家厂商的托管 key，见 11.3）时，整家厂商不列出，也不走第 3 步的 models.dev 回退。成功时解析：
   - OpenAI / DeepSeek / xAI：`{data: [{id}]}`
   - Anthropic：`{data: [{id, display_name}]}`
   - Google：`{models: [{name: "models/<id>", displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods}]}`，只保留含 `generateContent` 的
3. **回退**：某厂商实时列表失败（含 V2 不成立的情况，不含第 2 步的 2044）→ 用 models.dev 中该厂商原生目录的全部模型（模型 ID 取目录的键，不取条目里的 `id` 字段）。
4. **元数据合并**：按原生 ID 匹配 models.dev 原生目录，补 `name`、`limit`、`reasoning`/`variants`、`tool_call`、`temperature`、`modalities`、`cost`。精确 ID 没有条目时，去掉末尾的日期后缀（`-YYYY-MM-DD` 或 `-YYYYMMDD`）再查一次，日期快照借用基础模型的元数据，但不借用名称（避免与基础模型同名）。每个字段的取值优先级：models.dev → 实时列表自带的信息（Anthropic 的 `display_name`、Google 的 `displayName` 与 token 上限）→ 默认值（上下文 128000、输出 16384、支持工具调用、不推理、不支持 `temperature`：与 magpie 自身的 `temperature ?? false` 一致，推理模型会拒绝 temperature）。
5. **过滤**：
   - 去掉 `status: "deprecated"`（日期快照经第 4 步借用基础模型的元数据，所以基础模型已弃用时快照一并去掉，例如 `o4-mini-2025-04-16`）；
   - ID 含 `embed`、`-tts`、`image`、`audio`、`-live`、`realtime`、`moderation`、`whisper`、`dall-e`、`sora`、`transcribe`、`computer-use`、`deep-research` 的（参照 magpie `textModel`；这是各厂商共用的子串启发式，可能漏判或误判）；
   - 命中该厂商 `list.skip` 正则的 ID（`vendors.mjs`，只作用于本厂商，不依赖 models.dev）：OpenAI 只支持旧 Completions 的 `davinci-002`、`babbage-002`、`gpt-3.5-turbo-instruct*` 与只支持 Chat Completions 的 `*-search-preview*`、`*-search-api*`（走 Responses 会 400）；Google 的 Lyria（音乐）与 nano-banana（图像）；xAI 的 `grok-imagine-*`（图像 / 视频）；
   - models.dev 标明输出不含 `text` 的。
6. **输出**：键为模型键（`前缀/原生ID`；模式 B 为 `前缀/目录 ID`，见 6.2），`api: {id: 模型键, url: 占位地址, npm: 按账号模式与 5.2 选择}`。单个厂商实时列表失败、改用 models.dev 补齐属于正常路径，只写日志，不标记回退。
7. **最终列表为空**：返回 `provider.models` 的副本并打上 `Symbol.for("magpie.fellBack")`，magpie 保留它原有的列表。

**内存缓存**：magpie 宿主在每个推理请求之前都会调用 `provider.models`（见 11.4），所以 `listModels` 把每个账号的结果缓存在插件进程内存里（不写盘）10 分钟（`LIST_TTL`）：

- 键 = token 的 SHA-256 摘要 + `account` + `gateway` + `mode` + `alias` + `allowUnifiedBilling`；token 原文不进入键、日志或文件；同一网关的模式 A 与模式 B 列表分开缓存；
- 同一键的并发调用共享同一个进行中的 Promise，只发一轮请求；
- 失败（含抛出 `signIn: "expired"`）与空列表不缓存，下次调用重新获取；
- 每个调用方拿到结果的独立副本；`resetModelCache()` 供测试清空缓存。

### 6.1 models.dev 缓存

- 文件：`<directory>/cloudflare-ai-gateway-auth/models-dev.json`（`directory` 为 magpie 配置目录）。
- 只保留 5 家厂商的原生目录与 `cloudflare-ai-gateway`（6.2 的回退与元数据来源）。
- 文件内容须为 `{fetchedAt, data}`，且 `data` 中这 6 个目录的 `models` 都是对象；损坏或形状不对的文件视同没有缓存（旧版本写的、缺 `cloudflare-ai-gateway` 的文件也一样，会重新拉取）。
- 有效期 6 小时；刷新失败时继续用过期缓存；无缓存且拉取失败时，回退步骤只能返回空（交给第 7 步）。
- 刷新失败后在内存里记住 10 分钟（`CATALOG_RETRY`）不再请求 models.dev：期间有过期缓存就直接用，没有则照常抛错，不重新拉取。
- 以上规则由 `cache.mjs` 实现，6.2 的 `cf-catalog.json` 共用；两者的失败记录按文件分开，互不影响。`resetModelCache()` 同时清空两者的失败记录。

### 6.2 模式 B（REST API）的模型列表

REST 只接受 Cloudflare 模型目录里的 ID，且只有 OpenAI、Anthropic 用得上网关托管的 key（11.6）。所以模式 B 直接列目录里这两家的模型，不请求厂商实时列表（用户已批准，2026-10-08）。

- **来源**：`https://developers.cloudflare.com/ai/models/index.md`，即目录页面的 Markdown 版。目录没有机器可读的接口（1.1）。
- **解析**（`cfcatalog.mjs` 的 `parseCfCatalog`）：
  - 每个条目形如 `[![<Logo>](…)<h3><ID></h3>`，空行后接 `<作者><任务> <描述>](https://developers.cloudflare.com/ai/models/<author>/<ID>/)`。其他任务（`Text-to-Speech`、`Text-to-Image`、`Automatic Speech Recognition` 等）也是同样的形状。有些条目没有 logo 图，开头只剩一个字母（如 `[d<h3>deepseek-v4-pro</h3>`），或是 `[Pinned![<Logo>](…)<h3>`。
  - 按每个条目的 `<h3>` 标题切分（不按 `[![`，否则没有 logo 图的条目会被漏掉）。作者与 ID 取自标题之后的链接路径 `/ai/models/<author>/<ID>/`；只有标题与链接之间的文本（空白归一后）含 `Text Generation` 的条目才保留。带点的 ID 原样保留。
  - Workers AI 模型的链接是 `/ai/models/@cf/<author>/<ID>/`，作者以 `@` 开头，不匹配，不列出（1.4）。
  - 2026-10-08 的页面有 172 个 `/<author>/<ID>/` 链接，其中 69 个是 Text Generation（OpenAI 25 个，Anthropic 13 个）。其中 5 个没有 logo 图（`deepseek/deepseek-v4-pro`、`thinkingmachines/inkling`、`thinkingmachines/inkling-256k`、`typesafe/jev`、`unbiased/pareto`）。
- **缓存**：
  - 文件为 `<directory>/cloudflare-ai-gateway-auth/cf-catalog.json`，内容 `{fetchedAt, data: [{author, id}]}`。
  - 规则同 6.1：有效期 6 小时；刷新失败时用过期副本；失败后 10 分钟不重试。形状不对的文件视同没有，包括非数组、空数组、条目缺 `author` 或 `id` 字符串。
  - 解析为 0 条（例如页面改版）按刷新失败处理。
- **回退**：
  - 页面取不到或解析为 0 条，且没有可用缓存时，写 warn 日志，改用 models.dev `cloudflare-ai-gateway` 的模型键。键形如 `anthropic/claude-sonnet-5.5`，在第一个 `/` 处切成作者与 ID。
  - 两者都不可用时，列表为空，走第 7 步。
- **模型键**：
  - 对映射表中 `rest` 不为 `null`、且网关有 `default` 别名托管 key（第 1 步）的厂商（目前是 `openai`、`anthropic`），取作者等于其 `restPrefix` 的目录条目。
  - 模型键为 `<prefix>/<目录 ID>`，例如 `anthropic/claude-sonnet-5.5`。`api.npm` 按 5.2 的模式 B 协议：OpenAI 为 Responses，Anthropic 为 Messages。
  - 第 5 步的过滤（`isTextModel`、厂商的 `list.skip`）照常适用。
  - 路由（5.4）原样发送 `<restPrefix>/<目录 ID>`，请求时不做转换。
- **元数据**（`restMetaFor`）：依次查找，取第一个命中的条目；条目里缺的字段用第 4 步的默认值。
  1. models.dev `cloudflare-ai-gateway` 的 `models["<restPrefix>/<ID>"]`；
  2. 厂商原生目录中的同一 ID；
  3. 原生目录中把 `.` 换成 `-` 的 ID（`claude-sonnet-5.5` → `claude-sonnet-5-5`）；
  4. 第 4 步的日期后缀回退，先用原 ID，再用换成 `-` 的 ID。
- 模式 A 完全不变：实时列表、models.dev 回退等照旧。

## 7. 错误处理

### 7.1 上游非 2xx（只加头，不改体）

| 情况 | 判定依据 | `X-Magpie-Sign-In` |
|---|---|---|
| CF token 被拒（原生入口） | 401 且响应体为 AI Gateway 错误（`code` 2009 等网关错误码） | `expired` |
| CF token 被拒（REST） | 401 且 CF API 信封错误 `code` 10000 | `expired` |
| 厂商拒绝托管 key | 其他 401 / 403 | `kept` |
| 未配 key / byok_only / no-wholesale | 400 | 不加，透传 |
| 429 / 5xx | — | 不加，透传（magpie 故障切换） |

改写响应头时去掉 `content-length`、`content-encoding`（仅当需要读取响应体做判定的 401/403 分支；其余分支直接透传原 Response）。

### 7.2 本地错误

厂商前缀未知、协议路径不支持等，在本地按请求协议的错误格式返回 400。不支持的路径的消息为 `Unsupported endpoint: <路径>`（带冒号，magpie 识别「不支持的端点」的正则要求冒号）；某协议路径下的子路径（如 Claude Code 的 `/messages/count_tokens`）按该协议的格式返回，其余按 chat 格式。count_tokens 不转发到任何上游。

- Anthropic：`{"type":"error","error":{"type":"invalid_request_error","message":…}}`
- OpenAI（chat / responses）：`{"error":{"message":…,"type":"invalid_request_error"}}`
- Gemini：`{"error":{"code":400,"message":…,"status":"INVALID_ARGUMENT"}}`

### 7.3 日志

只记录厂商、协议、状态码、去掉查询串的 URL；绝不记录请求体、响应体内容、token、厂商 key。

## 8. 测试

### 8.1 第一步：实测待定项（Spike）

用户提供一个具备 AI Gateway Run + Read 的 token，放在项目根目录 `.env.local`（`chmod 600`，已 gitignore），脚本 `scripts/probe.sh` 从中读取，不在命令行与输出中出现 token。每个推理请求 `max_tokens: 1`，费用记在用户托管的厂商 key 上。

| 编号 | 问题 | 不成立时的处理 |
|---|---|---|
| V1 | 原生入口删掉厂商认证头后，各厂商请求是否成功并走 BYOK | 该厂商在模式 A 下标为不支持，README 说明 |
| V2 | `GET {gw}/{slug}/…models` 是否透传并使用托管 key | 实时列表步骤删除，models.dev 回退成为主路径 |
| V3 | REST API 下 Google、xAI 的模型前缀 | 映射表加 `restPrefix`；若 REST 不支持某厂商，模式 B 下不列出它 |
| V4 | 模式 B 的 token 是否需要 Workers AI Read | 写入 README 权限说明与登录失败提示 |
| V5 | `cf-aig-no-wholesale: true` 在两种入口上是否生效（对无 key 厂商返回 400） | 若 REST 不支持，README 说明模式 B 依赖网关 `byok_only` |
| V6 | Anthropic 原生入口仅用 `cf-aig-authorization` + `anthropic-version`，`anthropic-beta`、流式、工具调用是否正常 | 记录差异，必要时在 `route()` 中补头 |
| V7 | Gemini 原生路径 `…/v1beta/models/<id>:streamGenerateContent?alt=sse` 是否正常 | 改用 `/v1beta/openai/chat/completions`，Google 默认协议改为 Chat |
| V8 | magpie 侧：占位 `baseURL` 是否被接受；Gemini 路径中带 `/` 的模型 ID 是否被编码 | 调整占位地址或路径解析 |
| V9 | CF 鉴权错误的状态码与错误码：原生入口 token 无效、REST token 无效、CF API token 无效 / 缺权限 | 更新 `errors.mjs` 与 `cf.mjs` 的判定集合 |

实测结果写入 `vendors.mjs` 并在本文档追加「实测记录」一节。

### 8.2 单元测试（`bun test`）

- `route()`：5 厂商 × 2 模式 × 各支持协议，断言 URL、删除/新增的头、请求体 `model`；别名、`allowUnifiedBilling` 开关；未知厂商与不支持协议的本地 400。
- `models.mjs`：各厂商列表解析（固定样本）、models.dev 合并与默认值、过滤规则、部分失败回退、全部失败返回原值、401 抛 `signIn: "expired"`。
- `errors.mjs`：7.1 表格每一行。
- `cf.mjs`：`provider_configs` 分页、别名过滤、401 / 403 / 其他错误的分类。
- `cfcatalog.mjs`：用手写的小样本页面（不提交下载的目录页）测解析（只取 Text Generation、作者与 ID 取自链接、保留带点的 ID、忽略 tts / 图像 / ASR 与 `@cf` 模型、无匹配返回 `[]`、条目内多余空白与换行）与 6.2 的缓存规则；`models.mjs` 模式 B：键为目录 ID、不请求网关列表、按托管 key 过滤、元数据查找顺序、回退时写 warn、与模式 A 分开缓存。
- `index.mjs`：`authorize` 的规范化与校验、`config` 钩子、`models` 钩子的空列表回退。

### 8.3 集成测试

沙箱运行 magpie（`HOME`、`XDG_*` 指向临时目录，`MAGPIE_ADDR=127.0.0.1:3499`）：从 `.env.local` 直接写入沙箱的 `plugin-auth.json`（`plugin login` 是交互式的，且会让 token 经过终端；登录流程由 `authorize` 单元测试和 8.5 人工验收覆盖），然后 `plugin add ./`、`plugin --json`、对每个厂商两种模式各跑 `provider test`。`plugin --json` 的原始输出含账号名（网关、账号 ID 前 8 位）与 magpie 的 `accounts[].hint`（token 末 4 位），只写在沙箱临时目录（退出即删），终端只打印 `scripts/listing.mjs` 生成的摘要：各厂商前缀的模型数、npm 包集合与模型 ID（模型 ID 不含账号信息）。

### 8.4 BYOK 生效验证

用 Cloudflare API 只读查询网关日志，确认集成测试产生的请求未使用统一计费。

### 8.5 人工验收

用户在真实 magpie 中添加插件，分别用 Claude Code、Codex 完成一次带工具调用的对话。

## 9. 发布

- 仓库：`opencode-cloudflare-ai-gateway-auth`，代码注释、commit message、README 使用英文；commit 签名与提交者邮箱按用户全局约定，推送前逐个校验签名状态为 `G`。
- `package.json`：`type: module`、`main: ./index.mjs`、`files` 白名单（仅 `*.mjs`、`README.md`、`LICENSE`，不含 `docs/`、`test/`、`scripts/`）、`keywords: ["opencode", "opencode-plugin", "cloudflare", "ai-gateway", "byok", "magpie"]`、`license: MIT`、`magpie.icon`（通用云朵图标，不使用 Cloudflare 商标图形）、`repository`。
- README：声明非 Cloudflare 官方项目；说明登录项、token 权限、两种模式差异、支持厂商与模型来源、凭证存放位置（magpie `plugin-auth.json`）。
- GitHub：`gh` 创建公开仓库，加 topic `magpie-plugin`。
- npm：由用户登录并执行或确认 `npm publish`。
- 每一步对外操作（建仓库、推送、发布）执行前单独征得用户同意。

## 10. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| CF 原生入口或 REST 行为变更 | 请求失败 | 映射表集中在 `vendors.mjs`；集成测试脚本可随时重跑 |
| 厂商列表接口不经网关透传（V2） | 列表依赖 models.dev，新模型滞后 | 回退路径已是一等公民；用户仍可手动在 magpie 中补模型 |
| models.dev 下线或格式变化 | 元数据缺失 | 本地缓存 + 默认元数据 |
| Cloudflare 目录页面改版或取不到 | 模式 B 列表缺失 | 解析为 0 条按失败处理：先用过期缓存，再回退 models.dev `cloudflare-ai-gateway`，写 warn（6.2） |
| 误走统一计费 | 意外扣费 | 默认 `cf-aig-no-wholesale: true`；README 建议网关开启 `byok_only` |

## 11. 实测记录（2026-10-08）

### 11.1 条件

- 脚本：`scripts/probe.mjs`（8.1 原写 `probe.sh`，实际为 Bun 脚本），运行 `PROBE_V5=1 bun --env-file=.env.local scripts/probe.mjs`，结果写入 `probe-report.json`（已 gitignore，token 已脱敏）。
- Token 权限：Account › AI Gateway › Run + Read，**没有** Workers AI 权限。
- 网关：开启认证；`provider_configs` 在 `default` 别名下有 `openai`、`anthropic`、`google-ai-studio`、`deepseek`、`grok` 的 key（另有 4 个本插件不支持的 slug）。条目带 `provider_slug` 与 `alias` 字段，与 `cf.mjs` 的读取方式一致。
- 共运行两次。第 1 次脚本为 xAI 自动选中了视频模型 `grok-imagine-video-…-lite`（`lite` 命中 CHEAP，SKIP 不含 `imagine` / `video`），`V1.xai.chat` 30 秒超时，原因在脚本选模型，与 Cloudflare 无关。第 2 次用脚本自带的 `PROBE_MODEL_XAI` 指定文本模型重跑；除这一项外，两次各键的状态码与模型数完全一致。下表以第 2 次为准。
- 第 2 次各厂商所用模型：OpenAI `chat-latest`、Anthropic `claude-haiku-5-5`、Google `gemini-2.5-flash`、DeepSeek `deepseek-flash`、xAI `grok-4.20-0309-non-reasoning`。
- 补充检查（零成本，临时脚本，未提交）：用随机生成、格式正确但不存在的 40 字符 token 分别请求原生入口、REST、CF API，确认「格式正确的无效 token」的拒绝方式；token 无效时请求在鉴权阶段即被拒，不产生推理。

### 11.2 结论

| 编号 | 结论 | 状态码 / 证据 | 采用的处理 |
|---|---|---|---|
| V1 | 成立（各厂商默认协议） | OpenAI `/responses`、Anthropic `/v1/messages`、Google `:generateContent`、DeepSeek `/chat/completions`、xAI `/v1/chat/completions` 均 200。请求不带厂商认证头且带 `cf-aig-no-wholesale: true`，无托管 key 时会 400（见 V5），所以 200 即使用了托管 key | `VENDORS.native` 不变。非默认原生路径（OpenAI / Anthropic / Google 的 chat，xAI 的 responses）未实测 |
| V2 | 成立 | 5 家 `…models` 均 200，可解析模型数：OpenAI 139、Anthropic 14、Google（含 `generateContent`）45、DeepSeek 2、xAI 14 | `list` 不变 |
| V3 | 首测未能实测；复测（11.6）：`openai`、`anthropic` 成立，Google、DeepSeek、xAI 没有可用的前缀 | 首测：7 个 REST 请求（含 Google 的 `google-ai-studio/`、`google/` 与 xAI 的 `xai/`、`grok/` 两组前缀）全部 401，`errors[0].code` 10000：token 缺 Workers AI 权限（V4），请求在模型路由前即被拒 | 首测：按官方 REST 文档「Model naming」（https://developers.cloudflare.com/ai-gateway/usage/rest-api/#model-naming），Google 的 `restPrefix` 由 `google-ai-studio` 改为 `google`，xAI 保持 `xai`。复测后：两者路由正确，但 REST 用不上网关托管的 key，Google、DeepSeek、xAI 的 `rest` 改为 `null`（见 11.6） |
| V4 | 成立（需要）；复测证实 | 仅有 AI Gateway 权限的 token 调 `/ai/v1/*` 全部 401 / 10000。官方文档同一页「Authentication」：所有 `/accounts/{id}/ai/*` 端点需要 Account › Workers AI › Read，只有 AI Gateway 权限的 token 返回 401 / 10000。复测（11.6）：加上 Workers AI Read 后不再出现 401 / 10000 | README「Token permissions」：模式 B 另需 Account › Workers AI › Read；缺少时每个推理请求 401 / 10000，与 token 无效无法区分，插件标为 `expired` |
| V5 | 原生入口成立；REST 拒绝但不是 400（11.6） | 原生入口 → 无托管 key 的 `default` 网关：400，`error[0].code` 2044（"Customer-provided provider credentials are required for this request"）。REST 首测 → 401 / 10000（同 V4）；复测 → `default` 网关 402 / 7007，`byok_only` 网关 403 / 2049，均未计费 | 原生入口无需改动。README 写明 REST 的拒绝形状，并要求模式 B 开启网关 `byok_only`（控制台 Require provider credentials） |
| V6 | 成立 | `stream: true` + `tools` + `anthropic-beta` → 200，`text/event-stream`，首个事件 `message_start` | 无需在 `route()` 中补头 |
| V7 | 成立 | `:streamGenerateContent?alt=sse` → 200，`text/event-stream` | 路径可用，但默认协议因 V8 改为 Chat |
| V8 | 占位 `baseURL` 被接受。magpie 把 npm 为 `@ai-sdk/google` 的插件模型映射到 Code Assist 协议（`internal/provider/plugins.go` 的 `pluginProtocol`；`internal/gateway/gateway.go` 的 `pathOf` 给出 `/v1internal:streamGenerateContent?alt=sse`，带 Code Assist 信封与包装过的响应流），`route.mjs` 与网关的 google-ai-studio 端点都不支持 | 已安装的 magpie 对 Google 实际走 chat，`google/gemini-2.5-flash` 在网关日志中为 `v1beta/openai/chat/completions`（200）。沙箱复测：改为 chat 后 Google 的 27 个模型 npm 均为 `@ai-sdk/openai-compatible`，`provider test` 通过 | Google 的 `native.protocol` 改为 `chat`（V7 的回退方案）；`paths.gemini` 与 `route.mjs` 的 Gemini 分支保留 |
| V9 | 原生入口、REST 与预期一致；CF API 对格式错误的 token 返回 400 | 见 11.3 | `GATEWAY_AUTH_CODES = {2009}`；`API_AUTH_CODES = {10000}`（去掉未观察到的 9109）；`errorCodes` 读 `error` / `errors` 数组，与实测形状一致，不改；`listModels` 把 CF API 的 400 / 9106 也视为 token 被拒（`signIn: "expired"`） |

### 11.3 V9：Cloudflare 拒绝的形状

| 入口 | 情况 | 状态 | 响应体字段 | `code` |
|---|---|---|---|---|
| 原生入口 | token 格式错误，或格式正确但不存在 | 401 | `success: false`、`result: []`、`messages: []`、`error: [{code, message}]`、`name: "AiGatewayError"`、`httpCode`、`internalCode`、`message`、`description` | 2009（`internalCode` 同值） |
| 原生入口 | 无托管 key 且带 `cf-aig-no-wholesale: true` | 400 | 同上 | 2044 |
| REST | token 格式错误、格式正确但不存在、缺 Workers AI 权限 | 401 | `result: null`、`success: false`、`errors: [{code, message}]`、`messages: []` | 10000 |
| CF API（`provider_configs`） | token 格式正确但不存在 | 401 | 同 REST | 10000 |
| CF API（`provider_configs`） | token 格式错误，或无认证头 | 400 | 同 REST | 9106 |

未实测：CF API 在 token 缺 AI Gateway Read 时的状态码与错误码（没有这样的 token）。若与 REST 一样返回 401 / 10000，`listModels` 会标 `expired`，而不是第 6 节第 1 步设想的「403 → 按 5 家全部处理」。

### 11.4 其他发现

- magpie 0.1.1110 的插件宿主在每次插件 fetch 前（`fetchAs()`，为 `chat.headers` 准备模型信息）都调用 `info(provider, key)`，后者每次都调用插件的 `provider.models`，且 `info()` 本身不缓存。不加缓存时，每个推理请求之前都会多一次 CF API `provider_configs` 调用、5 次网关列表调用和一次 `models-dev.json` 读取：增加延迟、在网关日志里多出 5 行、消耗网关限流额度，并占用 CF API 每 5 分钟 1200 次的共享限额。因此第 6 节在内存中缓存列表。
- 官方文档（统一计费「Credential precedence」与 BYOK「Key aliases」）：REST `/ai/v1/*` 属统一计费端点，只认 `default` 别名的托管 key，`cf-aig-byok-alias` 只对原生入口生效；`default` 下没有 key 时回落统一计费（`cf-aig-no-wholesale` / `byok_only` 可阻止）。与 4.1「`alias` 仅 `mode == native` 时询问」一致，README 需说明。
- xAI 实时列表含非文本模型 `grok-imagine-*`（含视频生成），其 id 不含第 6 节第 5 步的过滤词；若 models.dev 未标注其输出不含 `text`，会被列出。最终评审已处理：xAI 的 `list.skip` 按 ID 过滤 `grok-imagine-*`（见第 6 节第 5 步）。

### 11.5 Task 7：沙箱集成（原生模式）

脚本：`scripts/sandbox.sh native …`（临时 HOME / XDG_*，不触碰真实 `~/.config/magpie`）、`scripts/logs.mjs`。

| 厂商 | 模型 | magpie 协议 | `provider test` | 列表中的模型数 |
|---|---|---|---|---|
| Anthropic | `anthropic/claude-haiku-5-5` | anthropic | 通过 | 14 |
| OpenAI | `openai/chat-latest` | responses | 通过 | 75 |
| Google | `google/gemini-2.5-flash` | chat | 通过 | 27 |
| DeepSeek | `deepseek/deepseek-flash` | chat | 通过 | 2 |
| xAI | `xai/grok-4.20-0309-non-reasoning` | chat | 通过 | 8 |

- 插件列表：`cloudflare-ai-gateway`（共 126 个模型）已登录，无加载错误。
- 网关日志：最近日志包含各厂商的模型列表请求（200）与推理请求（Anthropic `v1/messages`、OpenAI `responses`、Google `v1beta/openai/chat/completions`，均 `success: true`）。结合 V5 与每个请求都带 `cf-aig-no-wholesale: true`，这些请求只可能使用 BYOK。日志 `cost` 均为 0。`detail` 字段含 `cost`、`tokens_in`、`tokens_out` 等，没有计费方式字段。`logs.mjs` 第一次运行返回一次性的 7000 Internal Error，重试后正常。
- REST 模式沙箱运行：首测时 token 缺 Workers AI Read，所有 REST 请求 401（见 V3 / V4），未运行；加上该权限后的运行见下表。

REST 模式（2026-10-08 复测，Google、DeepSeek、xAI 已为 `rest: null`）：`scripts/sandbox.sh rest …`，模型为 11.6 运行 2 的 `picked`（xAI 用覆盖值），另加两个与目录 ID 一致的模型。

| 厂商 | 模型 | magpie 协议 | `provider test` | 列表中的模型数 |
|---|---|---|---|---|
| OpenAI | `openai/gpt-5.1-chat-latest`（`picked`，不在目录中） | responses | 失败：500 "Model execution failed"，网关日志 provider `unknown` | 59 |
| OpenAI | `openai/gpt-4.1-nano`（目录 ID；不在插件列表中，magpie 照样测试） | responses | 通过；网关日志 `byok: default`、`wholesale: false` | — |
| Anthropic | `anthropic/claude-haiku-5-5`（`picked`，不在目录中） | anthropic | 失败：500 "An internal error occurred"，网关日志 provider `unknown` | 14 |
| Anthropic | `anthropic/claude-sonnet-5`（ID 与目录一致） | anthropic | 通过；网关日志 `byok: default`、`wholesale: false` | — |
| Google | `google/gemini-2.5-flash` | responses（模型未列出） | 失败：插件本地 400 "The REST API can't serve this responses request; sign in with the native mode"，未发出 | 0 |
| DeepSeek | `deepseek/deepseek-flash` | responses（模型未列出） | 同上 | 0 |
| xAI | `xai/grok-4.20-0309-non-reasoning` | responses（模型未列出） | 同上 | 0 |

- 插件列表：`cloudflare-ai-gateway`（共 73 个模型）已登录，账号名以 ` · REST` 结尾。
- 两个 500 与探测脚本的 404 "Model not found" 是同一原因：ID 不在目录中（网关日志 provider `unknown`、tokens 0、cost 0）。状态码不同，推测与 magpie 的请求形状（如流式）有关，未深究。

### 11.6 REST 复测（2026-10-08）

#### 条件

- Token 加上了 Account › Workers AI › Read（仍有 AI Gateway Run + Read）。
- 只读查询 CF API 得到：插件网关开启认证且 `byok_only: true`（Require provider credentials）；`default` 网关 `byok_only: false`，没有托管 key（V5 原生入口 400 / 2044 也说明这一点）。
- 运行 1：`PROBE_V5=1 PROBE_MODEL_XAI=grok-4.20-0309-non-reasoning bun --env-file=.env.local scripts/probe.mjs`。REST 不再 401 / 10000，但 `openai/chat-latest`、`anthropic/claude-haiku-5-5`、`deepseek/deepseek-flash` 都是 404 "Model not found"。官方 REST 文档：REST 只接受 Cloudflare 模型目录（https://developers.cloudflare.com/ai/models/）里的 ID，而脚本用的是厂商实时列表里的 ID。V5 REST 也停在 404，没有走到计费判断。
- 脚本修正：新增 `PROBE_REST_MODEL_<VENDOR>`（逗号分隔，缺省为 `picked`），REST 调用改用目录 ID，每个 REST 记录带 `model` 字段；V5 REST 改用 OpenAI 的 REST ID。
- 运行 2：在运行 1 的命令上加 `PROBE_REST_MODEL_OPENAI=gpt-4.1-nano PROBE_REST_MODEL_ANTHROPIC=claude-haiku-4.5,claude-haiku-4-5 PROBE_REST_MODEL_DEEPSEEK=deepseek-v4-pro`。Google、xAI 的 `picked` 本身就是目录 ID。下表以运行 2 为准，两次运行中 Google、xAI 各请求的结果相同。
- 网关日志（`/logs`，只读）给出每个 REST 请求实际路由到的 provider，以及 `byok`、`wholesale` 字段。

#### V3：前缀与托管 key

| 厂商 | 端点 | 模型 | 状态 / 错误码 | 网关日志 | 结论 |
|---|---|---|---|---|---|
| OpenAI | `/ai/v1/responses` | `openai/gpt-4.1-nano` | 200 | provider `openai`，`byok: default`，`wholesale: false` | 前缀 `openai` 成立，用的是托管 key |
| Anthropic | `/ai/v1/messages` | `anthropic/claude-haiku-4.5` | 200 | provider `anthropic`，`byok: default`，`wholesale: false` | 前缀 `anthropic` 成立，用的是托管 key |
| Anthropic | `/ai/v1/messages` | `anthropic/claude-haiku-4-5`（原生 ID 写法） | 404，`error.type` `not_found_error`，"Model not found" | provider `unknown` | REST 不接受 Anthropic 原生 ID 的写法 |
| DeepSeek | `/ai/v1/chat/completions` | `deepseek/deepseek-v4-pro` | 403，`errors[0].code` 2049 | provider `fireworks` | REST 经 Fireworks 提供 DeepSeek，托管的 `deepseek` key 用不上 |
| Google | `/ai/v1/chat/completions` | `google/gemini-2.5-flash` | 403 / 2049 | provider `google-vertex-ai` | 前缀 `google` 可路由，但 REST 经 Vertex AI 提供，托管的 `google-ai-studio` key 用不上 |
| Google | `/ai/v1/chat/completions` | `google-ai-studio/gemini-2.5-flash` | 404 / 7003 "Model not found" | provider `unknown` | 不是 REST 前缀 |
| xAI | `/ai/v1/chat/completions` | `xai/grok-4.20-0309-non-reasoning` | 403 / 2049 | provider `xai` | 前缀 `xai` 可路由，但找不到可用的托管 key（key 存在 slug `grok` 下）；原因未确认 |
| xAI | `/ai/v1/chat/completions` | `grok/grok-4.20-0309-non-reasoning` | 404 / 7003 | provider `unknown` | 不是 REST 前缀 |

2049 的消息为 "This request requires customer-provided provider credentials, but no applicable provider key was found."。表中 403 / 404 请求的网关日志均为 tokens 0、cost 0、`wholesale: false`。REST 请求都出现在插件网关的日志里（路径记为 `/run`），说明 `cf-aig-gateway-id` 生效。

#### 结论

| 编号 | 结论 | 状态码 / 证据 | 采用的处理 |
|---|---|---|---|
| V3 | OpenAI、Anthropic 成立；Google、DeepSeek、xAI 没有返回 200 的前缀 | 见上表 | `restPrefix` 不变。Google、DeepSeek、xAI 的 `rest` 改为 `null`：模式 B 下不列出，请求在本地返回 400，提示改用原生模式（`route.mjs`、`models.mjs` 已支持） |
| V4 | 成立（需要） | 加上 Workers AI Read 后，REST 请求不再 401 / 10000 | README 不变 |
| V5（REST） | 拒绝，但不是 400 | `default` 网关（`byok_only: false`，只靠 `cf-aig-no-wholesale: true`），`openai/gpt-4.1-nano`：402，`errors[0].code` 7007（"This request is not eligible for unified billing and has no provider credentials"），该请求不在 `default` 网关的日志里，未计费。插件网关（`byok_only: true`）：403 / 2049。402 是该头造成的，还是账号没有可用的统一计费额度造成的，这次无法区分（要区分，得发一个不带该头、可能被计费的请求） | README「Billing safety」写明 REST 的拒绝形状，模式 B 仍要求开启 Require provider credentials |
| V9 | 与 11.3 一致 | 原生 401 / 2009、REST 401 / 10000、CF API 400 / 9106 | 无 |

#### 其他发现

- REST 的模型 ID 是 Cloudflare 模型目录的 ID，不一定等于厂商原生 ID。目录只是子集（如 OpenAI 的 `chat-latest`、`gpt-5.1-chat-latest` 不在其中）；Anthropic 带小版本号的模型在目录里用点（`claude-sonnet-5.5`，原生为 `claude-sonnet-5-5`）。插件在模式 B 下仍按第 6 节从厂商实时列表取模型、发送 `<restPrefix>/<原生ID>`。对照 2026-10-08 的目录页面，模式 B 列出的 OpenAI 59 个模型中有 22 个、Anthropic 14 个中有 3 个（`claude-opus-5`、`claude-sonnet-5`、`claude-fable-5`）的 ID 与目录一致；Anthropic 另有 7 个只差「`-数字-数字` → `-数字.数字`」。其余模型在模式 B 下请求失败：探测脚本的请求为 404 "Model not found"，经 magpie 为 500（11.5）。**已决定**（用户批准）：模式 B 改为只列目录里的模型，模型键用目录 ID（6.2），实测见 11.7。
- 原生入口复测：运行 1 各项与 11.2 相同（V1、V2、V6、V7 均 200）。运行 2 中脚本为 OpenAI 选中了 `gpt-5.1-chat-latest`（列表顺序变化），`V1.openai.responses` 30 秒超时；其余原生项为 200。该项与 REST 无关，未深究。

### 11.7 Task 11：模式 B 按目录列模型（2026-10-08）

- 运行一次：`scripts/sandbox.sh rest anthropic/claude-haiku-4.5 openai/gpt-4.1-nano anthropic/claude-sonnet-5.5`。输出经过脱敏过滤，不含账号 ID、网关名或 token，也没有记录模型输出。
- 插件列表：`cloudflare-ai-gateway` 已登录，共 38 个模型，只有两家：
  - `anthropic` 13 个（`@ai-sdk/anthropic`）；
  - `openai` 25 个（`@ai-sdk/openai`）。
- 列表中全部是目录 ID，例如 `claude-sonnet-5.5`、`claude-haiku-4.5`、`claude-opus-4.8`、`gpt-4.1-nano`、`gpt-5.5`、`o4-mini`。没有 Google、DeepSeek、xAI，也没有厂商原生写法的 ID（如 `claude-sonnet-5-5`）。11.5 时模式 B 列出 73 个模型，大多数请求失败。
- 运行后用 `loadCfCatalog` 直接解析线上目录页（只读公开文档，不涉及账号），OpenAI 25 个、Anthropic 13 个 Text Generation 条目与插件列表一致。models.dev `cloudflare-ai-gateway` 里这两家也是同样的 38 个 ID。
- 评审后修正解析器（6.2，按 `<h3>` 切分）：按修正后的解析器，同日的页面副本共有 69 个 Text Generation 条目。修正前按 `[![` 切分，漏掉 5 个没有 logo 图的条目；它们都不属于 OpenAI 或 Anthropic，所以上面的列表与测试结果不受影响。
- 本次没有查网关日志。11.6 已证实这两个前缀在模式 B 下使用托管 key。

| 厂商 | 模型（目录 ID） | magpie 协议 | `provider test` |
|---|---|---|---|
| Anthropic | `anthropic/claude-haiku-4.5` | anthropic | 通过（1599 ms） |
| OpenAI | `openai/gpt-4.1-nano` | responses | 通过（3488 ms） |
| Anthropic | `anthropic/claude-sonnet-5.5`（带点的 ID，原生为 `claude-sonnet-5-5`） | anthropic | 通过（1451 ms） |

脚本退出码为 0。

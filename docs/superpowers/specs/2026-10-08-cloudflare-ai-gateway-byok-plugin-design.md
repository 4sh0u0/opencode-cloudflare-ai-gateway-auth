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
| `models.mjs` | 厂商发现、实时列表、models.dev 回退、元数据合并、过滤 | `vendors.mjs`、`cf.mjs`、`errors.mjs`（读错误码）、`route.mjs`（只取常量） |
| `cf.mjs` | Cloudflare API 小客户端：读 `provider_configs`，统一错误分类 | `route.mjs`（只取 API 常量） |
| `errors.mjs` | 上游错误 → `X-Magpie-Sign-In` 判定；按协议格式构造本地错误响应 | 无 |
| `test/*.test.mjs` | `bun test` 单元测试，fetch 全部模拟 | 被测模块 |

### 3.2 模型命名

- 插件内部模型键 = `<统一前缀>/<原生ID>`，例如 `anthropic/claude-sonnet-5.5`、`openai/gpt-5.5`、`xai/grok-4.3`。
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
| `alias` | text | BYOK key 别名，留空即 `default`；仅 `mode == native` 时询问 | 可空 |

### 4.2 `authorize(inputs)`

magpie 不把 key 字段的值传给 `api` 方法的 `authorize`（`internal/plugin/host.js` 的 `apiKey()` 只调用 `m.authorize(inputs)`，key 由宿主自己保存），所以登录时无法用 token 调 CF API。`authorize` 只做：

1. 再次校验并规范化 `account`（trim、转小写）、`gateway`（trim）、`mode`（缺省 `native`）、`alias`（trim，`default` 视为空）；不合法返回 `{type: "failed", error}`。
2. 返回 `{type: "success", metadata: {account, gateway, mode, alias, email}}`，不返回 `key`（宿主用用户填写的 key 保存）。`email` 只用于账号显示名：magpie 按 `accountId` → `metadata.email` → `email` 取名，而 api 账号只保存 `metadata`。格式为 `<gateway>[/<alias>] · <account 前 8 位>[ · REST]`：别名非空时接在网关后，REST 模式在末尾加 ` · REST`。magpie 宿主的 `settle()` 登录时会替换同名账号（api 账号没有 uid），所以名称必须包含区分两次登录的全部字段（网关、别名、模式），否则同一网关的不同别名或不同模式会互相覆盖；同一（网关、账号、别名、模式）重新登录仍替换旧账号，正好用于轮换 token。
3. token 有效性在第一次 `provider.models` 时验证（见第 6 节第 1 步）：CF API 返回 401 → 抛出带 `signIn: "expired"` 的错误，账号显示需要重新登录并附原因。
4. 多网关 / 多账号 = 多次登录；magpie 自动对它们做故障切换。

### 4.3 Token 权限

- 必需：AI Gateway Run（调用）、AI Gateway Read（登录校验、厂商发现）。
- 模式 B 是否另需 Workers AI Read：见待实测项 V4，结论写入 README。

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
| Google | ❓V3 | `google-ai-studio` | `@ai-sdk/openai-compatible`（Chat；magpie 把 `@ai-sdk/google` 当 Code Assist，见 11 节 V8） | `/v1beta/openai/chat/completions`、`/v1beta`（Gemini 分支保留） | Chat | `/v1beta/models?pageSize=1000` | `google` |
| DeepSeek | `deepseek` | `deepseek` | `@ai-sdk/openai-compatible`（Chat） | `/chat/completions` | Chat | `/models` | `deepseek` |
| xAI | `xai`（❓V3） | `grok` | `@ai-sdk/openai-compatible`（Chat） | `/v1/chat/completions`、`/v1/responses` | Chat | `/v1/models` | `xai` |

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
- 请求体：`model` 保持 `前缀/原生ID`（V3 若证实 REST 前缀与内部前缀不同，在映射表加 `restPrefix` 字段做转换）。
- 删除请求头：`x-api-key`、`x-goog-api-key`；`authorization` 覆盖为 `Bearer <token>`。
- 设置请求头：`cf-aig-gateway-id: <gateway>`；`cf-aig-no-wholesale` 规则同模式 A。
- 模式 B 下 `models()` 给每个模型声明的协议见 5.2「模式 B 协议」列。

## 6. 模型列表（`provider.models`）

对每个账号：

1. **厂商发现**：`GET /accounts/{account}/ai-gateway/gateways/{gateway}/provider_configs`（分页 `page`/`per_page`），取 `alias` 与账号别名（空即 `default`）匹配的条目的 `provider_slug`，与映射表的 5 家取交集。
   - 401：token 无效 → 抛出带 `signIn: "expired"` 的错误；
   - 403（缺少 AI Gateway Read）或其他失败：日志提示，按 5 家全部处理。
2. **实时列表**（各厂商并行，每个 8 秒超时；无论账号是模式 A 还是 B，列表都经原生入口获取，因为 REST API 没有列表端点）：`GET {gw}/{slug}{实时列表路径}`，头同 5.3（无请求体）：`cf-aig-authorization`、非默认别名的 `cf-aig-byok-alias`，以及 `allowUnifiedBilling` 不为 `true` 时的 `cf-aig-no-wholesale: true`（`listModels` 从 `index.mjs` 接收插件选项，缺省即带该头）。返回 400 且错误码（与 `errors.mjs` 同一解析）含 2044（该别名下没有这家厂商的托管 key，见 11.3）时，整家厂商不列出，也不走第 3 步的 models.dev 回退。成功时解析：
   - OpenAI / DeepSeek / xAI：`{data: [{id}]}`
   - Anthropic：`{data: [{id, display_name}]}`
   - Google：`{models: [{name: "models/<id>", displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods}]}`，只保留含 `generateContent` 的
3. **回退**：某厂商实时列表失败（含 V2 不成立的情况，不含第 2 步的 2044）→ 用 models.dev 中该厂商原生目录的全部模型。
4. **元数据合并**：按原生 ID 匹配 models.dev 原生目录，补 `name`、`limit`、`reasoning`/`variants`、`tool_call`、`modalities`、`cost`。每个字段的取值优先级：models.dev → 实时列表自带的信息（Anthropic 的 `display_name`、Google 的 `displayName` 与 token 上限）→ 默认值（上下文 128000、输出 16384、支持工具调用、不推理）。
5. **过滤**：
   - 去掉 `status: "deprecated"`；
   - ID 含 `embed`、`-tts`、`image`、`audio`、`-live`、`realtime`、`moderation`、`whisper`、`dall-e`、`sora`、`transcribe`、`computer-use`、`deep-research` 的（参照 magpie `textModel`；这是各厂商共用的子串启发式，可能漏判或误判）；
   - 命中该厂商 `list.skip` 正则的 ID（`vendors.mjs`，只作用于本厂商，不依赖 models.dev）：OpenAI 只支持旧 Completions 的 `davinci-002`、`babbage-002`、`gpt-3.5-turbo-instruct*` 与只支持 Chat Completions 的 `*-search-preview*`、`*-search-api*`（走 Responses 会 400）；Google 的 Lyria（音乐）与 nano-banana（图像）；xAI 的 `grok-imagine-*`（图像 / 视频）；
   - models.dev 标明输出不含 `text` 的。
6. **输出**：键为模型键（`前缀/原生ID`），`api: {id: 模型键, url: 占位地址, npm: 按账号模式与 5.2 选择}`。单个厂商实时列表失败、改用 models.dev 补齐属于正常路径，只写日志，不标记回退。
7. **最终列表为空**：返回 `provider.models` 的副本并打上 `Symbol.for("magpie.fellBack")`，magpie 保留它原有的列表。

**内存缓存**：magpie 宿主在每个推理请求之前都会调用 `provider.models`（见 11.4），所以 `listModels` 把每个账号的结果缓存在插件进程内存里（不写盘）10 分钟（`LIST_TTL`）：

- 键 = token 的 SHA-256 摘要 + `account` + `gateway` + `mode` + `alias` + `allowUnifiedBilling`；token 原文不进入键、日志或文件；
- 同一键的并发调用共享同一个进行中的 Promise，只发一轮请求；
- 失败（含抛出 `signIn: "expired"`）与空列表不缓存，下次调用重新获取；
- 每个调用方拿到结果的独立副本；`resetModelCache()` 供测试清空缓存。

### 6.1 models.dev 缓存

- 文件：`<directory>/cloudflare-ai-gateway-auth/models-dev.json`（`directory` 为 magpie 配置目录）。
- 有效期 6 小时；刷新失败时继续用过期缓存；无缓存且拉取失败时，回退步骤只能返回空（交给第 7 步）。
- 刷新失败后在内存里记住 10 分钟（`CATALOG_RETRY`）不再请求 models.dev：期间有过期缓存就直接用，没有则照常抛错，不重新拉取。

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
- `index.mjs`：`authorize` 的规范化与校验、`config` 钩子、`models` 钩子的空列表回退。

### 8.3 集成测试

沙箱运行 magpie（`HOME`、`XDG_*` 指向临时目录，`MAGPIE_ADDR=127.0.0.1:3499`）：从 `.env.local` 直接写入沙箱的 `plugin-auth.json`（`plugin login` 是交互式的，且会让 token 经过终端；登录流程由 `authorize` 单元测试和 8.5 人工验收覆盖），然后 `plugin add ./`、`plugin --json`、对每个厂商两种模式各跑 `provider test`。

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
| V3 | 未能实测 | 7 个 REST 请求（含 Google 的 `google-ai-studio/`、`google/` 与 xAI 的 `xai/`、`grok/` 两组前缀）全部 401，`errors[0].code` 10000：token 缺 Workers AI 权限（V4），请求在模型路由前即被拒 | 按官方 REST 文档「Model naming」（https://developers.cloudflare.com/ai-gateway/usage/rest-api/#model-naming）：Google 前缀 `google`、xAI 前缀 `xai`。Google 的 `restPrefix` 由 `google-ai-studio` 改为 `google`，xAI 保持 `xai`。**待用带 Workers AI Read 的 token 重跑 V3 确认**（包括 REST 的 `google/` 是否使用 `google-ai-studio` 托管 key） |
| V4 | 成立（需要） | 仅有 AI Gateway 权限的 token 调 `/ai/v1/*` 全部 401 / 10000。官方文档同一页「Authentication」：所有 `/accounts/{id}/ai/*` 端点需要 Account › Workers AI › Read，只有 AI Gateway 权限的 token 返回 401 / 10000 | README「Token permissions」：模式 B 另需 Account › Workers AI › Read；缺少时每个推理请求 401 / 10000，与 token 无效无法区分，插件标为 `expired` |
| V5 | 原生入口成立；REST 未能实测 | 原生入口 → 无托管 key 的 `default` 网关：400，`error[0].code` 2044（"Customer-provided provider credentials are required for this request"）。REST → 401 / 10000（同 V4） | 原生入口无需改动。README 写明模式 B 依赖网关开启 `byok_only`（控制台 Require provider credentials） |
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
- REST 模式沙箱运行：**待定**。当前 token 缺 Workers AI Read，所有 REST 请求 401（见 V3 / V4），拿到该权限后再跑 `scripts/sandbox.sh rest …`。

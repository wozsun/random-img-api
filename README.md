# Random Image API

基于边缘函数的随机图片 API 项目，默认面向阿里云 ESA，同时兼容 Cloudflare Workers 与腾讯云 EdgeOne。

## 特性

- 边缘函数运行，低延迟、免运维
- 使用 KV 管理运行时配置，无需每次改配置都重新部署
- 支持 ESA EdgeKV、Cloudflare Workers KV、腾讯云 EdgeOne KV
- 支持按设备类型、明暗类型、主题等多维度筛选随机图片
- 可选 `proxy` 代理图片内容或 `redirect` 返回 302 跳转

## 快速开始

1. Clone 本项目
2. 在 KV 中配置 `BASE_IMAGE_URL` 和 `FOLDER_MAP`（见[KV 配置](#kv-存储配置)）
3. 按目标平台部署（见[部署指南](#部署指南)）
4. 访问 `GET /random-img` 验证

## 目录结构

```text
app/              入口路由、业务逻辑、业务配置
commons/           KV 读取、响应工具、Referer 校验、平台 KV 适配
edge-functions/   EdgeOne 平台适配入口
```

## API 接口

除 `/random-img` 外，已知普通路由默认不接受查询参数；携带查询参数会返回 403。未知路由仍按 404 处理。

### `GET /random-img`

随机图片主接口。

#### 查询参数

| 参数 | 含义 | 可选值 | 默认值 |
| --- | --- | --- | --- |
| `d` | 设备类型 | `pc` / `mb` / `r`（强制随机） | 按 User-Agent 自动推断 `pc`/`mb`，无法识别则随机 |
| `b` | 明暗类型 | `dark` / `light` | 随机 |
| `t` | 主题（支持多值） | 任意存在于 `FOLDER_MAP` 中的主题名，或以 `!` 开头排除 | 全部主题中随机 |
| `m` | 响应方式 | `proxy` / `redirect` | `proxy` |

查询参数白名单与单值约束由 `app/config.js` 控制：

```js
const ALLOWED_QUERY = ["d", "b", "t", "m"];
const SINGLE_VALUE_QUERY = ["d", "b", "m"];
```

其中 `t` 不在 `SINGLE_VALUE_QUERY` 中，因此允许多次传入。

`t` 参数支持以下语法：

- 逗号分隔：`?t=theme1,theme2`
- 重复参数：`?t=theme1&t=theme2`
- 排除语法：`?t=!theme1` 从全部主题中排除 `theme1`
- 排除多值：`?t=!theme1,!theme2` 或 `?t=!theme1&t=!theme2`

> ⚠️ 包含与排除不可混用，例如 `?t=theme1,!theme2` 会返回 400 错误。

#### 示例

```text
/random-img
/random-img?d=pc&b=dark
/random-img?t=theme1,theme2&m=redirect
/random-img?t=!theme1
/random-img?d=r&b=light&t=theme1
/random-img?d=mb&b=dark&t=!theme1&m=redirect
```

#### 响应方式

`m=proxy`（默认）：
- 边缘函数回源拉取图片并透传内容
- 响应头会附加 `X-Image-Info`，格式为 `{device}-{brightness}-{theme}-{index}; {耗时ms}`，例如 `pc-dark-theme1-000012; 34`
- `X-Image-Info` 可通过 `app/config.js` 中的 `IMAGE_INFO_HEADER_ENABLED` 开关

`m=redirect`：
- 返回 302，`Location` 指向目标图片 URL
- 可通过 `app/config.js` 中的 `REDIRECT_ENABLED` 全局禁用，设为 `false` 后所有请求强制使用 proxy 模式

> ⚠️ 隐私提示：`redirect` 模式不会隐藏上游图片源地址，客户端可直接看到图片 CDN/存储源 URL。如需隐藏源地址请使用默认的 `proxy` 模式。

#### 错误响应格式

所有错误响应均为 JSON，结构如下：

```json
{
  "status": 400,
  "message": "Bad Request: Invalid query parameters",
  "details": {
    "invalidQuery": ["x"],
    "allowedQuery": ["d", "b", "t", "m"]
  }
}
```

常见状态码：

| 状态码 | 场景 |
| --- | --- |
| 400 | 参数非法、重复、混用包含/排除主题等 |
| 403 | Referer 校验未通过（仅在启用时），或普通路由携带了不允许的查询参数 |
| 404 | 无匹配图片或无可用路由 |
| 405 | 使用了当前接口不支持的方法 |
| 500 | KV 配置缺失或无效 |
| 502 | 上游图片服务请求失败 |

随机图片业务错误定义见 `app/config.js` 中的 `ERRORS` 常量；入口路由错误由 `app/index.js` 返回。

### `GET /random-img-count`

图片数量统计接口，读取 `FOLDER_MAP` 并返回按设备、亮度与主题汇总后的数量信息。

- 仅支持 `GET`，其他方法返回 405
- 不接受查询参数，携带查询参数会返回 403

响应示例：

```json
{
  "totalImages": 30,
  "groupTotals": {
    "pc-dark": 10,
    "pc-light": 8,
    "mb-dark": 7,
    "mb-light": 5
  },
  "themeDetails": {
    "theme1": {
      "total": 12,
      "pc-dark": 4,
      "pc-light": 3,
      "mb-dark": 3,
      "mb-light": 2
    }
  }
}
```

### `GET /healthcheck`

健康检查接口，用于确认边缘函数入口可正常响应。

- 仅支持无查询参数访问，携带查询参数会返回 403

响应示例：

```json
{
  "message": "API on EdgeFunction is healthy"
}
```

## KV 存储配置

随机图片 API 使用以下命名空间：

```text
random_img_config
```

兼容说明：

- 默认按 ESA EdgeKV 方式读取
- Cloudflare Workers：设置环境变量 `KV_PROVIDER=CF`，并确保同名命名空间以 binding 形式挂载到 env
- EdgeOne：入口自动设置 `KV_PROVIDER=EO`，确保同名命名空间以 binding 形式挂载到全局对象

### 必需键

#### `BASE_IMAGE_URL`

图片基地址（单行有效 URL 字符串）。代码会自动规范化并确保末尾带 `/`。

示例：

```text
https://asset.example.com/random-img/
```

#### `FOLDER_MAP`

图片索引配置（JSON 对象）。示例：

```json
{
  "pc": {
    "dark": { "theme1": 15, "theme2": 13 },
    "light": { "theme1": 12, "theme2": 9 }
  },
  "mb": {
    "dark": { "theme1": 2, "theme2": 6 },
    "light": { "theme1": 4, "theme2": 4 }
  }
}
```

读取规则：

- 仅读取顶层设备键 `pc`、`mb`
- 仅读取明暗键 `dark`、`light`
- 主题计数转为数字后，有限且 `> 0` 的参与随机，`0` 或无效值不进入候选池

### 可选键

#### `ALLOWED_REFERER`

Referer 白名单（多行文本）。Referer 校验默认关闭，由 `app/config.js` 中的 `REFERER_CHECK_ENABLED` 控制。

若启用，需在此键中配置白名单，支持精确 origin 与通配子域名：

```text
https://example.com
https://*.example.com
```

### 图片存储路径

图片路径由 `BASE_IMAGE_URL`（KV）+ `IMAGE_PATH_PATTERN`（config.js）+ 文件扩展名组成。

默认 `IMAGE_PATH_PATTERN`：

```text
{device}-{brightness}/{theme}/{index}
```

因此默认图片存储结构为：

```text
{device}-{brightness}/{theme}/{index}.webp
```

示例：

```text
pc-dark/theme1/000001.webp
mb-light/theme2/000002.webp
```

`IMAGE_PATH_PATTERN` 支持 `{device}`、`{brightness}`、`{theme}`、`{index}` 四个占位符，可在 `app/config.js` 中自由组合：

```text
{device}/{brightness}-{theme}/{index}
{theme}/{device}-{brightness}-{index}
```

## 部署指南

### 阿里云 ESA

使用 [esa.jsonc](./esa.jsonc)：

```jsonc
{
  "name": "api",
  "entry": "./app/index.js",
  "installCommand": null,
  "buildCommand": null
}
```

不需要设置 `KV_PROVIDER`，默认按 ESA EdgeKV 读取。

### Cloudflare Workers

使用 [wrangler.jsonc](./wrangler.jsonc)：

```jsonc
{
  "main": "app/index.js",
  "vars": {
    "KV_PROVIDER": "CF"
  },
  "kv_namespaces": [
    {
      "binding": "random_img_config",
      "id": "your_namespace_id"
    }
  ]
}
```

KV binding 名需与代码中的命名空间名一致：`random_img_config`。

部署命令：

```bash
npx wrangler deploy
```

### 腾讯云 EdgeOne

EdgeOne 识别 `edge-functions` 目录下的文件为函数路由。本项目通过 `edge-functions/random-img.js` 作为适配入口，自动注入 `KV_PROVIDER=EO` 后转交 `app/index.js` 处理。

EdgeOne KV 命名空间的绑定变量名需与代码一致：

```text
random_img_config
```

## 多平台 KV 适配

KV 读取统一通过 `commons/kv.js` 的 getter 完成，底层 client 由 `commons/kv-providers.js` 根据 `KV_PROVIDER` 分发。

| 平台 | `KV_PROVIDER` | KV client 来源 |
| --- | --- | --- |
| ESA | 默认或 `ESA` | `new EdgeKV({ namespace })` |
| Cloudflare Workers | `CF` | `env[namespace]` |
| EdgeOne | `EO` | 优先 `env[namespace]`，其次 `globalThis[namespace]` |

可用的 KV getter：

| Getter | 用途 |
| --- | --- |
| `getKvJsonObjectCached` | 读取 JSON 对象，如 `FOLDER_MAP` |
| `getKvUrlCached` | 读取单行 URL，如 `BASE_IMAGE_URL` |
| `getKvTextCached` | 读取单行文本 |
| `getKvTextLinesCached` | 读取多行文本，如 Referer 白名单 |
| `getKvBooleanCached` | 读取严格布尔值 |
| `getKvNumberCached` | 读取有限数字 |

所有 getter 均带内存缓存、负缓存和 KV 读取重试。

## 开发与测试

修改 `app/config.js` 中的关键参数说明：

| 参数 | 说明 |
| --- | --- |
| `FETCH_MAX_ATTEMPTS` | 上游请求最大重试次数 |
| `FETCH_TIMEOUT_MS` | 单次上游请求超时（毫秒） |
| `IMAGE_INDEX_DIGITS` | 图片索引补零位数 |
| `IMAGE_FILE_EXTENSION` | 图片文件扩展名 |
| `IMAGE_PATH_PATTERN` | 图片路径模板 |
| `REDIRECT_ENABLED` | 是否允许 redirect 模式 |
| `REFERER_CHECK_ENABLED` | 是否启用 Referer 校验 |
| `IMAGE_INFO_HEADER_ENABLED` | 是否返回 X-Image-Info 响应头 |

## 开源协议

本项目使用 **GNU AGPLv3**，详见 [LICENSE](./LICENSE)。

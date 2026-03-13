# 主模块说明

该目录负责 API 的基础路由注册与通用行为处理，提供以下核心功能：

- 统一入口（`index.js`）
- 路由分发
- 全局异常兜底
- 通用响应工具（`response.js`）
- KV 读取工具（`kv.js`）
- Referrer 验证工具（`referer.js`）

## ESA KV 存储配置

命名空间：`hidden-routes`

必需键：

- `HIDDEN_API_PATH` 隐藏路径（字符串），示例：`/hidden-api`

## 入口行为

`index.js` 采用以下处理流程：

1. 从请求 URL 提取 `pathname`
2. 先在普通 `ROUTES` 中查找处理器
3. 普通路由未命中时，再尝试隐藏路径动态路由
4. 全部未命中返回 `404 API Not Found`
5. 发生未捕获异常时返回 `500 Internal Server Error`

## 路径扩展

`index.js` 在 `ROUTES` 中维护普通路由入口，在 `HIDDEN_PATH_KEYS` 中维护隐藏路由 KV 键，具体路径从 `hidden-routes` 命名空间动态读取。

所有隐藏路径统一不接受任何查询参数；若携带 query string，将直接返回 `403`。

未来新增普通路由时，在 `index.js` 中做两件事：

- 新增该模块的静态导入
- 在 `ROUTES` 中新增一条入口（值为模块导出对象）

未来新增隐藏路由时，按以下步骤扩展：

- 在 `HIDDEN_PATH_KEYS` 中追加一个 KV 键（命名建议：`*_PATH`）
- 在已注册模块中新增对应处理函数（命名约定：`handleXxx`）
- 在 `hidden-routes` 命名空间写入该 KV 键的真实路径值

处理函数采用命名约定自动匹配：

- 普通路由 `/foo-bar` 对应 `ROUTES["/foo-bar"]` 模块中的 `handleFooBar`
- 隐藏路由 KV key `FOO_BAR_PATH` 对应 `handleFooBar`

## 响应工具

`response.js` 提供统一 JSON 响应方法：

- `detailedErrorResponse(error, details?)`
- `jsonErrorResponse(error)`
- `jsonSuccessResponse(data, status?)`

统一响应头：

- `Content-Type: application/json; charset=utf-8`

## KV 工具

`kv.js` 封装了对 EdgeKV 的带缓存读取，所有 Getter 均采用"Isolate 内 Map 缓存 + 回源重试"机制，key 不存在或读取失败时统一返回 `null`。

**缓存行为：**

- 正向 TTL：60 秒（命中有效值时）
- 负向 TTL：3 秒（key 不存在或值为空时，防止频繁回源）
- 失败重试：最多 5 次，线性退避

## Referer 验证工具

`referer.js` 提供基于 KV 存储的白名单 Referer 校验，供各业务模块按需引入。

**校验流程：**

1. `referer` 为空且 `allowEmptyReferer` 为 `false` → 403
2. `referer` 无法解析为合法 URL → 403
3. 从 KV `namespace::ALLOWED_REFERER` 读取白名单，读取失败 → 500
4. Referer origin 未命中白名单 → 403
5. 全部通过 → `allowed: true`

**白名单规则格式（在 KV 存储中每行一条）：**

- 精确 origin：`https://example.com`
- 子域名通配：`https://*.example.com`（不匹配根域名本身）

# main 模块说明

该目录负责 API 网关层能力：

- 统一入口（`index.js`）
- 路由分发
- 全局异常兜底
- 通用响应工具（`response.js`）

## 路由清单

当前 `routes`：

- `GET /`：返回 `404 API Not Found`
- `GET /hello`：返回示例响应
- `GET /random-img`：随机图片主接口（详见 `../random-img/README.md`）

## 入口行为

`index.js` 采用以下处理流程：

1. 从请求 URL 提取 `pathname`
2. 在 `routes` 中查找处理器
3. 命中则执行对应 handler
4. 未命中返回 `404 API Not Found`
5. 发生未捕获异常时返回 `500 Internal Server Error`

## 响应工具

`response.js` 提供统一 JSON 响应方法：

- `detailedErrorResponse(error, details?)`
- `jsonErrorResponse(error)`
- `jsonSuccessResponse(data, status?)`

统一响应头：

- `Content-Type: application/json; charset=utf-8`

## 新增路由规范

新增 API 时建议保持以下约定：

1. 业务逻辑放在独立功能目录（如 `weather/function.js`）
2. 在 `main/index.js` 仅做路由映射，不堆叠业务逻辑
3. 错误返回尽量使用统一响应工具
4. 在对应功能目录补充接口文档

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

# Serverless-ESA

基于阿里云 ESA Edge Function 的 API 模板项目。当前已实现随机图片能力，并保持模块化结构，便于继续扩展更多业务 API。

本项目全部由AI完成。

## 特性

- 边缘函数运行，低延迟、免运维
- 路由与业务解耦，便于扩展
- 使用 EdgeKV 管理配置

## 项目结构

```text
.
├── esa.jsonc                # ESA 项目配置
├── main/
│   ├── index.js             # 全局入口与路由分发
│   ├── response.js          # 统一 JSON 响应工具
│   └── README.md            # 路由与基础接口文档
├── random-img/
│   ├── function.js          # 随机图片业务逻辑
│   └── README.md            # 随机图片 API 详细文档
└── README.md                # 项目总览（当前文件）
```

## 文档导航

- 基础路由与通用行为：`main/README.md`
- 随机图片相关 API：`random-img/README.md`

## 快速开始

### 1) 配置入口

`esa.jsonc` 已指定入口：

- `entry: ./main/index.js`

### 2) 部署

项目无额外构建步骤，按 ESA 平台标准流程发布即可。

## 扩展新 API（推荐模式）

1. 在新功能目录创建 `function.js`，导出处理函数
2. 在 `main/index.js` 中注册路由
3. 在对应功能目录新增 `README.md` 说明接口

## 开源协议

本项目使用 **GNU AGPLv3**，详见 `LICENSE`。

## 贡献

欢迎提交 Issue / PR，一起完善可复用的 ESA API 模板。

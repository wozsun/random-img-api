# Random Image API

## 简介

本项目是基于 Serverless 构建的随机图片 API。目前兼容 Cloudflare Workers、 Aliyun ESA 以及 Tencent Cloud EdgeOne 三大边缘计算平台。

## 特性

- 使用平台边缘函数运行，无需服务器
- 使用 KV 存储管理配置，可实现动态更新图片索引和基地址，无需重新部署
- 支持设备类型、明暗类型、主题等多维度随机选择
- 可选直接代理图片内容或返回重定向 URL

## 部署指南

详见 Wiki

## 接口使用

随机图片主接口：`GET /random-img`。

### 可选查询参数

| 参数 | 含义 | 可选值 | 默认值 |
| --- | --- | --- | --- |
| `d` | 设备类型 | `pc` / `mb` / `r`（强制随机） | 按 User-Agent 自动推断 `pc/mb` |
| `b` | 明暗类型 | `dark` / `light` | 随机 |
| `t` | 主题（支持多值） | 任意存在于 `FOLDER_MAP` 全局的主题 | 随机 |
| `m` | 返回模式 | `proxy` / `redirect` | `proxy` |

`t` 支持：

- 逗号分隔：`?t=theme1,theme2`
- 重复参数：`?t=theme1&t=theme2`
- 排除语法：`?t=!theme1` 表示排除 `theme1`，从所有主题中去掉指定项
- 排除多值：`?t=!theme1,!theme2` 或 `?t=!theme1&t=!theme2`

> ⚠️ 包含与排除不可混用，例如 `?t=theme1,!theme2` 会返回 400 错误。

示例：

```text
/random-img
/random-img?t=theme1
/random-img?t=!theme1
/random-img?d=r&t=theme1
/random-img?d=mb&b=light&t=theme1,theme2
/random-img?d=pc&b=dark&t=!theme1&m=redirect
/random-img?d=pc&b=dark&t=theme1&t=theme2&m=redirect
```

### 返回模式

- `m=proxy`：边缘函数回源拉图并透传内容
- `m=redirect`：返回 `302`，`Location` 指向目标图片 URL

> ⚠️ 隐私提示：`m=redirect`（302）模式不会隐藏上游图片源地址，客户端可直接看到图片仓库/分发源 URL。可通过修改仓库根目录 `index.js` 中的 `REDIRECT_ENABLED` 配置，启用或禁用 `redirect` 模式。当`REDIRECT_ENABLED = false`时，所有请求将强制使用 `proxy` 模式。

## 配置说明

### KV 存储配置

以下内容必须正确配置，否则相关接口将无法正常工作。

命名空间：`random-img-config`。

兼容说明：

- 默认按 ESA EdgeKV 方式读取
- 若运行在 Cloudflare Workers KV，请在运行环境中设置 `KV_PROVIDER=CF`
- 使用 CF 模式时，请确保同名命名空间以绑定形式挂在运行时 env 上

必需键：

#### 1） `BASE_IMAGE_URL`

图片基地址（字符串）。

示例：

```text
https://asset.example.com/random-img/
```

#### 2） `FOLDER_MAP`

图片索引配置（JSON 对象），示例：

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

约束：

- 顶层设备键仅允许 `pc`、`mb`
- 明暗键仅允许 `dark`、`light`
- 主题计数必须为 `>= 0` 的数字

### 图片存储

请将图片按照以下结构存储：

```text
{device}-{brightness}/{theme}/{index}.{ext}
```

示例：

```text
pc-dark/theme1/00001.jpg
mb-light/theme2/00002.png
```

## 开源协议

本项目使用 **GNU AGPLv3**，详见 [LICENSE](./LICENSE)。

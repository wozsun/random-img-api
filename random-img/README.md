# Random-Img API 文档

## 接口使用

随机图片主接口：`GET /random-img`

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

示例：

```text
/random-img
/random-img?t=theme1
/random-img?d=r&t=theme1
/random-img?d=mb&b=light&t=theme1,theme2
/random-img?d=pc&b=dark&t=theme1&t=theme2&m=redirect
```

### 返回模式

- `m=proxy`：边缘函数回源拉图并透传内容
- `m=redirect`：返回 `302`，`Location` 指向目标图片 URL

> ⚠️ 隐私提示：`m=redirect`（302）模式不会隐藏上游图片源地址，客户端可直接看到图片仓库/分发源 URL。若需要避免泄露源地址，请使用 `m=proxy` （默认）模式。
> 可选：修改 `function.js` 中的 `REDIRECT_ENABLED` 配置以启用或禁用 `redirect` 模式。

## 部署配置

### ESA KV 存储配置（必需）

以下内容必须正确配置，否则相关接口将无法正常工作。

命名空间：`random-img-config`

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

### GitHub Actions 自动化测试配置（可选）

测试脚本依赖以下环境变量：

```text
CONFIG =
{
  "API_BASE_URL": "https://your-api.example.com",
  "ASSET_BASE_URL": "https://your-asset.example.com/examle",
  "RANDOM_IMG_COUNT_PATH": "/path-for-random-img-count"
}
```

请将上述配置替换为真实值后注入 GitHub Actions Secrets。其中 `CONFIG` 为 Secret 名称。

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
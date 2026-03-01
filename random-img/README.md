# random-img API 文档

该目录实现随机图片相关能力：

- `GET /random-img`

## 依赖配置（EdgeKV）

命名空间：`random-img-config`

必需键：

### 1) `BASE_IMAGE_URL`

图片基地址（字符串）。

示例：

```text
https://asset.example.com/random-img/
```

### 2) `FOLDER_MAP`

图片索引配置（JSON 对象），示例：

```json
{
  "pc": {
    "dark": { "acg": 15, "ghost": 13 },
    "light": { "acg": 12, "ghost": 9 }
  },
  "mb": {
    "dark": { "fddm": 2, "wlop": 6 },
    "light": { "fddm": 4, "wlop": 4 }
  }
}
```

约束：

- 顶层设备键仅允许 `pc`、`mb`
- 明暗键仅允许 `dark`、`light`
- 主题计数必须为 `>= 0` 的数字

---

## 接口：`GET /random-img`

随机图片主接口。

### 查询参数

| 参数 | 含义 | 可选值 | 默认值 |
| --- | --- | --- | --- |
| `d` | 设备类型 | `pc` / `mb` / `r` | 按 User-Agent 自动推断 `pc/mb` |
| `b` | 明暗类型 | `dark` / `light` | 不限（两者都参与） |
| `t` | 主题（支持多值） | 任意存在于 `FOLDER_MAP` 全局的主题 | 不限（所有主题参与） |
| `m` | 返回模式 | `proxy` / `redirect` | `proxy` |

`t` 支持：

- 逗号分隔：`?t=fddm,wlop`
- 重复参数：`?t=fddm&t=wlop`
- 自动去空白、去重

### 主题合法性规则

- 主题与设备、亮度解耦：只要主题在 `FOLDER_MAP` 全局任意位置存在，即判定为合法参数。
- 如果主题合法但在当前筛选条件下无可用图片，返回：
  - `404 Not Found: No available images for the selected filters`
- 只有主题在全局不存在时，才返回：
  - `400 Bad Request: Invalid theme`

### 返回模式

- `m=proxy`：边缘函数回源拉图并透传内容
- `m=redirect`：返回 `302`，`Location` 指向目标图片 URL

### 常见错误码

- `400`：参数非法（未知参数、非法 `d/b/m`、主题全局不存在）
- `404`：筛选后无图片（组合无图或全局无图）
- `500`：KV 配置缺失或格式错误
- `502`：上游图片服务异常

---

## 维护建议

- 变更 `FOLDER_MAP` 结构时，同步更新本文件
- 新增筛选参数时，先更新参数白名单与错误定义，再补 E2E 用例
- 保持错误语义稳定，避免前端联调频繁改动

# Random Image API

An edge-function-based random image API. Targets Aliyun ESA by default, with compatibility for Cloudflare Workers and Tencent Cloud EdgeOne.

## Features

- Runs on edge functions — low latency, zero server maintenance
- KV-backed runtime configuration — no redeployment needed for config changes
- Supports ESA EdgeKV, Cloudflare Workers KV, and Tencent Cloud EdgeOne KV
- Multi-dimensional random selection by device type, brightness, and theme
- Choose between `proxy` (stream image content) or `redirect` (302 redirect)

## Quick Start

1. Clone this repository
2. Configure `BASE_IMAGE_URL` and `FOLDER_MAP` in KV (see [KV Configuration](#kv-storage-configuration))
3. Deploy to your target platform (see [Deployment Guide](#deployment-guide))
4. Verify by visiting `GET /random-img`

## Directory Structure

```text
app/              Entry routing, business logic, business config
commons/           KV reads, response helpers, Referer validation, platform KV adapters
edge-functions/   EdgeOne platform adapter entry
```

## API Reference

### `GET /random-img`

Main random image endpoint.

#### Query Parameters

| Parameter | Description | Accepted Values | Default |
| --- | --- | --- | --- |
| `d` | Device type | `pc` / `mb` / `r` (force random) | Auto-detected from User-Agent (`pc`/`mb`), random if unknown |
| `b` | Brightness | `dark` / `light` | Random |
| `t` | Theme (multi-value) | Any theme name in `FOLDER_MAP`, or `!`-prefixed to exclude | Random from all themes |
| `m` | Response mode | `proxy` / `redirect` | `proxy` |

Query parameter allowlist and single-value constraints are defined in `app/config.js`:

```js
const ALLOWED_QUERY = ["d", "b", "t", "m"];
const SINGLE_VALUE_QUERY = ["d", "b", "m"];
```

`t` is not in `SINGLE_VALUE_QUERY`, so repeated values are accepted.

The `t` parameter supports:

- Comma-separated: `?t=theme1,theme2`
- Repeated: `?t=theme1&t=theme2`
- Exclusion: `?t=!theme1` removes `theme1` from all themes
- Multiple exclusions: `?t=!theme1,!theme2` or `?t=!theme1&t=!theme2`

> ⚠️ Include and exclude selectors cannot be mixed. For example, `?t=theme1,!theme2` returns a 400 error.

#### Examples

```text
/random-img
/random-img?d=pc&b=dark
/random-img?t=theme1,theme2&m=redirect
/random-img?t=!theme1
/random-img?d=r&b=light&t=theme1
/random-img?d=mb&b=dark&t=!theme1&m=redirect
```

#### Response Modes

`m=proxy` (default):
- The edge function fetches the image from upstream and streams it to the client
- Response includes an `X-Image-Info` header with the format `{device}-{brightness}-{theme}-{index}; {duration_ms}`, e.g. `pc-dark-theme1-000012; 34`
- `X-Image-Info` can be toggled via `IMAGE_INFO_HEADER_ENABLED` in `app/config.js`

`m=redirect`:
- Returns a 302 redirect with the `Location` header pointing to the image URL
- Can be globally disabled by setting `REDIRECT_ENABLED` to `false` in `app/config.js`, which forces proxy mode for all requests

> ⚠️ Privacy notice: `redirect` mode does not hide the upstream image source URL — clients can see the CDN/storage origin directly. Use `proxy` mode (default) if you need to conceal the source address.

#### Error Response Format

All errors are returned as JSON:

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

Common status codes:

| Status | Scenario |
| --- | --- |
| 400 | Invalid parameter, duplicate parameter, mixed include/exclude themes, etc. |
| 403 | Referer validation failed (only when enabled) |
| 404 | No matching images or no matching route |
| 405 | Request method is not GET |
| 500 | KV configuration missing or invalid |
| 502 | Upstream image service request failed |

See the `ERRORS` constant in `app/config.js` for all error definitions.

## KV Storage Configuration

The random image API uses the following namespace:

```text
random_img_config
```

Platform compatibility:

- Defaults to ESA EdgeKV
- Cloudflare Workers: set env var `KV_PROVIDER=CF` and bind the namespace under the same name to `env`
- EdgeOne: the entry point automatically sets `KV_PROVIDER=EO`; bind the namespace under the same name to the global object

### Required Keys

#### `BASE_IMAGE_URL`

Base URL for images (single-line valid URL string). The code normalizes the URL and ensures it ends with `/`.

Example:

```text
https://asset.example.com/random-img/
```

#### `FOLDER_MAP`

Image index configuration (JSON object). Example:

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

Read rules:

- Only top-level device keys `pc` and `mb` are read
- Only brightness keys `dark` and `light` are read
- Theme counts are converted to numbers; finite values `> 0` participate in random selection, while `0` or invalid values are skipped

### Optional Keys

#### `ALLOWED_REFERER`

Referer allowlist (multi-line text). Referer validation is disabled by default, controlled by `REFERER_CHECK_ENABLED` in `app/config.js`.

If enabled, configure this key with allowed origins, supporting exact matches and wildcard subdomains:

```text
https://example.com
https://*.example.com
```

### Image Storage Path

Image URLs are composed from `BASE_IMAGE_URL` (KV) + `IMAGE_PATH_PATTERN` (config.js) + file extension.

Default `IMAGE_PATH_PATTERN`:

```text
{device}-{brightness}/{theme}/{index}
```

Expected image directory structure with the default pattern:

```text
{device}-{brightness}/{theme}/{index}.webp
```

Examples:

```text
pc-dark/theme1/000001.webp
mb-light/theme2/000002.webp
```

`IMAGE_PATH_PATTERN` supports four placeholders — `{device}`, `{brightness}`, `{theme}`, `{index}` — and can be customized in `app/config.js`:

```text
{device}/{brightness}-{theme}/{index}
{theme}/{device}-{brightness}-{index}
```

## Deployment Guide

### Aliyun ESA

Use [esa.jsonc](./esa.jsonc):

```jsonc
{
  "name": "api",
  "entry": "./app/index.js",
  "installCommand": null,
  "buildCommand": null
}
```

No need to set `KV_PROVIDER` — it defaults to ESA EdgeKV.

### Cloudflare Workers

Use [wrangler.jsonc](./wrangler.jsonc):

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

The KV binding name must match the code namespace: `random_img_config`.

Deploy:

```bash
npx wrangler deploy
```

### Tencent Cloud EdgeOne

EdgeOne recognizes files under `edge-functions/` as function routes. This project uses `edge-functions/random-img.js` as the adapter entry, which automatically injects `KV_PROVIDER=EO` before delegating to `app/index.js`.

EdgeOne KV namespace binding variable names must match those in the code:

```text
random_img_config
```

## Multi-Platform KV Adapters

All KV reads go through getters in `commons/kv.js`. The underlying client is resolved by `commons/kv-providers.js` based on `KV_PROVIDER`.

| Platform | `KV_PROVIDER` | KV Client Source |
| --- | --- | --- |
| ESA | Default or `ESA` | `new EdgeKV({ namespace })` |
| Cloudflare Workers | `CF` | `env[namespace]` |
| EdgeOne | `EO` | `env[namespace]`, fallback to `globalThis[namespace]` |

Available KV getters:

| Getter | Purpose |
| --- | --- |
| `getKvJsonObjectCached` | Read JSON config, e.g. `FOLDER_MAP` |
| `getKvUrlCached` | Read single-line URL, e.g. `BASE_IMAGE_URL` |
| `getKvTextCached` | Read single-line text |
| `getKvTextLinesCached` | Read multi-line text, e.g. Referer allowlist |
| `getKvBooleanCached` | Read strict boolean |
| `getKvNumberCached` | Read finite number |

All getters include in-memory caching, negative caching, and KV read retries.

## Development & Testing

Key configuration parameters in `app/config.js`:

| Parameter | Description |
| --- | --- |
| `FETCH_MAX_ATTEMPTS` | Max retry attempts for upstream requests |
| `FETCH_TIMEOUT_MS` | Single upstream request timeout (ms) |
| `IMAGE_INDEX_DIGITS` | Zero-padding width for image index |
| `IMAGE_FILE_EXTENSION` | Image file extension |
| `IMAGE_PATH_PATTERN` | Image path template |
| `REDIRECT_ENABLED` | Enable/disable redirect mode globally |
| `REFERER_CHECK_ENABLED` | Enable/disable Referer validation |
| `IMAGE_INFO_HEADER_ENABLED` | Enable/disable X-Image-Info response header |

## License

This project is licensed under **GNU AGPLv3**. See [LICENSE](./LICENSE) for details.

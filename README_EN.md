# Random Image API

## Introduction

This project is a random image API built on Serverless. It currently supports three edge computing platforms: **Cloudflare Workers**, **Aliyun ESA**, and **Tencent Cloud EdgeOne**.

## Features

- Runs on edge functions — low latency, zero maintenance
- Uses KV storage for configuration management
- Single endpoint, simple structure, easy to maintain

## Deployment Guide

1. Fork this repository
2. Configure the KV storage environment
3. Deploy the code to your Serverless platform
4. Configure DNS
5. Verify the endpoint is working correctly

## API Usage

Main random image endpoint: `GET /random-img`

### Optional Query Parameters

| Parameter | Description | Accepted Values | Default |
| --- | --- | --- | --- |
| `d` | Device type | `pc` / `mb` / `r` (force random) | Auto-detected from User-Agent (`pc`/`mb`), random if unknown |
| `b` | Brightness | `dark` / `light` | Random |
| `t` | Theme (multi-value supported) | Any theme present in the `FOLDER_MAP` config | Random |
| `m` | Response mode | `proxy` / `redirect` | `proxy` |

`t` supports:

- Comma-separated: `?t=theme1,theme2`
- Repeated parameter: `?t=theme1&t=theme2`
- Exclusion syntax: `?t=!theme1` excludes `theme1` from all themes
- Multiple exclusions: `?t=!theme1,!theme2` or `?t=!theme1&t=!theme2`

> Include and exclude selectors cannot be mixed. For example, `?t=theme1,!theme2` returns a 400 error.

Examples:

```text
/random-img
/random-img?t=theme1
/random-img?t=!theme1
/random-img?d=r&t=theme1
/random-img?d=mb&b=light&t=theme1,theme2
/random-img?d=pc&b=dark&t=!theme1&m=redirect
/random-img?d=pc&b=dark&t=theme1&t=theme2&m=redirect
```

### Response Modes

- `m=proxy`: The edge function fetches the image from upstream and streams it to the client
- `m=redirect`: Returns a `302` redirect with the `Location` header pointing to the image URL

> ⚠️ Privacy notice: `m=redirect` (302) mode does not hide the upstream image source URL — the client can directly see the image repository/CDN URL. Use `m=proxy` (default) if you need to conceal the source address.
> Optional: You can enable or disable `redirect` mode by modifying the `REDIRECT_ENABLED` constant in `app/index.js`.

## Configuration

### KV Storage Configuration

The following must be configured correctly, otherwise the endpoint will not function.

Namespace: `random_img_config`

Compatibility notes:

- Reads from ESA EdgeKV by default
- To run on Cloudflare Workers KV, set `KV_PROVIDER=CF` in your runtime environment
- When using CF mode, ensure the namespace is bound to the runtime `env` under the same name
- The EdgeOne entry automatically sets `KV_PROVIDER=EO`; ensure the namespace is bound on the runtime global object under the same name

Required keys:

#### 1) `BASE_IMAGE_URL`

Base URL for images (single-line valid URL string). The code normalizes the URL and ensures it ends with `/`.

Example:

```text
https://asset.example.com/random-img/
```

#### 2) `FOLDER_MAP`

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

- The code reads only top-level device keys `pc` and `mb`
- The code reads only brightness keys `dark` and `light`
- Theme counts are converted to numbers; finite values `> 0` participate in random selection, while `0` or invalid values are ignored

### Image Storage

Store images using the following path structure:

```text
{device}-{brightness}/{theme}/{index}.webp
```

Examples:

```text
pc-dark/theme1/000001.webp
mb-light/theme2/000002.webp
```

## License

This project is licensed under **GNU AGPLv3**. See [LICENSE](./LICENSE) for details.

# Serverless-ESA

## 简介

本项目是基于阿里云 ESA「函数与Pages」能力构建的 API 模板。

当前已实现随机图片 API，详见 [random-img/README.md](./random-img/README.md)。

## 特性

- 边缘函数运行，低延迟、免运维
- 使用 EdgeKV 管理配置
- 灵活的路由注册机制，易于扩展新功能

## 文档导航

- 基础路由与通用行为：[main/README.md](./main/README.md)
- 随机图片API：[random-img/README.md](./random-img/README.md)

## 部署指南

1. Fork 本仓库
2. 配置 ESA 环境（即 EdgeKV 存储），详见各 API 模块 README
3. 将代码部署到 ESA「函数与Pages」
4. 配置域名解析
5. 验证接口是否正常工作

## 开源协议

本项目使用 **GNU AGPLv3**，详见 [LICENSE](./LICENSE)。

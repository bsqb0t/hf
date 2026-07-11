# cf_hf_link

一个可直接部署到 Cloudflare Workers 的 HuggingFace 下载加速器。它只允许代理 HuggingFace 及其 CDN 域名，避免成为开放代理。

## 支持的请求

- 模型文件（通过 `/resolve/` 路径下载，边缘缓存一年）
- LFS 大文件（自动跟随跳转到 `cdn-lfs.huggingface.co`）
- HuggingFace API

## 部署

1. 安装依赖：`npm install`
2. 登录 Cloudflare：`npx wrangler login`
3. 部署：`npm run deploy`

部署成功后，将输出的 `https://cf-hf-link.<账户>.workers.dev` 替换下面的 `<worker>`。

## 用法

最通用的格式是在原始 HuggingFace 地址前添加 Worker 域名和一个 `/`：

```text
https://<worker>/https://huggingface.co/USER/MODEL/resolve/main/model.safetensors
```

也可使用更短的路由：

```text
https://<worker>/hf/USER/MODEL/resolve/main/model.safetensors
https://<worker>/models/USER/MODEL/resolve/main/model.safetensors
```

wget 下载示例：

```bash
wget -O model.safetensors https://<worker>/hf/USER/MODEL/resolve/main/model.safetensors
```

## 安全与缓存

仅允许 HTTPS 到 HuggingFace 白名单域名。模型文件的下载跳转会改写回 Worker 域名，使客户端仍然经过加速器；API 请求不被缓存，以免内容语义错误。

## 服务范围

仅对模型文件下载提供加速。HuggingFace 网页、模型卡和 Spaces 主页不提供加速支持。

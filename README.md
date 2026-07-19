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


## 固定短链

如果有常用的加速资源，可以直接在 Cloudflare Workers 后台添加环境变量，无需修改代码即可生成固定短链。支持以下变量名（按优先级读取第一个非空值）：`SHORT_LINKS`、`FIXED_LINKS`、`LINKS`。

推荐使用 JSON 对象格式：

```json
{
  "mytool": "https://huggingface.co/USER/MODEL/resolve/main/FILE",
  "readme": "https://huggingface.co/USER/MODEL/blob/main/README.md"
}
```

也支持逐行配置，便于在后台变量输入框中快速维护。每行可以使用 `=` 或 `:` 分隔短链名和目标地址：

```text
mytool=https://huggingface.co/USER/MODEL/resolve/main/FILE
readme=https://huggingface.co/USER/MODEL/blob/main/README.md
```

配置完成后访问 `https://<worker>/mytool` 或 `https://<worker>/readme` 即可按对应 HuggingFace 资源进行加速。短链名称只能占用一级路径；`hf`、`api`、`models` 等内置路由名称会保留给系统使用。短链目标仍会经过 HuggingFace 域名白名单校验，不会放开为通用代理。

如果 Cloudflare Dashboard 保存变量/密钥时报 `API Request Failed: POST /workers/scripts/<name>/versions (403)`，通常不是 Worker 运行时代码报错，而是 Dashboard 在保存新版本时被账号权限或 Cloudflare 控制台侧策略拦截。可以先用 `npx wrangler deploy --dry-run` 校验配置，再确认当前账号对该 Worker 有编辑权限。

## 安全与缓存

仅允许 HTTPS 到 HuggingFace 白名单域名。模型文件的下载跳转会改写回 Worker 域名，使客户端仍然经过加速器；API 请求不被缓存，以免内容语义错误。

## 服务范围

仅对模型文件下载提供加速。HuggingFace 网页、模型卡和 Spaces 主页不提供加速支持。

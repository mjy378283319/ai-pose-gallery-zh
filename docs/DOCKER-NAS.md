# A 房 Unraid Docker 部署 + 远程控制 B 房 ComfyUI

> 本 fork 在 upstream（`anhao/ai-pose-gallery-zh`，Cloudflare Workers/Pages 静态站）基础上加了
> `server.mjs` 同源代理与 Docker 打包，目的是：**把工作台装在 A 房 NAS 上，通过公网域名
> 跨房间驱动 B 房 Windows 上的 ComfyUI**，界面与 <https://ai-pose-gallery.anhao.app/> 一致。

## 一、与在线演示站的关键差异

| 项 | 在线演示站 | 本 Docker 版 |
| --- | --- | --- |
| 宿主 | Cloudflare Workers 静态资源 | A 房 Unraid 容器（Node 22） |
| 图库图片 | 打包进 Workers Assets | 打包进镜像（约 1.17 GB），NAS 无需再 clone |
| ComfyUI 地址 | 浏览器直连 `http://127.0.0.1:8000`，只适合同一台机器 | 浏览器走同源 `/comfy`，由 `server.mjs` 反代到 `COMFYUI_URL` |
| 跨房间 / 公网 | 不支持（混合内容 + CORS + 内网地址） | 支持：HTTPS 页面 → 同源代理 → A 房 frp 隧道 → B 房 ComfyUI |
| CORS 要求 | ComfyUI 需 `--enable-cors-header "<站点来源>"` | **不需要**（代理转发时剥离 `Origin`） |
| WebSocket 进度 | 直连 | 已反代 `/comfy/ws`，断线自动退化为 HTTP 轮询 |

## 二、前置条件（沿用 A 档远程操控方案）

| 位置 | 服务 | 端口 | 说明 |
| --- | --- | --- | --- |
| A 房 Unraid | Lucky 反代 + DNSPod DDNS | 443 | 已配好，公网唯一入口 |
| A 房 Unraid | `frps` | 7000 / 18188 / 18189 | `proxyBindAddr = "0.0.0.0"`；**18188/18189 绝不在路由器转发** |
| B 房 Windows | ComfyUI 0.45.0 cu130 / Z-Image INT8 | **8188** | 2026-11-14 已从 8189 改回 8188，约 9.7 s/张 |
| B 房 Windows | `frpc` | — | 两条隧道把本机 8188 暴露到 A 房 18188 / 18189 |
| A 房 Unraid | 本容器 `ai-pose-gallery-zh` | **8198** | 8199 已被 `comfyui-prompt-studio` 占用 |

> ⚠️ **端口一致性坑**：`comfy-remote/frpc.toml` 原先把 `18189 → B房 8189`（INT8）、
> `18188 → B房 8188`（已删除的秋叶包）。B 房 11-14 把 INT8 改回 8188 后，
> `18189` 会指向空端口。本次已把 frpc 两条都指向 8188，两个隧道都可用。
> 若你没改 frpc，就直接用 `COMFYUI_URL=http://host.docker.internal:18188`。

## 三、部署（A 房 Unraid）

### 方式 A：拉预构建镜像（推荐）

GitHub Actions 在 push 到 `main` 时自动构建并推到
`ghcr.io/mjy378283319/ai-pose-gallery-zh:latest`；也可在仓库 Actions 页手动 `Run workflow`。

```bash
mkdir -p /mnt/user/appdata/ai-pose-gallery-zh
cd /mnt/user/appdata/ai-pose-gallery-zh
# 从本仓库取 compose 与配置样例
curl -O https://raw.githubusercontent.com/mjy378283319/ai-pose-gallery-zh/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/mjy378283319/ai-pose-gallery-zh/main/.env.example
cp .env.example .env      # compose 已内置默认值；只改 COMFYUI_URL 时可省略 .env
docker compose pull
docker compose up -d
```

> GHCR 包若显示为 private，先登录：
> `echo <PAT> | docker login ghcr.io -u mjy378283319 --password-stdin`

### 方式 B：NAS 本地构建（拉不动 GHCR 时）

```bash
git clone --depth 1 https://github.com/mjy378283319/ai-pose-gallery-zh.git
cd ai-pose-gallery-zh
cp .env.example .env
docker compose -f docker-compose.build.yml up -d --build
```

### .env 关键项

```dotenv
HOST_PORT=8198
COMFYUI_URL=http://host.docker.internal:18189   # 或 18188 / B 房内网 IP:8188
COMFY_BASE_URL=/comfy                            # 不要改，浏览器必须同源
PROXY_ALLOWED_ORIGINS=                          # 自定义中转站时才填
```

`extra_hosts: host.docker.internal:host-gateway` 已在 compose 里配好，bridge 容器才能访问宿主机上的 frps。

## 四、Lucky 反代（A 房）

新增一条规则，与 `prompt.` / `fast.` 并列：

| 名称 | 前端域名 | 上游 | 其他 |
| --- | --- | --- | --- |
| Pose Atlas | `pose.你的域名` | `http://127.0.0.1:8198` | HTTPS + 自动证书 + **Basic Auth** + WebSocket 默认开启 |

- 只走 443；**不要**把 8198、18188、18189、7000 转发到公网。
- Basic Auth 套在整站上即可，`/comfy/*` 是同源请求，浏览器会自动带凭据。
- 子域用一级子域（`pose.xxx.com`），CF 免费 Universal SSL 才覆盖。

## 五、连通性验证

```bash
# 1) 容器活着
curl -s http://127.0.0.1:8198/healthz
# {"ok":true,"comfyui":"http://host.docker.internal:18189","comfyBaseUrl":"/comfy"}

# 2) 反代是否真的通到 B 房 ComfyUI（应返回 ComfyUI 的 system_stats JSON）
curl -s http://127.0.0.1:8198/comfy/system_stats | head -c 300

# 3) 图库静态资源
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8198/data/pose-zh.json
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8198/thumbs/portrait/
```

第 2 步若 502，按序排查：B 房 ComfyUI 是否开机并监听 8188 → `frpc` 是否 `login success` →
A 房 `curl http://127.0.0.1:18189/system_stats` → frps 是否绑 `0.0.0.0` → 容器 `host-gateway` 是否生效。

## 六、浏览器里完成接入

1. 打开 `https://pose.你的域名/settings` → 选「本地 ComfyUI」。
2. Base URL 保持 **`/comfy`**（本机已把默认值改成它，不再指向 `127.0.0.1:8000`）；点「自动识别 / 检测连接」，应显示 `ComfyUI 0.45.x · RTX 4060`。
3. 打开「合成台」→ 导入工作流 → 选仓库内
   `docs/workflows/z-image-int8-pose.api.json`（**API 格式**，不是画布格式）。
   - 该工作流对应 B 房实装的 `z_image_turbo_int8_convrot` + `qwen_3_4b_fp8_mixed` +
     `Z-Image-Turbo-Fun-Controlnet-Union`，8 步 / CFG 1 / AuraFlow shift 3 / 1024²。
   - 单条件 Pose 控制 strength 0.8；**必须先从姿势库选一张姿势**，合成台会把它上传到 `LoadImage` 节点。
   - 不要导入仓库自带的 Qwen Image Edit 2509 三图工作流：B 房没有那 20 GB 的 Qwen 模型。
   - 若节点/模型名报错，在 B 房 ComfyUI 里把 `Z-Image-Turbo-INT8` 工作流「保存 (API 格式)」导出后导入，再按提示重设节点映射。
4. 选人像 / 服装 / 姿势 → 「随机」/「复制词」/「合成」→ 出图（B 房约 9.7 s，回传受上行带宽影响）。
5. 进度走 `/comfy/ws`；隧道抖动时前端自动退化为 HTTP 轮询，刷新页面可恢复未决任务。

## 七、安全与合规

- 公网入口只有 Lucky 443 + Basic Auth；`18188/18189/7000` 只走 A 房内网，路由器不转发。
- 容器内不保存任何 API Key；云端 AI 的 Key 与 ComfyUI 凭据只存在浏览器本地 / `.env`。
- `/api/proxy` 有上游域名白名单 + 10 MiB 请求体上限，避免被当开放代理。
- 图库默认开启 **SFW 安全模式**，含 18+ 分类，禁止向未成年人开放；素材版权归原作者，仅限个人学习/合法创作，禁止打包倒卖。
- 用完请吊销本次使用的 GitHub fine-grained PAT（`_pat.txt` 为明文，任务结束建议撤销）。

## 八、常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面能开，「检测连接」失败 | `/comfy` 反代没通到 B 房；先做第五节第 2 步，多半是 frpc 未起或 8189/8188 端口写错 |
| 检测连接成功，提交工作流报「缺少节点」 | 导入的是画布格式 JSON；要在 ComfyUI 里「导出 (API)」 |
| 提交后一直排队无图 | B 房 ComfyUI 关机 / 显存不足；把节点 5 的 `width/height` 降到 832 试试 |
| HTTPS 页面报混合内容 | 浏览器侧 Base URL 必须是 `/comfy`，不能填 `http://...` 内网地址 |
| 云端 Gemini / Qwen 报 CORS | 在「全局请求选项」打开服务端代理；自定义中转站把域名加进 `PROXY_ALLOWED_ORIGINS` |
| 拉 GHCR 镜像慢 | 1.2 GB 属正常；或改用方式 B 在 NAS 本地构建 |
| 想改容器端口 | 改 `.env` 的 `HOST_PORT`，同步改 Lucky 上游端口 |

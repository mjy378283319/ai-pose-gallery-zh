# 我的素材：把手机微信/相册的图片与文字存进 Docker 并在网页里选用

## 原理

`ai-pose-gallery-zh` 容器新增一个**只读挂卷** `/app/userdata`（宿主机目录可自定义），
`server.mjs` 提供两个同源接口：

| 接口 | 作用 |
| --- | --- |
| `/userdata/list` | 列出目录里的图片（含文件名、URL、文字、大小） |
| `/userdata/img/<文件名>` | 返回图片本身 |

网页新增「我的素材」页（`/mine`）：网格看图和文字 → 「加入配方」进入合成台 → 走原有 5 大协议 / ComfyUI 出图。
文字还能一键填入提示词或复制。

**内置 6,162 条图库与 12,022 张图完全没动。** 挂卷只在容器中新增一个目录，互不影响。

## 一、准备目录（A 房 Unraid）

在 NAS 建目录，例如：

```
/mnt/user/appdata/ai-pose-gallery-zh/userdata/
```

把手机里的图片传进去，两种布局都支持：

```
userdata/
├── IMG_001.jpg                 # 直接放根目录
├── IMG_002.png
├── images/                     # 或放 images/ 子目录
│   ├── 微信图片_2026.jpg
│   └── ...
├── captions.json               # 可选：文字说明（见下）
└── XXX.txt                     # 可选：与图片同名的 .txt 文字
```

图片格式：`jpg / jpeg / png / webp / gif / bmp / avif`。

> ⚠️ `.wxpic` 是微信加密格式，**必须先转成 jpg/png**。
> 手机微信：「长按图片 → 保存图片」到相册；电脑微信：右键图片 → 另存为。
> 批量导出后传到上面的目录。

## 二、加文字（三选一）

### 方式 1：captions.json（推荐，最省事）

在 `userdata/` 里建一个 `captions.json`：

```json
{
  "IMG_001.jpg": "长发女性，站在窗边，暖色午后光，写实摄影",
  "IMG_002.png": "赛博朋克霓虹街道，半身像，电影感",
  "微信图片_2026.jpg": "白色连衣裙，夏日海边，逆光"
}
```

键 = 图片文件名（含扩展名），值 = 文字。没有对应键的图片显示文件名。

### 方式 2：同名 .txt

每张图配一个同名 `.txt`：`IMG_001.jpg` → `IMG_001.txt`，内容即文字。
优先级低于 `captions.json`。

### 方式 3：先不配

直接放图片也能用，网页里显示文件名，点「加入配方」照样能当参考图。

## 三、改 compose 挂卷

在 NAS 的 `docker-compose.yml`（本仓库版本）里已有：

```yaml
    environment:
      USERDATA_DIR: "/app/userdata"
    volumes:
      - "${USERDATA_DIR:-./userdata}:/app/userdata:ro"
```

在 `.env` 里改成你的实际目录：

```dotenv
USERDATA_DIR=/mnt/user/appdata/ai-pose-gallery-zh/userdata
```

然后重建容器（**只重建本容器，不动内置图库**）：

```bash
docker compose pull
docker compose up -d
```

> `:ro` 只读挂载：网页不会误删你的原始图片。要新增图片，直接在 NAS 目录里放，网页点「刷新」即可。

## 四、验收

```bash
# 1) 接口有数据
curl -s http://127.0.0.1:8198/userdata/list | head -c 500

# 2) 图片能取到（换成你的文件名）
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:8198/userdata/img/IMG_001.jpg'

# 3) healthz 带挂载路径
curl -s http://127.0.0.1:8198/healthz
```

网页打开 `/mine`：能看到图片网格 + 文字 → 点「加入配方」→ 配方槽 (1/3) → 去合成台出图。

重建容器后图片仍在（在 NAS 目录里，不在容器里）。

## 五、从手机传到 NAS 的几种方式

| 方式 | 操作 |
| --- | --- |
| Unraid 手机 App / SMB | 手机连家里 WiFi，用文件管理器连 `\\NAS\appdata\...\userdata`，直接复制相册图片 |
| 微信电脑版 | 手机微信传文件到「文件传输助手」→ 电脑微信另存到 NAS 映射的网络盘 |
| 网盘同步 | 手机相册同步到网盘 → NAS 上同步下来 |
| USB / 移动硬盘 | 拷贝后插 NAS 直接复制 |

只要最终文件出现在 `USERDATA_DIR`，网页就能看到。

## 六、常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `/mine` 显示「还没有自己的素材」 | 目录为空或路径不对；核对 `.env` 的 `USERDATA_DIR`，`docker inspect` 看挂载 |
| 图片不显示但列表有 | 文件名含特殊字符；改成纯英文+数字+下划线，或用 URL 编码 |
| 文字没出来 | 键名必须与文件名**完全一致**（含扩展名）；或 `.txt` 要与图片同名 |
| 更新镜像后图片还在吗 | 在。图片在 NAS 挂卷，不在镜像里 |
| 想删图片 | 直接在 NAS 目录删；网页刷新即可 |
| 图片很多加载慢 | 网页用懒加载；建议单目录不超过几百张，可按子目录整理 |

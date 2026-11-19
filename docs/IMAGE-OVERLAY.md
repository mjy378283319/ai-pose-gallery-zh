# 素材生图（方案 B：多图文字化 + 单图参考）

入口：左侧导航「工作台 → 素材生图」，地址 `/overlay`。

## 背景：为什么这样做

Z-Image-Turbo INT8 是**纯文生图**模型。`TextEncodeZImageOmni` 是给 Omni/Edit 变体用的
实验节点，把它喂给 Turbo 会把参考图编码成 Turbo 不认识的 reference latents，
**只要加图就出棋盘格**（1 张、3 张都这样，不是显存问题）。

所以改为**图生图（img2img）**：参考图当底稿，走标准 `VAEEncode → KSampler(denoise=0.6)`
链路，配文字重绘。彻底不用坏掉的 Omni 节点。8GB 卡稳定，不出棋盘格。

新工作流：`src/workflows/z_image_int8_img2img.api.json`，内置预设 `zimage_int8_img2img`（默认）。
旧配置会自动迁移到新预设（configVersion v4）。三张素材的文字仍可全部加进提示词。

## 使用顺序

1. **加入文字**：在「我的素材」里，对每张图点「+文字」按钮，把该图存的描述加进提示词。
   人像、服装、姿势三张可以全加，文字会按顺序汇总到右侧描述框。
2. **设底稿**：点其中一张图的**缩略图**设为底稿（必选，img2img 需要底稿）。
   建议选构图/主体最接近你想要的那张。
3. **调整描述**：描述框写清楚"把底稿改成什么样"。文字决定改造方向。
4. **生成**：点「底稿 + 文字重绘」。

重绘幅度（denoise）默认 0.6：数值越大越自由、越小越贴近底稿。
想调就到「API 接口配置 → 工作流 JSON」里改 KSampler 节点（30）的 `denoise`。

文字描述存得好不好，直接决定效果。可在「我的素材」里编辑每张图的文字（点铅笔）。

## 前提

- 生成器必须是**本地 ComfyUI（B 房）**，页面顶部可一键切换。
- 工作流用内置「Z-Image INT8 单图参考」稳定预设，832×1216，8GB 显存可跑。

## 改动文件

- `src/routes/overlay.tsx`（多选文字 + 单图参考的页面逻辑）
- `src/components/layout/nav.ts`（菜单「素材生图」）
- `src/routeTree.gen.ts`（`/overlay` 路由）

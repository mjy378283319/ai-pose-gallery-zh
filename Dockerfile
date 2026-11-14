# syntax=docker/dockerfile:1
# 两阶段构建：Node 构建前端，运行期只带 dist + 图库静态资源 + server.mjs
# 图库约 1.17 GB / 1.2 万文件直接进镜像，NAS 上无需再 clone 或挂载素材。

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10 --no-audit --no-fund
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    COMFYUI_URL=http://127.0.0.1:8188 \
    COMFY_BASE_URL=/comfy
COPY --from=build /app/dist ./dist
COPY data ./data
COPY thumbs ./thumbs
COPY img ./img
COPY og-cover.jpg robots.txt sitemap.xml ./
COPY server.mjs ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

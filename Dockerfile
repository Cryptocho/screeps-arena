# M2/S3：单 app 容器（host + 私服 runner 同进程，managed 模式原样进容器；plan-M2 复审拍板）。
# 构建期跑一次私服安装（ensure 链：screeps + native 编译 + arena-mod 落位），安装产物进镜像；
# 运行卷只挂可变数据（server/db 世界库 + journal）——消除「卷为空时仅校验存在」的分叉。
FROM node:22-slim
WORKDIR /app

# native 模块编译工具链（screeps server 依赖）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build && npm run build:client

# 构建期私服安装 + 首启世界结构（走已验证的 ensureRunning 链，随后干净停服）
RUN node dist/server/main.mjs --install-only --data-dir /app/.arena-data \
 && rm -rf /app/.arena-data/journal /app/.arena-data/agents

EXPOSE 8787
CMD ["node", "dist/server/main.mjs", "--host", "0.0.0.0", "--port", "8787", "--data-dir", "/app/.arena-data"]

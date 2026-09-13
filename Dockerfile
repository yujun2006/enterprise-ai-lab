# Phase 27-C — EnterpriseAiRuntime HTTP Service 容器镜像
# 仅安装运行期依赖（omit devDependencies）；不 bake .env / API keys。
FROM node:22-bookworm-slim

WORKDIR /app

# 安装运行期依赖（pi-agent-core / pi-ai / dotenv）。
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝已构建的产物（dist 由 `npm run build` 在宿主机生成）。
COPY dist ./dist

ENV PORT=3000
ENV HOST=0.0.0.0
ENV RUNTIME_BACKEND=ollama
ENV LLM_PROVIDER=ollama
ENV LLM_MODEL=qwen2.5:14b
ENV LLM_BASE_URL=http://localhost:11434/v1
ENV LLM_API_KEY=ollama

EXPOSE 3000

# 容器 localhost ≠ 宿主机 localhost；连接宿主机 Ollama 应在 docker run 时覆盖：
#   -e LLM_BASE_URL=http://host.docker.internal:11434/v1
# （Linux 还需 --add-host=host.docker.internal:host-gateway）
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 以非 root 用户运行（node 镜像内置 node 用户）。
USER node

CMD ["node", "dist/server.js"]

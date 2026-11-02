# NOTICE:
# The embedder uses Debian, not Alpine like the other server apps.
# The prebuilt binaries of onnxruntime-node link against glibc, and Alpine has musl.
# Source: node_modules/onnxruntime-node/bin/napi-v*/linux ships glibc builds only.
# Removal condition: onnxruntime-node ships musl builds.
FROM node:24.22.1-bookworm-slim

WORKDIR /app

RUN groupadd --system airi && useradd --system --gid airi airi

RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY patches/ ./patches/
COPY server/apps/embedder server/apps/embedder
COPY server/packages/http-error-shared server/packages/http-error-shared

# onnxruntime-node ships its CPU binaries in the package. Its install script only adds CUDA, so scripts stay off.
RUN --mount=type=cache,id=pnpm-store,target=/root/.pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @proj-airi/embedder-server...

RUN pnpm -F @proj-airi/embedder-server run build

RUN mkdir -p /models && chown airi:airi /models

EXPOSE 3000

USER airi

CMD ["pnpm", "-F", "@proj-airi/embedder-server", "start"]

# AiWork Gateway —— 仅桥接层容器镜像 (Bridge-Only)
#
# 遵循 ADR-0001 与 ADR-0005：
# 1) 仅包含 Node.js 运行时、桥接层代码、锁定的运行依赖及许可证声明
# 2) 严禁在构建阶段下载/安装官方 CLI，不包含任何个人凭据、守护进程或初始化种子
# 3) 默认作为直连网关启动，官方 CLI 状态目录通过只读卷挂载接入

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="aiwork-gateway" \
      org.opencontainers.image.description="OpenAI/Responses/Messages-compatible HTTP bridge for AiWork" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=8080 \
    BIND=0.0.0.0 \
    GATEWAY_DATA_DIR=/data \
    UPSTREAM=direct

# 基础工具：仅安装进程管理器 tini 及健康检查工具 curl
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 声明许可证与第三方通知
COPY LICENSE THIRD-PARTY-NOTICES.md /app/

# 拷贝桥接层代码及启动脚本
COPY src/ /app/src/
COPY scripts/ /app/scripts/

# 去掉可能被 Windows 编辑器带进来的 CRLF，赋予执行权限，初始化数据目录
RUN sed -i 's/\r$//' /app/scripts/*.sh \
 && chmod +x /app/scripts/*.sh \
 && mkdir -p /data

EXPOSE 8080

# 探活：只用 /healthz（纯文本 ok），不触发模型调用
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]

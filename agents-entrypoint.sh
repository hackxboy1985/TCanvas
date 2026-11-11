#!/bin/sh
# ============================================================
# Lens 画布 Agent（agents-cli）容器入口脚本
#
# 职责：
#   1) 校验内部 token（缺失/为空 fail-fast，禁止以无鉴权方式监听）；
#   2) 注入 AGENTS_API_KEY（默认取 internal-token，供 lens LLM 代理鉴权）；
#   3) 日志同时输出到 stdout（docker logs）和 AGENTS_LOG_DIR（默认 /data/logs）下的文件，
#      每行带时间戳；文件名按容器启动时间命名，配合 -v <宿主机目录>:/data/logs 可落宿主机；
#   4) 时间戳/文件名统一用北京时间：容器内为 UTC 且无 tzdata，用 epoch + 8h 换算（不依赖时区数据库）。
#
# 环境变量：
#   LENS_CANVAS_AGENT_INTERNAL_TOKEN  必填，与 lens internal-token 一致；
#   AGENTS_LOG_DIR                    日志目录，默认 /data/logs；
#   AGENTS_TZ                         预留（当前固定北京时间 UTC+8，无需配置）
# ============================================================
set -eu

if [ -z "${LENS_CANVAS_AGENT_INTERNAL_TOKEN:-}" ]; then
  echo "[agents-entrypoint] missing LENS_CANVAS_AGENT_INTERNAL_TOKEN" >&2
  exit 1
fi
export AGENTS_API_KEY="${AGENTS_API_KEY:-$LENS_CANVAS_AGENT_INTERNAL_TOKEN}"

# 北京时间：容器内为 UTC 且无 tzdata，用 epoch + 28800 秒换算，避免依赖时区数据库
now_beijing() {
  date -u -d "@$(( $(date -u +%s) + 28800 ))" "$1"
}

LOG_DIR="${AGENTS_LOG_DIR:-/data/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/agents-cli-$(now_beijing '+%Y%m%d-%H%M%S').log"
echo "[agents-entrypoint] log file: $LOG_FILE"

# 同时输出到 stdout（docker logs）与日志文件，每行加时间戳（北京时间）
node dist/cli/index.js serve --host 0.0.0.0 --port 8799 --token "$LENS_CANVAS_AGENT_INTERNAL_TOKEN" 2>&1 \
  | while IFS= read -r line; do
      printf '[%s] %s\n' "$(now_beijing '+%Y-%m-%d %H:%M:%S')" "$line"
    done \
  | tee -a "$LOG_FILE"

#!/usr/bin/env bash
# ============================================================================
# SSTV Studio —— 公网远程访问启动脚本
# ----------------------------------------------------------------------------
# 作用：把本地 8000 端口的网页通过 cloudflared 隧道暴露成公网 HTTPS 地址，
#       让你在任何网络（不同网段、4G/5G）都能打开，且手机麦克风直接可用。
#
# 用法：
#   bash web/tools/tunnel.sh              # 快速隧道（随机 URL，每次重启会变）
#   bash web/tools/tunnel.sh --named      # 命名隧道（固定域名，需先按提示创建）
#
# 本脚本固化了两个真实踩过的坑（详见 web/HTTPS_MIC_GUIDE.md 第 3.3 节）：
#   1. origin 必须用 127.0.0.1 而非 localhost
#      —— Python http.server 绑 0.0.0.0 只监听 IPv4，cloudflared 会把 localhost
#         优先解析成 IPv6 ::1，回源被拒，表现为 Cloudflare 530 / 错误码 1033。
#   2. 必须用 --config 指定独立配置文件
#      —— cloudflared 默认加载 ~/.cloudflared/config.yml，那份配置属于别的项目，
#         其 ingress 兜底是 http_status:404，会导致本隧道所有请求回源 404。
# ============================================================================
set -u

CF="/d/ruanjian/unzip/cloudflared/cloudflared"
PORT=8000
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$ROOT/web/tools/cloudflared-sstv.yml"
PY="/d/ruanjian/install/WorkBuddy/resources/vendor/python/python.exe"
LOG="/tmp/cf-sstv-tunnel.log"

if [ ! -x "$CF" ]; then
  echo "✗ 未找到 cloudflared: $CF"
  echo "  请修改脚本顶部的 CF 变量为你机器上的实际路径。"
  exit 1
fi

# ---------------------------------------------------------------- 1. 起本地服务
is_listening() { netstat -ano 2>/dev/null | grep -i "LISTENING" | grep -q ":$PORT "; }

if is_listening; then
  echo "✓ 本地 $PORT 端口已在监听，跳过启动"
else
  echo "… 本地 $PORT 未监听，正在启动 serve.py"
  if [ -x "$PY" ]; then
    ( cd "$ROOT" && "$PY" web/serve.py >/tmp/sstv-serve.log 2>&1 & )
  else
    ( cd "$ROOT/web" && python -m http.server "$PORT" --bind 0.0.0.0 >/tmp/sstv-serve.log 2>&1 & )
  fi
  sleep 2
  if is_listening; then
    echo "✓ 本地服务已启动"
  else
    echo "✗ 本地服务启动失败，请查看 /tmp/sstv-serve.log"
    exit 1
  fi
fi

# --------------------------------------------------------------- 2. 起隧道
if [ "${1:-}" = "--named" ]; then
  echo "… 使用命名隧道模式（读取 $CONFIG 中的 tunnel / ingress 配置）"
  echo "  若提示缺少隧道凭据，请先执行："
  echo "    $CF tunnel create sstv-studio"
  echo "    $CF tunnel route dns sstv-studio sstv.qiaoyukeji.com"
  echo "  然后把返回的 UUID 与主机名填入 $CONFIG"
  echo
  exec "$CF" tunnel --config "$CONFIG" run --no-autoupdate --logfile "$LOG"
fi

echo "… 正在建立快速隧道（origin=http://127.0.0.1:$PORT）"
rm -f "$LOG"
"$CF" tunnel --config "$CONFIG" --url "http://127.0.0.1:$PORT" \
  --no-autoupdate --protocol http2 --logfile "$LOG" >/dev/null 2>&1 &

# 等待 URL 出现（最多 40 秒）
for i in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1)"
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "${URL:-}" ]; then
  echo "✗ 40 秒内未取得隧道地址，日志尾部："
  tail -15 "$LOG"
  exit 1
fi

echo
echo "════════════════════════════════════════════════════════════"
echo "  ✅ 公网地址（任何网络均可访问，含手机麦克风）"
echo
echo "     $URL"
echo
echo "  ⚠️  这是临时地址，进程退出即失效；重跑会得到新的随机域名。"
echo "     需要固定域名请用：bash web/tools/tunnel.sh --named"
echo "════════════════════════════════════════════════════════════"
echo
echo "按 Ctrl+C 停止隧道（本地服务不受影响）。"
wait

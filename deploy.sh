#!/usr/bin/env bash
# M²Studio 协作白板 · 一键部署脚本（Debian / Ubuntu）
#
# 用法（用 root 执行）：
#   bash deploy.sh --token 你的口令
#   bash deploy.sh --port 8787 --token 你的口令 --snapmb 24
#
# 做完的事：装 Node.js（>=18）→ 建 /opt/whiteboard → 注册 systemd 开机自启
#          → 启动中继并打印可分享的网址。重复执行只更新程序，不动 rooms 里已有内容。
#
# 参数：
#   --port    监听端口，默认 8787
#   --token   访问口令（强烈建议设置，12 位以上随机串）
#   --dir     安装目录，默认 /opt/whiteboard
#   --snapmb  单个房间快照体积上限（MB），默认 12；图多的板可调到 24
set -euo pipefail

PORT=8787
TOKEN=""
APP_DIR=/opt/whiteboard
SNAP_MB=12
SERVICE=whiteboard

while [ $# -gt 0 ]; do
  case "$1" in
    --port)   PORT="${2:-}"; shift 2 ;;
    --token)  TOKEN="${2:-}"; shift 2 ;;
    --dir)    APP_DIR="${2:-}"; shift 2 ;;
    --snapmb) SNAP_MB="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）"; exit 1 ;;
  esac
done

[ "$(id -u)" = "0" ] || { echo "请用 root 运行：先执行 sudo -i，再执行 bash deploy.sh ..."; exit 1; }
command -v apt-get >/dev/null 2>&1 || { echo "本脚本只支持 Debian / Ubuntu；其他系统请按说明书手动部署"; exit 1; }

say(){ printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m[注意] %s\033[0m\n' "$*"; }

# ---------- 1. Node.js ----------
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -v | sed 's/^v//' | cut -d. -f1)
  [ "${major:-0}" -ge 18 ] 2>/dev/null && need_node=0
fi
if [ "$need_node" = 1 ]; then
  say "安装 Node.js 22（这一步约 1–2 分钟）"
  apt-get update -y
  apt-get install -y curl ca-certificates
  # 官方源；若卡在下载，可先设置国内镜像（见说明书「装不上 Node 怎么办」）
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
say "Node.js 已就绪：$($NODE_BIN -v)（$NODE_BIN）"

# ---------- 2. 程序文件 ----------
say "准备安装目录 $APP_DIR"
mkdir -p "$APP_DIR/rooms"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SRC_DIR/relay-server.js" ] && [ -f "$SRC_DIR/whiteboard.html" ]; then
  say "使用脚本同目录的程序文件"
  install -m 0644 "$SRC_DIR/relay-server.js" "$APP_DIR/relay-server.js"
  install -m 0644 "$SRC_DIR/whiteboard.html" "$APP_DIR/whiteboard.html"
else
  say "从 GitHub 下载程序文件（约 300KB）"
  BASE=https://raw.githubusercontent.com/rkdehd-rgb/whiteboard/master
  curl -fsSL -o "$APP_DIR/relay-server.js" "$BASE/relay-server.js"
  curl -fsSL -o "$APP_DIR/whiteboard.html" "$BASE/whiteboard.html"
fi

# 独立低权限账号跑服务（不存在才创建）
if ! id wb >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin wb
fi
chown -R wb:wb "$APP_DIR"
chmod 0755 "$APP_DIR"
chmod 0700 "$APP_DIR/rooms"

# ---------- 3. systemd ----------
TOKEN_ARG=""
if [ -n "$TOKEN" ]; then TOKEN_ARG="--token $TOKEN"; else warn "没有设置口令，任何拿到网址的人都能进；建议加 --token"; fi

say "注册开机自启服务 $SERVICE.service"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=M2Studio Whiteboard Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=wb
Group=wb
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/relay-server.js --port $PORT --dir $APP_DIR/rooms --snapmb $SNAP_MB $TOKEN_ARG
Restart=always
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 1

if ! systemctl is-active --quiet "$SERVICE"; then
  warn "服务没起来，下面是最近 20 行日志："
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  exit 1
fi

# ---------- 4. 防火墙与本机检查 ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null 2>&1 || true
  say "已在本机防火墙放行 TCP $PORT"
fi

IP="$(curl -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)"
[ -n "$IP" ] || IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="你的服务器公网IP"

Q=""
[ -n "$TOKEN" ] && Q="?token=$TOKEN"

say "部署完成"
cat <<EOF

  服务器公网 IP：$IP
  健康检查：    http://$IP:$PORT/health$Q
  打开白板：    http://$IP:$PORT/$Q
  发给同事：    http://$IP:$PORT/$Q#room=team

  房间内容目录：$APP_DIR/rooms
  查看日志：    journalctl -u $SERVICE -n 50 --no-pager
  重启服务：    systemctl restart $SERVICE

  还需要做的两件事：
  1) 云厂商控制台 → 防火墙/安全组 → 放行 TCP $PORT（否则外网打不开）
  2) 换掉示例房间名 team，改成本团队自己的英文/拼音房间号

EOF

if [ -n "$TOKEN" ]; then
  echo "  口令：$TOKEN（请连同网址一起发给同事，不要公开发布）"
else
  warn "未设置口令：任何人拿到网址即可编辑白板"
fi

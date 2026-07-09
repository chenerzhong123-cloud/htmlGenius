#!/usr/bin/env bash
# 刷新 Google JWKS(在能连 Google 的机器上跑,如你的 Mac)。
# 用途:Google 签名密钥约每月轮换;当登录开始报 "JWKS 无匹配 key" 时跑这个,
#       或设成每周 cron。后端按文件 mtime 自动重载,无需重启服务。
set -e
OUT=/tmp/google-jwks.json
echo "抓取 Google JWKS…"
curl -fsS -m 15 -o "$OUT" https://www.googleapis.com/oauth2/v3/certs
echo "keys: $(python3 -c "import json;print(len(json.load(open('$OUT'))['keys']))") 个"
scp "$OUT" aliyun:/etc/htmlgenius/google-jwks.json
chmod 600 /tmp/google-jwks.json 2>/dev/null || true
ssh aliyun 'chmod 600 /etc/htmlgenius/google-jwks.json'
echo "✓ JWKS 已推到阿里云,后端自动重载。"

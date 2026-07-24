#!/usr/bin/env bash
# scripts/pack.sh — 打包 htmlGenius 扩展为 Chrome Web Store 上传 zip
#
# 产物:dist/htmlGenius-<version>.zip,manifest.json 在 zip 根目录(商店要求)。
# 设计要点:
#   - 以 extension/ 全量为根,排除 *-test.html 开发页与系统垃圾;
#   - 密钥 / pem / db 本就不在 extension/ 内,这里再加自检兜底;
#   - macOS:用 COPYFILE_DISABLE=1 + zip -X,杜绝 __MACOSX / ._* / .DS_Store。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"

if [ ! -f "$EXT/manifest.json" ]; then
  echo "❌ 找不到 extension/manifest.json ($EXT)"; exit 1
fi

# 从 manifest 读版本号('"version"' 不会误匹配 "manifest_version":前者 v 前是引号,后者 v 前是下划线)
VERSION=$(grep -m1 '"version"' "$EXT/manifest.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
if [ -z "${VERSION:-}" ]; then echo "❌ 解析版本失败"; exit 1; fi
echo "📦 打包 htmlGenius v$VERSION"

DIST="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$DIST"

# 1) 拷贝 extension/ 全部到临时 staging(保留目录结构)
cp -R "$EXT/." "$STAGE/"

# 2) 排除开发页 / 系统垃圾 / 死重量(产物里不应出现)
rm -f "$STAGE"/*-test.html "$STAGE"/*-test.js
rm -f "$STAGE"/fonts/*cormorant*          # Cormorant 已在 v0.5.1 弃用,sidepanel.css 只用 Inter
rm -f "$STAGE"/icons/icon-512*            # 512 是商店图标素材,manifest 只引用 16/48/128,不该进运行包
find "$STAGE" -name '.DS_Store' -delete

# 3) 移除 Web Store 上传不允许的字段(只动 staging 副本,源 extension/ 保留)
#    - key:本地开发用来钉扩展 ID;商店包里带了会被拒(报"清单文件中不得包含 key 字段")。
#      商店端会按其登记的公钥分配 ID,不需要 manifest 里的 key。
#    - update_url:商店会自动注入,manifest 里带了反而被拒(本就没有,双保险删一次)。
node -e "const fs=require('fs');const f=process.argv[1];const m=JSON.parse(fs.readFileSync(f,'utf8'));const stripped=[];for(const k of ['key','update_url']){if(k in m){delete m[k];stripped.push(k);}}fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n');console.log(stripped.length?('已从上传包移除: '+stripped.join(', ')):'manifest 无 key/update_url,跳过');" "$STAGE/manifest.json"

# 5) 打包:进 staging 目录打,保证 manifest.json 落在 zip 根
OUT="$DIST/htmlGenius-$VERSION.zip"
rm -f "$OUT"
( cd "$STAGE" && COPYFILE_DISABLE=1 zip -r -X "$OUT" . -x '*.DS_Store' -x '__MACOSX*' -x '*/.DS_Store' >/dev/null )

# 统一取一份清单/manifest 内容到变量再 grep:
# 避免 `unzip -l | grep -q` 在 set -o pipefail 下因 grep -q 提前退出触发 unzip SIGPIPE,把整条管道误判为失败。
LISTING="$(unzip -l "$OUT")"
MANIFEST_CONTENT="$(unzip -p "$OUT" manifest.json)"

# 6) 安全自检:产物绝不能含敏感文件
if grep -qiE "client_secret|\.pem$|\.db(-wal|-shm)?$" <<< "$LISTING"; then
  echo "❌ 安全自检失败:产物含敏感文件(密钥/pem/db)!"; grep -iE "client_secret|\.pem|\.db" <<< "$LISTING"; exit 1
fi

# 7) manifest 合规自检:上传包绝不能含 key / update_url(商店硬性拒绝)
if grep -qE '"(key|update_url)"\s*:' <<< "$MANIFEST_CONTENT"; then
  echo "❌ manifest 合规自检失败:含 key/update_url(会被 Web Store 拒)"; exit 1
fi

# 8) 结构自检:关键文件必须在根
for f in manifest.json sidepanel.html sidepanel.js content-script.js background.js config.js; do
  if ! grep -qE "^\s+[0-9]+\s+[0-9-]+\s+[0-9:]+\s+$f$" <<< "$LISTING"; then
    echo "❌ 结构自检失败:根目录缺 $f"; exit 1
  fi
done

# 6) 汇报
NFILES=$(unzip -Z1 "$OUT" | grep -c .)
echo "✅ 安全自检通过:无密钥/pem/db"
echo "✅ 结构自检通过:关键文件在根"
echo "─── 产物 ───"
ls -lh "$OUT"
echo "包含 $NFILES 个文件;manifest.json / sidepanel.html 在根目录,可直接上传 Chrome Web Store。"

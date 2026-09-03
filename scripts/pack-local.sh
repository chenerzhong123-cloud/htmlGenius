#!/usr/bin/env bash
# 为“加载已解压的扩展程序”生成本地测试包。
# 与 Chrome Web Store 上传包不同，本包必须保留 manifest.key，以便每次解压升级仍使用同一个开发扩展 ID。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT="$ROOT/extension"
VERSION=$(grep -m1 '"version"' "$EXT/manifest.json" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
DIST="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$DIST"
cp -R "$EXT/." "$STAGE/"
rm -f "$STAGE"/*-test.html "$STAGE"/*-test.js
rm -f "$STAGE"/fonts/*cormorant* "$STAGE"/icons/icon-512*
find "$STAGE" -name '.DS_Store' -delete

# 本地包保留 key；update_url 仍不应由本地测试包指定。
node -e "const fs=require('fs');const f=process.argv[1];const m=JSON.parse(fs.readFileSync(f,'utf8'));delete m.update_url;fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n');" "$STAGE/manifest.json"

OUT="$DIST/PageTack-$VERSION-local-test.zip"
rm -f "$OUT"
( cd "$STAGE" && COPYFILE_DISABLE=1 zip -r -X "$OUT" . -x '*.DS_Store' -x '__MACOSX*' -x '*/.DS_Store' >/dev/null )

LISTING="$(unzip -l "$OUT")"
MANIFEST_CONTENT="$(unzip -p "$OUT" manifest.json)"
if grep -qiE "client_secret|\.pem$|\.db(-wal|-shm)?$" <<< "$LISTING"; then
  echo "❌ 本地测试包含敏感文件"; exit 1
fi
if ! grep -qE '"key"[[:space:]]*:' <<< "$MANIFEST_CONTENT"; then
  echo "❌ 本地测试包缺少固定 ID key"; exit 1
fi
for f in manifest.json sidepanel.html sidepanel.js content-script.js background.js config.js; do
  if ! grep -qE "^\s+[0-9]+\s+[0-9-]+\s+[0-9:]+\s+$f$" <<< "$LISTING"; then
    echo "❌ 本地测试包根目录缺 $f"; exit 1
  fi
done

echo "✅ PageTack v$VERSION 本地测试包（保留固定扩展 ID）"
ls -lh "$OUT"
echo "注意：仅用于 Chrome 开发者模式，禁止上传 Chrome Web Store。"

#!/bin/bash
# MediaGrab installer.
#
# Deploys the native messaging host and registers it with every Chromium-family
# browser found on this machine. Idempotent: safe to re-run after a code change.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$ROOT/build"
APP_SUPPORT="$HOME/Library/Application Support/MediaGrab"
HOST_DIR="$APP_SUPPORT/host"
HOST_NAME="com.mass.mediagrab"

say()  { printf '  %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
head_ "1. 检查运行环境"

for bin in /opt/homebrew/bin/yt-dlp /usr/local/bin/yt-dlp; do
  if [ -x "$bin" ]; then
    say "yt-dlp : $bin"
    break
  fi
done
command -v yt-dlp >/dev/null 2>&1 || say "⚠️  未找到 yt-dlp，请先执行：brew install yt-dlp"

FFMPEG=""
for bin in /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg; do
  [ -x "$bin" ] && FFMPEG="$bin" && break
done
if [ -n "$FFMPEG" ]; then say "ffmpeg : $FFMPEG"; else say "⚠️  未找到 ffmpeg，高清视频将无法自动合并音视频轨"; fi

PY=""
for candidate in /opt/homebrew/bin/python3 /usr/local/bin/python3 \
                 "$HOME"/.workbuddy/binaries/python/versions/*/bin/python3 /usr/bin/python3; do
  [ -x "$candidate" ] && PY="$candidate" && break
done
if [ -z "$PY" ]; then
  echo "找不到可用的 python3，安装中止。" >&2
  exit 1
fi
say "python : $PY"

# ---------------------------------------------------------------------------
head_ "2. 确定扩展 ID"

if [ ! -f "$BUILD/extension_key.pem" ] || [ ! -f "$BUILD/extension_id.txt" ]; then
  say "首次安装，生成扩展密钥…"
  mkdir -p "$BUILD"
  /usr/bin/openssl genrsa -out "$BUILD/extension_key.pem" 2048 2>/dev/null
  /usr/bin/openssl rsa -in "$BUILD/extension_key.pem" -pubout -outform DER \
    -out "$BUILD/extension_pub.der" 2>/dev/null
  "$PY" - "$BUILD" <<'PYEOF'
import base64, hashlib, os, sys
build = sys.argv[1]
der = open(os.path.join(build, "extension_pub.der"), "rb").read()
digest = hashlib.sha256(der).hexdigest()[:32]
ext_id = "".join(chr(ord("a") + int(c, 16)) for c in digest)
open(os.path.join(build, "extension_id.txt"), "w").write(ext_id + "\n")
open(os.path.join(build, "extension_key_b64.txt"), "w").write(base64.b64encode(der).decode() + "\n")
PYEOF
fi

EXT_ID="$(tr -d '\n' < "$BUILD/extension_id.txt")"
say "扩展 ID : $EXT_ID"

# Keep the manifest's "key" in sync with the generated identity, otherwise
# Chrome assigns a random ID and the allow-list in the host manifest misses.
"$PY" - "$ROOT/extension/manifest.json" "$BUILD/extension_key_b64.txt" <<'PYEOF'
import json, sys
manifest_path, key_path = sys.argv[1], sys.argv[2]
key = open(key_path).read().strip()
data = json.load(open(manifest_path, encoding="utf-8"))
if data.get("key") != key:
    data["key"] = key
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print("  manifest.json 的 key 已更新")
else:
    print("  manifest.json 的 key 已是最新")
PYEOF

# ---------------------------------------------------------------------------
head_ "3. 部署 native host"

mkdir -p "$HOST_DIR"
/usr/bin/install -m 755 "$ROOT/native/mediagrab_host.py" "$HOST_DIR/mediagrab_host.py"
/usr/bin/install -m 755 "$ROOT/native/mediagrab-host" "$HOST_DIR/mediagrab-host"
say "已安装到 $HOST_DIR"

# Smoke-test the host over the real protocol before registering it.
say "协议自检…"
RESULT="$("$PY" "$ROOT/build/nm_client.py" "$HOST_DIR/mediagrab-host" '{"cmd":"ping"}' 30 2>&1 \
  | /usr/bin/grep -c '"ok": true' || true)"
if [ "$RESULT" = "1" ]; then
  say "✓ native host 响应正常"
else
  say "✗ native host 未按预期响应，请检查 $HOST_DIR"
fi

# ---------------------------------------------------------------------------
head_ "4. 注册到浏览器"

write_manifest() {
  local dir="$1" label="$2"
  [ -d "$dir" ] || return 0
  cat > "$dir/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "MediaGrab native host: bridges the MediaGrab extension to yt-dlp.",
  "path": "$HOST_DIR/mediagrab-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
  say "✓ $label"
}

CHROME_SUPPORT="$HOME/Library/Application Support/Google/Chrome"
write_manifest "$CHROME_SUPPORT/NativeMessagingHosts" "Google Chrome"

CHROMIUM_SUPPORT="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
write_manifest "$CHROMIUM_SUPPORT" "Chromium"

write_manifest "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" "Brave"
write_manifest "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" "Microsoft Edge"
write_manifest "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts" "Vivaldi"
write_manifest "$HOME/Library/Application Support/Arc/NativeMessagingHosts" "Arc"

# ---------------------------------------------------------------------------
head_ "安装完成"

EXT_DIR="$ROOT/extension"
cat <<EOF

接下来在浏览器里加载扩展（只需一次）：

  1. 打开  chrome://extensions
  2. 右上角打开「开发者模式」
  3. 点「加载已解压的扩展程序」，选择：
       $EXT_DIR
  4. 确认扩展 ID 是：
       $EXT_ID

如果加载后 ID 不是上面这个，说明 manifest.json 里的 key 被改动了，
重新运行本脚本即可修复。

验证：点扩展图标，左上角应显示「已连接」。

目录说明
  扩展源码     $ROOT/extension
  本地服务     $HOST_DIR
  任务日志     $APP_SUPPORT/jobs
  浏览器注册   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json
EOF

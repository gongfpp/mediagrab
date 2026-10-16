#!/bin/bash
# MediaGrab uninstaller: removes the browser registration and the local host.
# The unpacked extension itself must be removed from chrome://extensions by hand.

set -uo pipefail

APP_SUPPORT="$HOME/Library/Application Support/MediaGrab"
HOST_NAME="com.mass.mediagrab"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "==> 移除浏览器注册"
for dir in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Arc/NativeMessagingHosts"
do
  target="$dir/$HOST_NAME.json"
  if [ -f "$target" ]; then
    /bin/mv "$target" "$HOME/.Trash/${HOST_NAME}.json.${STAMP}"
    echo "  移入废纸篓: $target"
  fi
done

echo "==> 移除本地服务与任务记录"
if [ -d "$APP_SUPPORT" ]; then
  /bin/mv "$APP_SUPPORT" "$HOME/.Trash/MediaGrab.${STAMP}"
  echo "  移入废纸篓: $APP_SUPPORT"
fi

echo
echo "完成。扩展本体请到 chrome://extensions 手动移除。"

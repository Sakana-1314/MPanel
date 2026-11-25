#!/bin/sh
# 生成运行时 /config.json。放在 /docker-entrypoint.d/ 下，由 nginx 官方入口在启动前执行。
set -eu

TARGET=/usr/share/nginx/html/config.json

if [ -n "${MPANEL_CONFIG_FILE:-}" ] && [ -f "${MPANEL_CONFIG_FILE}" ]; then
  cp "${MPANEL_CONFIG_FILE}" "$TARGET"
  echo "mpanel: config.json 来自 ${MPANEL_CONFIG_FILE}"
  exit 0
fi

export MPANEL_APP_NAME="${MPANEL_APP_NAME:-MPanel}"
export MPANEL_ALLOW_USER_CONNECTIONS="${MPANEL_ALLOW_USER_CONNECTIONS:-true}"
export MPANEL_DBX_URL="${MPANEL_DBX_URL:-}"
export MPANEL_DEFAULT_BACKENDS="${MPANEL_DEFAULT_BACKENDS:-[]}"

case "$MPANEL_APP_NAME" in
  *'"'* | *'\'* ) echo "mpanel: MPANEL_APP_NAME 不能包含引号或反斜杠" >&2; exit 1 ;;
esac
case "$MPANEL_DBX_URL" in
  *'"'* | *'\'* ) echo "mpanel: MPANEL_DBX_URL 不能包含引号或反斜杠" >&2; exit 1 ;;
esac
case "$MPANEL_ALLOW_USER_CONNECTIONS" in
  true | false ) : ;;
  * ) echo "mpanel: MPANEL_ALLOW_USER_CONNECTIONS 只能是 true 或 false" >&2; exit 1 ;;
esac

envsubst '${MPANEL_APP_NAME} ${MPANEL_ALLOW_USER_CONNECTIONS} ${MPANEL_DBX_URL} ${MPANEL_DEFAULT_BACKENDS}' \
  < /etc/mpanel/config.json.template > "$TARGET"

# 校验生成结果是合法 JSON。
jq empty "$TARGET" 2>/dev/null \
  || { echo "mpanel: 生成的 config.json 不是合法 JSON（检查 MPANEL_DEFAULT_BACKENDS）" >&2; exit 1; }

echo "mpanel: 已生成 config.json"

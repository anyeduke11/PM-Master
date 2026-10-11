#!/bin/bash
# 启动包装：.env 缺失但 .env.enc 存在时，从 Keychain 解密为临时 env 文件加载（明文不常驻）
set -euo pipefail
cd "$(dirname "$0")/.."

SVC="pm-master"; ACC="env-encryption-key"

if [ -f .env ]; then
  exec node --env-file-if-exists=.env "$@"
fi
if [ -f .env.enc ]; then
  KEY=$(security find-generic-password -s "$SVC" -a "$ACC" -w 2>/dev/null || true)
  [ -n "$KEY" ] || { echo "no key in Keychain; run: npm run secrets unlock"; exit 1; }
  TMP=$(mktemp /tmp/pm-env.XXXXXX); trap 'rm -f "$TMP"' EXIT
  printf '%s' "$KEY" | openssl enc -aes-256-cbc -d -pbkdf2 -in .env.enc -out "$TMP" -pass stdin
  chmod 600 "$TMP"
  exec node --env-file="$TMP" "$@"
fi
echo "(no .env; mock provider)" >&2
exec node "$@"

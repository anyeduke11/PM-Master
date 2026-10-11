#!/bin/bash
# PM-Master 密钥管理：macOS Keychain 托管 AES 密钥，.env ↔ .env.enc
# 用法: secrets.sh {lock|unlock|status}
set -euo pipefail
cd "$(dirname "$0")/.."

SVC="pm-master"
ACC="env-encryption-key"
EF=".env"
ENC=".env.enc"

get_key() { security find-generic-password -s "$SVC" -a "$ACC" -w 2>/dev/null || true; }

case "${1:-status}" in
  lock)
    [ -f "$EF" ] || { echo "missing $EF"; exit 1; }
    KEY=$(get_key)
    if [ -z "$KEY" ]; then
      KEY=$(openssl rand -base64 32)
      security add-generic-password -s "$SVC" -a "$ACC" -w "$KEY"
      echo "key generated and stored in Keychain ($SVC)"
    fi
    printf '%s' "$KEY" | openssl enc -aes-256-cbc -salt -pbkdf2 -in "$EF" -out "$ENC" -pass stdin
    rm "$EF"
    echo "locked: $ENC (plaintext removed)"
    ;;
  unlock)
    [ -f "$ENC" ] || { echo "missing $ENC"; exit 1; }
    KEY=$(get_key)
    [ -n "$KEY" ] || { echo "no key in Keychain"; exit 1; }
    printf '%s' "$KEY" | openssl enc -aes-256-cbc -d -pbkdf2 -in "$ENC" -out "$EF" -pass stdin
    echo "unlocked: $EF (remember to lock after use)"
    ;;
  status)
    [ -f "$EF" ] && echo "$EF: plaintext EXISTS" || echo "$EF: absent"
    [ -f "$ENC" ] && echo "$ENC: present" || echo "$ENC: absent"
    KEY=$(get_key); [ -n "$KEY" ] && echo "Keychain: managed ($SVC)" || echo "Keychain: none"
    ;;
  *) echo "usage: $0 {lock|unlock|status}"; exit 1 ;;
esac

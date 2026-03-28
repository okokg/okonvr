#!/bin/bash
# Generate .htpasswd for nginx basic auth
# Usage: ./gen-htpasswd.sh [username] [password]
#
# Also repairs the Docker bind mount quirk where .htpasswd becomes
# a directory if the file was missing when docker-compose started.

USER="${1:-demo}"
PASS="${2:-memo}"

TARGET="nginx/.htpasswd"

# Fix: Docker creates a directory when bind-mounting a nonexistent file
if [ -d "$TARGET" ]; then
  echo "⚠ $TARGET is a directory (Docker bind mount quirk) — removing"
  rm -rf "$TARGET"
fi

HASH=$(openssl passwd -apr1 "$PASS")
echo "${USER}:${HASH}" > "$TARGET"

echo "✓ Created $TARGET"
echo "  User: ${USER}"
echo "  Pass: ${PASS}"
echo ""
echo "Restart nginx: docker compose restart nginx"

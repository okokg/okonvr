#!/bin/bash
# Generate .htpasswd for nginx basic auth
# Usage: ./gen-htpasswd.sh [username] [password]

USER="${1:-demo}"
PASS="${2:-memo}"

HASH=$(openssl passwd -apr1 "$PASS")
echo "${USER}:${HASH}" > nginx/.htpasswd

echo "Created nginx/.htpasswd"
echo "  User: ${USER}"
echo "  Pass: ${PASS}"
echo ""
echo "Restart nginx: docker compose restart nginx"

#!/bin/bash
# OKO NVR — First-time setup
# Run once before `docker compose up -d`

set -e
cd "$(dirname "$0")"

echo "═══════════════════════════════════"
echo "  OKO NVR — Setup"
echo "═══════════════════════════════════"
echo ""

CHANGED=0

# 1. .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ Created .env from template"
  echo "  → Edit SERVER_IP in .env"
  CHANGED=1
else
  echo "· .env exists"
fi

# 2. oko.yaml
if [ ! -f oko.yaml ]; then
  cp oko.yaml.example oko.yaml
  echo "✓ Created oko.yaml from template"
  echo "  → Edit NVR credentials in oko.yaml"
  CHANGED=1
else
  echo "· oko.yaml exists"
fi

# 3. nginx/.htpasswd
if [ ! -f nginx/.htpasswd ]; then
  HASH=$(openssl passwd -apr1 "demo" 2>/dev/null || echo '$apr1$default$pljh2huX5l.Y7gWwKFSFB0')
  echo "demo:${HASH}" > nginx/.htpasswd
  echo "✓ Created nginx/.htpasswd (demo/demo)"
  echo "  → Run ./gen-htpasswd.sh admin yourpass to change"
  CHANGED=1
elif [ -d nginx/.htpasswd ]; then
  # Fix Docker bind mount quirk
  rm -rf nginx/.htpasswd
  HASH=$(openssl passwd -apr1 "demo" 2>/dev/null || echo '$apr1$default$pljh2huX5l.Y7gWwKFSFB0')
  echo "demo:${HASH}" > nginx/.htpasswd
  echo "✓ Fixed nginx/.htpasswd (was directory, now file)"
  CHANGED=1
else
  echo "· nginx/.htpasswd exists"
fi

# 4. models/ directory
if [ ! -d models ]; then
  mkdir -p models
  echo "✓ Created models/ directory"
else
  echo "· models/ exists"
fi

echo ""
if [ $CHANGED -eq 1 ]; then
  echo "═══════════════════════════════════"
  echo "  Setup complete. Next steps:"
  echo ""
  echo "  1. Edit oko.yaml — add your NVR"
  echo "  2. Edit .env    — set SERVER_IP"
  echo "  3. docker compose up -d"
  echo "═══════════════════════════════════"
else
  echo "Everything ready. Run: docker compose up -d"
fi

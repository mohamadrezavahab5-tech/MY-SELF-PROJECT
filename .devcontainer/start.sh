#!/usr/bin/env bash
# Starts the site in a GitHub Codespace. Demo login: 09120000000 / demo1234
# (created by `npm run seed`; ADMIN_PHONES makes it the site owner too).
set -e
cd "$(dirname "$0")/.."
if curl -fs -o /dev/null http://localhost:3000/; then
  echo "Site is already running on port 3000."
  exit 0
fi
if [ -n "$CODESPACE_NAME" ]; then
  export SITE_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
fi
exec npm start

#!/bin/sh
# Entrypoint of the n8n container in docker-compose.yml.
# First start only: create the credentials from the environment, then import
# and publish the two workflows. Later starts leave your edits alone. The data
# tables are created by the workflows themselves on their first run.
set -eu

MARK=/home/node/.n8n/.account-scanner-imported

if [ ! -f "$MARK" ]; then
  STAGE=$(mktemp -d)
  node /bootstrap/prepare.mjs /bootstrap/workflows "$STAGE"
  n8n import:credentials --input="$STAGE/credentials.json"
  n8n import:workflow --separate --input="$STAGE/workflows"
  # The scanner first, then the workflow that calls it.
  for id in acctScannerMain01 acctScannerHook01; do
    n8n publish:workflow --id="$id"
  done
  rm -rf "$STAGE"
  touch "$MARK"
  echo "account-scanner: workflows imported and published"
fi

exec n8n start

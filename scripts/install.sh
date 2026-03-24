#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

MODULE_ID="tuner"
DIST_DIR="$ROOT_DIR/dist/$MODULE_ID"
REMOTE_HOST="${MOVE_HOST:-move.local}"
REMOTE_USER="${MOVE_USER:-root}"
REMOTE_PATH="/data/UserData/schwung/modules/tools/$MODULE_ID"

if [ ! -d "$DIST_DIR" ]; then
    echo "ERROR: dist/$MODULE_ID/ not found. Run ./scripts/build.sh first."
    exit 1
fi

echo "==> Deploying $MODULE_ID to $REMOTE_USER@$REMOTE_HOST..."

ssh "$REMOTE_USER@$REMOTE_HOST" "mkdir -p $REMOTE_PATH"
scp -r "$DIST_DIR"/* "$REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH/"
ssh "$REMOTE_USER@$REMOTE_HOST" "chmod -R a+rw $REMOTE_PATH"

echo "==> Installed to $REMOTE_PATH"
echo "==> Restart Move or reload modules to use."

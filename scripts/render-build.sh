#!/bin/bash
set -e

echo "=== Installing dependencies ==="
npm install --include=dev

echo "=== Building @ham/types ==="
node_modules/.bin/tsc -p packages/types/tsconfig.json

echo "=== Building @ham/db ==="
node_modules/.bin/tsc -p packages/db/tsconfig.json

echo "=== Building API (NestJS) ==="
ROOT=$(pwd)
cd apps/api
"$ROOT/node_modules/.bin/nest" build
cd "$ROOT"

echo "=== Build complete ==="
ls apps/api/dist/main.js

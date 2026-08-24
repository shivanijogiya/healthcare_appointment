#!/bin/bash
set -e

echo "Node: $(node -v), NPM: $(npm -v)"
echo "PWD: $(pwd)"

echo "=== Installing all dependencies ==="
npm install --include=dev

echo "=== Checking tools ==="
./node_modules/.bin/tsc --version
./node_modules/.bin/nest --version

echo "=== Building @ham/types ==="
./node_modules/.bin/tsc -p packages/types/tsconfig.json
echo "types dist: $(ls packages/types/dist/)"

echo "=== Building @ham/db ==="
./node_modules/.bin/tsc -p packages/db/tsconfig.json
echo "db dist: $(ls packages/db/dist/)"

echo "=== Building NestJS API ==="
cd apps/api
../../node_modules/.bin/nest build
cd ../..

echo "=== Verifying output ==="
ls -la apps/api/dist/main.js
echo "=== BUILD SUCCESSFUL ==="

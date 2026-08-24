#!/bin/bash
set -e
echo "=== Running migrations ==="
npm run migrate
echo "=== Seeding demo data ==="
npm run seed
echo "=== Post-deploy complete ==="

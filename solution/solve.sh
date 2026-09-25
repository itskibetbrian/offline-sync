#!/usr/bin/env bash
set -euo pipefail

# Oracle: apply the reference sync fix over the scaffold, then build.
# Harbor copies solution/ to /solution at runtime.
cp -r /solution/fixed/src/. /workspace/src/

cd /workspace
npm install
npm run build

#!/bin/bash
set -euo pipefail
export CI=true
pnpm install --no-frozen-lockfile
pnpm build

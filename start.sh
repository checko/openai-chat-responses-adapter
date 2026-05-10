#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export ADAPTER_BIND="${ADAPTER_BIND:-127.0.0.1}"
export ADAPTER_PORT="${ADAPTER_PORT:-18891}"
export ADAPTER_TOKEN="${ADAPTER_TOKEN:-change-me}"
export RESPONSES_UPSTREAM_URL="${RESPONSES_UPSTREAM_URL:-http://127.0.0.1:18890/v1/responses}"
export RESPONSES_UPSTREAM_TOKEN="${RESPONSES_UPSTREAM_TOKEN:-change-me-upstream-token}"

exec node server.mjs

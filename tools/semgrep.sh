#!/usr/bin/env bash
# Runs the project's custom Semgrep rules locally, mirroring the CI `sast` job.
#
# Semgrep has no npm package we want as a dependency, so it runs via Docker.
# This is optional locally (skips cleanly if Docker is unavailable) but is a
# blocking gate in CI — see .github/workflows/ci.yml.
set -euo pipefail

IMAGE="semgrep/semgrep:1.170.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "semgrep: docker not found — skipping local SAST (CI still enforces it)."
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "semgrep: docker not running — skipping local SAST (CI still enforces it)."
  exit 0
fi

echo "semgrep: running custom rules (.semgrep.yml)…"
docker run --rm -v "/${ROOT}":/src -w //src "$IMAGE" \
  semgrep --config=.semgrep.yml --error --skip-unknown-extensions \
  --exclude=node_modules --exclude=dist .

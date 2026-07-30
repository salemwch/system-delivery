#!/usr/bin/env bash
# Prepares the OSRM Tunisia extract that `docker compose --profile routing` serves.
#
# `infra/docker/docker-compose.yml` tells you to run this first, and it is not
# optional: `osrm-routed` needs a PREPROCESSED `.osrm` graph, and pointing it at a
# raw `.osm.pbf` fails with an error that reads like a missing file.
#
# One-time and slow (download plus three passes; minutes, not seconds). Idempotent
# — it skips both the download and the preprocessing if their outputs already
# exist, so re-running after a partial failure resumes rather than restarts.
#
# The image is pinned by digest to exactly the one the compose file serves with.
# Preprocessing and serving MUST use the same OSRM version: the graph format is
# version-specific, and a mismatch fails at startup.
set -euo pipefail

# Same digest as the `osrm` service in infra/docker/docker-compose.yml.
IMAGE="ghcr.io/project-osrm/osrm-backend:latest@sha256:a7091038e39a73659767f34ef2d389909b42ea80b09bd2bdca482dce2991cbad"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${ROOT}/infra/docker/osrm-data"

# ⚠️ WINDOWS PATH CONVERSION, and it cost a silently-broken run to find.
#
# Git Bash (MSYS) rewrites anything that looks like a Unix path in a command's
# arguments into a Windows path before the process sees it. `-p /opt/car.lua` — a
# path INSIDE the container — arrived as `C:/Program Files/Git/opt/car.lua`, and
# osrm-extract failed on an argument this script never wrote. These two variables
# switch that off for the docker invocations; both are unset and inert on Linux
# and macOS, so the script stays one code path.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# Tunisia only. The full Maghreb extract is ~5x the size and the MVP serves one
# country (01-mvp-scope: Tunisia first). Swapping the region is this URL plus the
# `command:` in the compose file.
REGION="tunisia-latest"
PBF_URL="https://download.geofabrik.de/africa/${REGION}.osm.pbf"

if ! command -v docker >/dev/null 2>&1; then
  echo "osrm:prepare: docker not found. Install Docker Desktop and retry." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "osrm:prepare: docker is not running. Start it and retry." >&2
  exit 1
fi

mkdir -p "${DATA_DIR}"

# The volume SOURCE needs the OPPOSITE treatment to the arguments above: Docker
# Desktop wants `C:/Users/…`, and `pwd` in Git Bash gives `/c/Users/…`, which it
# rejects outright. `pwd -W` is the MSYS-only builtin that returns the Windows
# form. After `mkdir`, because `cd` needs the directory to exist.
if [ -n "${MSYSTEM:-}" ]; then
  DOCKER_DATA_DIR="$(cd "${DATA_DIR}" && pwd -W)"
else
  DOCKER_DATA_DIR="${DATA_DIR}"
fi

if [ -f "${DATA_DIR}/${REGION}.osrm.mldgr" ]; then
  echo "osrm:prepare: ${REGION} is already prepared. Nothing to do."
  echo "              Start it with: docker compose -f infra/docker/docker-compose.yml --profile routing up -d"
  exit 0
fi

if [ ! -f "${DATA_DIR}/${REGION}.osm.pbf" ]; then
  echo "osrm:prepare: downloading ${REGION}.osm.pbf (~100 MB)…"
  # Downloaded to a temp name and moved on success, so an interrupted download
  # cannot leave a truncated file that the next run treats as complete.
  curl -fSL --retry 3 -o "${DATA_DIR}/${REGION}.osm.pbf.part" "${PBF_URL}"
  mv "${DATA_DIR}/${REGION}.osm.pbf.part" "${DATA_DIR}/${REGION}.osm.pbf"
else
  echo "osrm:prepare: reusing the existing ${REGION}.osm.pbf."
fi

run_osrm() {
  docker run --rm -v "${DOCKER_DATA_DIR}:/data" "${IMAGE}" "$@"
}

# The three passes, in the only order that works: extract builds the graph,
# partition computes the MLD cells, customize weights them. `--algorithm mld` in
# the compose command is what requires the last two.
echo "osrm:prepare: extract (car profile)…"
run_osrm osrm-extract -p /opt/car.lua "/data/${REGION}.osm.pbf"

echo "osrm:prepare: partition…"
run_osrm osrm-partition "/data/${REGION}.osrm"

echo "osrm:prepare: customize…"
run_osrm osrm-customize "/data/${REGION}.osrm"

echo
echo "osrm:prepare: done. Next:"
echo "  docker compose -f infra/docker/docker-compose.yml --profile routing up -d"
echo "  then set ROUTING_OPTIMIZER=osrm in .env to use it (default is haversine)."

#!/usr/bin/env sh
set -eu

REPO_URL="${ROAMCLI_REPO_URL:-https://github.com/CharAznable98/roam-cli.git}"
INSTALL_DIR="${ROAMCLI_INSTALL_DIR:-$HOME/.roamcli/server}"
DATA_DIR=""
BIND="0.0.0.0"
PORT="8787"
PUBLIC_ORIGIN=""
VERSION=""
REF=""
DRY_RUN="0"
UNINSTALL="0"
YES="0"
DELETE_DATA="0"

usage() {
  cat <<'USAGE'
Usage: install-server.sh [options]

Install, upgrade, or uninstall RoamCli Server using local Docker Compose builds.

Options:
  --version <tag>        Install a release tag, for example v1.2.3.
  --ref <ref>            Install a git ref, branch, tag, or sha. Overrides --version.
  --install-dir <path>   Install directory. Default: ~/.roamcli/server.
  --data-dir <path>      Persistent data directory. Default: <install-dir>/data.
  --bind <host>          Host bind address. Default: 0.0.0.0.
  --port <port>          Host port. Default: 8787.
  --public-origin <url>  Optional ROAMCLI_PUBLIC_ORIGIN value.
  --dry-run              Print planned files and commands without writing.
  --uninstall            Stop and remove deployment files.
  --delete-data          With --uninstall, also delete the data directory.
  --yes                  Skip confirmation prompts for uninstall.
  -h, --help             Show help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:?missing --version value}"
      shift 2
      ;;
    --ref)
      REF="${2:?missing --ref value}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:?missing --install-dir value}"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="${2:?missing --data-dir value}"
      shift 2
      ;;
    --bind)
      BIND="${2:?missing --bind value}"
      shift 2
      ;;
    --port)
      PORT="${2:?missing --port value}"
      shift 2
      ;;
    --public-origin)
      PUBLIC_ORIGIN="${2:?missing --public-origin value}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --uninstall)
      UNINSTALL="1"
      shift
      ;;
    --delete-data)
      DELETE_DATA="1"
      shift
      ;;
    --yes|-y)
      YES="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$DATA_DIR" ]; then
  DATA_DIR="$INSTALL_DIR/data"
fi

resolve_path() {
  case "$1" in
    /*) printf "%s" "$1" ;;
    *) printf "%s/%s" "$(pwd -P)" "$1" ;;
  esac
}

INSTALL_DIR="$(resolve_path "$INSTALL_DIR")"
DATA_DIR="$(resolve_path "$DATA_DIR")"

COMPOSE_FILE="$INSTALL_DIR/compose.yml"
ENV_FILE="$INSTALL_DIR/.env"

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    echo "Install Docker, Docker Compose, and Git, then retry." >&2
    exit 1
  fi
}

need_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    echo "Missing dependency: docker compose" >&2
    echo "Install Docker Compose v2, then retry." >&2
    exit 1
  fi
}

confirm() {
  prompt="$1"
  if [ "$YES" = "1" ]; then
    return 0
  fi
  printf "%s [y/N] " "$prompt"
  read answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

uninstall() {
  echo "RoamCli Server uninstall"
  if [ "$DRY_RUN" = "1" ]; then
    echo "Would run: docker compose -f $COMPOSE_FILE down"
    echo "Would remove deployment files under: $INSTALL_DIR"
    if [ "$DELETE_DATA" = "1" ]; then
      echo "Would delete data directory: $DATA_DIR"
    fi
    return 0
  fi
  if ! confirm "Stop RoamCli Server and remove deployment files?"; then
    echo "Cancelled."
    return 0
  fi
  if [ -f "$COMPOSE_FILE" ]; then
    docker compose -f "$COMPOSE_FILE" down
  fi
  if [ "$DELETE_DATA" = "1" ]; then
    if ! confirm "Delete persistent data at $DATA_DIR? This cannot be undone."; then
      echo "Data preserved."
      DELETE_DATA="0"
    fi
  fi
  rm -rf "$INSTALL_DIR/current" "$INSTALL_DIR/releases" "$COMPOSE_FILE" "$ENV_FILE"
  if [ "$DELETE_DATA" = "1" ]; then
    rm -rf "$DATA_DIR"
  fi
  echo "RoamCli Server uninstalled."
}

latest_tag() {
  tag="$(
    git ls-remote --tags --refs --sort=-version:refname "$REPO_URL" 'v*' \
      | awk 'NR == 1 { sub("refs/tags/", "", $2); print $2 }'
  )"
  if [ -z "$tag" ]; then
    echo "Could not resolve latest release tag from $REPO_URL" >&2
    exit 1
  fi
  printf "%s" "$tag"
}

sanitize_ref() {
  printf "%s" "$1" | tr '/:' '--'
}

clone_ref() {
  ref="$1"
  target="$2"
  rm -rf "$target"
  mkdir -p "$(dirname "$target")"
  if git clone --depth 1 --branch "$ref" "$REPO_URL" "$target"; then
    return 0
  fi
  rm -rf "$target"
  git clone "$REPO_URL" "$target"
  git -C "$target" checkout "$ref"
}

compose_content() {
  cat <<EOF
services:
  server:
    build:
      context: "$SOURCE_DIR"
      dockerfile: apps/server/Dockerfile
    environment:
      ROAMCLI_DATA_DIR: /data
      HOST: 0.0.0.0
      PORT: 8787
EOF
  if [ -n "$PUBLIC_ORIGIN" ]; then
    cat <<EOF
      ROAMCLI_PUBLIC_ORIGIN: "$PUBLIC_ORIGIN"
EOF
  fi
  cat <<EOF
    ports:
      - "$BIND:$PORT:8787"
    volumes:
      - "$DATA_DIR:/data"
EOF
}

install_or_upgrade() {
  need_command git
  need_command docker
  need_compose

  TARGET_REF="$REF"
  if [ -z "$TARGET_REF" ]; then
    if [ -n "$VERSION" ]; then
      TARGET_REF="$VERSION"
    else
      TARGET_REF="$(latest_tag)"
    fi
  fi
  REF_DIR="$(sanitize_ref "$TARGET_REF")"
  SOURCE_DIR="$INSTALL_DIR/releases/$REF_DIR/source"

  if [ "$DRY_RUN" = "1" ]; then
    echo "RoamCli Server dry run"
    echo "Repo: $REPO_URL"
    echo "Ref: $TARGET_REF"
    echo "Install dir: $INSTALL_DIR"
    echo "Data dir: $DATA_DIR"
    echo "Compose file: $COMPOSE_FILE"
    echo "Would clone source to: $SOURCE_DIR"
    echo "Would write env file:"
    print_env
    echo "Would write compose file:"
    compose_content
    echo "Would run: docker compose -f $COMPOSE_FILE up -d --build"
    return 0
  fi

  mkdir -p "$INSTALL_DIR" "$DATA_DIR"
  clone_ref "$TARGET_REF" "$SOURCE_DIR"
  ln -sfn "$INSTALL_DIR/releases/$REF_DIR" "$INSTALL_DIR/current"
  print_env > "$ENV_FILE"
  compose_content > "$COMPOSE_FILE"
  docker compose -f "$COMPOSE_FILE" up -d --build

  echo "RoamCli Server is starting on http://$BIND:$PORT"
  echo "Setup token file: $DATA_DIR/setup-token.txt"
}

print_env() {
  cat <<EOF
ROAMCLI_REF=$TARGET_REF
ROAMCLI_DATA_DIR=$DATA_DIR
ROAMCLI_BIND=$BIND
ROAMCLI_PORT=$PORT
ROAMCLI_PUBLIC_ORIGIN=$PUBLIC_ORIGIN
EOF
}

if [ "$UNINSTALL" = "1" ]; then
  need_command docker
  need_compose
  uninstall
else
  install_or_upgrade
fi

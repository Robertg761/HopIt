#!/bin/sh
# HopIt installer.
#
#   curl -fsSL https://hopit.dev/install | sh
#
# Downloads the prebuilt HopIt bundle for this machine from the public release
# channel, verifies its checksum, installs it under ~/.hopit, and links the
# `hop` launcher into ~/.local/bin. Run `hop setup` afterwards for first-run
# onboarding.
set -eu

BASE="${HOPIT_RELEASE_BASE_URL:-https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev}"
CHANNEL="${HOPIT_RELEASE_CHANNEL:-latest}"
INSTALL_DIR="${HOPIT_INSTALL_DIR:-$HOME/.hopit}"
BIN_DIR="$HOME/.local/bin"

TMP_DIR=""
LOCK_DIR=""
LOCK_HELD=0
RUNTIME_STAGE=""
LAUNCHER_STAGE=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -n "$RUNTIME_STAGE" ] && [ -e "$RUNTIME_STAGE" ]; then
    rm -rf "$RUNTIME_STAGE"
  fi
  if [ -n "$LAUNCHER_STAGE" ] && [ -e "$LAUNCHER_STAGE" ]; then
    rm -f "$LAUNCHER_STAGE"
  fi
  if [ "$LOCK_HELD" -eq 1 ] && [ -n "$LOCK_DIR" ]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "hopit install: $1" >&2
  exit 1
}

# --- Detect platform -------------------------------------------------------
uname_s="$(uname -s)"
case "$uname_s" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    fail "unsupported operating system: $uname_s (Windows is not supported yet)" ;;
  *)
    fail "unsupported operating system: $uname_s" ;;
esac

# --- Detect architecture ---------------------------------------------------
uname_m="$(uname -m)"
case "$uname_m" in
  arm64 | aarch64) ARCH="arm64" ;;
  x86_64 | amd64) ARCH="x64" ;;
  *)
    fail "unsupported architecture: $uname_m" ;;
esac

TARGET="${PLATFORM}-${ARCH}"
ARCHIVE="hop-${TARGET}.tar.gz"
MANIFEST_URL="${BASE}/${CHANNEL}/manifest.json"

echo "Resolving HopIt ${CHANNEL} for ${TARGET} from ${BASE}" >&2

# --- Pick a downloader -----------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  DOWNLOAD="curl -fsSL -o"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOAD="wget -qO"
else
  fail "need either curl or wget to download the release"
fi

download() {
  # download <url> <dest>
  # shellcheck disable=SC2086
  $DOWNLOAD "$2" "$1" || fail "failed to download $1"
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hopit-install.XXXXXX")" || fail "could not create temp dir"

# Serialize installers before resolving the channel. A stale lock is reclaimed
# only when its recorded process no longer exists.
mkdir -p "$INSTALL_DIR"
LOCK_DIR="$INSTALL_DIR/.install-lock"
if mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_HELD=1
else
  lock_pid="$(sed -n '1p' "$LOCK_DIR/pid" 2>/dev/null || true)"
  case "$lock_pid" in
    '' | *[!0-9]*) fail "another HopIt installer owns an incomplete lock; retry shortly or remove $LOCK_DIR if no installer is running" ;;
  esac
  if kill -0 "$lock_pid" 2>/dev/null; then
    fail "another HopIt installer is already running (pid $lock_pid)"
  fi
  stale_lock="$INSTALL_DIR/.install-lock.stale.$$"
  mv "$LOCK_DIR" "$stale_lock" 2>/dev/null || fail "installer lock changed while it was being checked; retry"
  rm -rf "$stale_lock"
  mkdir "$LOCK_DIR" 2>/dev/null || fail "another HopIt installer started concurrently"
  LOCK_HELD=1
fi
echo "$$" > "$LOCK_DIR/pid"

MANIFEST_PATH="$TMP_DIR/manifest.json"
download "$MANIFEST_URL" "$MANIFEST_PATH"

# The mutable channel contains only a manifest. Resolve it to immutable release
# objects so an interrupted publisher can never mix archive/checksum versions.
VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST_PATH" | head -n 1)"
case "$VERSION" in
  '' | *[!A-Za-z0-9._+-]*) fail "release manifest contains an invalid version" ;;
esac
grep -F "\"$TARGET\"" "$MANIFEST_PATH" >/dev/null 2>&1 || fail "release manifest does not contain target $TARGET"

RELEASE_PREFIX="releases/${VERSION}"
ARCHIVE_URL="${BASE}/${RELEASE_PREFIX}/${ARCHIVE}"
CHECKSUM_URL="${ARCHIVE_URL}.sha256"
ARCHIVE_PATH="$TMP_DIR/$ARCHIVE"
CHECKSUM_PATH="$TMP_DIR/$ARCHIVE.sha256"

echo "Installing HopIt ${VERSION} for ${TARGET}" >&2
download "$ARCHIVE_URL" "$ARCHIVE_PATH"
download "$CHECKSUM_URL" "$CHECKSUM_PATH"

# --- Verify checksum -------------------------------------------------------
# Accept exactly one canonical sidecar line for the archive we downloaded,
# then hash that archive directly. This prevents a malformed sidecar from
# successfully checking some other file in the temporary directory.
EXPECTED_CHECKSUM="$(awk -v archive="$ARCHIVE" '
  NF == 2 && $2 == archive && $1 ~ /^[0-9A-Fa-f]+$/ {
    digest = tolower($1)
    matches += 1
  }
  END {
    if (NR == 1 && matches == 1 && length(digest) == 64) print digest
  }
' "$CHECKSUM_PATH")"
[ -n "$EXPECTED_CHECKSUM" ] || fail "release checksum sidecar is malformed or names the wrong archive"

if command -v shasum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM="$(shasum -a 256 "$ARCHIVE_PATH" | awk 'NR == 1 { print tolower($1) }')"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_CHECKSUM="$(sha256sum "$ARCHIVE_PATH" | awk 'NR == 1 { print tolower($1) }')"
else
  fail "need shasum or sha256sum to verify the release"
fi
[ "$ACTUAL_CHECKSUM" = "$EXPECTED_CHECKSUM" ] || fail "checksum verification failed"

# --- Extract ---------------------------------------------------------------
EXTRACT_DIR="$TMP_DIR/extract"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$EXTRACT_DIR" || fail "failed to extract $ARCHIVE"

# The archive contains a single top-level directory (hop-<target>/).
PACKAGE_SRC="$EXTRACT_DIR/hop-${TARGET}"
if [ ! -d "$PACKAGE_SRC" ]; then
  # Fall back to whatever single directory the archive produced.
  PACKAGE_SRC="$(find "$EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
fi
[ -n "$PACKAGE_SRC" ] && [ -x "$PACKAGE_SRC/bin/hop" ] || fail "release archive did not contain bin/hop"
"$PACKAGE_SRC/bin/hop" help >/dev/null 2>&1 || fail "downloaded HopIt runtime failed its pre-install smoke test"

# --- Stage an immutable versioned runtime ---------------------------------
# Never rename the currently launched runtime out of the way. The old launcher
# remains usable until its atomic replacement points at this fully staged tree.
RUNTIMES_DIR="$INSTALL_DIR/runtimes"
RUNTIME_DIR="$RUNTIMES_DIR/$VERSION"
RUNTIME_STAGE="$RUNTIMES_DIR/.$VERSION.new.$$"
mkdir -p "$RUNTIMES_DIR"

if [ -e "$RUNTIME_DIR" ]; then
  [ -x "$RUNTIME_DIR/bin/hop" ] || fail "existing runtime $VERSION is incomplete"
  "$RUNTIME_DIR/bin/hop" help >/dev/null 2>&1 || fail "existing runtime $VERSION failed its smoke test"
else
  mv "$PACKAGE_SRC" "$RUNTIME_STAGE"
  chmod +x "$RUNTIME_STAGE/bin/hop" "$RUNTIME_STAGE/runtime/node" 2>/dev/null || true
  mv "$RUNTIME_STAGE" "$RUNTIME_DIR" || fail "could not stage runtime $VERSION"
  RUNTIME_STAGE=""
fi

HOP_BIN="$RUNTIME_DIR/bin/hop"

# --- Link launcher ---------------------------------------------------------
# The packaged launcher resolves its sibling runtime/app relative to its own
# directory via "$0". A bare symlink would carry the link path as "$0" and look
# for the runtime next to the link, so install a tiny wrapper that execs the
# real launcher by absolute path instead.
mkdir -p "$BIN_DIR"
LINK="$BIN_DIR/hop"
LAUNCHER_STAGE="$BIN_DIR/.hop.new.$$"
cat > "$LAUNCHER_STAGE" <<EOF
#!/bin/sh
exec "$HOP_BIN" "\$@"
EOF
chmod +x "$LAUNCHER_STAGE"
mv -f "$LAUNCHER_STAGE" "$LINK" || fail "could not activate the HopIt launcher"
LAUNCHER_STAGE=""

# --- Report ----------------------------------------------------------------
echo "" >&2
echo "HopIt installed." >&2
echo "  version:  $VERSION" >&2
echo "  runtime:  $RUNTIME_DIR" >&2
echo "  launcher: $LINK -> $HOP_BIN" >&2

case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "" >&2
    echo "$BIN_DIR is not on your PATH. Add it with:" >&2
    echo "  export PATH=\"$BIN_DIR:\$PATH\"" >&2
    ;;
esac

echo "" >&2
echo "Next step: run 'hop setup' for guided first-run onboarding." >&2

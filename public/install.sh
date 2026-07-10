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
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

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
ARCHIVE_URL="${BASE}/${CHANNEL}/${ARCHIVE}"
CHECKSUM_URL="${ARCHIVE_URL}.sha256"

echo "Installing HopIt for ${TARGET} from ${BASE}/${CHANNEL}" >&2

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

ARCHIVE_PATH="$TMP_DIR/$ARCHIVE"
CHECKSUM_PATH="$TMP_DIR/$ARCHIVE.sha256"

download "$ARCHIVE_URL" "$ARCHIVE_PATH"
download "$CHECKSUM_URL" "$CHECKSUM_PATH"

# --- Verify checksum -------------------------------------------------------
# The sidecar is "<hex>  <name>.tar.gz"; verify from inside the temp dir so the
# relative filename in the sidecar resolves.
(
  cd "$TMP_DIR" || fail "could not enter temp dir"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$CHECKSUM_PATH" >/dev/null 2>&1 || fail "checksum verification failed"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$CHECKSUM_PATH" >/dev/null 2>&1 || fail "checksum verification failed"
  else
    echo "hopit install: warning: no shasum/sha256sum found; skipping checksum verification" >&2
  fi
)

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

# --- Atomically replace <install-dir>/runtime -----------------------------
mkdir -p "$INSTALL_DIR"
RUNTIME_DIR="$INSTALL_DIR/runtime"
RUNTIME_NEW="$INSTALL_DIR/runtime.new.$$"
RUNTIME_OLD="$INSTALL_DIR/runtime.old.$$"

rm -rf "$RUNTIME_NEW"
# Move the freshly extracted, verified package into place under the install dir
# first, so the old runtime is only removed after the new one is staged.
mv "$PACKAGE_SRC" "$RUNTIME_NEW"

if [ -e "$RUNTIME_DIR" ]; then
  mv "$RUNTIME_DIR" "$RUNTIME_OLD"
fi
mv "$RUNTIME_NEW" "$RUNTIME_DIR"
rm -rf "$RUNTIME_OLD"

HOP_BIN="$RUNTIME_DIR/bin/hop"
chmod +x "$HOP_BIN" "$RUNTIME_DIR/runtime/node" 2>/dev/null || true

# --- Link launcher ---------------------------------------------------------
# The packaged launcher resolves its sibling runtime/app relative to its own
# directory via "$0". A bare symlink would carry the link path as "$0" and look
# for the runtime next to the link, so install a tiny wrapper that execs the
# real launcher by absolute path instead.
mkdir -p "$BIN_DIR"
LINK="$BIN_DIR/hop"
rm -f "$LINK"
cat > "$LINK" <<EOF
#!/bin/sh
exec "$HOP_BIN" "\$@"
EOF
chmod +x "$LINK"

# --- Report ----------------------------------------------------------------
echo "" >&2
echo "HopIt installed." >&2
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

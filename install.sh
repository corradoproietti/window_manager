#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
DEST_BASE="${CINNAWM_EXTENSIONS_DIR:-${DATA_HOME}/cinnamon/extensions}"
LOCALE_BASE="${CINNAWM_LOCALE_DIR:-${DATA_HOME}/locale}"
SRC_DIR="${CINNAWM_SRC_DIR:-}"
ZIP_FILE="${CINNAWM_ZIP_FILE:-}"
ENABLE_EXT=true
RELOAD_EXT=true
UNINSTALL=false

EXTRACT_DIR=""
STAGE_DIR=""
cleanup() {
    if [ -n "${EXTRACT_DIR}" ]; then
        rm -rf "${EXTRACT_DIR}"
    fi
    if [ -n "${STAGE_DIR}" ]; then
        rm -rf "${STAGE_DIR}"
    fi
}
trap cleanup EXIT

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install, update, or uninstall CinnaWM from the local Cinnamon environment.

Options:
  --src=DIR          Path to the extension folder containing metadata.json
  --zip=FILE         Install directly from a distributable release .zip archive
  --dest-dir=DIR     Override extensions base directory (default: \$XDG_DATA_HOME/cinnamon/extensions)
  --locale-dir=DIR   Override locale base directory (default: \$XDG_DATA_HOME/locale)
  --no-enable        Do not modify org.cinnamon enabled-extensions
  --no-reload        Do not trigger live Cinnamon extension reload over D-Bus
  --uninstall        Remove installed extension, legacy backups, and compiled locale files
  -h, --help         Show this help message
EOF
}

for arg in "$@"; do
    case "$arg" in
        --src=*) SRC_DIR="${arg#*=}" ;;
        --zip=*) ZIP_FILE="${arg#*=}" ;;
        --dest-dir=*) DEST_BASE="${arg#*=}" ;;
        --locale-dir=*) LOCALE_BASE="${arg#*=}" ;;
        --no-enable) ENABLE_EXT=false ;;
        --no-reload) RELOAD_EXT=false ;;
        --uninstall) UNINSTALL=true ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
    esac
done

read_metadata_field() {
    local meta_file="$1"
    local field="$2"
    python3 -c "import json, sys; print(json.load(open(sys.argv[1], encoding='utf-8')).get(sys.argv[2], ''))" "${meta_file}" "${field}"
}

detect_src_dir() {
    local search_root="$1"
    if [ -n "${SRC_DIR}" ] && [ -f "${SRC_DIR}/metadata.json" ]; then
        printf '%s\n' "${SRC_DIR}"
        return 0
    fi
    if [ -f "${search_root}/metadata.json" ] && [ -n "$(read_metadata_field "${search_root}/metadata.json" uuid)" ]; then
        printf '%s\n' "${search_root}"
        return 0
    fi
    for candidate in "${search_root}"/*/metadata.json; do
        if [ -f "${candidate}" ] && [ -n "$(read_metadata_field "${candidate}" uuid)" ]; then
            dirname "${candidate}"
            return 0
        fi
    done
    return 1
}

SEARCH_ROOT="${SCRIPT_DIR}"
if [ -n "${ZIP_FILE}" ] && [ "${UNINSTALL}" != true ]; then
    if [ ! -f "${ZIP_FILE}" ]; then
        echo "Error: archive not found: ${ZIP_FILE}" >&2
        exit 1
    fi
    if ! command -v unzip >/dev/null 2>&1; then
        echo "Error: 'unzip' is required to install from ${ZIP_FILE}." >&2
        exit 1
    fi
    EXTRACT_DIR="$(mktemp -d)"
    unzip -q "${ZIP_FILE}" -d "${EXTRACT_DIR}"
    SEARCH_ROOT="${EXTRACT_DIR}"
fi

SRC_DIR="$(detect_src_dir "${SEARCH_ROOT}")" || {
    echo "Error: unable to locate extension directory containing metadata.json." >&2
    exit 1
}

UUID="${CINNAWM_UUID:-$(read_metadata_field "${SRC_DIR}/metadata.json" uuid)}"
VERSION="$(read_metadata_field "${SRC_DIR}/metadata.json" version)"
if [ -z "${UUID}" ]; then
    echo "Error: missing 'uuid' in ${SRC_DIR}/metadata.json." >&2
    exit 1
fi

DEST_DIR="${DEST_BASE}/${UUID}"

remove_legacy_backups() {
    if [ -d "${DEST_BASE}" ]; then
        find "${DEST_BASE}" -maxdepth 1 -mindepth 1 -name "${UUID}.backup.*" -exec rm -rf {} + 2>/dev/null || true
    fi
}

if [ "${UNINSTALL}" = true ]; then
    echo "==> Removing ${UUID} and any legacy backups from ${DEST_BASE} ..."
    rm -rf "${DEST_DIR}"
    remove_legacy_backups
    if [ -d "${LOCALE_BASE}" ]; then
        find "${LOCALE_BASE}" -type f -name "${UUID}.mo" -delete 2>/dev/null || true
    fi
    echo "==> Uninstall complete."
    exit 0
fi

echo "==> Installing ${UUID} (v${VERSION:-unknown}) into ${DEST_DIR} ..."
mkdir -p "${DEST_BASE}"
STAGE_DIR="$(mktemp -d "${DEST_BASE}/.${UUID}.install.XXXXXX")"

cp -r "${SRC_DIR}" "${STAGE_DIR}/${UUID}"
find "${STAGE_DIR}/${UUID}" \( -name '__pycache__' -o -name '*.pyc' -o -name '*.pyo' -o -name '*.swp' -o -name '.DS_Store' \) -exec rm -rf {} + 2>/dev/null || true

# Clean up any legacy backup folders inside DEST_BASE (Cinnamon treats every subfolder as an extension).
remove_legacy_backups

# Atomic swap with rollback kept strictly outside DEST_BASE (inside STAGE_DIR).
if [ -e "${DEST_DIR}" ]; then
    ROLLBACK_DIR="${STAGE_DIR}/${UUID}.previous"
    mv "${DEST_DIR}" "${ROLLBACK_DIR}"
    if ! mv "${STAGE_DIR}/${UUID}" "${DEST_DIR}"; then
        mv "${ROLLBACK_DIR}" "${DEST_DIR}"
        echo "Error: restored previous installation after swap failure." >&2
        exit 1
    fi
else
    mv "${STAGE_DIR}/${UUID}" "${DEST_DIR}"
fi

# Install Gettext catalogs (.mo bundled in package or compiled from .po) into $LOCALE_BASE
if [ -d "${SRC_DIR}/locale" ]; then
    for mo_file in "${SRC_DIR}/locale/"*/LC_MESSAGES/"${UUID}.mo"; do
        [ -f "${mo_file}" ] || continue
        lang="$(basename "$(dirname "$(dirname "${mo_file}")")")"
        locale_dir="${LOCALE_BASE}/${lang}/LC_MESSAGES"
        mkdir -p "${locale_dir}"
        cp "${mo_file}" "${locale_dir}/${UUID}.mo"
    done
fi
if command -v msgfmt >/dev/null 2>&1 && [ -d "${SRC_DIR}/po" ]; then
    for po_file in "${SRC_DIR}/po/"*.po; do
        [ -f "${po_file}" ] || continue
        lang="$(basename "${po_file}" .po)"
        locale_dir="${LOCALE_BASE}/${lang}/LC_MESSAGES"
        mkdir -p "${locale_dir}"
        msgfmt "${po_file}" -o "${locale_dir}/${UUID}.mo"
    done
fi

# Enable extension in gsettings if available and desired
if [ "${ENABLE_EXT}" = true ] && command -v gsettings >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    python3 - "${UUID}" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
try:
    raw = subprocess.check_output(["gsettings", "get", "org.cinnamon", "enabled-extensions"], text=True).strip()
    if raw.startswith("@as "):
        raw = raw[4:].strip()
    arr = list(ast.literal_eval(raw)) if raw else []
    if uuid not in arr:
        arr.append(uuid)
        subprocess.check_call(["gsettings", "set", "org.cinnamon", "enabled-extensions", str(arr)])
        print(f"==> Enabled '{uuid}' in gsettings (org.cinnamon enabled-extensions).")
    else:
        print(f"==> Extension '{uuid}' already enabled in gsettings.")
except Exception as e:
    print(f"Note: could not update gsettings automatically ({e}).")
PY
fi

# Trigger hot-reload in running Cinnamon session if requested
if [ "${RELOAD_EXT}" = true ] && command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon \
        org.Cinnamon.ReloadXlet string:"${UUID}" string:"EXTENSION" >/dev/null 2>&1 || true
    echo "==> Triggered Cinnamon live reload for ${UUID}."
fi

echo "==> Done! Open settings via: ${CINNAWM_XLET_SETTINGS_CMD:-xlet-settings} extension ${UUID}"

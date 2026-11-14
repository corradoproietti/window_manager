#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
DEST_BASE="${CINNAWM_EXTENSIONS_DIR:-${DATA_HOME}/cinnamon/extensions}"
LOCALE_BASE="${CINNAWM_LOCALE_DIR:-${DATA_HOME}/locale}"
SRC_DIR="${CINNAWM_SRC_DIR:-}"
ENABLE_EXT=true
RELOAD_EXT=true
UNINSTALL=false

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Install, update, or uninstall CinnaWM from the local Cinnamon environment.

Options:
  --src=DIR          Path to the extension folder containing metadata.json
  --dest-dir=DIR     Override extensions base directory (default: \$XDG_DATA_HOME/cinnamon/extensions)
  --locale-dir=DIR   Override locale base directory (default: \$XDG_DATA_HOME/locale)
  --no-enable        Do not modify org.cinnamon enabled-extensions
  --no-reload        Do not trigger live Cinnamon extension reload over D-Bus
  --uninstall        Remove installed extension and compiled locale files
  -h, --help         Show this help message
EOF
}

for arg in "$@"; do
    case "$arg" in
        --src=*) SRC_DIR="${arg#*=}" ;;
        --dest-dir=*) DEST_BASE="${arg#*=}" ;;
        --locale-dir=*) LOCALE_BASE="${arg#*=}" ;;
        --no-enable) ENABLE_EXT=false ;;
        --no-reload) RELOAD_EXT=false ;;
        --uninstall) UNINSTALL=true ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
    esac
done

detect_src_dir() {
    if [ -n "${SRC_DIR}" ] && [ -f "${SRC_DIR}/metadata.json" ]; then
        printf '%s\n' "${SRC_DIR}"
        return 0
    fi
    if [ -f "${SCRIPT_DIR}/metadata.json" ]; then
        printf '%s\n' "${SCRIPT_DIR}"
        return 0
    fi
    for candidate in "${SCRIPT_DIR}"/*/metadata.json; do
        if [ -f "${candidate}" ]; then
            dirname "${candidate}"
            return 0
        fi
    done
    return 1
}

read_metadata_field() {
    local meta_file="$1"
    local field="$2"
    python3 -c "import json, sys; print(json.load(open(sys.argv[1], encoding='utf-8')).get(sys.argv[2], ''))" "${meta_file}" "${field}"
}

SRC_DIR="$(detect_src_dir)" || {
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

if [ "${UNINSTALL}" = true ]; then
    echo "==> Removing ${UUID} from ${DEST_DIR} ..."
    rm -rf "${DEST_DIR}"
    if [ -d "${LOCALE_BASE}" ]; then
        find "${LOCALE_BASE}" -type f -name "${UUID}.mo" -delete 2>/dev/null || true
    fi
    echo "==> Uninstall complete."
    exit 0
fi

echo "==> Installing ${UUID} (v${VERSION:-unknown}) into ${DEST_DIR} ..."
mkdir -p "${DEST_BASE}"
STAGE_DIR="$(mktemp -d "${DEST_BASE}/.${UUID}.install.XXXXXX")"
trap 'rm -rf "${STAGE_DIR}"' EXIT

cp -r "${SRC_DIR}" "${STAGE_DIR}/${UUID}"
find "${STAGE_DIR}/${UUID}" \( -name '__pycache__' -o -name '*.pyc' -o -name '*.pyo' -o -name '*.swp' -o -name '.DS_Store' \) -exec rm -rf {} + 2>/dev/null || true

# Preserve previous installation as a recoverable backup before atomic swap.
if [ -e "${DEST_DIR}" ]; then
    BACKUP_DIR="${DEST_DIR}.backup.$(date +%Y%m%d-%H%M%S).$$"
    mv "${DEST_DIR}" "${BACKUP_DIR}"
    if ! mv "${STAGE_DIR}/${UUID}" "${DEST_DIR}"; then
        mv "${BACKUP_DIR}" "${DEST_DIR}"
        echo "Error: restored previous installation from ${BACKUP_DIR}" >&2
        exit 1
    fi
    echo "==> Previous installation backed up at ${BACKUP_DIR}"
else
    mv "${STAGE_DIR}/${UUID}" "${DEST_DIR}"
fi

# Compile Gettext catalogs (.po -> $LOCALE_BASE/<lang>/LC_MESSAGES/${UUID}.mo)
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

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${CINNAWM_DIST_DIR:-${SCRIPT_DIR}/dist}"
SRC_DIR="${CINNAWM_SRC_DIR:-}"

for arg in "$@"; do
    case "$arg" in
        --src=*) SRC_DIR="${arg#*=}" ;;
        --out=*) OUT_DIR="${arg#*=}" ;;
        -h|--help)
            cat <<EOF
Usage: $(basename "$0") [--src=DIR] [--out=DIR]

Build an installable Cinnamon extension release archive (.zip), SHA256 checksum,
and Markdown release notes from metadata.json cleanly without caches or secrets.
EOF
            exit 0
            ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

if [ -z "${SRC_DIR}" ]; then
    for candidate in "${SCRIPT_DIR}"/*/metadata.json; do
        if [ -f "${candidate}" ] && python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1], encoding='utf-8')).get('uuid') else 1)" "${candidate}" 2>/dev/null; then
            SRC_DIR="$(dirname "${candidate}")"
            break
        fi
    done
fi

if [ -z "${SRC_DIR}" ] || [ ! -f "${SRC_DIR}/metadata.json" ]; then
    echo "Error: could not locate extension metadata.json." >&2
    exit 1
fi

for req_bin in zip sha256sum python3; do
    if ! command -v "${req_bin}" >/dev/null 2>&1; then
        echo "Error: required build dependency '${req_bin}' not found in PATH." >&2
        exit 1
    fi
done

META_FILE="${SRC_DIR}/metadata.json"
read_meta() {
    python3 -c "import json,sys; v=json.load(open(sys.argv[1], encoding='utf-8')).get(sys.argv[2], ''); print(', '.join(v) if isinstance(v, list) else v)" "${META_FILE}" "$1"
}

UUID="${CINNAWM_UUID:-$(read_meta uuid)}"
VERSION="$(read_meta version)"
EXT_NAME="$(read_meta name)"
EXT_DESC="$(read_meta description)"
CINNAMON_VERSIONS="$(read_meta cinnamon-version)"
REPO_URL="$(read_meta url)"

ARCHIVE_NAME="${UUID}-v${VERSION}.zip"
mkdir -p "${OUT_DIR}"
STAGE_DIR="$(mktemp -d "${OUT_DIR}/.pkg.XXXXXX")"
trap 'rm -rf "${STAGE_DIR}"' EXIT

STAGE_EXT="${STAGE_DIR}/${UUID}"
cp -r "${SRC_DIR}" "${STAGE_EXT}"
find "${STAGE_EXT}" \( -name '__pycache__' -o -name '*.pyc' -o -name '*.pyo' -o -name '*.swp' -o -name '.DS_Store' \) -exec rm -rf {} + 2>/dev/null || true

# Bundle documentation & license inside extension folder for self-contained zip installs
[ -f "${SCRIPT_DIR}/README.md" ] && cp "${SCRIPT_DIR}/README.md" "${STAGE_EXT}/README.md"
[ -f "${SCRIPT_DIR}/LICENSE" ] && cp "${SCRIPT_DIR}/LICENSE" "${STAGE_EXT}/LICENSE"

# Bundle compiled .mo catalogs into <uuid>/locale/<lang>/LC_MESSAGES/<uuid>.mo
if command -v msgfmt >/dev/null 2>&1 && [ -d "${STAGE_EXT}/po" ]; then
    for po_file in "${STAGE_EXT}/po/"*.po; do
        [ -f "${po_file}" ] || continue
        lang="$(basename "${po_file}" .po)"
        mkdir -p "${STAGE_EXT}/locale/${lang}/LC_MESSAGES"
        msgfmt "${po_file}" -o "${STAGE_EXT}/locale/${lang}/LC_MESSAGES/${UUID}.mo"
    done
fi

chmod +x "${STAGE_EXT}/settings-window.py" 2>/dev/null || true

ARCHIVE_PATH="${OUT_DIR}/${ARCHIVE_NAME}"
rm -f "${ARCHIVE_PATH}" "${ARCHIVE_PATH}.sha256"
(
    cd "${STAGE_DIR}"
    zip -rq9 "${ARCHIVE_PATH}" "${UUID}"
)

(
    cd "${OUT_DIR}"
    sha256sum "${ARCHIVE_NAME}" > "${ARCHIVE_NAME}.sha256"
)

SHA256_VAL="$(cut -d' ' -f1 "${ARCHIVE_PATH}.sha256")"
NOTES_PATH="${OUT_DIR}/RELEASE_NOTES-v${VERSION}.md"

cat > "${NOTES_PATH}" <<EOF
# ${EXT_NAME} v${VERSION}

${EXT_DESC}

## Package Information

- **Extension UUID**: \`${UUID}\`
- **Version**: \`v${VERSION}\`
- **Supported Cinnamon Versions**: ${CINNAMON_VERSIONS}
- **License**: GPL-3.0
- **Source**: ${REPO_URL}
- **Release Asset**: \`${ARCHIVE_NAME}\`
- **SHA256**: \`${SHA256_VAL}\`

## Highlights in v${VERSION}

- **Hybrid Tiling Engine**: Per-\`(workspace, monitor)\` layouts including **Dwindle / BSP**, **Master & Stack**, **Centered Master 3-Column**, **Scrolling Columns**, **Monocle / Zen**, **Balanced Grid**, and **Floating**, with **Per-Workspace Default Layout** overrides and **Auto Portrait Rotation** on vertical monitors.
- **Manual Tab Groups & Overflow Stacks**: \`Shift + Drag\` or \`Super + W\` / \`Super + Shift + T\` groups windows into tabbed cells with titlebar badges, scroll switching, and smooth directional keyboard exit (\`Super + H/J/K/L\` or Arrows).
- **Quick Window & Tab Switching via Albert Launcher Companion & Picture-in-Picture (\`Super + Y\`)**: Exposes \`GetOpenWindows\`, \`ActivateWindow\`, and \`CloseWindow\` over \`org.cinnawm.Service\` plus \`Super + Tab\` D-Bus dispatch (\`org.cinnawm.AlbertSwitcher\`) for the companion native Albert plugin ([cinnawm_albert_switcher](https://github.com/corradoproietti/cinnawm_albert_switcher)); sticky corner PiP mode offers configurable size and screen corner.
- **Direct Multi-Workspace & Multi-Monitor Actions**: Move windows across workspaces (\`Super + Shift + Page_Up/Page_Down\` or \`Super + Alt + Left/Right\`), throw/move across monitors (\`Super + Shift + O\`), and switch focus across monitors (\`Super + Alt + O\`).
- **State-Aware Active Borders, Dimming & Cursor Follows Focus**: Distinct colors for Tiled, Floating/Scratchpad, and Stacked/Tabbed windows, **Smart No-Border** on single-window monitors, optional **Unfocused Window Dimming**, and pointer warping on keyboard/monitor navigation.
- **Interactive Tools**: **Quick Snap Grid** (\`Super + G\`), **Modal Resize Mode** (\`Super + R\`), **Scratchpad** (\`Super + S\` / \`Super + \\\`\`), **Mouse Drag-to-Swap / Ctrl+Drag Edge Snap**, and live **Shared Edge Resize**.
- **Hardened D-Bus IPC & Lifecycle Resilience**: All session D-Bus methods on \`org.cinnawm.Service\` (\`StateChanged\` signal + \`GetOpenWindows\`, \`ActivateWindow\`, \`CloseWindow\`, and action methods) protected against transient window/JSON failures with safe fallback handling in \`settings-window.py\` and duplicate-free installs in \`install.sh\`.
- **Full Gettext Localization**: English & Italian translations precompiled inside the extension archive.

## Installation from Release Archive

### Option A: Quick Manual Install (Plug-and-Play)

\`\`\`bash
mkdir -p "\${XDG_DATA_HOME:-\$HOME/.local/share}/cinnamon/extensions"
unzip -o "${ARCHIVE_NAME}" -d "\${XDG_DATA_HOME:-\$HOME/.local/share}/cinnamon/extensions/"
\`\`\`

Then enable **${EXT_NAME}** in **System Settings → Extensions** (or reload Cinnamon with \`Alt + F2\` → \`r\` → \`Enter\`).

### Option B: Install from Source Repository

\`\`\`bash
git clone ${REPO_URL}.git
cd window_manager
bash install.sh
\`\`\`
EOF

echo "==> Built release archive: ${ARCHIVE_PATH}"
echo "==> Checksum: ${SHA256_VAL}"
echo "==> Release notes: ${NOTES_PATH}"

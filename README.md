# CinnaWM

Hybrid tiling and window management extension for the **Cinnamon Desktop Environment** (`cinnawm@corradoproietti`).

CinnaWM brings modern tiling workflows into Cinnamon without replacing Muffin, combining per-workspace automatic tiling layouts, smooth floating tools, Manual Tab Groups, multi-monitor awareness, a native GTK3 preferences app, and a dedicated session D-Bus IPC service.

---

## Layouts

Each `(workspace, monitor)` pair maintains its own layout (with optional per-workspace initial layout presets) and independent ratios/trees:

- **`[@]` Dwindle / BSP** (Hyprland / bspwm style): binary space partitioning with aspect-ratio, spiral, vertical, or horizontal splits and Smart Gaps.
- **`[]=` Master & Stack** (dwm / XMonad style): configurable master count/ratio, orientation (`left`, `right`, `top`, `bottom`), and automatic Portrait rotation on vertical monitors.
- **`[|M|]` Centered Master 3-Column**: central master pane flanked by dual side stacks (ideal for ultrawide displays).
- **`[>>>]` Scrolling Columns** (Niri / PaperWM style): horizontally scrolling ribbon of adjustable columns.
- **`[M]` Monocle / Zen**: maximized or centered distraction-free deck.
- **`[#]` Balanced Grid**: automatic balanced `R × C` grid with optional max columns and row weights.
- **`[~]` Floating**: classic free-floating window management on selected workspaces.

When an area becomes too tight (`overflowMinWidthPx` / `overflowMinHeightPx`), overflow windows automatically group into a stacked deck with a clickable/scrollable titlebar pill badge.

---

## Installation

### From Release Archive

Download the installable release archive (`cinnawm@corradoproietti-v1.0.2.zip`) and extract it into your Cinnamon extensions directory (or run `bash install.sh --zip=cinnawm@corradoproietti-v1.0.2.zip`):

```bash
mkdir -p "${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/extensions"
unzip -o cinnawm@corradoproietti-v1.0.2.zip -d "${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/extensions/"
```

Then enable **CinnaWM** in **System Settings → Extensions** (precompiled translations are bundled inside the archive).

### From Source

```bash
bash install.sh
```

`install.sh` dynamically reads extension metadata (`metadata.json`), deploys the extension into `${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/extensions/<uuid>`, compiles `.po` Gettext translations into `${XDG_DATA_HOME:-$HOME/.local/share}/locale/<lang>/LC_MESSAGES/<uuid>.mo`, enables it in `org.cinnamon enabled-extensions`, and triggers Cinnamon hot-reload.

Override defaults cleanly using environment variables or CLI flags (`bash install.sh --help`):
- `CINNAWM_EXTENSIONS_DIR`, `CINNAWM_LOCALE_DIR`, `CINNAWM_CONFIG_DIR`, `CINNAWM_DATA_DIR`, `CINNAWM_UUID`
- `CINNAWM_DBUS_NAME`, `CINNAWM_DBUS_PATH`, `CINNAWM_APP_ID`, `CINNAWM_XLET_SETTINGS_CMD`
- `CINNAWM_ALBERT_DBUS_NAME`, `CINNAWM_ALBERT_DBUS_PATH`, `CINNAWM_ALBERT_DBUS_INTERFACE`

---

## Panel Indicator Controls

Right on the Cinnamon panel badge:

| Action | Behavior |
| :--- | :--- |
| **Left Click** | Open / toggle the Layout Switcher & Quick Actions popup |
| **Scroll Wheel** | Cycle through layouts on the current workspace |
| **Middle Click** | Enable / pause Auto-Tiling on the current workspace |
| **Right Click** | Open Native GTK3 **Preferences** at the active layout section |

---

## Mouse Interactions & Visual Feedback

- **Drag Tile onto Tile**: Live drop preview to **swap positions** (or drop near a tile edge in **Dwindle** to split inline).
- **`Shift + Drag` onto Tile**: Merge windows into a **Manual Tab Group** (click the titlebar tab pills, scroll over the badge, or use keyboard navigation to switch tabs).
- **`Ctrl + Drag` to Screen Edges/Corners**: Instant **Edge Snap** (halves, quarters, or top-edge maximize).
- **Drag Shared Border**: Live adjacent tile resize (`mouseEdgeResize`).
- **State-Aware Active Border & Dimming**: Configurable outer highlight border with distinct colors for **Tiled**, **Floating / Scratchpad**, and **Stacked / Tabbed** windows, **Smart No-Border** on single-window monitors, plus optional **Unfocused Window Dimming**.
- **Cursor Follows Focus** *(optional)*: Enable in Preferences to center the pointer automatically when moving focus via keyboard or across monitors.
- **Native GTK3 Preferences (`settings-window.py`)**: Two-way live sync via D-Bus (`StateChanged` signal), full shortcut viewer, window rules editor, and **Export / Import JSON profile** backup.

---

## Default Keyboard Shortcuts

> **Cinnamon Lock Screen Protection**: Window swap right uses `Super + Shift + L` / `Super + Shift + Right`. `Ctrl + Alt + L` is left untouched for Cinnamon's system Lock Screen.

### Focus, Swapping, Workspaces & Monitors

| Shortcut | Action |
| :--- | :--- |
| `Super + H / J / K / L` or `Super + Arrows` | Directional focus (walks tabs inside Stacks/Tab Groups and exits smoothly at boundaries) |
| `Super + Shift + H / J / K / L` or `Super + Shift + Arrows` | Directional swap (throws window to adjacent monitor at screen edge) |
| `Super + Return` | Promote focused window to Master (or swap Master with 2nd tile) |
| `Super + Shift + Page_Up` / `Super + Alt + Left` | Move focused window to the **previous workspace** |
| `Super + Shift + Page_Down` / `Super + Alt + Right` | Move focused window to the **next workspace** |
| `Super + Shift + O` | Move focused window to the **next monitor** |
| `Super + Alt + O` | Move focus to the **next monitor** |

### Layouts, Splits & Tab Groups

| Shortcut | Action |
| :--- | :--- |
| `Super + Space` / `Super + Shift + Space` | Cycle to next / previous layout |
| `Super + T` | Toggle Auto-Tiling On / Pause on the active workspace |
| `Super + M` or `Super + Z` | Toggle **Monocle / Zen Zoom** on the active window |
| `Super + W` or `Super + Shift + T` | Group / ungroup active window in a **Manual Tab Group** |
| `Super + = / ] / +` and `Super + - / [` | Increase / decrease Master ratio, split ratio, or Scrolling width |
| `Super + .` / `Super + ,` | Increase / decrease Master window count |
| `Super + O` | Rotate Master orientation (`left/right/top/bottom`) or Dwindle BSP split |

### Scratchpad, Quick Snap Grid, Floating & Resize Mode

| Shortcut | Action |
| :--- | :--- |
| `Super + S` or `Super + `` ` `` | Show / hide the drop-down **Scratchpad** |
| `Super + Shift + S` | Assign / remove focused window from Scratchpad |
| `Super + F` | Toggle Floating / Tiled state for focused window |
| `Super + C` | Float and center focused window |
| `Super + G` | Open interactive **Quick Snap Grid** (`gTile` style) |
| `Super + Y` | Toggle **Picture-in-Picture / Sticky** corner window across workspaces |
| `Super + Tab` | Open **CinnaWM Switcher** in Albert directly; repeat `Tab` / `Super + Tab` to cycle windows |
| `Super + R` | Enter / exit **Modal Resize Mode** (`HJKL`/Arrows resize, `Shift` fine 2%, `0` reset ratios, `Esc`/`Enter` exit) |

---

## Albert Launcher Integration (`CinnaWM Switcher`)

Window, Manual Tab Group, Scratchpad, and Picture-in-Picture searching/switching can be delegated to the companion native C++23/Qt6 Albert Launcher plugin repository: **[cinnawm_albert_switcher](https://github.com/corradoproietti/cinnawm_albert_switcher)**.

- **Direct `Super + Tab` Switcher & Window Cycling**: Pressing `Super + Tab` invokes the parameterized D-Bus endpoint (`CINNAWM_ALBERT_DBUS_NAME` / `CINNAWM_ALBERT_DBUS_PATH` / `CINNAWM_ALBERT_DBUS_INTERFACE`, defaulting to `org.cinnawm.AlbertSwitcher`); continuing to press `Super + Tab` (or `Tab` / `Shift + Tab`) cycles across windows and switches on `Super` release or `Enter`.
- **Native CinnaWM D-Bus Actions**: The companion plugin queries `org.cinnawm.Service` (`GetOpenWindows`, `ActivateWindow`, `CloseWindow`) via `QtDBus`.

---

## D-Bus IPC Service (`org.cinnawm.Service`)

CinnaWM exposes a typed session D-Bus service at bus name `org.cinnawm.Service`, object path `/org/cinnawm/Service`:

- **Signal**: `StateChanged(s reason)` — emitted when layouts, tiling state, active workspace, tab groups, or settings change.
- **Query & Settings Methods**:
  - `GetSnapshot() -> (s payloadJson)`
  - `GetOpenWindows() -> (s windowsJson)`
  - `UpdateSetting(s prop, s valueJson) -> (b ok)`
  - `ImportSettings(s payloadJson) -> (b ok)`
- **WM Action Methods** (for scripts, panels, or custom keybindings):
  - `ActivateLayout(s layoutId) -> (b ok)`
  - `CycleLayout(i direction) -> (b ok)`
  - `FocusDirection(s direction) -> (b ok)` (`left` | `right` | `up` | `down`)
  - `SwapDirection(s direction) -> (b ok)` (`left` | `right` | `up` | `down`)
  - `ToggleFloating() -> (b ok)`
  - `ToggleTiling() -> (b ok)`
  - `ToggleScratchpad() -> (b ok)`
  - `TogglePip() -> (b ok)`
  - `ActivateWindow(i winId) -> (b ok)`
  - `CloseWindow(i winId) -> (b ok)`
  - `MoveToWorkspace(i delta) -> (b ok)` (`-1` | `1`)
  - `MoveToNextMonitor() -> (b ok)`
  - `FocusNextMonitor() -> (b ok)`
  - `ResetRatios() -> (b ok)`

Example CLI queries:

```bash
gdbus call --session --dest org.cinnawm.Service --object-path /org/cinnawm/Service --method org.cinnawm.Service.GetOpenWindows
gdbus call --session --dest org.cinnawm.Service --object-path /org/cinnawm/Service --method org.cinnawm.Service.CycleLayout 1
```

---

## Development, Packaging & Tests

Run the unit test suite cleanly via `cjs`:

```bash
GI_TYPELIB_PATH=/usr/lib/x86_64-linux-gnu/muffin cjs tests/test_layouts.js
```

Build a clean installable release `.zip` archive, `.sha256` checksum, and release notes in `dist/`:

```bash
bash package-release.sh
```

---

## License

Licensed under the [GNU General Public License v3.0](LICENSE).

# -*- coding: utf-8 -*-
"""
CinnaWM Settings Data & Metadata Definitions.

Contains default settings values, keybinding formatting helpers, sidebar section
metadata, Visual Guide descriptions, and Shortcuts / Mouse interaction tables.
"""

import gettext
import json
import os
import re

_EXT_DIR = os.path.dirname(os.path.abspath(__file__))
_META_PATH = os.path.join(_EXT_DIR, 'metadata.json')
try:
    with open(_META_PATH, 'r', encoding='utf-8') as _meta_file:
        META = json.load(_meta_file)
except Exception:
    META = {}

UUID = os.environ.get('CINNAWM_UUID') or str(META.get('uuid') or os.path.basename(_EXT_DIR))
APP_NAME = str(META.get('name', 'CinnaWM'))
APP_VERSION = str(META.get('version', '1.0.0'))
PROJECT_URL = str(META.get('url', ''))

DBUS_BUS_NAME = os.environ.get('CINNAWM_DBUS_NAME', 'org.cinnawm.Service')
DBUS_OBJECT_PATH = os.environ.get('CINNAWM_DBUS_PATH', '/org/cinnawm/Service')
DBUS_INTERFACE_NAME = os.environ.get('CINNAWM_DBUS_INTERFACE', 'org.cinnawm.Service')
GTK_APP_ID = os.environ.get('CINNAWM_APP_ID', 'org.cinnamon.extensions.cinnawm.settings')
XLET_SETTINGS_CMD = os.environ.get('CINNAWM_XLET_SETTINGS_CMD', 'xlet-settings')


def _has_compiled_locale(locale_root, domain):
    if not locale_root or not os.path.isdir(locale_root):
        return False
    try:
        for lang in os.listdir(locale_root):
            mo_file = os.path.join(locale_root, lang, 'LC_MESSAGES', f'{domain}.mo')
            if os.path.isfile(mo_file):
                return True
    except OSError:
        pass
    return False


def _resolve_localedir(domain, ext_dir):
    env_dir = os.environ.get('CINNAWM_LOCALE_DIR')
    if env_dir:
        return env_dir
    data_home = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    user_locale = os.path.join(data_home, 'locale')
    bundled_locale = os.path.join(ext_dir, 'locale')
    if not _has_compiled_locale(user_locale, domain) and _has_compiled_locale(bundled_locale, domain):
        return bundled_locale
    return user_locale


LOCALEDIR = _resolve_localedir(UUID, _EXT_DIR)

try:
    _translation = gettext.translation(UUID, LOCALEDIR, fallback=True)
    _ = _translation.gettext
except Exception:
    _ = lambda s: s

_DEFAULTS_PATH = os.path.join(_EXT_DIR, 'defaults.json')
with open(_DEFAULTS_PATH, 'r', encoding='utf-8') as _defaults_file:
    DEFAULT_SETTINGS = json.load(_defaults_file)


def format_keybinding_list(raw):
    """Formats a Cinnamon keybinding string (e.g. '<Super>h::<Super>Left') into a list of readable combos."""
    if not raw or not isinstance(raw, str):
        return [_('Unassigned')]
    parts = [p.strip() for p in raw.split('::') if p.strip()]
    if not parts:
        return [_('Unassigned')]

    key_map = {
        'Return': 'Enter',
        'KP_Enter': 'Enter',
        'space': 'Space',
        'Left': '←',
        'Right': '→',
        'Up': '↑',
        'Down': '↓',
        'equal': '=',
        'plus': '+',
        'KP_Add': 'Num +',
        'minus': '-',
        'KP_Subtract': 'Num -',
        'period': '.',
        'comma': ',',
        'bracketleft': '[',
        'bracketright': ']',
        'grave': '`',
        'Escape': 'Esc',
        'Page_Up': 'PgUp',
        'Page_Down': 'PgDn',
        'Prior': 'PgUp',
        'Next': 'PgDn',
    }

    combos = []
    for part in parts:
        mods = []

        def _extract_mod(match):
            m = match.group(1)
            ml = m.lower()
            if ml in ('super', 'mod4'):
                mods.append('Super')
            elif ml == 'shift':
                mods.append('Shift')
            elif ml in ('control', 'ctrl', 'primary'):
                mods.append('Ctrl')
            elif ml in ('alt', 'mod1'):
                mods.append('Alt')
            else:
                mods.append(m)
            return ''

        key = re.sub(r'<([^>]+)>', _extract_mod, part)
        if key in key_map:
            key = key_map[key]
        elif len(key) == 1:
            key = key.upper()
        combos.append(' + '.join(mods + ([key] if key else [])))
    return combos or [_('Unassigned')]


def get_sections_meta():
    return [
        {
            'id': 'general',
            'title': _('General & Gaps'),
            'icon': 'cinnawm-layout-grid-symbolic.svg',
            'subtitle': _('Global tiling settings, window spacing (gaps), mouse interactions, and active window border.'),
        },
        {
            'id': 'dwindle',
            'title': _('Dwindle / BSP'),
            'icon': 'cinnawm-layout-dwindle-symbolic.svg',
            'subtitle': _('Recursive binary space partitioning (Hyprland / bspwm style). Each window splits the tile according to the selected mode.'),
        },
        {
            'id': 'master-stack',
            'title': _('Master & Stack'),
            'icon': 'cinnawm-layout-master-symbolic.svg',
            'subtitle': _('Primary Master area alongside a vertically stacked secondary column (dwm / XMonad style).'),
        },
        {
            'id': 'centered-master',
            'title': _('Centered Master'),
            'icon': 'cinnawm-layout-centered-symbolic.svg',
            'subtitle': _('Three-column layout designed for wide and ultrawide monitors: Master column in the center and two side Stack columns.'),
        },
        {
            'id': 'scrolling',
            'title': _('Scrolling Columns'),
            'icon': 'cinnawm-layout-scrolling-symbolic.svg',
            'subtitle': _('Infinite horizontal ribbon of full-height columns (Niri / PaperWM style) with automatic viewport scrolling.'),
        },
        {
            'id': 'monocle',
            'title': _('Monocle / Zen'),
            'icon': 'cinnawm-layout-monocle-symbolic.svg',
            'subtitle': _('Deck of full-screen stacked windows or distraction-free centered Zen mode.'),
        },
        {
            'id': 'grid',
            'title': _('Balanced Grid'),
            'icon': 'cinnawm-layout-grid-symbolic.svg',
            'subtitle': _('Automatic balanced Rows × Columns grid to display all open windows with uniform dimensions.'),
        },
        {
            'id': 'floating',
            'title': _('Floating & Tools'),
            'icon': 'cinnawm-layout-floating-symbolic.svg',
            'subtitle': _('Free-floating windows, quick center parameters (Super+C), Quick Snap Grid (Super+G), and Scratchpad (Super+S).'),
        },
        {
            'id': 'visual-guide',
            'title': _('Visual Guide'),
            'icon': 'cinnawm-guide-symbolic.svg',
            'subtitle': _('Graphical overview of all 7 layouts with miniature monitor mockups, ideal workflows, and practical tips.'),
        },
        {
            'id': 'shortcuts',
            'title': _('Shortcuts'),
            'icon': 'cinnawm-shortcuts-symbolic.svg',
            'subtitle': _('Active keyboard shortcuts, modal resize controls, and mouse & multi-monitor interactions.'),
        },
    ]


def get_layouts_guide_list():
    return [
        {
            'id': 'dwindle',
            'badge': '[@]',
            'name': _('Dwindle / BSP'),
            'summary': _('Dynamic binary spiral (Hyprland / bspwm style)'),
            'how': _('Each new window recursively splits the focused window tile based on its aspect ratio (vertical split if wider, horizontal split if taller), creating a balanced binary spiral.'),
            'best': _('Everyday multitasking (terminals, code editors, browser, file manager). Any internal border can be dragged with the mouse.'),
            'tips': _('Drag any shared border with the mouse or press Super+R to resize the active BSP node.'),
        },
        {
            'id': 'master-stack',
            'badge': '[]=',
            'name': _('Master & Stack'),
            'summary': _('Primary Master window + vertical Stack column (dwm / XMonad style)'),
            'how': _('Divides the screen into two areas: the primary Master area (55% by default) for your main window, and the side Stack column where secondary windows are stacked vertically.'),
            'best': _('Software development or writing with a large primary window and terminals/docs alongside.'),
            'tips': _('Press Super+Enter to promote the focused window to Master, Super+O to rotate Master (Left/Right/Top/Bottom), and Super+. / Super+, to change the Master window count.'),
        },
        {
            'id': 'centered-master',
            'badge': '[|M|]',
            'name': _('Centered Master (3-Column)'),
            'summary': _('Master in the center with Left and Right Stack wings (ideal for Ultrawide)'),
            'how': _('Places the Master area in the center of the screen (with 1 or 2 windows) and automatically distributes secondary windows between the left and right wing columns.'),
            'best': _('Large monitors (27"+) and Ultrawide displays (21:9 or 32:9), keeping your main work directly in front of you.'),
            'tips': _('With 1–2 windows it behaves like Master & Stack; from the 3rd window onward it automatically activates both side wings.'),
        },
        {
            'id': 'scrolling',
            'badge': '[>>>]',
            'name': _('Scrolling Columns'),
            'summary': _('Horizontal ribbon of wide columns with automatic viewport scrolling (Niri / PaperWM style)'),
            'how': _('Arranges windows side-by-side on a continuous horizontal ribbon: each window keeps a generous width (e.g. 60% of the screen) without ever shrinking into tiny slivers. Moving focus scrolls the viewport smoothly.'),
            'best': _('Laptop screens or sessions with many open windows that need to stay wide and readable.'),
            'tips': _('Use Super+H / Super+L (or Super + ←/→) to scroll along the ribbon and Super+= / Super+- to widen or narrow the focused column.'),
        },
        {
            'id': 'monocle',
            'badge': '[M]',
            'name': _('Monocle / Deck (Zen)'),
            'summary': _('All windows maximized in a deck; focus raises the active window'),
            'how': _('Maximizes every window to full screen (or into a centered Zen column), stacking them on top of each other. Switching focus via keyboard automatically raises the selected window.'),
            'best': _('Deep focus on a single task with zero visual distractions.'),
            'tips': _('Press Super+M at any time to quickly toggle Monocle mode and return to your previous layout.'),
        },
        {
            'id': 'grid',
            'badge': '[#]',
            'name': _('Balanced Grid'),
            'summary': _('Equal-sized Rows × Columns grid for all open windows'),
            'how': _('Automatically computes a symmetrical mathematical grid (e.g. 2×2 for 4 windows, 3×2 for 5–6 windows), giving every window equal screen space.'),
            'best': _('Monitoring multiple terminals, system logs, charts, or dashboards simultaneously.'),
            'tips': _('Use Super+Shift+Arrows (or drag with the mouse) to quickly swap two cells in the grid.'),
        },
        {
            'id': 'floating',
            'badge': '[~]',
            'name': _('Floating (Classic)'),
            'summary': _('Free-floating windows with manual positioning'),
            'how': _('Disables automatic tiling on the current workspace: windows can be freely moved, overlapped, and resized just like on a traditional Cinnamon desktop.'),
            'best': _('Graphics applications, photo/video editing, or windows you prefer to arrange manually.'),
            'tips': _('Even in Floating mode you can still use Super+G (Quick Snap Grid), Ctrl+Drag to screen edges, and Super+S (Scratchpad).'),
        },
    ]


def get_shortcut_groups():
    return [
        (
            _('Focus Navigation (Vim HJKL or Arrows)'),
            [
                ('kbFocusLeft', _('Move focus to the window on the Left')),
                ('kbFocusRight', _('Move focus to the window on the Right')),
                ('kbFocusUp', _('Move focus to the window Above')),
                ('kbFocusDown', _('Move focus to the window Below')),
                ('kbFocusMonitorNext', _('Focus the next monitor')),
            ],
        ),
        (
            _('Move / Swap Windows'),
            [
                ('kbSwapLeft', _('Swap active window with the one on the Left')),
                ('kbSwapRight', _('Swap active window with the one on the Right')),
                ('kbSwapUp', _('Swap active window with the one Above')),
                ('kbSwapDown', _('Swap active window with the one Below')),
                ('kbPromoteMaster', _('Promote focused window to Master (or swap with Master)')),
                ('kbMoveWorkspacePrev', _('Move focused window to previous workspace')),
                ('kbMoveWorkspaceNext', _('Move focused window to next workspace')),
                ('kbMoveMonitorNext', _('Move focused window to next monitor')),
                (None, _('Lock the screen (Cinnamon System)'), ['Ctrl + Alt + L']),
            ],
        ),
        (
            _('Layouts, Splits & Ratios'),
            [
                ('kbCycleLayout', _('Switch to next Layout (Dwindle → Master → 3-Col → Scrolling → ...)')),
                ('kbCycleLayoutBack', _('Switch to previous Layout')),
                ('kbToggleTiling', _('Enable / Pause Auto-Tiling on the current workspace')),
                ('kbToggleMonocle', _('Toggle Monocle / Zen Zoom on the active window')),
                ('kbToggleTabGroup', _('Group / Ungroup active window in a Manual Tab Group')),
                ('kbIncreaseRatio', _('Widen Master area / active split / Scrolling column')),
                ('kbDecreaseRatio', _('Narrow Master area / active split / Scrolling column')),
                ('kbIncreaseMasterCount', _('Increase number of windows in the Master area')),
                ('kbDecreaseMasterCount', _('Decrease number of windows in the Master area')),
                ('kbRotateOrientation', _('Rotate Master orientation (L/R/T/B) or Dwindle BSP split')),
            ],
        ),
        (
            _('Scratchpad, Quick Grid & Floating'),
            [
                ('kbScratchpadToggle', _('Show / Hide the drop-down Scratchpad window')),
                ('kbScratchpadAssign', _('Add / Remove the active window from the Scratchpad')),
                ('kbQuickGrid', _('Open the interactive Quick Snap Grid overlay (gTile style)')),
                ('kbToggleFloating', _('Toggle Floating / Tiled state for the active window')),
                ('kbCenterWindow', _('Float and center the active window on the monitor')),
                ('kbResizeMode', _('Enter / Exit Modal Resize Mode')),
            ],
        ),
        (
            _('Inside Modal Resize Mode (Super + R)'),
            [
                (None, _('Widen / Narrow or Grow / Shrink the focused tile by 5%'), ['← / → / ↑ / ↓', 'H / J / K / L']),
                (None, _('Fine resize by 2% steps'), ['Shift + Arrows', 'Shift + H / J / K / L']),
                (None, _('Reset all ratios and splits on the current workspace to defaults'), ['0', '=']),
                (None, _('Cycle to the next layout without leaving Resize Mode'), ['Space']),
                (None, _('Confirm and exit Modal Resize Mode'), ['Esc', 'Enter']),
            ],
        ),
    ]


def get_mouse_items():
    return [
        (
            _('Drag Window (Left Click)'),
            _('Drag a tiled window onto another to swap their positions (or onto a tile edge in Dwindle to split it) with a live drop preview.'),
        ),
        (
            _('Shift + Drag Window'),
            _('Hold Shift while dragging a window onto another tile to merge them into a Manual Tab Group (click or scroll the titlebar badge to switch tabs).'),
        ),
        (
            _('Ctrl + Drag Window'),
            _('Hold Ctrl while dragging a window to screen edges or corners for instant Edge Snap (halves, quarters, or top-edge maximize).'),
        ),
        (
            _('Drag Shared Border'),
            _('Resizing any shared border between tiled windows with the mouse simultaneously adjusts the neighboring tiles.'),
        ),
        (
            _('Panel Indicator (Top/Bottom Bar)'),
            _('Left-Click: Layout Menu  •  Middle-Click: Toggle Auto-Tile  •  Right-Click: Preferences  •  Scroll Wheel: Cycle Layout.'),
        ),
        (
            _('Independent Multi-Monitor & Workspaces'),
            _('Every (Monitor, Workspace) pair maintains its own independent layout, split ratios, and BSP tree.'),
        ),
    ]

// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Window Classification, Custom Rules, Popup/Dialog Handling & X11 Hints
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const { clamp } = require('./bsp-tree');

function _compileTitleWordRegex(pattern) {
    let escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
}

function _parsePatternField(rawToken) {
    let matchField = 'any';
    let pattern = rawToken.trim().toLowerCase();
    if (pattern.startsWith('title:') && pattern.length > 6) {
        matchField = 'title';
        pattern = pattern.slice(6).trim();
    }
    return { matchField, pattern };
}

function _matchesPatternEntry(entry, wmClass, wmInstance, title) {
    if (!entry || !entry.pattern) return false;
    if (entry.matchField === 'title') {
        return title.includes(entry.pattern);
    }
    if (wmClass.includes(entry.pattern) || wmInstance.includes(entry.pattern)) {
        return true;
    }
    return entry._titleRegex ? entry._titleRegex.test(title) : false;
}

/**
 * Parses custom window rules string.
 * Format: comma or newline separated entries like:
 *   "Spotify:workspace=4, KeePassXC:scratchpad, Pavucontrol:float, title:Zoom:float"
 */
function parseCustomRules(rulesStr) {
    let rules = [];
    if (!rulesStr || typeof rulesStr !== 'string') return rules;

    // Commas between entries are recognized by the next `pattern:`; commas inside an
    // action list remain attached to the current rule (e.g. `App:float,workspace=4`).
    let lines = rulesStr.split(/[\n;]+/);
    let parts = [];
    for (let line of lines) {
        parts.push(...line.split(/,\s*(?=[^,:]+:)/));
    }
    for (let raw of parts) {
        let line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        let hasTitlePrefix = line.toLowerCase().startsWith('title:');
        let colonIdx = hasTitlePrefix ? line.indexOf(':', 6) : line.indexOf(':');
        if (colonIdx === -1) continue;

        let { matchField, pattern } = _parsePatternField(line.substring(0, colonIdx));
        let actionPart = line.substring(colonIdx + 1).trim().toLowerCase();
        if (!pattern || !actionPart) continue;

        let rule = { pattern, matchField, float: false, tile: false, scratchpad: false, workspace: null };
        Object.defineProperty(rule, '_titleRegex', {
            value: _compileTitleWordRegex(pattern),
            enumerable: false
        });
        let tokens = actionPart.split(/[\s,]+/);
        for (let tok of tokens) {
            if (tok === 'float' || tok === 'floating') {
                rule.float = true;
            } else if (tok === 'tile' || tok === 'tiled') {
                rule.tile = true;
            } else if (tok === 'scratchpad' || tok === 'scratch') {
                rule.scratchpad = true;
            } else if (tok.startsWith('workspace=')) {
                let wsNum = parseInt(tok.split('=')[1], 10);
                if (!isNaN(wsNum) && wsNum >= 1) {
                    rule.workspace = wsNum - 1; // 0-indexed internally
                }
            }
        }
        rules.push(rule);
    }
    return rules;
}

let _cachedCustomRulesRaw = null;
let _cachedCustomRulesList = [];
function getCachedCustomRules(rulesStr) {
    let key = typeof rulesStr === 'string' ? rulesStr : '';
    if (key === _cachedCustomRulesRaw) return _cachedCustomRulesList;
    _cachedCustomRulesList = parseCustomRules(key);
    _cachedCustomRulesRaw = key;
    return _cachedCustomRulesList;
}

let _cachedFloatingRaw = null;
let _cachedFloatingEntries = [];
function getCachedFloatingEntries(floatingRaw) {
    let key = typeof floatingRaw === 'string' ? floatingRaw : '';
    if (key === _cachedFloatingRaw) return _cachedFloatingEntries;
    _cachedFloatingEntries = key
        .split(',')
        .map(s => _parsePatternField(s))
        .filter(e => e.pattern.length > 0)
        .map(e => ({
            pattern: e.pattern,
            matchField: e.matchField,
            _titleRegex: _compileTitleWordRegex(e.pattern)
        }));
    _cachedFloatingRaw = key;
    return _cachedFloatingEntries;
}

const POPUP_DIALOG_ROLES = new Set([
    'dialog',
    'pop-up',
    'popup',
    'task_dialog',
    'bubble',
    'alert',
    'confirm',
    'about',
    'preferences',
    'cinnawm-settings-dialog',
    'gtkfilechooserdialog',
    'filechooser',
    'xfce4-file-chooser'
]);

const POPUP_PORTAL_CLASSES = [
    'xdg-desktop-portal',
    'org.freedesktop.impl.portal',
    'zenity',
    'yad',
    'kdialog',
    'qarma',
    'matedialog',
    'gxmessage',
    'xmessage',
    'pinentry',
    'gcr-prompter',
    'polkit-gnome-authentication',
    'polkit-kde-authentication',
    'lxpolkit',
    'gksu',
    'cinnawm-settings',
    'org.gnome.nautiluspreviewer',
    'nemo-preview'
];

const EXACT_FILE_DIALOG_TITLES = new Set([
    'open',
    'open file',
    'open files',
    'open folder',
    'open directory',
    'open document',
    'open image',
    'open project',
    'open archive',
    'save',
    'save as',
    'save file',
    'save a copy',
    'save image',
    'save document',
    'choose file',
    'choose files',
    'choose folder',
    'choose directory',
    'choose an application',
    'select file',
    'select files',
    'select folder',
    'select folders',
    'select directory',
    'select a file',
    'select a folder',
    'select destination',
    'file upload',
    'upload file',
    'upload files',
    'export file',
    'import file',
    'apri',
    'apri file',
    'apri cartella',
    'apri directory',
    'apri documento',
    'apri immagine',
    'salva',
    'salva file',
    'salva con nome',
    'salva una copia',
    'salva immagine',
    'scegli file',
    'scegli cartella',
    'scegli una cartella',
    'scegli un file',
    'scegli applicazione',
    'seleziona file',
    'seleziona cartella',
    'seleziona una cartella',
    'seleziona un file',
    'seleziona destinazione',
    'carica file',
    'caricamento file',
    'esporta file',
    'importa file',
    'authentication required',
    'autenticazione richiesta',
    'unlock keyring',
    'sblocca portachiavi'
]);

const FILE_CHOOSER_TITLE_RE = /^(open|save|choose|select|upload|apri|salva|scegli|seleziona|carica)\s+(a\s+|an\s+|un\s+|una\s+)?(file|files|folder|folders|directory|directories|cartella|cartelle|con nome|as|una copia|a copy)(\b.*)?$/i;

function hasBasicNonTileableFlags(metaWindow) {
    if (!metaWindow) return true;
    if (metaWindow.get_window_type() !== Meta.WindowType.NORMAL) {
        return true;
    }
    return Boolean(
        metaWindow.is_skip_taskbar() ||
        metaWindow.is_override_redirect() ||
        metaWindow.is_attached_dialog() ||
        metaWindow.get_transient_for() !== null
    );
}

/**
 * Returns true if `metaWindow` is a popup, dialog, transient child, portal dialog,
 * or file-selection window (Open / Save / Choose File / XDG Desktop Portal).
 */
function isPopupOrDialogWindow(metaWindow) {
    if (!metaWindow) return false;

    if (hasBasicNonTileableFlags(metaWindow)) {
        return true;
    }

    let wmClass = (metaWindow.get_wm_class() || '').trim().toLowerCase();
    let wmInstance = (metaWindow.get_wm_class_instance() || '').trim().toLowerCase();
    let gtkAppId = (typeof metaWindow.get_gtk_application_id === 'function'
        ? (metaWindow.get_gtk_application_id() || '')
        : '').trim().toLowerCase();
    let role = (metaWindow.get_role() || '').trim().toLowerCase();
    let rawTitle = (metaWindow.get_title() || '').trim().toLowerCase();
    let cleanTitle = rawTitle.replace(/(\.\.\.|…)+$/, '').trim();

    if (role && (POPUP_DIALOG_ROLES.has(role) ||
        role.includes('filechooser') ||
        role.includes('dialog') ||
        role.includes('pop-up'))) {
        return true;
    }

    for (let pattern of POPUP_PORTAL_CLASSES) {
        if ((wmClass && wmClass.includes(pattern)) ||
            (wmInstance && wmInstance.includes(pattern)) ||
            (gtkAppId && gtkAppId.includes(pattern))) {
            return true;
        }
    }

    if (cleanTitle && (EXACT_FILE_DIALOG_TITLES.has(cleanTitle) || FILE_CHOOSER_TITLE_RE.test(cleanTitle))) {
        return true;
    }

    return false;
}

/**
 * Evaluates a Meta.Window against smart exclusions and user Window Rules.
 * Returns { shouldTile: boolean, scratchpad: boolean, targetWorkspace: number|null }
 */
function evaluateWindow(metaWindow, settings, manualFloatingSet, manualTiledSet) {
    let result = {
        shouldTile: false,
        scratchpad: false,
        targetWorkspace: null
    };

    if (!metaWindow) return result;

    let winId = metaWindow.get_stable_sequence();

    // 1. Check basic window type, transient/dialog state, and file-chooser/popup heuristics
    if (hasBasicNonTileableFlags(metaWindow)) {
        return result;
    }

    let wmClass = (metaWindow.get_wm_class() || '').toLowerCase();
    let wmInstance = (metaWindow.get_wm_class_instance() || '').toLowerCase();
    let title = (metaWindow.get_title() || '').toLowerCase();
    let role = (metaWindow.get_role() || '').toLowerCase();

    if (wmClass.includes('cinnawm-settings') ||
        wmInstance.includes('cinnawm-settings') ||
        role === 'cinnawm-settings-dialog') {
        result.shouldTile = false;
        return result;
    }

    // 2. Check custom window rules first
    let customRules = getCachedCustomRules((settings && settings.customWindowRules) || '');
    for (let rule of customRules) {
        if (_matchesPatternEntry(rule, wmClass, wmInstance, title)) {
            if (rule.workspace !== null) {
                result.targetWorkspace = rule.workspace;
            }
            if (rule.scratchpad) {
                result.scratchpad = true;
                result.shouldTile = false;
                return result;
            }
            if (rule.float) {
                result.shouldTile = false;
                return result;
            }
            if (rule.tile) {
                result.shouldTile = true;
                return result;
            }
        }
    }

    // 3. Respect manual per-window override during session (Super+F)
    if (manualFloatingSet && manualFloatingSet.has(winId)) {
        result.shouldTile = false;
        return result;
    }
    if (manualTiledSet && manualTiledSet.has(winId)) {
        result.shouldTile = true;
        return result;
    }

    // 4. Exclude popup / file-chooser / portal dialogs (e.g. Open File, Save As, xdg-desktop-portal)
    if (isPopupOrDialogWindow(metaWindow)) {
        result.shouldTile = false;
        return result;
    }

    // 5. Check Picture-in-Picture / Sticky / Always-on-top utility windows
    if (title === 'picture-in-picture' ||
        title === 'picture in picture' ||
        role.includes('pictureinpicture') ||
        (metaWindow.is_on_all_workspaces() && metaWindow.is_above())) {
        return result;
    }

    // 6. Check if window is non-resizable (note: do not check allows_resize() because Muffin sets it to false while maximized!)
    if (!metaWindow.resizeable) {
        return result;
    }

    // 7. Check floating classes list from settings
    let floatingEntries = getCachedFloatingEntries((settings && settings.floatingClasses) || '');
    for (let entry of floatingEntries) {
        if (_matchesPatternEntry(entry, wmClass, wmInstance, title)) {
            result.shouldTile = false;
            return result;
        }
    }

    result.shouldTile = true;
    return result;
}

/**
 * Ensures popup, dialog, and file-chooser windows (e.g. Open/Save File, XDG Desktop Portal)
 * are reasonably sized (not full-screen/tiled), centered over their parent or monitor workarea,
 * and raised above tiled windows.
 */
function arrangePopupOrDialogWindow(metaWindow, forceCenter = false) {
    if (!metaWindow || metaWindow.minimized || metaWindow.is_fullscreen()) return;
    if (metaWindow.is_override_redirect()) return;

    let winType = metaWindow.get_window_type();
    let isManageableType = (winType === Meta.WindowType.NORMAL ||
                            winType === Meta.WindowType.DIALOG ||
                            winType === Meta.WindowType.MODAL_DIALOG ||
                            winType === Meta.WindowType.UTILITY);
    if (!isManageableType) return;

    if (metaWindow.is_attached_dialog()) {
        safeRaiseWindow(metaWindow);
        return;
    }

    let parentWin = metaWindow.get_transient_for();
    if (!parentWin && typeof global !== 'undefined' && global.display) {
        let focusWin = global.display.focus_window;
        if (focusWin && focusWin !== metaWindow &&
            focusWin.get_window_type() === Meta.WindowType.NORMAL &&
            !focusWin.minimized) {
            parentWin = focusWin;
        }
    }

    let ws = metaWindow.get_workspace() ||
             (parentWin ? parentWin.get_workspace() : null) ||
             (typeof global !== 'undefined' && global.workspace_manager
                 ? global.workspace_manager.get_active_workspace()
                 : null);
    if (!ws) return;

    let monIdx = parentWin ? parentWin.get_monitor() : metaWindow.get_monitor();
    let workarea = ws.get_work_area_for_monitor(monIdx);
    if (!workarea || workarea.width <= 0 || workarea.height <= 0) return;

    let r;
    try {
        if (metaWindow.get_maximized()) {
            metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
        }
        r = metaWindow.get_frame_rect();
    } catch (e) {
        return;
    }
    if (!r || r.width <= 20 || r.height <= 20) {
        safeRaiseWindow(metaWindow);
        return;
    }

    let maxW = Math.round(workarea.width * 0.80);
    let maxH = Math.round(workarea.height * 0.82);
    let isOversized = (r.width > workarea.width * 0.85 || r.height > workarea.height * 0.85);
    let targetW = isOversized
        ? Math.min(980, Math.round(workarea.width * 0.68))
        : Math.min(r.width, maxW);
    let targetH = isOversized
        ? Math.min(700, Math.round(workarea.height * 0.72))
        : Math.min(r.height, maxH);

    let role = (metaWindow.get_role() || '').toLowerCase();
    let wmClass = (metaWindow.get_wm_class() || '').toLowerCase();
    let gtkAppId = (typeof metaWindow.get_gtk_application_id === 'function'
        ? (metaWindow.get_gtk_application_id() || '')
        : '').toLowerCase();
    let isFileOrPortal = role.includes('filechooser') ||
                         wmClass.includes('xdg-desktop-portal') ||
                         gtkAppId.includes('portal') ||
                         (winType === Meta.WindowType.NORMAL && isPopupOrDialogWindow(metaWindow));

    let isOutOfWorkarea = (r.x < workarea.x + 4 ||
                           r.y < workarea.y + 4 ||
                           (r.x + targetW) > (workarea.x + workarea.width - 4) ||
                           (r.y + targetH) > (workarea.y + workarea.height - 4));
    let isAtTopLeftCorner = (Math.abs(r.x - workarea.x) <= 24 && Math.abs(r.y - workarea.y) <= 24);

    let needsResize = metaWindow.resizeable && (Math.abs(targetW - r.width) > 4 || Math.abs(targetH - r.height) > 4);
    let effW = needsResize ? targetW : r.width;
    let effH = needsResize ? targetH : r.height;

    let shouldCenter = forceCenter || isOversized || isOutOfWorkarea || isAtTopLeftCorner || isFileOrPortal;
    if (shouldCenter || needsResize) {
        let centerX = workarea.x + Math.round(workarea.width / 2);
        let centerY = workarea.y + Math.round(workarea.height / 2);
        if (parentWin && parentWin.get_monitor() === monIdx) {
            let pr = parentWin.get_frame_rect();
            if (pr.width > 100 && pr.height > 100) {
                centerX = pr.x + Math.round(pr.width / 2);
                centerY = pr.y + Math.round(pr.height / 2);
            }
        }
        let margin = 12;
        let nx = shouldCenter
            ? clamp(centerX - Math.round(effW / 2), workarea.x + margin, Math.max(workarea.x + margin, workarea.x + workarea.width - effW - margin))
            : clamp(r.x, workarea.x + margin, Math.max(workarea.x + margin, workarea.x + workarea.width - effW - margin));
        let ny = shouldCenter
            ? clamp(centerY - Math.round(effH / 2), workarea.y + margin, Math.max(workarea.y + margin, workarea.y + workarea.height - effH - margin))
            : clamp(r.y, workarea.y + margin, Math.max(workarea.y + margin, workarea.y + workarea.height - effH - margin));

        safeApplyWindowFrame(metaWindow, nx, ny, needsResize ? effW : 0, needsResize ? effH : 0, false);
    }

    safeRaiseWindow(metaWindow);
}

/**
 * Safely raises a Meta.Window without throwing if already unmanaging or disposed.
 */
function safeRaiseWindow(metaWindow) {
    if (!metaWindow) return false;
    try {
        if (typeof metaWindow.raise === 'function') {
            metaWindow.raise();
            return true;
        }
    } catch (e) {
        // Window may already be unmanaging or disposed
    }
    return false;
}

/**
 * Safely activates a Meta.Window without throwing if already unmanaging or disposed.
 */
function safeActivateWindow(metaWindow, timestamp = 0) {
    if (!metaWindow) return false;
    try {
        if (typeof metaWindow.activate === 'function') {
            metaWindow.activate(timestamp);
            return true;
        }
    } catch (e) {
        // Window may already be unmanaging or disposed
    }
    return false;
}

/**
 * Safely applies frame geometry (and optional unmaximize) on a Meta.Window.
 */
function safeApplyWindowFrame(metaWindow, x, y, width = 0, height = 0, unmaximize = true) {
    if (!metaWindow) return false;
    try {
        if (unmaximize && typeof metaWindow.get_maximized === 'function' && metaWindow.get_maximized()) {
            metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
        }
        let rx = Math.round(x);
        let ry = Math.round(y);
        let rw = Math.round(width);
        let rh = Math.round(height);
        if (rw > 0 && rh > 0 && typeof metaWindow.move_resize_frame === 'function') {
            metaWindow.move_resize_frame(false, rx, ry, rw, rh);
        }
        if (typeof metaWindow.move_frame === 'function') {
            metaWindow.move_frame(false, rx, ry);
        }
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Handles windows that initially map as Meta.WindowType.NORMAL without transient hints,
 * and shortly afterward set WM_TRANSIENT_FOR, dialog window-type, or a file-chooser title.
 */
function recheckLatePopupOrDialog(wm, metaWindow, isInitialScan = false) {
    if (!wm || !metaWindow) return false;
    let winId = metaWindow.get_stable_sequence();
    if (wm.manualTiled.has(winId)) return false;
    if (!isPopupOrDialogWindow(metaWindow)) return false;

    let wasInTiledOrder = false;
    for (let state of wm._states.values()) {
        let idx = state.windowOrder.indexOf(winId);
        if (idx !== -1) {
            state.windowOrder.splice(idx, 1);
            wasInTiledOrder = true;
        }
        if (Array.isArray(state.fullWindowOrder)) {
            let fIdx = state.fullWindowOrder.indexOf(winId);
            if (fIdx !== -1) {
                state.fullWindowOrder.splice(fIdx, 1);
                wasInTiledOrder = true;
            }
        }
        if (state.bspTree && state.bspTree.hasWindow(winId)) {
            state.bspTree.remove(winId);
            wasInTiledOrder = true;
        }
        if (state.lastRects && state.lastRects.delete(winId)) {
            wasInTiledOrder = true;
        }
    }

    if (wasInTiledOrder) {
        let saved = wm.savedFloatingRects.get(winId);
        if (saved && saved.width > 120 && saved.height > 90) {
            safeApplyWindowFrame(metaWindow, saved.x, saved.y, saved.width, saved.height, false);
        }
        if (!isInitialScan) {
            arrangePopupOrDialogWindow(metaWindow, true);
        }
        wm.queueRetile(true);
        return true;
    }
    return false;
}

const _X11_CLEAR_HINTS_PY = [
    'import ctypes, ctypes.util, sys',
    'xlib = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11"))',
    'xlib.XOpenDisplay.restype = ctypes.c_void_p',
    'class H(ctypes.Structure): _fields_ = [("flags", ctypes.c_long)] + [(f"f{i}", ctypes.c_int) for i in range(17)]',
    'dpy = xlib.XOpenDisplay(None)',
    'if dpy:',
    '    try:',
    '        h, s = H(), ctypes.c_long()',
    '        any_changed = False',
    '        for arg in sys.argv[1:]:',
    '            try:',
    '                xid = int(arg)',
    '            except Exception:',
    '                continue',
    '            if xlib.XGetWMNormalHints(dpy, ctypes.c_ulong(xid), ctypes.byref(h), ctypes.byref(s)):',
    '                changed = False',
    '                if (h.flags & 0x20):',
    '                    h.flags &= ~0x20; h.f6 = 32767; h.f7 = 32767; changed = True',
    '                if (h.flags & 0x40) and (h.f8 > 1 or h.f9 > 1):',
    '                    h.flags |= 0x40; h.f8 = 1; h.f9 = 1; changed = True',
    '                if (h.flags & 0x10) and (h.f4 > 100 or h.f5 > 80):',
    '                    h.flags |= 0x10; h.f4 = min(h.f4, 100); h.f5 = min(h.f5, 80); changed = True',
    '                if (h.flags & 0x100) and (h.f14 > 100 or h.f15 > 80):',
    '                    h.flags |= 0x100; h.f14 = min(h.f14, 100); h.f15 = min(h.f15, 80); changed = True',
    '                if changed:',
    '                    xlib.XSetWMNormalHints(dpy, ctypes.c_ulong(xid), ctypes.byref(h)); any_changed = True',
    '        if any_changed:',
    '            xlib.XFlush(dpy)',
    '    finally:',
    '        xlib.XCloseDisplay(dpy)'
].join('\n');

function _flushX11ResizeIncrements(wm) {
    if (!wm) return;
    wm._resizeIncFlushIdleId = 0;
    if (!wm._enabled || !wm._resizeIncQueue || wm._resizeIncQueue.size === 0) {
        if (wm._resizeIncQueue) wm._resizeIncQueue.clear();
        return;
    }

    let batch = Array.from(wm._resizeIncQueue);
    wm._resizeIncQueue.clear();

    const finishBatch = (succeeded) => {
        for (let xid of batch) {
            if (wm._pendingResizeIncXids) wm._pendingResizeIncXids.delete(xid);
            if (wm._clearedResizeIncXids) wm._clearedResizeIncXids.add(xid);
        }
        if (succeeded && wm._enabled && wm._states && typeof wm._schedulePostRetileSettle === 'function') {
            wm._schedulePostRetileSettle();
        }
    };

    try {
        if (wm._resizeIncCancellable) {
            try { wm._resizeIncCancellable.cancel(); } catch (e) {}
        }
        let cancellable = new Gio.Cancellable();
        wm._resizeIncCancellable = cancellable;
        let proc = Gio.Subprocess.new(
            ['python3', '-c', _X11_CLEAR_HINTS_PY, ...batch.map(String)],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        proc.wait_async(cancellable, (_proc, res) => {
            if (wm._resizeIncCancellable === cancellable) {
                wm._resizeIncCancellable = null;
            }
            let ok = false;
            try {
                ok = proc.wait_finish(res) && proc.get_successful();
            } catch (e) {
                if (typeof global !== 'undefined' && global.logError &&
                    !(typeof e.matches === 'function' && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))) {
                    global.logError(`[${wm.uuid || 'cinnawm'}] Failed to relax X11 size hints: ${e}`);
                }
            }
            finishBatch(!cancellable.is_cancelled() && ok);
        });
    } catch (e) {
        if (typeof global !== 'undefined' && global.logError) {
            global.logError(`[${wm.uuid || 'cinnawm'}] Failed to spawn X11 size hint helper: ${e}`);
        }
        finishBatch(false);
    }
}

/**
 * Relaxes X11 WM_NORMAL_HINTS PResizeInc (to 1x1), PMinSize (to <= 100x80), and PBaseSize (to <= 100x80)
 * on tiled windows so Muffin and X11 clients can resize them to exact pixel boundaries without
 * character-cell rounding gaps or rigid minimum-size overflows. Batched via a single idle tick.
 */
function clearX11ResizeIncrements(wm, metaWindow) {
    if (!wm || !wm._enabled || !metaWindow || typeof metaWindow.get_xwindow !== 'function') return;
    let xid = 0;
    try {
        xid = metaWindow.get_xwindow();
    } catch (e) {
        return;
    }
    if (!xid || wm._clearedResizeIncXids.has(xid) || wm._pendingResizeIncXids.has(xid)) return;
    wm._pendingResizeIncXids.add(xid);
    if (!wm._resizeIncQueue) {
        wm._resizeIncQueue = new Set();
    }
    wm._resizeIncQueue.add(xid);
    if (!wm._resizeIncFlushIdleId) {
        wm._resizeIncFlushIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            _flushX11ResizeIncrements(wm);
            return GLib.SOURCE_REMOVE;
        });
    }
}

module.exports = {
    parseCustomRules,
    getCachedCustomRules,
    getCachedFloatingEntries,
    isPopupOrDialogWindow,
    evaluateWindow,
    arrangePopupOrDialogWindow,
    recheckLatePopupOrDialog,
    clearX11ResizeIncrements,
    safeRaiseWindow,
    safeActivateWindow,
    safeApplyWindowFrame
};

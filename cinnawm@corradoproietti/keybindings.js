// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Global Hotkey Registration & Cinnamon Keybinding Conflict Resolution
 */

const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const RuntimeConfig = require('./runtime-config');
let Main = null;
try {
    Main = imports.ui.main;
} catch (e) {}

const KEYBINDING_SETTINGS_MAP = [
    ['kb-focus-left', 'kbFocusLeft'],
    ['kb-focus-right', 'kbFocusRight'],
    ['kb-focus-up', 'kbFocusUp'],
    ['kb-focus-down', 'kbFocusDown'],
    ['kb-swap-left', 'kbSwapLeft'],
    ['kb-swap-right', 'kbSwapRight'],
    ['kb-swap-up', 'kbSwapUp'],
    ['kb-swap-down', 'kbSwapDown'],
    ['kb-promote-master', 'kbPromoteMaster'],
    ['kb-cycle-layout', 'kbCycleLayout'],
    ['kb-cycle-layout-back', 'kbCycleLayoutBack'],
    ['kb-toggle-floating', 'kbToggleFloating'],
    ['kb-toggle-tiling', 'kbToggleTiling'],
    ['kb-toggle-monocle', 'kbToggleMonocle'],
    ['kb-increase-ratio', 'kbIncreaseRatio'],
    ['kb-decrease-ratio', 'kbDecreaseRatio'],
    ['kb-increase-master-count', 'kbIncreaseMasterCount'],
    ['kb-decrease-master-count', 'kbDecreaseMasterCount'],
    ['kb-rotate-orientation', 'kbRotateOrientation'],
    ['kb-resize-mode', 'kbResizeMode'],
    ['kb-scratchpad-toggle', 'kbScratchpadToggle'],
    ['kb-scratchpad-assign', 'kbScratchpadAssign'],
    ['kb-quick-grid', 'kbQuickGrid'],
    ['kb-center-window', 'kbCenterWindow'],
    ['kb-toggle-tab-group', 'kbToggleTabGroup'],
    ['kb-move-workspace-prev', 'kbMoveWorkspacePrev'],
    ['kb-move-workspace-next', 'kbMoveWorkspaceNext'],
    ['kb-move-monitor-next', 'kbMoveMonitorNext'],
    ['kb-focus-monitor-next', 'kbFocusMonitorNext'],
    ['kb-toggle-pip', 'kbTogglePip'],
    ['kb-window-switcher', 'kbWindowSwitcher']
];

function normalizeAccelerator(accel) {
    if (!accel || typeof accel !== 'string') return null;
    let trimmed = accel.trim();
    if (!trimmed) return null;
    try {
        let [keyval, mods] = Gtk.accelerator_parse(trimmed);
        if (!keyval && !mods) return null;
        return `${keyval}:${mods}`;
    } catch (e) {
        return trimmed.toLowerCase();
    }
}

class KeybindingManager {
    constructor(wm) {
        this.wm = wm;
        this._registeredHotkeys = [];
        this._overriddenCustomBindings = new Map();
        this._wmKeybindingBackupFile = RuntimeConfig.getSpicesConfigFile(
            wm.uuid,
            'saved-wm-keybindings.json',
            false
        );
    }

    _resolveWmKeybindingConflicts(activeAccels) {
        try {
            let wmSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.keybindings.wm' });
            let savedWm = {};
            if (GLib.file_test(this._wmKeybindingBackupFile, GLib.FileTest.EXISTS)) {
                try {
                    let [ok, contents] = GLib.file_get_contents(this._wmKeybindingBackupFile);
                    if (ok && contents) {
                        let parsed = JSON.parse(ByteArray.toString(contents));
                        if (parsed && typeof parsed === 'object') {
                            savedWm = parsed;
                        }
                    }
                } catch (e) {
                    // ignore malformed backup
                }
            }

            let schema = wmSettings.settings_schema;
            let keys = wmSettings.list_keys();
            let modified = false;

            for (let key of keys) {
                try {
                    let schemaKey = schema ? schema.get_key(key) : null;
                    if (schemaKey && schemaKey.get_value_type().dup_string() !== 'as') {
                        continue;
                    }
                    let current = wmSettings.get_strv(key);
                    if (!Array.isArray(current) || current.length === 0) continue;

                    let filtered = current.filter(b => {
                        let norm = normalizeAccelerator(b);
                        return !norm || !activeAccels.has(norm);
                    });

                    if (filtered.length !== current.length) {
                        if (!Object.prototype.hasOwnProperty.call(savedWm, key)) {
                            savedWm[key] = current;
                        }
                        wmSettings.set_strv(key, filtered);
                        modified = true;
                    }
                } catch (e) {
                    // ignore non-strv keys
                }
            }

            // Ensure Cinnamon screen lock ('screensaver') is assigned to <Control><Alt>l
            let lockNorm = normalizeAccelerator('<Control><Alt>l');
            if (lockNorm && !activeAccels.has(lockNorm)) {
                try {
                    let mediaSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.keybindings.media-keys' });
                    let currentLock = mediaSettings.get_strv('screensaver') || [];
                    let filteredLock = currentLock.filter(b => {
                        let norm = normalizeAccelerator(b);
                        return !norm || !activeAccels.has(norm);
                    });
                    let hasCtrlAltL = filteredLock.some(b => normalizeAccelerator(b) === lockNorm);
                    if (!hasCtrlAltL) {
                        filteredLock.unshift('<Control><Alt>l');
                    }
                    if (JSON.stringify(filteredLock) !== JSON.stringify(currentLock)) {
                        if (!Object.prototype.hasOwnProperty.call(savedWm, '__mediaKeys_screensaver')) {
                            savedWm['__mediaKeys_screensaver'] = currentLock;
                        }
                        mediaSettings.set_strv('screensaver', filteredLock);
                        modified = true;
                        if (Main && Main.keybindingManager && typeof Main.keybindingManager.setup_media_keys === 'function') {
                            Main.keybindingManager.setup_media_keys();
                        }
                    }
                } catch (e) {
                    // ignore if media-keys schema is unavailable
                }
            }

            if (modified || Object.keys(savedWm).length > 0) {
                let dir = GLib.path_get_dirname(this._wmKeybindingBackupFile);
                GLib.mkdir_with_parents(dir, 0o755);
                GLib.file_set_contents(this._wmKeybindingBackupFile, JSON.stringify(savedWm, null, 2));
            }
        } catch (e) {
            if (typeof global !== 'undefined' && global.logError) {
                global.logError(`[${this.wm.uuid}] Failed to resolve WM keybinding conflicts: ${e}`);
            }
        }
    }

    _restoreWmKeybindingConflicts() {
        try {
            if (!GLib.file_test(this._wmKeybindingBackupFile, GLib.FileTest.EXISTS)) {
                return;
            }
            let [ok, contents] = GLib.file_get_contents(this._wmKeybindingBackupFile);
            if (!ok || !contents) return;

            let savedWm = JSON.parse(ByteArray.toString(contents));
            if (savedWm && typeof savedWm === 'object') {
                let wmSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.keybindings.wm' });
                let mediaSettings = null;
                let restoredMediaKeys = false;
                for (let [key, origValues] of Object.entries(savedWm)) {
                    if (!Array.isArray(origValues)) continue;
                    try {
                        if (key === '__mediaKeys_screensaver') {
                            if (!mediaSettings) {
                                mediaSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.keybindings.media-keys' });
                            }
                            mediaSettings.set_strv('screensaver', origValues);
                            restoredMediaKeys = true;
                        } else {
                            wmSettings.set_strv(key, origValues);
                        }
                    } catch (e) {
                        // ignore
                    }
                }
                if (restoredMediaKeys && Main && Main.keybindingManager && typeof Main.keybindingManager.setup_media_keys === 'function') {
                    Main.keybindingManager.setup_media_keys();
                }
            }
            GLib.unlink(this._wmKeybindingBackupFile);
        } catch (e) {
            if (typeof global !== 'undefined' && global.logError) {
                global.logError(`[${this.wm.uuid}] Failed to restore WM keybinding conflicts: ${e}`);
            }
        }
    }

    _resolveCustomKeybindingConflicts(activeAccels) {
        if (!Main || !Main.keybindingManager || !Main.keybindingManager.bindings) return false;
        let resolvedAny = false;
        let entries = Array.from(Main.keybindingManager.bindings.values());

        for (let entry of entries) {
            if (!entry || !entry.name || entry.name.startsWith('cinnawm-')) continue;
            if (!Array.isArray(entry.bindings) || entry.bindings.length === 0) continue;

            let hasConflict = entry.bindings.some(b => {
                let norm = normalizeAccelerator(b);
                return norm && activeAccels.has(norm);
            });

            if (hasConflict) {
                if (!this._overriddenCustomBindings.has(entry.name)) {
                    this._overriddenCustomBindings.set(entry.name, {
                        name: entry.name,
                        bindings: entry.bindings.slice(),
                        callback: entry.callback
                    });
                }

                let remaining = entry.bindings.filter(b => {
                    let norm = normalizeAccelerator(b);
                    return !norm || !activeAccels.has(norm);
                });

                try {
                    Main.keybindingManager.removeHotKey(entry.name);
                    if (remaining.length > 0) {
                        Main.keybindingManager.addHotKeyArray(entry.name, remaining, entry.callback);
                    }
                    resolvedAny = true;
                } catch (e) {
                    if (typeof global !== 'undefined' && global.logError) {
                        global.logError(`[${this.wm.uuid}] Failed to resolve custom keybinding '${entry.name}': ${e}`);
                    }
                }
            }
        }
        return resolvedAny;
    }

    _restoreCustomKeybindingConflicts() {
        if (!Main || !Main.keybindingManager) return;
        for (let saved of this._overriddenCustomBindings.values()) {
            try {
                Main.keybindingManager.removeHotKey(saved.name);
                Main.keybindingManager.addHotKeyArray(saved.name, saved.bindings, saved.callback);
            } catch (e) {
                if (typeof global !== 'undefined' && global.logError) {
                    global.logError(`[${this.wm.uuid}] Failed to restore custom keybinding '${saved.name}': ${e}`);
                }
            }
        }
        this._overriddenCustomBindings.clear();
    }

    register() {
        this.unregister(false);
        if (!Main || !Main.keybindingManager) return;

        let s = this.wm.settings;
        const bindings = [
            ['cinnawm-focus-left',          s.kbFocusLeft,          () => this.wm.focusDirectional('left')],
            ['cinnawm-focus-right',         s.kbFocusRight,         () => this.wm.focusDirectional('right')],
            ['cinnawm-focus-up',            s.kbFocusUp,            () => this.wm.focusDirectional('up')],
            ['cinnawm-focus-down',          s.kbFocusDown,          () => this.wm.focusDirectional('down')],
            ['cinnawm-swap-left',           s.kbSwapLeft,           () => this.wm.swapDirectional('left')],
            ['cinnawm-swap-right',          s.kbSwapRight,          () => this.wm.swapDirectional('right')],
            ['cinnawm-swap-up',             s.kbSwapUp,             () => this.wm.swapDirectional('up')],
            ['cinnawm-swap-down',           s.kbSwapDown,           () => this.wm.swapDirectional('down')],
            ['cinnawm-promote-master',      s.kbPromoteMaster,      () => this.wm.promoteFocusedToMaster()],
            ['cinnawm-cycle-layout',        s.kbCycleLayout,        () => this.wm.cycleLayout(1)],
            ['cinnawm-cycle-layout-back',   s.kbCycleLayoutBack,    () => this.wm.cycleLayout(-1)],
            ['cinnawm-toggle-floating',     s.kbToggleFloating,     () => this.wm.toggleFocusedFloating()],
            ['cinnawm-toggle-tiling',       s.kbToggleTiling,       () => this.wm.toggleWorkspaceTiling()],
            ['cinnawm-toggle-monocle',      s.kbToggleMonocle,      () => this.wm.toggleMonocleZoom()],
            ['cinnawm-increase-ratio',      s.kbIncreaseRatio,      () => this.wm.resizeFocusedDirectional(0.05, 0)],
            ['cinnawm-decrease-ratio',      s.kbDecreaseRatio,      () => this.wm.resizeFocusedDirectional(-0.05, 0)],
            ['cinnawm-increase-master',     s.kbIncreaseMasterCount, () => this.wm.adjustMasterCount(1)],
            ['cinnawm-decrease-master',     s.kbDecreaseMasterCount, () => this.wm.adjustMasterCount(-1)],
            ['cinnawm-rotate-orientation',  s.kbRotateOrientation,  () => this.wm.rotateLayoutOrientation()],
            ['cinnawm-resize-mode',         s.kbResizeMode,         () => this.wm.resizeMode && this.wm.resizeMode.toggle()],
            ['cinnawm-scratchpad-toggle',   s.kbScratchpadToggle,   () => this.wm.handleScratchpadToggle()],
            ['cinnawm-scratchpad-assign',   s.kbScratchpadAssign,   () => this.wm.handleScratchpadAssign()],
            ['cinnawm-quick-grid',          s.kbQuickGrid,          () => this.wm.quickGrid && this.wm.quickGrid.toggle()],
            ['cinnawm-center-window',       s.kbCenterWindow,       () => this.wm.centerFocusedWindow()],
            ['cinnawm-toggle-tab-group',    s.kbToggleTabGroup,     () => this.wm.toggleFocusedTabGroup()],
            ['cinnawm-move-ws-prev',        s.kbMoveWorkspacePrev,  () => this.wm.moveFocusedToWorkspace(-1)],
            ['cinnawm-move-ws-next',        s.kbMoveWorkspaceNext,  () => this.wm.moveFocusedToWorkspace(1)],
            ['cinnawm-move-monitor-next',   s.kbMoveMonitorNext,    () => this.wm.moveFocusedToAdjacentMonitor(1)],
            ['cinnawm-focus-monitor-next',  s.kbFocusMonitorNext,   () => this.wm.focusMonitorStep(1)],
            ['cinnawm-toggle-pip',          s.kbTogglePip,          () => this.wm.toggleFocusedPip()],
            ['cinnawm-window-switcher',     s.kbWindowSwitcher,     () => this.wm.openWindowSwitcher()]
        ];

        let activeAccels = new Set();
        for (let [, combo] of bindings) {
            if (!combo || !combo.trim()) continue;
            for (let part of combo.split('::')) {
                let norm = normalizeAccelerator(part);
                if (norm) activeAccels.add(norm);
            }
        }

        this._resolveWmKeybindingConflicts(activeAccels);
        this._resolveCustomKeybindingConflicts(activeAccels);

        for (let [name, combo, handler] of bindings) {
            if (combo && combo.trim()) {
                try {
                    Main.keybindingManager.addHotKey(name, combo, handler);
                    this._registeredHotkeys.push(name);
                } catch (e) {
                    if (typeof global !== 'undefined' && global.logError) {
                        global.logError(`[${this.wm.uuid}] Failed to bind hotkey '${name}' (${combo}): ${e}`);
                    }
                }
            }
        }

        // Catch any applet or input-source hotkeys committed asynchronously via GLib.idle_add
        this.wm._addTimeout(250, () => {
            if (this._resolveCustomKeybindingConflicts(activeAccels)) {
                for (let [name, combo, handler] of bindings) {
                    if (combo && combo.trim()) {
                        try {
                            Main.keybindingManager.removeHotKey(name);
                            Main.keybindingManager.addHotKey(name, combo, handler);
                        } catch (e) {
                            if (typeof global !== 'undefined' && global.logError) {
                                global.logError(`[${this.wm.uuid}] Failed to rebind hotkey '${name}': ${e}`);
                            }
                        }
                    }
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    unregister(restoreWm = false) {
        if (Main && Main.keybindingManager) {
            for (let name of this._registeredHotkeys) {
                try {
                    Main.keybindingManager.removeHotKey(name);
                } catch (e) {
                    // ignore
                }
            }
        }
        this._registeredHotkeys = [];
        this._restoreCustomKeybindingConflicts();
        if (restoreWm) {
            this._restoreWmKeybindingConflicts();
        }
    }
}

module.exports = {
    KEYBINDING_SETTINGS_MAP,
    normalizeAccelerator,
    KeybindingManager
};

// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Hybrid Tiling & Window Manager Extension for Cinnamon
 *
 * Combines the best ideas from:
 *  - Hyprland / bspwm (Dwindle/BSP binary tree, Smart Gaps, Active Window Border)
 *  - dwm / XMonad / AwesomeWM (Master & Stack, Centered Master 3-Column, per-workspace layouts)
 *  - i3 / Sway (Scratchpad, Modal Resize Mode, Window Rules, Monocle/Zen)
 *  - Pop!_OS Shell / Forge (Mouse Drag-to-Swap with preview, Live Edge Resize, Directional Focus/Swap)
 *  - Niri / PaperWM (Scrolling Columns layout)
 *  - gTile / FancyZones (Interactive Quick Snap Grid overlay)
 */

const ByteArray = imports.byteArray;
const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;

const Layouts = require('./layouts');
const WindowRules = require('./window-rules');
const Scratchpad = require('./scratchpad');
const StateStore = require('./state-store');
const PanelIndicator = require('./panel-indicator');
const Keybindings = require('./keybindings');
const GrabControllerModule = require('./grab-controller');
const Overlays = require('./overlays');
const IpcService = require('./ipc-service');
const RuntimeConfig = require('./runtime-config');

let _gettextCtx = RuntimeConfig.bindGettext();
let _runtimeUuid = _gettextCtx.uuid;

function _(str) {
    return Gettext.dgettext(_runtimeUuid, str);
}

const VISUAL_SETTINGS_MAP = [
    ['default-layout', 'defaultLayout'],
    ['workspace-default-layouts', 'workspaceDefaultLayouts'],
    ['auto-tiling-enabled', 'autoTilingEnabled'],
    ['dwindle-split-direction', 'dwindleSplitDirection'],
    ['dwindle-default-split-ratio-pct', 'dwindleDefaultSplitRatioPct'],
    ['dwindle-new-window-placement', 'dwindleNewWindowPlacement'],
    ['dwindle-resize-step-pct', 'dwindleResizeStepPct'],
    ['dwindle-respect-min-size', 'dwindleRespectMinSize'],
    ['master-ratio-pct', 'masterRatioPct'],
    ['master-count', 'masterCount'],
    ['master-orientation', 'masterOrientation'],
    ['master-auto-orientation', 'masterAutoOrientation'],
    ['master-new-window-placement', 'masterNewWindowPlacement'],
    ['master-single-window-width-pct', 'masterSingleWindowWidthPct'],
    ['centered-master-ratio-pct', 'centeredMasterRatioPct'],
    ['centered-master-count', 'centeredMasterCount'],
    ['centered-master-side-balance', 'centeredMasterSideBalance'],
    ['centered-master-single-width-pct', 'centeredMasterSingleWidthPct'],
    ['scrolling-column-width-pct', 'scrollingColumnWidthPct'],
    ['scrolling-single-column-width-pct', 'scrollingSingleColumnWidthPct'],
    ['scrolling-focus-alignment', 'scrollingFocusAlignment'],
    ['scrolling-min-visible-width-px', 'scrollingMinVisibleWidthPx'],
    ['scrolling-resize-step-pct', 'scrollingResizeStepPct'],
    ['monocle-zen-width-pct', 'monocleZenWidthPct'],
    ['monocle-zen-height-pct', 'monocleZenHeightPct'],
    ['monocle-outer-margin-px', 'monocleOuterMarginPx'],
    ['monocle-wrap-navigation', 'monocleWrapNavigation'],
    ['grid-max-cols', 'gridMaxCols'],
    ['grid-last-row-behavior', 'gridLastRowBehavior'],
    ['floating-center-new-windows', 'floatingCenterNewWindows'],
    ['floating-center-width-pct', 'floatingCenterWidthPct'],
    ['floating-center-height-pct', 'floatingCenterHeightPct'],
    ['inner-gap', 'innerGap'],
    ['outer-gap', 'outerGap'],
    ['overflow-min-width-px', 'overflowMinWidthPx'],
    ['overflow-min-height-px', 'overflowMinHeightPx'],
    ['smart-gaps', 'smartGaps'],
    ['mouse-drag-swap', 'mouseDragSwap'],
    ['mouse-edge-resize', 'mouseEdgeResize'],
    ['cursor-follows-focus', 'cursorFollowsFocus'],
    ['active-border-enabled', 'activeBorderEnabled'],
    ['active-border-color', 'activeBorderColor'],
    ['active-border-state-colors', 'activeBorderStateColors'],
    ['active-border-floating-color', 'activeBorderFloatingColor'],
    ['active-border-stacked-color', 'activeBorderStackedColor'],
    ['active-border-width', 'activeBorderWidth'],
    ['active-border-radius', 'activeBorderRadius'],
    ['smart-no-border', 'smartNoBorder'],
    ['inactive-dimming-enabled', 'inactiveDimmingEnabled'],
    ['inactive-window-opacity-pct', 'inactiveWindowOpacityPct'],
    ['show-osd', 'showOsd'],
    ['show-panel-indicator', 'showPanelIndicator'],
    ['grid-cols', 'gridCols'],
    ['grid-rows', 'gridRows'],
    ['floating-classes', 'floatingClasses'],
    ['custom-window-rules', 'customWindowRules'],
    ['scratchpad-width-pct', 'scratchpadWidthPct'],
    ['scratchpad-height-pct', 'scratchpadHeightPct'],
    ['pip-corner', 'pipCorner'],
    ['pip-width-pct', 'pipWidthPct'],
    ['pip-height-pct', 'pipHeightPct']
];

const PROP_TO_SCHEMA_KEY = new Map(
    [...VISUAL_SETTINGS_MAP, ...Keybindings.KEYBINDING_SETTINGS_MAP].map(([k, p]) => [p, k])
);

const CORE_FALLBACK_DEFAULTS = {
    defaultLayout: 'dwindle',
    autoTilingEnabled: true,
    innerGap: 8,
    outerGap: 8,
    overflowMinWidthPx: 220,
    overflowMinHeightPx: 150,
    smartGaps: false,
    mouseDragSwap: true,
    mouseEdgeResize: true,
    cursorFollowsFocus: false,
    activeBorderEnabled: true,
    activeBorderColor: 'rgba(94, 129, 244, 0.95)',
    activeBorderStateColors: true,
    activeBorderFloatingColor: 'rgba(245, 194, 17, 0.95)',
    activeBorderStackedColor: 'rgba(180, 142, 173, 0.95)',
    activeBorderWidth: 3,
    activeBorderRadius: 8,
    showOsd: true,
    showPanelIndicator: true,
    gridCols: 4,
    gridRows: 3,
    scratchpadWidthPct: 75,
    scratchpadHeightPct: 70
};

function loadDefaultSettings(extensionPath) {
    let defaultsPath = `${extensionPath}/defaults.json`;
    try {
        let [ok, contents] = GLib.file_get_contents(defaultsPath);
        if (!ok || !contents) {
            throw new Error(`Unable to read defaults.json at ${defaultsPath}`);
        }
        let parsed = JSON.parse(ByteArray.toString(contents));
        if (parsed && typeof parsed === 'object') {
            return Object.assign({}, CORE_FALLBACK_DEFAULTS, parsed);
        }
    } catch (e) {
        if (typeof global !== 'undefined' && global.logError) {
            global.logError(`[${_runtimeUuid}] Failed to load defaults.json (${defaultsPath}), using built-in fallback: ${e}`);
        }
    }
    return Object.assign({}, CORE_FALLBACK_DEFAULTS);
}

class CinnaWMExtension {
    constructor(meta) {
        this.meta = meta;
        this.uuid = (meta && meta.uuid) || RuntimeConfig.resolveUuid(meta);
        _runtimeUuid = this.uuid;
        RuntimeConfig.bindGettext(this.uuid, meta ? meta.path : null);
        this._enabled = false;
        this._signals = new SignalManager.SignalManager(null);
        this._windowSignals = new Map(); // winId -> [{ obj, id }]
        this._states = new Map(); // "ws:mon" -> WorkspaceMonitorState
        this._windowMinSizes = new Map(); // winId -> { minW, minH } observed from X11 WM_NORMAL_HINTS
        this._clearedResizeIncXids = new Set(); // X11 window IDs already checked for PResizeInc
        this._pendingResizeIncXids = new Set(); // X11 window IDs with an active async PResizeInc clear
        this._resizeIncQueue = new Set(); // X11 window IDs queued for next idle batch clear
        this._resizeIncFlushIdleId = 0;
        this._resizeIncCancellable = null;
        this._previewIdleId = 0;
        this._winIdToXid = new Map(); // winId -> X11 window ID

        this.manualFloating = new Set(); // winId explicitly floated by user
        this.manualTiled = new Set();    // winId explicitly forced to tile by user
        this.savedFloatingRects = new Map(); // winId -> { x, y, width, height } before tiling
        this.pipWindows = new Set(); // winId currently pinned in Picture-in-Picture / Sticky mode
        this._pipPrevState = new Map(); // winId -> { wasTiled, rect }

        this._retileTimeoutId = 0;
        this._dragPollTimeoutId = 0;
        this._pendingTimeouts = new Set();
        this._postRetileSettleIds = [];
        this._postUnminimizeSettleIds = [];
        this._isApplyingLayout = false;
        this._isSavingSettings = false;
        this._grabState = null;
        this._panelPosition = { panelId: null, zone: 'right', index: 0 };

        this.panelIndicator = new PanelIndicator.PanelIndicatorController(this);
        this.keybindings = new Keybindings.KeybindingManager(this);
        this.grabController = new GrabControllerModule.GrabController(this);
        this.ipcService = null;
        this._wmPrefsSettings = null;
        this._originalButtonLayout = null;
        this._isSyncingButtonLayout = false;
        this._lastAppliedButtonLayout = null;

        this.settings = loadDefaultSettings(meta ? meta.path : '.');
    }

    _safeRun(context, fn) {
        try {
            return fn();
        } catch (e) {
            if (typeof global !== 'undefined' && global.logError) {
                global.logError(`[${this.uuid}] ${context}: ${e}`);
            }
            return undefined;
        }
    }

    _addTimeout(delayMs, callback) {
        let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._pendingTimeouts.delete(id);
            if (!this._enabled) return GLib.SOURCE_REMOVE;
            try {
                return callback();
            } catch (e) {
                if (typeof global !== 'undefined' && global.logError) {
                    global.logError(`[${this.uuid}] Scheduled callback error: ${e}`);
                }
                return GLib.SOURCE_REMOVE;
            }
        });
        this._pendingTimeouts.add(id);
        return id;
    }

    enable() {
        if (this._enabled) return;
        this._enabled = true;
        this._safeRun('initSettings', () => this._initSettings());
        this._loadPersistedStates();

        this.scratchpad = new Scratchpad.ScratchpadManager(this);
        this.activeBorder = new Overlays.ActiveBorderOverlay(this);
        this.dropPreview = new Overlays.DropPreviewOverlay();
        this.resizePreview = new Overlays.ResizePreviewOverlay(this);
        this.osd = new Overlays.HudOsd(this);
        this.layoutSelector = new Overlays.LayoutSelectorPopup(this);
        this.quickGrid = new Overlays.QuickGridOverlay(this);
        this.resizeMode = new Overlays.ResizeModeController(this);

        this._safeRun('panelIndicator.setup', () => this.panelIndicator.setup());
        this._safeRun('keybindings.register', () => this.keybindings.register());
        this._connectGlobalSignals();
        this._safeRun('initButtonLayoutSync', () => this._initButtonLayoutSync());

        this.ipcService = new IpcService.CinnaWMIpcService(this);
        this._safeRun('ipcService.start', () => this.ipcService.start());

        this._safeRun('initialWindowScan', () => {
            let actors = Meta.get_window_actors(global.display);
            for (let actor of actors) {
                let mw = actor ? actor.get_meta_window() : null;
                if (mw) {
                    this._safeRun('trackInitialWindow', () => this._trackWindow(mw, true));
                }
            }
        });

        this._safeRun('initialRetile', () => {
            this.queueRetile(true);
            this._onFocusWindowChanged();
        });
    }

    disable() {
        this._enabled = false;
        this._safeRun('restoreButtonLayout', () => this._restoreButtonLayout());
        this._safeRun('savePersistedStates', () => this._savePersistedStates());

        if (this.ipcService) {
            this._safeRun('ipcService.destroy', () => this.ipcService.destroy());
            this.ipcService = null;
        }
        if (this._resizeIncCancellable) {
            this._safeRun('resizeIncCancellable.cancel', () => this._resizeIncCancellable.cancel());
            this._resizeIncCancellable = null;
        }
        if (this._previewIdleId) {
            this._safeRun('removePreviewIdle', () => GLib.source_remove(this._previewIdleId));
            this._previewIdleId = 0;
        }
        if (this._retileTimeoutId) {
            this._safeRun('removeRetileTimeout', () => GLib.source_remove(this._retileTimeoutId));
            this._retileTimeoutId = 0;
        }
        if (this._resizeIncFlushIdleId) {
            this._safeRun('removeResizeIncIdle', () => GLib.source_remove(this._resizeIncFlushIdleId));
            this._resizeIncFlushIdleId = 0;
        }
        this._resizeIncQueue.clear();
        for (let tid of this._pendingTimeouts) {
            this._safeRun('removePendingTimeout', () => GLib.source_remove(tid));
        }
        this._pendingTimeouts.clear();
        this._postRetileSettleIds = [];
        this._postUnminimizeSettleIds = [];
        this._safeRun('stopDragPolling', () => this._stopDragPolling());
        this._grabState = null;

        this._safeRun('keybindings.unregister', () => this.keybindings.unregister(true));
        this._safeRun('panelIndicator.remove', () => this.panelIndicator.remove());

        for (let winId of Array.from(this._windowSignals.keys())) {
            this._untrackWindowById(winId);
        }
        this._windowSignals.clear();
        this._winIdToXid.clear();
        this._safeRun('disconnectGlobalSignals', () => this._signals.disconnectAllSignals());
        this._wmPrefsSettings = null;

        this._safeRun('restorePipWindows', () => this._restoreAllPipWindows());
        this.pipWindows.clear();
        this._pipPrevState.clear();

        const uiModules = [
            'resizeMode',
            'quickGrid',
            'layoutSelector',
            'osd',
            'resizePreview',
            'dropPreview',
            'activeBorder',
            'scratchpad'
        ];
        for (let prop of uiModules) {
            if (this[prop]) {
                this._safeRun(`${prop}.destroy`, () => this[prop].destroy());
                this[prop] = null;
            }
        }
        if (this.extSettings) {
            this._safeRun('extSettings.finalize', () => this.extSettings.finalize());
            this.extSettings = null;
        }
    }

    _applySettingSideEffects(prop, value) {
        if (prop === 'defaultLayout') {
            let overrides = Layouts.parseWorkspaceDefaultLayouts(this.settings.workspaceDefaultLayouts);
            for (let [key, st] of this._states.entries()) {
                let wsIdx = Number(String(key).split(':')[0]);
                if (overrides.has(wsIdx)) continue;
                let newLayout = value || 'dwindle';
                st.previousLayoutId = null;
                st.layoutId = newLayout;
                st.autoTile = (this.settings.autoTilingEnabled !== false) && (newLayout !== 'floating');
            }
        } else if (prop === 'workspaceDefaultLayouts') {
            let overrides = Layouts.parseWorkspaceDefaultLayouts(value);
            for (let [key, st] of this._states.entries()) {
                let wsIdx = Number(String(key).split(':')[0]);
                let targetLayout = overrides.has(wsIdx)
                    ? overrides.get(wsIdx)
                    : (this.settings.defaultLayout || 'dwindle');
                st.previousLayoutId = null;
                st.layoutId = targetLayout;
                st.autoTile = (this.settings.autoTilingEnabled !== false) && (targetLayout !== 'floating');
            }
        } else if (prop === 'pipCorner' || prop === 'pipWidthPct' || prop === 'pipHeightPct') {
            this._safeRun('repositionPipWindows', () => this._repositionAllPipWindows());
        } else if (prop === 'autoTilingEnabled') {
            for (let st of this._states.values()) {
                st.autoTile = Boolean(value) && (st.layoutId !== 'floating');
                if (st.autoTile && st.layoutId === 'floating') {
                    st.layoutId = (this.settings.defaultLayout && this.settings.defaultLayout !== 'floating')
                        ? this.settings.defaultLayout
                        : 'dwindle';
                }
            }
        } else if (prop === 'masterRatioPct') {
            let ratio = Layouts.clamp((value || 55) / 100.0, 0.15, 0.85);
            for (let st of this._states.values()) {
                st.masterRatio = ratio;
            }
        } else if (prop === 'masterCount') {
            let count = Layouts.clamp(value || 1, 1, 6);
            for (let st of this._states.values()) {
                st.masterCount = count;
            }
        } else if (prop === 'masterOrientation') {
            let orient = value || 'left';
            for (let st of this._states.values()) {
                st.masterOrientation = orient;
            }
        } else if (prop === 'centeredMasterRatioPct') {
            let ratio = Layouts.clamp((value || 50) / 100.0, 0.25, 0.75);
            for (let st of this._states.values()) {
                st.centeredMasterRatio = ratio;
                st.centeredLeftRatio = null;
                st.centeredRightRatio = null;
            }
        }
    }

    _syncExtSetting(prop, value) {
        let schemaKey = PROP_TO_SCHEMA_KEY.get(prop);
        if (!this.extSettings || !schemaKey) return;
        this._isSavingSettings = true;
        try {
            this.extSettings.setValue(schemaKey, value);
        } catch (e) {
            // ignore if key is unavailable in settings schema
        } finally {
            this._isSavingSettings = false;
        }
    }

    _initSettings() {
        try {
            this.extSettings = new Settings.ExtensionSettings(this.settings, this.uuid);
        } catch (e) {
            global.logError(`[${this.uuid}] Failed to initialize ExtensionSettings: ${e}`);
            return;
        }

        for (let [key, prop] of VISUAL_SETTINGS_MAP) {
            this.extSettings.bind(key, prop, () => {
                if (!this._isSavingSettings) {
                    this._applySettingSideEffects(prop, this.settings[prop]);
                    this._savePersistedStates();
                }
                this._syncPanelIndicatorVisibility();
                this.queueRetile();
                if (this.activeBorder) this.activeBorder.sync();
                if (!this._isSavingSettings) {
                    this._emitIpcStateChanged('setting-changed');
                }
            });
        }

        for (let [key, prop] of Keybindings.KEYBINDING_SETTINGS_MAP) {
            this.extSettings.bind(key, prop, () => {
                if (!this._isSavingSettings && this.keybindings) {
                    this.keybindings.register();
                }
            });
        }
    }

    updateSettingValue(prop, value) {
        this._isSavingSettings = true;
        try {
            this.settings[prop] = value;
        } finally {
            this._isSavingSettings = false;
        }

        this._syncExtSetting(prop, value);
        this._applySettingSideEffects(prop, value);
        if (prop.startsWith('kb') && this.keybindings) {
            this.keybindings.register();
        }

        this._savePersistedStates();
        this._syncPanelIndicatorVisibility();
        this.queueRetile(true);
        if (this.activeBorder) this.activeBorder.sync();
        this._emitIpcStateChanged('setting-updated');
    }

    importSettingsSnapshot(newSettingsObj) {
        if (!newSettingsObj || typeof newSettingsObj !== 'object') return false;
        let updatedProps = [];
        this._isSavingSettings = true;
        try {
            for (let [k, v] of Object.entries(newSettingsObj)) {
                if (Object.prototype.hasOwnProperty.call(this.settings, k) &&
                    typeof v === typeof this.settings[k]) {
                    this.settings[k] = v;
                    updatedProps.push(k);
                }
            }
        } finally {
            this._isSavingSettings = false;
        }

        for (let prop of updatedProps) {
            this._syncExtSetting(prop, this.settings[prop]);
        }
        for (let prop of updatedProps) {
            this._applySettingSideEffects(prop, this.settings[prop]);
        }

        if (this.keybindings) {
            this.keybindings.register();
        }
        this._savePersistedStates();
        this._syncPanelIndicatorVisibility();
        this.queueRetile(true);
        if (this.activeBorder) this.activeBorder.sync();
        this._emitIpcStateChanged('settings-imported');
        if (this.osd) {
            this.osd.show('✔', _('Configuration Imported'), _('All preferences and shortcuts restored'));
        }
        return true;
    }

    openSettingsDialog(section = null) {
        if (!this.meta || !this.meta.path) {
            global.logError(`[${this.uuid}] Cannot open settings dialog: missing extension path`);
            return;
        }
        let scriptPath = GLib.build_filenamev([this.meta.path, 'settings-window.py']);
        if (!GLib.file_test(scriptPath, GLib.FileTest.EXISTS)) {
            global.logError(`[${this.uuid}] Settings script not found at ${scriptPath}`);
            return;
        }
        try {
            let argv = ['python3', scriptPath];
            if (section && typeof section === 'string') {
                argv.push(section);
            }
            GLib.spawn_async(
                this.meta.path,
                argv,
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
        } catch (e) {
            global.logError(`[${this.uuid}] Failed to launch GTK settings window: ${e}`);
        }
    }

    _syncPanelIndicatorVisibility() {
        if (this.panelIndicator) {
            this.panelIndicator.syncVisibility();
        }
    }

    _updatePanelIndicator() {
        if (this.panelIndicator) {
            this.panelIndicator.update();
        }
    }

    _initButtonLayoutSync() {
        try {
            this._wmPrefsSettings = new Gio.Settings({ schema_id: 'org.cinnamon.desktop.wm.preferences' });
        } catch (e) {
            this._wmPrefsSettings = null;
            return;
        }

        let currentVal = this._wmPrefsSettings.get_string('button-layout') || ':minimize,maximize,close';
        if (typeof this._originalButtonLayout !== 'string') {
            this._originalButtonLayout = currentVal;
            this._savePersistedStates();
        }

        this._signals.connect(this._wmPrefsSettings, 'changed::button-layout', () => {
            if (this._isSyncingButtonLayout || !this._enabled || !this._wmPrefsSettings) return;
            let externalVal = this._wmPrefsSettings.get_string('button-layout') || '';
            if (externalVal === this._lastAppliedButtonLayout) return;
            this._originalButtonLayout = externalVal;
            this._lastAppliedButtonLayout = null;
            this._savePersistedStates();
            this._syncWindowMaximizeButton();
        });
    }

    _setWmButtonLayout(targetLayout) {
        if (!this._wmPrefsSettings || typeof targetLayout !== 'string') return;
        let current = this._wmPrefsSettings.get_string('button-layout');
        if (current === targetLayout) {
            this._lastAppliedButtonLayout = targetLayout;
            return;
        }
        this._isSyncingButtonLayout = true;
        try {
            this._lastAppliedButtonLayout = targetLayout;
            this._wmPrefsSettings.set_string('button-layout', targetLayout);
        } catch (e) {
            global.logError(`[${this.uuid}] Failed to update window button-layout: ${e}`);
        } finally {
            this._isSyncingButtonLayout = false;
        }
    }

    _syncWindowMaximizeButton() {
        if (!this._enabled || !this._wmPrefsSettings) return;
        if (typeof this._originalButtonLayout !== 'string') {
            this._originalButtonLayout = this._wmPrefsSettings.get_string('button-layout') || ':minimize,maximize,close';
        }
        let state = this.getCurrentState();
        let isFloating = !state || !state.autoTile || state.layoutId === 'floating';
        let target = isFloating
            ? this._originalButtonLayout
            : WindowRules.stripMaximizeFromButtonLayout(this._originalButtonLayout);
        this._setWmButtonLayout(target);
    }

    _restoreButtonLayout() {
        if (!this._wmPrefsSettings) return;
        if (typeof this._originalButtonLayout === 'string') {
            this._setWmButtonLayout(this._originalButtonLayout);
            this._originalButtonLayout = null;
        }
        this._lastAppliedButtonLayout = null;
    }

    _connectGlobalSignals() {
        this._signals.connect(global.display, 'window-created', (display, metaWindow) => {
            this._trackWindow(metaWindow, false);
        });

        this._signals.connect(global.display, 'notify::focus-window', () => {
            this._onFocusWindowChanged();
        });

        this._signals.connect(global.display, 'grab-op-begin', (...args) => {
            let { window, op } = GrabControllerModule.parseGrabOpArgs(args);
            this.grabController.onGrabOpBegin(window, op);
        });

        this._signals.connect(global.display, 'grab-op-end', (...args) => {
            let { window, op } = GrabControllerModule.parseGrabOpArgs(args);
            this.grabController.onGrabOpEnd(window, op);
        });

        this._signals.connect(global.display, 'workareas-changed', () => {
            this.queueRetile();
        });

        this._signals.connect(global.display, 'in-fullscreen-changed', () => {
            if (this.activeBorder) this.activeBorder.sync();
        });

        this._signals.connect(global.workspace_manager, 'active-workspace-changed', () => {
            this._updatePanelIndicator();
            this.queueRetile();
            if (this.activeBorder) this.activeBorder.sync();
            this._emitIpcStateChanged('workspace-changed');
        });

        this._signals.connect(global.workspace_manager, 'showing-desktop-changed', () => {
            this._onShowingDesktopChanged();
        });

        this._signals.connect(Main.layoutManager, 'monitors-changed', () => {
            this.queueRetile();
        });

        if (Main.overview) {
            this._signals.connect(Main.overview, 'showing', () => {
                if (this.activeBorder) this.activeBorder.hide();
            });
            this._signals.connect(Main.overview, 'hidden', () => {
                if (this.activeBorder) this.activeBorder.sync();
            });
        }

        if (Main.expo) {
            this._signals.connect(Main.expo, 'showing', () => {
                if (this.activeBorder) this.activeBorder.hide();
            });
            this._signals.connect(Main.expo, 'hidden', () => {
                if (this.activeBorder) this.activeBorder.sync();
            });
        }
    }

    _onShowingDesktopChanged() {
        this.queueRetile();
        this._schedulePostUnminimizeSettle();
        if (this.activeBorder) {
            this.activeBorder.sync();
        }
        this._updatePanelIndicator();
    }

    _trackWindow(metaWindow, isInitialScan = false) {
        if (!metaWindow) return;
        let winId = metaWindow.get_stable_sequence();
        if (this._windowSignals.has(winId)) return;

        try {
            let xid = typeof metaWindow.get_xwindow === 'function' ? metaWindow.get_xwindow() : 0;
            if (xid) this._winIdToXid.set(winId, xid);
        } catch (e) {
            // Ignore errors on non-X11 or transient windows
        }

        let hooks = [];
        const connectWin = (sig, cb) => {
            let id = metaWindow.connect(sig, () => {
                if (!this._enabled) return;
                this._safeRun(`window:${sig}`, cb);
            });
            hooks.push({ obj: metaWindow, id });
        };

        connectWin('unmanaging', () => {
            this._onWindowClosed(metaWindow);
        });
        connectWin('workspace-changed', () => {
            this.queueRetile();
        });
        connectWin('monitor-changed', () => {
            this.queueRetile();
        });
        connectWin('notify::minimized', () => {
            this.queueRetile();
            if (!metaWindow.minimized) {
                this._schedulePostUnminimizeSettle();
            }
            if (this.activeBorder) this.activeBorder.sync();
        });
        connectWin('notify::fullscreen', () => {
            this.queueRetile();
            if (this.activeBorder) this.activeBorder.sync();
        });
        connectWin('notify::maximized-horizontally', () => {
            if (!this._isApplyingLayout) this.queueRetile();
        });
        connectWin('notify::maximized-vertically', () => {
            if (!this._isApplyingLayout) this.queueRetile();
        });
        connectWin('notify::window-type', () => {
            WindowRules.recheckLatePopupOrDialog(this, metaWindow, isInitialScan);
        });
        connectWin('notify::title', () => {
            WindowRules.recheckLatePopupOrDialog(this, metaWindow, isInitialScan);
        });
        connectWin('size-changed', () => {
            if (this._isApplyingLayout || this._grabState) return;
            let ws = metaWindow.get_workspace();
            if (!ws) return;
            let st = this.getState(ws.index(), metaWindow.get_monitor());
            if (!st.autoTile || st.layoutId === 'floating') return;
            let tr = st.lastRects.get(winId);
            if (!tr) return;
            let fr = metaWindow.get_frame_rect();
            let tw = Math.round(tr.width);
            let th = Math.round(tr.height);
            if (fr.width < tw - 1 || fr.height < th - 1) {
                WindowRules.clearX11ResizeIncrements(this, metaWindow);
                this._schedulePostRetileSettle();
            } else if (fr.width > tw + 1 || fr.height > th + 1) {
                this._schedulePostRetileSettle();
            }
        });

        this._windowSignals.set(winId, hooks);

        let evalRes = WindowRules.evaluateWindow(metaWindow, this.settings, this.manualFloating, this.manualTiled);
        if (!isInitialScan && evalRes.targetWorkspace !== null) {
            try {
                let nWs = global.workspace_manager.get_n_workspaces();
                if (evalRes.targetWorkspace < nWs) {
                    metaWindow.change_workspace_by_index(evalRes.targetWorkspace, false);
                }
            } catch (e) {
                global.logError(`[${this.uuid}] Failed to move window to workspace ${evalRes.targetWorkspace}: ${e}`);
            }
        }
        if (evalRes.scratchpad && this.scratchpad) {
            this.scratchpad.registerWindow(metaWindow, false);
            return;
        }

        if (evalRes.shouldTile) {
            if (!this.savedFloatingRects.has(winId)) {
                let r = metaWindow.get_frame_rect();
                if (r.width > 50 && r.height > 50) {
                    this.savedFloatingRects.set(winId, { x: r.x, y: r.y, width: r.width, height: r.height });
                }
            }
            let wsIdx = metaWindow.get_workspace() ? metaWindow.get_workspace().index() : global.workspace_manager.get_active_workspace_index();
            let monIdx = metaWindow.get_monitor();
            let state = this.getState(wsIdx, monIdx);
            if (state.autoTile && state.layoutId !== 'floating') {
                WindowRules.clearX11ResizeIncrements(this, metaWindow);
            }
            if (!state.windowOrder.includes(winId)) {
                let placement = this.settings.masterNewWindowPlacement || 'stack-end';
                if (!isInitialScan && state.layoutId === 'master-stack' && placement === 'master') {
                    state.windowOrder.unshift(winId);
                    if (Array.isArray(state.fullWindowOrder) && !state.fullWindowOrder.includes(winId)) {
                        state.fullWindowOrder.unshift(winId);
                    }
                } else if (!isInitialScan && state.layoutId === 'master-stack' && placement === 'stack-top') {
                    let insertAt = Math.min(state.windowOrder.length, state.masterCount || 1);
                    state.windowOrder.splice(insertAt, 0, winId);
                    if (Array.isArray(state.fullWindowOrder) && !state.fullWindowOrder.includes(winId)) {
                        let fullInsertAt = Math.min(state.fullWindowOrder.length, state.masterCount || 1);
                        state.fullWindowOrder.splice(fullInsertAt, 0, winId);
                    }
                } else {
                    state.windowOrder.push(winId);
                    if (Array.isArray(state.fullWindowOrder) && !state.fullWindowOrder.includes(winId)) {
                        state.fullWindowOrder.push(winId);
                    }
                }
            }
            if (!isInitialScan && (!state.autoTile || state.layoutId === 'floating') && this.settings.floatingCenterNewWindows) {
                let wRatio = Layouts.clamp((this.settings.floatingCenterWidthPct || 70) / 100.0, 0.35, 0.95);
                let hRatio = Layouts.clamp((this.settings.floatingCenterHeightPct || 72) / 100.0, 0.35, 0.95);
                this.centerWindowOnMonitor(metaWindow, wRatio, hRatio);
            }
        } else if (!isInitialScan && WindowRules.isPopupOrDialogWindow(metaWindow)) {
            WindowRules.arrangePopupOrDialogWindow(metaWindow, false);
        }

        if (!isInitialScan) {
            this._addTimeout(35, () => {
                if (!this._enabled || !this._windowSignals.has(winId)) return GLib.SOURCE_REMOVE;
                if (!WindowRules.recheckLatePopupOrDialog(this, metaWindow, false)) {
                    if (WindowRules.isPopupOrDialogWindow(metaWindow) && !this.manualTiled.has(winId)) {
                        WindowRules.arrangePopupOrDialogWindow(metaWindow, false);
                    }
                    this.queueRetile(true);
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _untrackWindowById(winId) {
        let hooks = this._windowSignals.get(winId);
        if (hooks) {
            for (let h of hooks) {
                try {
                    h.obj.disconnect(h.id);
                } catch (e) {
                    // ignore
                }
            }
            this._windowSignals.delete(winId);
        }
    }

    _onWindowClosed(metaWindow) {
        if (!metaWindow) return;
        let winId = metaWindow.get_stable_sequence();
        this._untrackWindowById(winId);

        let xid = this._winIdToXid.get(winId) || 0;
        this._winIdToXid.delete(winId);
        if (!xid) {
            try {
                xid = typeof metaWindow.get_xwindow === 'function' ? metaWindow.get_xwindow() : 0;
            } catch (e) {
                xid = 0;
            }
        }
        if (xid) {
            this._clearedResizeIncXids.delete(xid);
            this._pendingResizeIncXids.delete(xid);
            this._resizeIncQueue.delete(xid);
        }

        if (this._grabState && this._grabState.winId === winId) {
            this._stopDragPolling();
            this._grabState = null;
        }

        this.manualFloating.delete(winId);
        this.manualTiled.delete(winId);
        this.savedFloatingRects.delete(winId);
        this.pipWindows.delete(winId);
        this._pipPrevState.delete(winId);
        this._windowMinSizes.delete(winId);
        if (this.scratchpad) {
            this.scratchpad.onWindowClosed(winId);
        }

        for (let state of this._states.values()) {
            Layouts.onWindowClosedStateCleanup(state, winId, this.settings);
        }

        this.queueRetile();
    }

    _onFocusWindowChanged() {
        let focusWin = global.display.focus_window;
        if (focusWin) {
            let winId = focusWin.get_stable_sequence();
            let ws = focusWin.get_workspace();
            if (ws) {
                let wsIdx = ws.index();
                let monIdx = focusWin.get_monitor();
                let state = this.getState(wsIdx, monIdx);
                if (state.windowOrder.includes(winId)) {
                    let changedFocus = (state.focusedId !== winId);
                    if (changedFocus) {
                        state.lastFocusedId = state.focusedId;
                        state.focusedId = winId;
                    }
                    let tabGrp = Layouts.findTabGroupForWindow(state, winId);
                    if (tabGrp && state.activeTabMap) {
                        state.activeTabMap.set(tabGrp[0], winId);
                    }
                    if (state.layoutId === 'scrolling' && state.autoTile) {
                        this.queueRetile();
                    }
                    if (changedFocus && state.autoTile) {
                        this._showStackPositionOsd(state, focusWin, wsIdx, monIdx);
                    }
                }
            }
        }
        if (this.activeBorder) {
            this.activeBorder.attachToWindow(focusWin);
        }
        this._syncWindowMaximizeButton();
        this._updatePanelIndicator();
    }

    getStateKey(wsIndex, monitorIndex) {
        return `${wsIndex}:${monitorIndex}`;
    }

    _loadPersistedStates() {
        StateStore.loadPersistedStates(this);
    }

    _savePersistedStates() {
        StateStore.savePersistedStates(this);
    }

    getState(wsIndex, monitorIndex) {
        let key = this.getStateKey(wsIndex, monitorIndex);
        if (!this._states.has(key)) {
            this._states.set(key, new StateStore.WorkspaceMonitorState(this.settings, wsIndex));
        }
        return this._states.get(key);
    }

    getCurrentState() {
        let wsIdx = global.workspace_manager.get_active_workspace_index();
        let focusWin = global.display.focus_window;
        let monIdx = focusWin ? focusWin.get_monitor() : global.display.get_current_monitor();
        return this.getState(wsIdx, monIdx);
    }

    /**
     * Single-pass collector returning visible, minimized, and fullscreen tileable Meta.Windows on (wsIndex, monitorIndex).
     */
    getTileableWindowSets(wsIndex, monitorIndex) {
        let visibleMap = new Map();
        let minimizedSet = new Set();
        let fullscreenSet = new Set();
        let hiddenMap = new Map();
        let actors = Meta.get_window_actors(global.display);

        for (let actor of actors) {
            let mw = actor.get_meta_window();
            if (!mw) continue;

            let winId = mw.get_stable_sequence();
            if ((this.scratchpad && this.scratchpad.has(winId)) ||
                (this.pipWindows && this.pipWindows.has(winId))) {
                continue;
            }
            let ws = mw.get_workspace();
            if (!ws || ws.index() !== wsIndex) {
                continue;
            }
            if (mw.get_monitor() !== monitorIndex) {
                continue;
            }

            let evalRes = WindowRules.evaluateWindow(mw, this.settings, this.manualFloating, this.manualTiled);
            if (!evalRes.shouldTile) {
                continue;
            }

            let isFullscreen = mw.is_fullscreen();
            let isHiddenByDesktopOrMin = mw.minimized ||
                (typeof mw.showing_on_its_workspace === 'function' && !mw.showing_on_its_workspace());

            if (isFullscreen) {
                fullscreenSet.add(winId);
                hiddenMap.set(winId, mw);
            } else if (isHiddenByDesktopOrMin) {
                minimizedSet.add(winId);
                hiddenMap.set(winId, mw);
            } else {
                visibleMap.set(winId, mw);
            }
        }
        return { visibleMap, minimizedSet, fullscreenSet, hiddenMap };
    }

    /**
     * Returns all currently visible tileable Meta.Windows on (wsIndex, monitorIndex)
     */
    getTileableWindowsMap(wsIndex, monitorIndex) {
        return this.getTileableWindowSets(wsIndex, monitorIndex).visibleMap;
    }

    /**
     * Returns the Set of window stable sequences on (wsIndex, monitorIndex) that are tileable
     * but currently minimized or hidden by Show Desktop (Super+D).
     */
    getMinimizedTileableWindowsSet(wsIndex, monitorIndex) {
        return this.getTileableWindowSets(wsIndex, monitorIndex).minimizedSet;
    }

    isSingleTiledWindowOnMonitor(metaWindow) {
        if (!metaWindow || !metaWindow.get_workspace()) return false;
        let wsIdx = metaWindow.get_workspace().index();
        let monIdx = metaWindow.get_monitor();
        let state = this.getState(wsIdx, monIdx);
        if (!state.autoTile || state.layoutId === 'floating') return false;
        let map = this.getTileableWindowsMap(wsIdx, monIdx);
        return map.size === 1 && map.has(metaWindow.get_stable_sequence());
    }

    queueRetile(immediate = false) {
        if (this._retileTimeoutId) {
            GLib.source_remove(this._retileTimeoutId);
            this._retileTimeoutId = 0;
        }

        if (immediate) {
            this._safeRun('retileActiveWorkspace', () => this.retileActiveWorkspace());
            return;
        }

        this._retileTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 18, () => {
            this._retileTimeoutId = 0;
            if (!this._enabled) return GLib.SOURCE_REMOVE;
            this._safeRun('retileActiveWorkspace', () => this.retileActiveWorkspace());
            return GLib.SOURCE_REMOVE;
        });
    }

    retileActiveWorkspace() {
        if (this._grabState) {
            if (!this._grabState.usePreviewResize &&
                typeof global.display.get_grab_op === 'function' &&
                global.display.get_grab_op() === Meta.GrabOp.NONE) {
                this._stopDragPolling();
                this._grabState = null;
            } else {
                return;
            }
        }

        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs) return;
        let wsIdx = activeWs.index();
        let nMonitors = Main.layoutManager.monitors.length;

        let needsPostRetileSettle = false;
        let needsPostUnminimizeSettle = false;

        this._isApplyingLayout = true;
        try {
            for (let monIdx = 0; monIdx < nMonitors; monIdx++) {
                let res = this._retileMonitor(activeWs, wsIdx, monIdx);
                if (res) {
                    if (res.needsPostRetileSettle) needsPostRetileSettle = true;
                    if (res.needsPostUnminimizeSettle) needsPostUnminimizeSettle = true;
                }
            }
        } finally {
            this._isApplyingLayout = false;
        }

        if (needsPostUnminimizeSettle) {
            this._schedulePostUnminimizeSettle();
        }
        if (needsPostRetileSettle) {
            this._schedulePostRetileSettle();
        }

        if (this.activeBorder) {
            this.activeBorder.sync();
        }
        this._syncWindowMaximizeButton();
        this._updatePanelIndicator();
    }

    _retileMonitor(workspace, wsIdx, monIdx) {
        let state = this.getState(wsIdx, monIdx);
        let {
            visibleMap: tileableMap,
            minimizedSet,
            fullscreenSet,
            hiddenMap
        } = this.getTileableWindowSets(wsIdx, monIdx);

        let allCandidateMap = new Map(tileableMap);
        for (let [id, mw] of hiddenMap.entries()) {
            allCandidateMap.set(id, mw);
        }

        let prunedOrder = [];
        let weightRefOrder = null;
        if (state.pendingWindowKeys && allCandidateMap.size > 0) {
            let currentKeys = StateStore.buildWindowPersistenceKeys(Array.from(allCandidateMap.entries()));
            let idsByKey = new Map(Array.from(currentKeys.entries()).map(([id, key]) => [key, id]));
            let fullOrder = [];
            for (let key of state.pendingWindowKeys) {
                let id = idsByKey.get(key);
                if (id !== undefined && !fullOrder.includes(id)) fullOrder.push(id);
            }
            for (let id of allCandidateMap.keys()) {
                if (!fullOrder.includes(id)) fullOrder.push(id);
            }
            state.pendingWindowKeys = null;
            state.fullWindowOrder = fullOrder;
            prunedOrder = fullOrder.filter(id => tileableMap.has(id));
            state.windowOrder = prunedOrder;
            state._hadMinimizedWindows = minimizedSet.size > 0;
            state._hadHiddenWindows = (minimizedSet.size + fullscreenSet.size) > 0;
            weightRefOrder = fullOrder;
            if (Array.isArray(state.pendingTabGroups)) {
                let restoredGroups = [];
                for (let keyGrp of state.pendingTabGroups) {
                    if (!Array.isArray(keyGrp)) continue;
                    let mappedGrp = keyGrp.map(k => idsByKey.get(k)).filter(id => id !== undefined);
                    if (mappedGrp.length >= 2) {
                        restoredGroups.push(mappedGrp);
                    }
                }
                state.tabGroups = restoredGroups;
                state.pendingTabGroups = null;
            }
        } else {
            prunedOrder = Layouts.syncWindowOrderWithMinimized(
                state,
                Array.from(tileableMap.keys()),
                Array.from(minimizedSet),
                Array.from(fullscreenSet)
            );
            weightRefOrder = prunedOrder;
        }

        if (weightRefOrder && weightRefOrder.length > 0) {
            for (let [pendingKey, mapKey] of [['pendingWeights', 'weights'], ['pendingColWeights', 'colWeights']]) {
                let pending = state[pendingKey];
                if (!pending) continue;
                let map = state[mapKey];
                map.clear();
                for (let pair of pending) {
                    if (Array.isArray(pair) && Number.isInteger(pair[0]) && pair[0] >= 0 && pair[0] < weightRefOrder.length && Number.isFinite(pair[1]))
                        map.set(weightRefOrder[pair[0]], pair[1]);
                }
                state[pendingKey] = null;
            }
            if (state.pendingGridRowWeights) {
                state.gridRowWeights = new Map(state.pendingGridRowWeights.filter(pair => Array.isArray(pair) && Number.isInteger(pair[0]) && Number.isFinite(pair[1])));
                state.pendingGridRowWeights = null;
            }
        }

        if (!state.autoTile || state.layoutId === 'floating' || prunedOrder.length === 0) {
            state.lastRects.clear();
            return;
        }

        let focusWin = global.display.focus_window;
        if (focusWin && tileableMap.has(focusWin.get_stable_sequence())) {
            state.focusedId = focusWin.get_stable_sequence();
        } else if (!state.focusedId || !tileableMap.has(state.focusedId)) {
            if (state.savedFocusedId && tileableMap.has(state.savedFocusedId)) {
                state.focusedId = state.savedFocusedId;
            } else {
                state.focusedId = prunedOrder[0];
            }
        }

        let prevCount = state.lastRects ? state.lastRects.size : 0;
        let workarea = workspace.get_work_area_for_monitor(monIdx);
        let rectsMap = Layouts.computeLayoutRects(state.layoutId, prunedOrder, workarea, state, this.settings, this._windowMinSizes);
        state.lastRects = rectsMap;

        if (prevCount > 0 && prevCount !== rectsMap.size && !state._justRestoredFromMinimize) {
            let focusedMw = tileableMap.get(state.focusedId);
            if (focusedMw) {
                this._showStackPositionOsd(state, focusedMw, wsIdx, monIdx);
            }
        }

        for (let [winId, targetRect] of rectsMap.entries()) {
            let mw = tileableMap.get(winId);
            if (!mw) continue;
            WindowRules.clearX11ResizeIncrements(this, mw);
            this._applyWindowRect(mw, targetRect);
        }

        let needsPostUnminimizeSettle = false;
        if (state._justRestoredFromMinimize) {
            state._justRestoredFromMinimize = false;
            needsPostUnminimizeSettle = true;
        }

        // Follow-up post-resize checks are debounced once across monitors by retileActiveWorkspace()
        let needsPostRetileSettle = true;

        // Ensure proper Z-order for overlapping layouts (Scrolling offscreen peek columns, Monocle deck, & Stacked cells)
        // while preserving any floating, dialog, transient, or file-chooser windows above tiled windows.
        let raisedAnyTiled = false;
        let floatingAboveToRestore = [];
        let popupDialogsToRaise = [];
        let actorsBefore = Meta.get_window_actors(global.display);
        let seenAnyTiled = false;
        for (let actor of actorsBefore) {
            let mw = actor.get_meta_window();
            if (!mw || mw.minimized) continue;
            if (typeof mw.showing_on_its_workspace === 'function' && !mw.showing_on_its_workspace()) continue;
            let mwWs = mw.get_workspace();
            let parentWin = mw.get_transient_for();
            let parentWs = parentWin ? parentWin.get_workspace() : null;
            let onThisWs = (mwWs && mwWs.index() === wsIdx) ||
                           (parentWs && parentWs.index() === wsIdx) ||
                           mw.is_on_all_workspaces();
            if (!onThisWs) continue;
            let effMon = parentWin ? parentWin.get_monitor() : mw.get_monitor();
            if (effMon !== monIdx && mw.get_monitor() !== monIdx) continue;

            let id = mw.get_stable_sequence();
            if (tileableMap.has(id)) {
                seenAnyTiled = true;
            } else {
                let wType = mw.get_window_type();
                if (wType === Meta.WindowType.DESKTOP ||
                    wType === Meta.WindowType.DOCK ||
                    mw.is_override_redirect()) {
                    continue;
                }
                let isPopupDialog = WindowRules.isPopupOrDialogWindow(mw);
                if (isPopupDialog) {
                    if (seenAnyTiled || mw === focusWin || parentWin !== null || wType !== Meta.WindowType.NORMAL) {
                        popupDialogsToRaise.push(mw);
                    }
                } else if (wType === Meta.WindowType.NORMAL && (seenAnyTiled || mw === focusWin)) {
                    floatingAboveToRestore.push(mw);
                }
            }
        }

        if (state.layoutId === 'scrolling') {
            for (let [winId, targetRect] of rectsMap.entries()) {
                let mw = tileableMap.get(winId);
                if (mw && !targetRect.offscreen && winId !== state.focusedId) {
                    if (WindowRules.safeRaiseWindow(mw)) raisedAnyTiled = true;
                }
            }
            let focusedMw = tileableMap.get(state.focusedId);
            if (focusedMw && WindowRules.safeRaiseWindow(focusedMw)) {
                raisedAnyTiled = true;
            }
        } else if (state.layoutId === 'monocle') {
            let focusedMw = tileableMap.get(state.focusedId);
            if (focusedMw && WindowRules.safeRaiseWindow(focusedMw)) {
                raisedAnyTiled = true;
            }
        } else {
            if (Array.isArray(state.tabGroups) && state.tabGroups.length > 0 && state.activeTabMap) {
                for (let grp of state.tabGroups) {
                    if (!Array.isArray(grp) || grp.length < 2) continue;
                    let activeTabId = state.activeTabMap.get(grp[0]) || grp[0];
                    let activeTabMw = tileableMap.get(activeTabId);
                    if (activeTabMw && WindowRules.safeRaiseWindow(activeTabMw)) {
                        raisedAnyTiled = true;
                    }
                }
            }
            let focusedRect = rectsMap.get(state.focusedId);
            if (focusedRect && focusedRect.stacked) {
                let focusedMw = tileableMap.get(state.focusedId);
                if (focusedMw && WindowRules.safeRaiseWindow(focusedMw)) {
                    raisedAnyTiled = true;
                }
            }
        }

        if (floatingAboveToRestore.length > 0 && raisedAnyTiled) {
            for (let fw of floatingAboveToRestore) {
                WindowRules.safeRaiseWindow(fw);
            }
        }

        if (popupDialogsToRaise.length > 0) {
            for (let pw of popupDialogsToRaise) {
                WindowRules.safeRaiseWindow(pw);
            }
        }

        return {
            needsPostRetileSettle,
            needsPostUnminimizeSettle
        };
    }

    /**
     * Returns true if Cinnamon's WindowManager is currently running a minimize, unminimize,
     * map, or size-change Clutter animation on `actor`.
     */
    _isActorAnimatingInWm(actor) {
        if (!actor || !Main || !Main.wm) return false;
        let wm = Main.wm;
        return Boolean(
            (wm._unminimizing && wm._unminimizing.has(actor)) ||
            (wm._minimizing && wm._minimizing.has(actor)) ||
            (wm._mapping && wm._mapping.has(actor))
        );
    }

    _cancelTimeoutIds(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return;
        for (let id of ids) {
            if (this._pendingTimeouts && this._pendingTimeouts.has(id)) {
                this._pendingTimeouts.delete(id);
                GLib.source_remove(id);
            }
        }
        ids.length = 0;
    }

    _scheduleSettleTimers(idsProp, delays, finalThreshold, reconcileActorGeometry = false) {
        this._cancelTimeoutIds(this[idsProp]);
        for (let delayMs of delays) {
            let isFinalPass = (delayMs >= finalThreshold);
            let tid = this._addTimeout(delayMs, () => {
                this[idsProp] = this[idsProp].filter(x => x !== tid);
                this._verifyAndSettleWindowRects(isFinalPass, reconcileActorGeometry);
                return GLib.SOURCE_REMOVE;
            });
            this[idsProp].push(tid);
        }
    }

    /**
     * Schedules short follow-up checks after a tiling pass so X11 clients that asynchronously
     * snap to character-cell increments (e.g. Gnome-terminal ~10ms after ConfigureNotify) or
     * enforce X11 minimum widths (e.g. Chromium) are settled to exact pixel gaps.
     */
    _schedulePostRetileSettle() {
        this._scheduleSettleTimers('_postRetileSettleIds', [22, 65], 60, false);
    }

    /**
     * Schedules follow-up verification passes after windows unminimize or exit Show Desktop (Super+D)
     * so that once Cinnamon's MAP_ANIMATION_TIME unminimize transition finishes, every window frame
     * and Clutter actor is settled at its exact layout coordinates.
     */
    _schedulePostUnminimizeSettle() {
        this._scheduleSettleTimers('_postUnminimizeSettleIds', [55, 140, 260, 380], 200, true);
    }

    _verifyAndSettleWindowRects(isFinalPass = false, reconcileActorGeometry = false) {
        if (this._isApplyingLayout || this._grabState || !this._states) return;
        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs) return;
        let wsIdx = activeWs.index();
        let nMonitors = Main.layoutManager.monitors.length;
        let needsFullRetile = false;

        this._isApplyingLayout = true;
        try {
            for (let monIdx = 0; monIdx < nMonitors; monIdx++) {
                let state = this.getState(wsIdx, monIdx);
                if (!state.autoTile || state.layoutId === 'floating') continue;
                let tileableMap = this.getTileableWindowsMap(wsIdx, monIdx);
                if (tileableMap.size > 0 && state.lastRects.size !== tileableMap.size) {
                    needsFullRetile = true;
                    continue;
                }
                if (state.lastRects.size === 0) continue;

                for (let [winId, targetRect] of state.lastRects.entries()) {
                    let mw = tileableMap.get(winId);
                    if (!mw) continue;
                    let actor = (typeof mw.get_compositor_private === 'function')
                        ? mw.get_compositor_private()
                        : null;
                    if (actor && this._isActorAnimatingInWm(actor)) {
                        continue;
                    }

                    let actual = mw.get_frame_rect();
                    let tw = Math.round(targetRect.width);
                    let th = Math.round(targetRect.height);
                    let tx = Math.round(targetRect.x);
                    let ty = Math.round(targetRect.y);

                    if (actual.width > tw + 1 || actual.height > th + 1) {
                        let xid = (typeof mw.get_xwindow === 'function') ? mw.get_xwindow() : 0;
                        if (!isFinalPass || (xid && !this._clearedResizeIncXids.has(xid))) {
                            WindowRules.clearX11ResizeIncrements(this, mw);
                            this._applyWindowRect(mw, targetRect);
                            continue;
                        }
                        if (state.layoutId !== 'monocle' && state.layoutId !== 'scrolling' &&
                            state.lastRects.size >= 2 &&
                            (actual.width > tw + 4 || actual.height > th + 4)) {
                            let workarea = activeWs.get_work_area_for_monitor(monIdx);
                            let maxMinW = Math.max(700, Math.round(workarea.width * 0.85));
                            let maxMinH = Math.max(600, Math.round(workarea.height * 0.85));
                            let prev = this._windowMinSizes.get(winId) || { minW: 60, minH: 60 };
                            let nextMinW = (actual.width > tw + 4 && actual.width <= maxMinW)
                                ? Math.max(prev.minW, actual.width)
                                : prev.minW;
                            let nextMinH = (actual.height > th + 4 && actual.height <= maxMinH)
                                ? Math.max(prev.minH, actual.height)
                                : prev.minH;
                            if (nextMinW !== prev.minW || nextMinH !== prev.minH) {
                                this._windowMinSizes.set(winId, { minW: nextMinW, minH: nextMinH });
                                needsFullRetile = true;
                                continue;
                            }
                        }
                    }

                    if (actual.width < tw - 1 || actual.height < th - 1 ||
                        Math.abs(actual.x - tx) > 1 || Math.abs(actual.y - ty) > 1) {
                        WindowRules.clearX11ResizeIncrements(this, mw);
                        this._applyWindowRect(mw, targetRect);
                    }

                    if (reconcileActorGeometry && actor && typeof mw.get_buffer_rect === 'function') {
                        let isResizingInWm = Boolean(Main && Main.wm && Main.wm._resizing && Main.wm._resizing.has(actor));
                        if (!isResizingInWm) {
                            let buf = mw.get_buffer_rect();
                            if (Math.abs(actor.x - buf.x) > 1 || Math.abs(actor.y - buf.y) > 1) {
                                actor.set_position(buf.x, buf.y);
                            }
                            if (Math.abs(actor.scale_x - 1) > 0.001 || Math.abs(actor.scale_y - 1) > 0.001) {
                                actor.set_scale(1.0, 1.0);
                            }
                            if (Math.abs(actor.translation_x) > 0.5 || Math.abs(actor.translation_y) > 0.5) {
                                actor.translation_x = 0;
                                actor.translation_y = 0;
                            }
                        }
                    }
                }
            }
        } finally {
            this._isApplyingLayout = false;
        }

        if (needsFullRetile) {
            this.queueRetile(true);
        } else if (this.activeBorder) {
            this.activeBorder.sync();
        }
    }

    /**
     * Programmatically moves and resizes a Meta.Window to `targetRect`.
     */
    _applyWindowRect(metaWindow, targetRect) {
        if (!metaWindow || !targetRect) return;

        let rx = Math.round(targetRect.x);
        let ry = Math.round(targetRect.y);
        let rw = Math.round(targetRect.width);
        let rh = Math.round(targetRect.height);

        let wasMaximized = false;
        let cur = null;
        try {
            wasMaximized = metaWindow.get_maximized() !== 0;
            cur = metaWindow.get_frame_rect();
        } catch (e) {
            return;
        }

        let dx = Math.abs(cur.x - rx);
        let dy = Math.abs(cur.y - ry);
        let dw = Math.abs(cur.width - rw);
        let dh = Math.abs(cur.height - rh);

        if (wasMaximized || dx > 1 || dy > 1 || dw > 1 || dh > 1) {
            let actor = (typeof metaWindow.get_compositor_private === 'function')
                ? metaWindow.get_compositor_private()
                : null;
            if (actor && this._isActorAnimatingInWm(actor)) {
                this._schedulePostUnminimizeSettle();
                return;
            }
            WindowRules.safeApplyWindowFrame(metaWindow, rx, ry, rw, rh, wasMaximized);

            if (wasMaximized) {
                this._addTimeout(45, () => {
                    if (!this._grabState && this._windowSignals.has(metaWindow.get_stable_sequence())) {
                        if (WindowRules.safeApplyWindowFrame(metaWindow, rx, ry, rw, rh, false) && this.activeBorder) {
                            this.activeBorder.sync();
                        }
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    _finishPreviewResize(cancelled = false) {
        if (this.grabController) {
            this.grabController.finishPreviewResize(cancelled);
        }
    }

    _stopDragPolling() {
        if (this.grabController) {
            this.grabController.stopDragPolling();
        }
    }

    _findMonitorAtPoint(px, py) {
        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            let m = monitors[i];
            if (px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height) {
                return i;
            }
        }
        return global.display.get_current_monitor();
    }

    /**
     * Finds the nearest adjacent monitor in `direction` ('left', 'right', 'up', 'down') from `currentMonIdx`.
     */
    _findAdjacentMonitor(currentMonIdx, direction) {
        let monitors = Main.layoutManager.monitors;
        if (!monitors || monitors.length < 2) return null;
        let cur = monitors[currentMonIdx];
        if (!cur) return null;

        let candidates = [];
        for (let i = 0; i < monitors.length; i++) {
            if (i === currentMonIdx) continue;
            let m = monitors[i];
            candidates.push({
                id: i,
                rect: { x: m.x, y: m.y, width: m.width, height: m.height }
            });
        }

        let sourceRect = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
        return Layouts.findDirectionalTarget(currentMonIdx, sourceRect, candidates, direction);
    }

    /**
     * Moves a tiled window from `fromMonIdx` to `toMonIdx` and places it cleanly at the entry side of `toMonIdx`.
     */
    _moveWindowAcrossMonitors(metaWindow, wsIdx, fromMonIdx, toMonIdx, direction) {
        if (!metaWindow || fromMonIdx === toMonIdx) return false;
        let winId = metaWindow.get_stable_sequence();

        let fromState = this.getState(wsIdx, fromMonIdx);
        let toState = this.getState(wsIdx, toMonIdx);

        Layouts.detachWindowFromState(fromState, winId);
        fromState.lastRects.delete(winId);
        Layouts.detachWindowFromState(toState, winId);

        // Insert at start if moving right/down (entering left/top of target monitor), or at end if moving left/up
        if (direction === 'right' || direction === 'down') {
            toState.windowOrder.unshift(winId);
            if (Array.isArray(toState.fullWindowOrder)) toState.fullWindowOrder.unshift(winId);
        } else {
            toState.windowOrder.push(winId);
            if (Array.isArray(toState.fullWindowOrder)) toState.fullWindowOrder.push(winId);
        }
        toState.focusedId = winId;

        try {
            metaWindow.move_to_monitor(toMonIdx);
        } catch (e) {
            global.logError(`[${this.uuid}] Failed to move window across monitors: ${e}`);
            return false;
        }
        WindowRules.safeRaiseWindow(metaWindow);
        WindowRules.safeActivateWindow(metaWindow, global.get_current_time());

        this.queueRetile(true);

        let meta = Layouts.getLayoutMeta(toState.layoutId);
        if (this.osd) {
            this.osd.show(
                '⇄',
                _('Moved to Monitor %d').replace('%d', String(toMonIdx + 1)),
                _('Monitor %d Layout: %s').replace('%d', String(toMonIdx + 1)).replace('%s', _(meta.name)),
                meta.iconFile,
                toMonIdx
            );
        }
        return true;
    }

    _swapWindowIdsInState(state, idA, idB) {
        return Layouts.swapWindowIdsInState(state, idA, idB);
    }

    _insertWindowRelativeInState(state, winId, targetWinId, side = 'right') {
        let defaultRatio = (this.settings && Number.isFinite(this.settings.dwindleDefaultSplitRatioPct))
            ? (this.settings.dwindleDefaultSplitRatioPct / 100.0)
            : 0.50;
        return Layouts.insertWindowRelativeInState(state, winId, targetWinId, side, defaultRatio);
    }

    // =========================================================================
    // KEYBOARD & WM ACTIONS
    // =========================================================================

    _getActiveNormalWindow() {
        let focusWin = global.display.focus_window;
        if (focusWin && focusWin.get_window_type() === Meta.WindowType.NORMAL && !focusWin.minimized) {
            return focusWin;
        }
        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs) return null;
        let wsIdx = activeWs.index();
        let monIdx = global.display.get_current_monitor();
        let state = this.getState(wsIdx, monIdx);
        let tileable = this.getTileableWindowsMap(wsIdx, monIdx);
        if (state.focusedId && tileable.has(state.focusedId)) {
            return tileable.get(state.focusedId);
        }
        for (let id of state.windowOrder) {
            if (tileable.has(id)) {
                return tileable.get(id);
            }
        }
        for (let mw of tileable.values()) {
            return mw;
        }
        return null;
    }

    _showStackPositionOsd(state, targetWin, wsIdx, monIdx) {
        if (!this.osd || !state || !state.autoTile || !targetWin) return false;
        let winId = targetWin.get_stable_sequence();
        if (!state.windowOrder.includes(winId)) return false;

        let groupIds = null;
        let anchorRect = null;
        let subtitle = '';
        let meta = Layouts.getLayoutMeta(state.layoutId);

        if (state.layoutId === 'monocle' || state.layoutId === 'scrolling') {
            if (state.windowOrder.length < 2) return false;
            groupIds = state.windowOrder;
            let ws = global.workspace_manager.get_workspace_by_index(wsIdx);
            anchorRect = ws ? ws.get_work_area_for_monitor(monIdx) : null;
            subtitle = _(meta.name);
        } else {
            let rect = state.lastRects.get(winId);
            if (!rect || !rect.stacked) return false;
            groupIds = state.windowOrder.filter(id => {
                let r = state.lastRects.get(id);
                return r && r.stacked &&
                    r.x === rect.x && r.y === rect.y &&
                    r.width === rect.width && r.height === rect.height;
            });
            if (groupIds.length < 2) return false;
            anchorRect = rect;
            subtitle = `${_('Stacked Windows')} — ${_(meta.name)}`;
        }

        let idx = groupIds.indexOf(winId);
        if (idx === -1) return false;

        let now = Date.now();
        let dedupKey = `${wsIdx}:${monIdx}:${winId}:${idx}:${groupIds.length}`;
        if (this._lastStackOsdInfo &&
            this._lastStackOsdInfo.key === dedupKey &&
            (now - this._lastStackOsdInfo.time) < 180) {
            return true;
        }
        this._lastStackOsdInfo = { key: dedupKey, time: now };

        let posStr = `${idx + 1}/${groupIds.length}`;
        let rawTitle = targetWin.get_title() || targetWin.get_wm_class() || _('Window');
        let cleanTitle = rawTitle.length > 44 ? `${rawTitle.slice(0, 41)}...` : rawTitle;

        this.osd.show(
            posStr,
            cleanTitle,
            subtitle,
            meta.iconFile,
            monIdx,
            anchorRect
        );
        return true;
    }

    _resolveActiveTabWindow(targetWin, windowById) {
        let ws = targetWin.get_workspace();
        if (!ws) return { win: targetWin, state: null, wsIdx: -1, monIdx: targetWin.get_monitor() };
        let wsIdx = ws.index();
        let monIdx = targetWin.get_monitor();
        let tState = this.getState(wsIdx, monIdx);
        let targetId = targetWin.get_stable_sequence();
        if (tState && tState.autoTile && tState.lastRects) {
            let tRect = tState.lastRects.get(targetId);
            if (tRect && tRect.stacked && tState.focusedId && tState.focusedId !== targetId && windowById.has(tState.focusedId)) {
                let fRect = tState.lastRects.get(tState.focusedId);
                if (fRect && fRect.stacked &&
                    fRect.x === tRect.x && fRect.y === tRect.y &&
                    fRect.width === tRect.width && fRect.height === tRect.height) {
                    return { win: windowById.get(tState.focusedId), state: tState, wsIdx, monIdx };
                }
            }
        }
        return { win: targetWin, state: tState, wsIdx, monIdx };
    }

    _focusExternalDirectionalTarget(focusWin, direction, excludeIds = null) {
        let focusId = focusWin.get_stable_sequence();
        let candidates = [];
        let windowById = new Map();
        let actors = Meta.get_window_actors(global.display);

        for (let actor of actors) {
            let mw = actor.get_meta_window();
            if (!mw || mw.minimized || mw.get_window_type() !== Meta.WindowType.NORMAL) continue;
            if (!mw.showing_on_its_workspace()) continue;
            let id = mw.get_stable_sequence();
            if (excludeIds && excludeIds.has(id)) continue;
            let rect = mw.get_frame_rect();
            candidates.push({ id, rect });
            windowById.set(id, mw);
        }

        let targetId = Layouts.findDirectionalTarget(focusId, focusWin.get_frame_rect(), candidates, direction);
        if (targetId === null || !windowById.has(targetId)) {
            return false;
        }

        let resolved = this._resolveActiveTabWindow(windowById.get(targetId), windowById);
        let targetWin = resolved.win;
        if (resolved.state) {
            resolved.state.focusedId = targetWin.get_stable_sequence();
        }
        WindowRules.safeRaiseWindow(targetWin);
        WindowRules.safeActivateWindow(targetWin, global.get_current_time());
        this._scheduleCursorWarp(targetWin, 0);
        if (resolved.state && resolved.wsIdx >= 0) {
            this._showStackPositionOsd(resolved.state, targetWin, resolved.wsIdx, resolved.monIdx);
        }
        return true;
    }

    focusDirectional(direction) {
        let focusWin = this._getActiveNormalWindow();
        if (!focusWin) return;

        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs) return;
        let wsIdx = activeWs.index();
        let monIdx = focusWin.get_monitor();
        let state = this.getState(wsIdx, monIdx);
        let focusId = focusWin.get_stable_sequence();

        if (state.autoTile && state.layoutId !== 'monocle' && state.layoutId !== 'scrolling') {
            let focusedRect = state.lastRects.get(focusId);
            if (focusedRect && focusedRect.stacked) {
                let siblings = state.windowOrder.filter(id => {
                    let rect = state.lastRects.get(id);
                    return rect && rect.stacked && rect.x === focusedRect.x && rect.y === focusedRect.y &&
                        rect.width === focusedRect.width && rect.height === focusedRect.height;
                });
                let index = siblings.indexOf(focusId);
                if (siblings.length > 1 && index !== -1) {
                    let excludeSet = new Set(siblings);
                    let isHorizontal = (direction === 'left' || direction === 'right');
                    let step = (direction === 'left' || direction === 'up') ? -1 : 1;
                    let nextIdx = index + step;
                    let atBoundary = !isHorizontal || nextIdx < 0 || nextIdx >= siblings.length;

                    // Up/Down or Left/Right at stack boundary exits smoothly when an external neighbor exists.
                    if (atBoundary && this._focusExternalDirectionalTarget(focusWin, direction, excludeSet)) {
                        return;
                    }

                    let targetId = siblings[(nextIdx + siblings.length) % siblings.length];
                    let tileable = this.getTileableWindowsMap(wsIdx, monIdx);
                    let targetWin = tileable.get(targetId);
                    if (targetWin) {
                        state.focusedId = targetId;
                        WindowRules.safeRaiseWindow(targetWin);
                        WindowRules.safeActivateWindow(targetWin, global.get_current_time());
                        this.queueRetile(true);
                        this._scheduleCursorWarp(targetWin, 0);
                        this._showStackPositionOsd(state, targetWin, wsIdx, monIdx);
                        return;
                    }
                }
            }
        }

        if (state.autoTile && (state.layoutId === 'monocle' || state.layoutId === 'scrolling')) {
            if (direction === 'left' || direction === 'up' || direction === 'right' || direction === 'down') {
                let step = (direction === 'left' || direction === 'up') ? -1 : 1;
                let order = state.windowOrder;
                if (order.length > 1) {
                    let curIdx = order.indexOf(focusId);
                    if (curIdx === -1) curIdx = 0;
                    let shouldWrap = (state.layoutId === 'scrolling') ||
                                     ((state.layoutId === 'monocle') && (this.settings.monocleWrapNavigation !== false));
                    let nextIdx = shouldWrap
                        ? ((curIdx + step + order.length) % order.length)
                        : (curIdx + step);
                    if (nextIdx >= 0 && nextIdx < order.length) {
                        let tileable = this.getTileableWindowsMap(wsIdx, monIdx);
                        let targetWin = tileable.get(order[nextIdx]);
                        if (targetWin) {
                            state.focusedId = order[nextIdx];
                            WindowRules.safeRaiseWindow(targetWin);
                            WindowRules.safeActivateWindow(targetWin, global.get_current_time());
                            this.queueRetile(true);
                            this._scheduleCursorWarp(targetWin, state.layoutId === 'scrolling' ? 50 : 0);
                            this._showStackPositionOsd(state, targetWin, wsIdx, monIdx);
                            return;
                        }
                    }
                } else if (order.length === 1) {
                    let tileable = this.getTileableWindowsMap(wsIdx, monIdx);
                    let onlyWin = tileable.get(order[0]);
                    if (onlyWin) {
                        WindowRules.safeRaiseWindow(onlyWin);
                        WindowRules.safeActivateWindow(onlyWin, global.get_current_time());
                    }
                }
            }
        }

        this._focusExternalDirectionalTarget(focusWin, direction);
    }

    swapDirectional(direction) {
        let focusWin = this._getActiveNormalWindow();
        if (!focusWin) return;

        let ws = focusWin.get_workspace();
        if (!ws) return;
        let wsIdx = ws.index();
        let monIdx = focusWin.get_monitor();
        let state = this.getState(wsIdx, monIdx);
        let focusId = focusWin.get_stable_sequence();

        if (!state.autoTile || !state.windowOrder.includes(focusId)) {
            let r = focusWin.get_frame_rect();
            let step = 48;
            let nx = r.x + (direction === 'left' ? -step : direction === 'right' ? step : 0);
            let ny = r.y + (direction === 'up' ? -step : direction === 'down' ? step : 0);
            WindowRules.safeApplyWindowFrame(focusWin, nx, ny, 0, 0, true);
            return;
        }

        if (state.layoutId === 'scrolling' || state.layoutId === 'monocle') {
            let step = (direction === 'left' || direction === 'up') ? -1 : 1;
            let order = state.windowOrder;
            let curIdx = order.indexOf(focusId);
            if (curIdx !== -1) {
                let targetIdx = curIdx + step;
                if (targetIdx >= 0 && targetIdx < order.length) {
                    this._swapWindowIdsInState(state, focusId, order[targetIdx]);
                    this.queueRetile(true);
                    this._showStackPositionOsd(state, focusWin, wsIdx, monIdx);
                    return;
                }
            }
            // At the start/end of the Scrolling/Monocle list -> try throwing window to adjacent monitor!
            let adjMon = this._findAdjacentMonitor(monIdx, direction);
            if (adjMon !== null) {
                this._moveWindowAcrossMonitors(focusWin, wsIdx, monIdx, adjMon, direction);
                this._scheduleCursorWarp(focusWin, 50);
                this._emitIpcStateChanged('monitor-moved');
            }
            return;
        }

        let focusedRect = state.lastRects.get(focusId);
        if (focusedRect && focusedRect.stacked) {
            let siblings = state.windowOrder.filter(id => {
                let rect = state.lastRects.get(id);
                return rect && rect.stacked &&
                    rect.x === focusedRect.x && rect.y === focusedRect.y &&
                    rect.width === focusedRect.width && rect.height === focusedRect.height;
            });
            let index = siblings.indexOf(focusId);
            if (siblings.length > 1 && index !== -1) {
                let step = (direction === 'left' || direction === 'up') ? -1 : 1;
                let targetId = siblings[(index + step + siblings.length) % siblings.length];
                this._swapWindowIdsInState(state, focusId, targetId);
                this.queueRetile(true);
                this._showStackPositionOsd(state, focusWin, wsIdx, monIdx);
                return;
            }
        }

        let candidates = [];
        for (let [id, rect] of state.lastRects.entries()) {
            candidates.push({ id, rect });
        }

        let sourceRect = state.lastRects.get(focusId) || focusWin.get_frame_rect();
        let targetId = Layouts.findDirectionalTarget(focusId, sourceRect, candidates, direction);

        if (targetId !== null) {
            this._swapWindowIdsInState(state, focusId, targetId);
            this.queueRetile(true);
            return;
        }

        // No tile in `direction` on the current monitor -> throw window to adjacent monitor in `direction`!
        let adjMon = this._findAdjacentMonitor(monIdx, direction);
        if (adjMon !== null) {
            this._moveWindowAcrossMonitors(focusWin, wsIdx, monIdx, adjMon, direction);
            this._scheduleCursorWarp(focusWin, 50);
            this._emitIpcStateChanged('monitor-moved');
        }
    }

    promoteFocusedToMaster() {
        let focusWin = this._getActiveNormalWindow();
        if (!focusWin) return;
        let ws = focusWin.get_workspace();
        if (!ws) return;

        let state = this.getState(ws.index(), focusWin.get_monitor());
        let focusId = focusWin.get_stable_sequence();
        let idx = state.windowOrder.indexOf(focusId);
        if (idx === -1 || state.windowOrder.length < 2) return;

        if (idx === 0) {
            let secondId = state.windowOrder[1];
            this._swapWindowIdsInState(state, focusId, secondId);
        } else {
            let firstId = state.windowOrder[0];
            this._swapWindowIdsInState(state, focusId, firstId);
        }

        this.queueRetile(true);
        let meta = Layouts.getLayoutMeta(state.layoutId);
        if (this.osd) {
            this.osd.show('★', _('Promoted to Master'), focusWin.get_title() || '', meta.iconFile);
        }
    }

    setLayoutById(layoutId) {
        let state = this.getCurrentState();
        if (layoutId === 'monocle' && state.autoTile && state.layoutId === 'monocle' && state.previousLayoutId) {
            this.toggleMonocleZoom();
            return;
        }
        if (layoutId === 'monocle' && state.layoutId !== 'monocle' && state.layoutId !== 'floating') {
            state.previousLayoutId = state.layoutId;
        } else {
            state.previousLayoutId = null;
        }
        state.layoutId = layoutId;
        state.autoTile = (layoutId !== 'floating');

        this._savePersistedStates();

        this.queueRetile(true);
        this._emitIpcStateChanged('layout-changed');

        let meta = Layouts.getLayoutMeta(layoutId);
        if (this.osd) {
            this.osd.show(
                meta.badge,
                _('Layout: %s').replace('%s', _(meta.name)),
                _(meta.description),
                meta.iconFile
            );
        }
    }

    cycleLayout(direction = 1) {
        let state = this.getCurrentState();
        let currentId = state.autoTile ? state.layoutId : 'floating';
        let nextId = Layouts.getNextLayoutId(currentId, direction);
        this.setLayoutById(nextId);
    }

    toggleWorkspaceTiling() {
        let state = this.getCurrentState();
        state.autoTile = !state.autoTile;
        if (state.autoTile && state.layoutId === 'floating') {
            state.layoutId = this.settings.defaultLayout !== 'floating' ? this.settings.defaultLayout : 'dwindle';
        }

        this._savePersistedStates();

        this.queueRetile(true);
        this._emitIpcStateChanged('tiling-toggled');

        let meta = Layouts.getLayoutMeta(state.autoTile ? state.layoutId : 'floating');
        if (this.osd) {
            if (state.autoTile) {
                this.osd.show(meta.badge, _('Auto-Tiling Enabled'), _(meta.name), meta.iconFile);
            } else {
                this.osd.show('[~]', _('Auto-Tiling Paused'), _('Floating mode on this workspace'), 'cinnawm-layout-floating-symbolic.svg');
            }
        }
    }

    toggleFocusedFloating() {
        let focusWin = global.display.focus_window;
        if (!focusWin || focusWin.get_window_type() !== Meta.WindowType.NORMAL) return;

        let winId = focusWin.get_stable_sequence();
        let ws = focusWin.get_workspace();
        if (!ws) return;
        let wsIdx = ws.index();
        let monIdx = focusWin.get_monitor();
        let state = this.getState(wsIdx, monIdx);

        let currentlyTiled = state.windowOrder.includes(winId) && !this.manualFloating.has(winId);

        if (currentlyTiled) {
            this.manualFloating.add(winId);
            this.manualTiled.delete(winId);
            Layouts.detachWindowFromState(state, winId);

            let saved = this.savedFloatingRects.get(winId);
            if (saved) {
                WindowRules.safeApplyWindowFrame(focusWin, saved.x, saved.y, saved.width, saved.height, false);
            } else {
                this.centerWindowOnMonitor(focusWin, 0.65, 0.65);
            }
            WindowRules.safeRaiseWindow(focusWin);
            if (this.osd) {
                this.osd.show('[~]', _('Floating Window'), focusWin.get_wm_class() || focusWin.get_title() || '', 'cinnawm-layout-floating-symbolic.svg');
            }
        } else {
            let r = focusWin.get_frame_rect();
            this.savedFloatingRects.set(winId, { x: r.x, y: r.y, width: r.width, height: r.height });

            this.manualFloating.delete(winId);
            this.manualTiled.add(winId);
            if (this.scratchpad && this.scratchpad.has(winId)) {
                this.scratchpad.unregisterWindow(focusWin);
            }
            if (focusWin.is_above()) {
                focusWin.unmake_above();
            }
            if (!state.windowOrder.includes(winId)) {
                state.windowOrder.push(winId);
            }
            if (Array.isArray(state.fullWindowOrder) && !state.fullWindowOrder.includes(winId)) {
                state.fullWindowOrder.push(winId);
            }
            let meta = Layouts.getLayoutMeta(state.layoutId);
            if (this.osd) {
                this.osd.show(meta.badge, _('Tiled Window'), focusWin.get_wm_class() || focusWin.get_title() || '', meta.iconFile);
            }
        }

        this.queueRetile(true);
        this._emitIpcStateChanged('floating-toggled');
    }

    toggleMonocleZoom(targetWindow = null) {
        let win = targetWindow || this._getActiveNormalWindow();
        let state = this.getCurrentState();
        if (win) {
            let ws = win.get_workspace();
            if (ws) {
                state = this.getState(ws.index(), win.get_monitor());
            }
            let winId = win.get_stable_sequence();
            if (state.windowOrder.includes(winId)) {
                state.focusedId = winId;
            }
            WindowRules.safeRaiseWindow(win);
            WindowRules.safeActivateWindow(win, global.get_current_time());
        }

        if (!state.autoTile || state.layoutId !== 'monocle') {
            let prevId = (state.layoutId && state.layoutId !== 'monocle' && state.layoutId !== 'floating')
                ? state.layoutId
                : (this.settings.defaultLayout !== 'monocle' ? this.settings.defaultLayout : 'dwindle');
            state.previousLayoutId = prevId;
            state.layoutId = 'monocle';
            state.autoTile = true;
            let prevMeta = Layouts.getLayoutMeta(prevId);
            let rawTitle = win ? (win.get_title() || win.get_wm_class() || _('Window')) : _('Monocle / Zoom Mode');
            let singleLineTitle = String(rawTitle).replace(/\s+/g, ' ').trim();
            let cleanTitle = singleLineTitle.length > 40 ? `${singleLineTitle.slice(0, 37)}...` : singleLineTitle;
            let zoomShortcut = Overlays.formatPrimaryShortcut(this.settings.kbToggleMonocle, 'Super + Z');
            if (this.osd) {
                this.osd.show(
                    '[M]',
                    `${_('Zoom / Zen')}: ${cleanTitle}`,
                    `${zoomShortcut} → ${_(prevMeta.name)}`,
                    'cinnawm-layout-monocle-symbolic.svg'
                );
            }
        } else {
            state.layoutId = state.previousLayoutId || (this.settings.defaultLayout !== 'monocle' ? this.settings.defaultLayout : 'dwindle');
            state.previousLayoutId = null;
            let meta = Layouts.getLayoutMeta(state.layoutId);
            if (this.osd) {
                this.osd.show(
                    meta.badge,
                    _('Layout: %s').replace('%s', _(meta.name)),
                    _('Restored from Zoom / Zen'),
                    meta.iconFile
                );
            }
        }
        this._savePersistedStates();
        this.queueRetile(true);
    }

    resizeFocusedDirectional(deltaXRatio, deltaYRatio) {
        let focusWin = this._getActiveNormalWindow();
        if (!focusWin) return;

        let ws = focusWin.get_workspace();
        if (!ws) return;
        let wsIdx = ws.index();
        let monIdx = focusWin.get_monitor();
        let state = this.getState(wsIdx, monIdx);
        let winId = focusWin.get_stable_sequence();

        if (!state.autoTile || state.layoutId === 'floating' || !state.windowOrder.includes(winId)) {
            let workarea = ws.get_work_area_for_monitor(monIdx);
            let r = focusWin.get_frame_rect();
            let dw = Math.round(workarea.width * deltaXRatio);
            let dh = Math.round(workarea.height * deltaYRatio);
            let nw = Layouts.clamp(r.width + dw, Math.min(160, workarea.width), workarea.width);
            let nh = Layouts.clamp(r.height + dh, Math.min(120, workarea.height), workarea.height);
            let nx = Layouts.clamp(r.x, workarea.x, workarea.x + workarea.width - nw);
            let ny = Layouts.clamp(r.y, workarea.y, workarea.y + workarea.height - nh);
            WindowRules.safeApplyWindowFrame(focusWin, nx, ny, nw, nh, true);
            return;
        }

        if (state.layoutId === 'dwindle') {
            let stepRatio = (this.settings.dwindleResizeStepPct || 5) / 100.0;
            if (Math.abs(deltaXRatio) > 0.001) {
                let effDx = Math.sign(deltaXRatio) * (Math.abs(deltaXRatio) === 0.05 ? stepRatio : Math.abs(deltaXRatio));
                if (!state.bspTree.adjustSplit(winId, 'vertical', effDx)) {
                    state.bspTree.adjustSplit(winId, 'horizontal', effDx);
                }
            }
            if (Math.abs(deltaYRatio) > 0.001) {
                let effDy = Math.sign(deltaYRatio) * (Math.abs(deltaYRatio) === 0.05 ? stepRatio : Math.abs(deltaYRatio));
                if (!state.bspTree.adjustSplit(winId, 'horizontal', effDy)) {
                    state.bspTree.adjustSplit(winId, 'vertical', effDy);
                }
            }
        } else if (state.layoutId === 'master-stack' || state.layoutId === 'centered-master') {
            if (Math.abs(deltaXRatio) > 0.001) {
                if (state.layoutId === 'centered-master') {
                    let curCenter = Number.isFinite(state.centeredMasterRatio)
                        ? state.centeredMasterRatio
                        : ((this.settings.centeredMasterRatioPct || 50) / 100.0);
                    state.centeredMasterRatio = Layouts.clamp(curCenter + deltaXRatio, 0.20, 0.80);
                    state.centeredLeftRatio = (1 - state.centeredMasterRatio) / 2;
                    state.centeredRightRatio = 1 - state.centeredMasterRatio - state.centeredLeftRatio;
                    state.masterRatio = state.centeredMasterRatio;
                } else {
                    state.masterRatio = Layouts.clamp(state.masterRatio + deltaXRatio, 0.15, 0.85);
                }
            }
            if (Math.abs(deltaYRatio) > 0.001) {
                let w = state.weights.get(winId) || 1.0;
                state.weights.set(winId, Layouts.clamp(w + deltaYRatio * 2.0, 0.2, 5.0));
            }
        } else if (state.layoutId === 'scrolling') {
            if (Math.abs(deltaXRatio) > 0.001) {
                let stepRatio = (this.settings.scrollingResizeStepPct || 8) / 100.0;
                let effDx = Math.sign(deltaXRatio) * (Math.abs(deltaXRatio) === 0.05 ? stepRatio : Math.abs(deltaXRatio));
                let w = state.weights.get(winId) || 1.0;
                state.weights.set(winId, Layouts.clamp(w + effDx * 1.5, 0.5, 1.65));
            }
        }

        this.queueRetile(true);
    }

    resetCurrentLayoutRatios() {
        let state = this.getCurrentState();
        state.masterRatio = (this.settings.masterRatioPct || 55) / 100.0;
        state.centeredMasterRatio = (this.settings.centeredMasterRatioPct || 50) / 100.0;
        state.centeredLeftRatio = null;
        state.centeredRightRatio = null;
        state.weights.clear();
        state.colWeights.clear();
        state.gridRowWeights.clear();
        state.bspTree.resetRatios((this.settings.dwindleDefaultSplitRatioPct || 50) / 100.0);
        this._savePersistedStates();
        this.queueRetile(true);
        this._emitIpcStateChanged('ratios-reset');
        let meta = Layouts.getLayoutMeta(state.layoutId);
        if (this.osd) {
            this.osd.show('[=]', _('Ratios Reset'), _('All tiles restored to default sizes'), meta.iconFile);
        }
    }

    adjustMasterCount(delta) {
        let state = this.getCurrentState();
        state.masterCount = Layouts.clamp(state.masterCount + delta, 1, 6);
        this._savePersistedStates();
        this.queueRetile(true);
        this._emitIpcStateChanged('master-count-changed');
        if (this.osd) {
            this.osd.show('[]=', _('Master Windows: %d').replace('%d', String(state.masterCount)), _('Primary area'), 'cinnawm-layout-master-symbolic.svg');
        }
    }

    rotateLayoutOrientation() {
        let state = this.getCurrentState();
        let focusWin = global.display.focus_window;

        if (state.layoutId === 'dwindle' && focusWin) {
            let winId = focusWin.get_stable_sequence();
            if (state.bspTree.rotateParent(winId)) {
                this.queueRetile(true);
                this._emitIpcStateChanged('orientation-rotated');
                if (this.osd) {
                    this.osd.show('[@]', _('Split Rotated'), _('Toggled vertical/horizontal orientation of BSP node'), 'cinnawm-layout-dwindle-symbolic.svg');
                }
                return;
            }
        }

        const orientations = ['left', 'right', 'top', 'bottom'];
        let idx = orientations.indexOf(state.masterOrientation);
        state.masterOrientation = orientations[(idx + 1) % orientations.length];
        this._savePersistedStates();
        this.queueRetile(true);
        this._emitIpcStateChanged('orientation-rotated');
        if (this.osd) {
            this.osd.show('[]=', _('Master Orientation: %s').replace('%s', state.masterOrientation.toUpperCase()), _('Master & Stack'), 'cinnawm-layout-master-symbolic.svg');
        }
    }

    handleScratchpadToggle() {
        if (!this.scratchpad) return;
        let res = this.scratchpad.toggleShow();
        if (!this.osd) return;
        if (res.status === 'empty') {
            let assignShortcut = Overlays.formatPrimaryShortcut(this.settings.kbScratchpadAssign, 'Super + Shift + S');
            this.osd.show('[S]', _('Scratchpad Empty'), _('Press %s on a window to assign it to the Scratchpad').replace('%s', assignShortcut));
        } else if (res.status === 'shown' && res.window) {
            this.osd.show('[S]', _('Scratchpad Shown'), res.window.get_title() || res.window.get_wm_class() || '');
        } else if (res.status === 'hidden' && res.window) {
            this.osd.show('[S]', _('Scratchpad Hidden'), res.window.get_title() || res.window.get_wm_class() || '');
        }
    }

    handleScratchpadAssign() {
        if (!this.scratchpad) return;
        let focusWin = global.display.focus_window;
        if (!focusWin || focusWin.get_window_type() !== Meta.WindowType.NORMAL) return;

        let winId = focusWin.get_stable_sequence();
        let res = this.scratchpad.toggleWindowRegistration(focusWin);

        if (res.status === 'added') {
            for (let state of this._states.values()) {
                Layouts.detachWindowFromState(state, winId);
            }
            if (this.osd) {
                let toggleShortcut = Overlays.formatPrimaryShortcut(this.settings.kbScratchpadToggle, 'Super + S');
                this.osd.show('[S+]', _('Added to Scratchpad'), _('Press %s to toggle it anytime').replace('%s', toggleShortcut));
            }
        } else if (res.status === 'removed') {
            if (this.osd) {
                this.osd.show('[S-]', _('Removed from Scratchpad'), focusWin.get_title() || '');
            }
        }
        this.queueRetile(true);
    }

    _positionPipWindow(metaWindow) {
        if (!metaWindow) return false;
        let activeWs = global.workspace_manager.get_active_workspace();
        let ws = metaWindow.get_workspace() || activeWs;
        if (!ws) return false;
        let monIdx = metaWindow.get_monitor();
        let workarea = ws.get_work_area_for_monitor(monIdx);
        if (!workarea || workarea.width <= 0 || workarea.height <= 0) return false;

        let corner = this.settings.pipCorner || 'bottom-right';
        let widthPct = this.settings.pipWidthPct || 28;
        let heightPct = this.settings.pipHeightPct || 28;
        let margin = Math.max(12, Number(this.settings.outerGap) || 12);
        let rect = Layouts.computeCornerRect(workarea, corner, widthPct, heightPct, margin);
        return WindowRules.safeApplyWindowFrame(metaWindow, rect.x, rect.y, rect.width, rect.height, true);
    }

    _repositionAllPipWindows() {
        if (!this.pipWindows || this.pipWindows.size === 0) return;
        let actors = Meta.get_window_actors(global.display);
        for (let actor of actors) {
            let mw = actor && typeof actor.get_meta_window === 'function' ? actor.get_meta_window() : null;
            if (!mw) continue;
            if (this.pipWindows.has(mw.get_stable_sequence())) {
                this._positionPipWindow(mw);
            }
        }
    }

    _restoreAllPipWindows() {
        if (!this.pipWindows || this.pipWindows.size === 0) return;
        let actors = Meta.get_window_actors(global.display);
        for (let actor of actors) {
            let mw = actor && typeof actor.get_meta_window === 'function' ? actor.get_meta_window() : null;
            if (!mw) continue;
            if (this.pipWindows.has(mw.get_stable_sequence())) {
                try {
                    if (mw.is_on_all_workspaces()) mw.unstick();
                    if (mw.is_above()) mw.unmake_above();
                } catch (e) {
                    // ignore closing window
                }
            }
        }
    }

    toggleFocusedPip() {
        let focusWin = this._getActiveNormalWindow();
        if (!focusWin) return false;

        let winId = focusWin.get_stable_sequence();
        let isCurrentlyPip = this.pipWindows.has(winId) ||
            (focusWin.is_on_all_workspaces() && focusWin.is_above() &&
             !(this.scratchpad && this.scratchpad.has(winId)));

        if (isCurrentlyPip) {
            this.pipWindows.delete(winId);
            let prev = this._pipPrevState.get(winId) || null;
            this._pipPrevState.delete(winId);

            try {
                if (focusWin.is_on_all_workspaces()) focusWin.unstick();
                if (focusWin.is_above()) focusWin.unmake_above();
            } catch (e) {
                // ignore closing window
            }

            let ws = focusWin.get_workspace() || global.workspace_manager.get_active_workspace();
            if (prev && prev.wasTiled && ws) {
                if (!prev.prevManualFloating) {
                    this.manualFloating.delete(winId);
                }
                let st = this.getState(ws.index(), focusWin.get_monitor());
                if (st) {
                    if (!st.windowOrder.includes(winId)) st.windowOrder.push(winId);
                    if (Array.isArray(st.fullWindowOrder) && !st.fullWindowOrder.includes(winId)) {
                        st.fullWindowOrder.push(winId);
                    }
                }
            } else if (prev && prev.rect) {
                WindowRules.safeApplyWindowFrame(
                    focusWin,
                    prev.rect.x,
                    prev.rect.y,
                    prev.rect.width,
                    prev.rect.height,
                    true
                );
            }

            if (this.osd) {
                this.osd.show(
                    '[PiP]',
                    _('Picture-in-Picture Disabled'),
                    focusWin.get_title() || focusWin.get_wm_class() || '',
                    'cinnawm-layout-floating-symbolic.svg'
                );
            }
            this.queueRetile(true);
            if (this.activeBorder) this.activeBorder.sync();
            this._emitIpcStateChanged('pip-toggled');
            return true;
        }

        let r = focusWin.get_frame_rect();
        let ws = focusWin.get_workspace();
        let wasTiled = false;
        if (ws) {
            let st = this.getState(ws.index(), focusWin.get_monitor());
            wasTiled = Boolean(st && st.autoTile && st.layoutId !== 'floating' && st.windowOrder.includes(winId));
        }
        this._pipPrevState.set(winId, {
            wasTiled,
            prevManualFloating: this.manualFloating.has(winId),
            rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
        });

        for (let st of this._states.values()) {
            Layouts.detachWindowFromState(st, winId);
        }
        if (this.scratchpad && this.scratchpad.has(winId)) {
            this.scratchpad.unregisterWindow(focusWin);
        }

        this.pipWindows.add(winId);
        try {
            focusWin.stick();
            focusWin.make_above();
        } catch (e) {
            global.logError(`[${this.uuid}] Failed to pin PiP window: ${e}`);
        }
        this._positionPipWindow(focusWin);
        WindowRules.safeRaiseWindow(focusWin);
        WindowRules.safeActivateWindow(focusWin, global.get_current_time());

        if (this.osd) {
            this.osd.show(
                '[PiP]',
                _('Picture-in-Picture Enabled'),
                focusWin.get_title() || focusWin.get_wm_class() || '',
                'cinnawm-layout-floating-symbolic.svg'
            );
        }
        this.queueRetile(true);
        if (this.activeBorder) this.activeBorder.sync();
        this._emitIpcStateChanged('pip-toggled');
        return true;
    }

    openWindowSwitcher() {
        let switcherCfg = RuntimeConfig.getAlbertSwitcherConfig();
        try {
            Gio.DBus.session.call(
                switcherCfg.busName,
                switcherCfg.objectPath,
                switcherCfg.interfaceName,
                'cycleWindow',
                null,
                new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NONE,
                1000,
                null,
                (conn, res) => {
                    try {
                        let reply = conn.call_finish(res);
                        let ok = reply ? Boolean(reply.deep_unpack()[0]) : false;
                        if (!ok && this.osd && this.settings && this.settings.showOsd) {
                            this.osd.show(
                                'SWITCHER',
                                _('Albert CinnaWM Switcher Unavailable'),
                                _('Start Albert and enable CinnaWM Switcher in Plugins'),
                                'view-list-symbolic'
                            );
                        }
                    } catch (e) {
                        if (this.osd && this.settings && this.settings.showOsd) {
                            this.osd.show(
                                'SWITCHER',
                                _('Albert CinnaWM Switcher Unavailable'),
                                _('Start Albert and enable CinnaWM Switcher in Plugins'),
                                'view-list-symbolic'
                            );
                        }
                    }
                }
            );
            return true;
        } catch (e) {
            global.logWarning(`[${_runtimeUuid}] openWindowSwitcher D-Bus error: ${e}`);
            return false;
        }
    }

    _findWindowById(winId) {
        let actors = Meta.get_window_actors(global.display);
        for (let actor of actors) {
            let mw = actor && typeof actor.get_meta_window === 'function' ? actor.get_meta_window() : null;
            if (mw && mw.get_stable_sequence() === winId) {
                return mw;
            }
        }
        return null;
    }

    activateWindowById(winId) {
        let targetWin = this._findWindowById(winId);
        if (!targetWin) return false;

        if (this.scratchpad && this.scratchpad.has(winId)) {
            let shown = this.scratchpad.showScratchpadWindow(targetWin);
            if (shown) {
                this._scheduleCursorWarp(targetWin, 50);
                if (this.activeBorder) this.activeBorder.sync();
            }
            return shown;
        }

        let ws = targetWin.get_workspace();
        let activeWs = global.workspace_manager.get_active_workspace();
        let now = global.get_current_time();
        if (ws && activeWs && ws.index() !== activeWs.index() && !targetWin.is_on_all_workspaces()) {
            try {
                ws.activate(now);
            } catch (e) {
                // ignore workspace switch failure
            }
        }
        try {
            if (targetWin.minimized) {
                targetWin.unminimize();
            }
        } catch (e) {
            // ignore closing window
        }

        let effWs = targetWin.get_workspace() || activeWs;
        let wsIdx = effWs ? effWs.index() : -1;
        let monIdx = targetWin.get_monitor();
        let state = wsIdx >= 0 ? this.getState(wsIdx, monIdx) : null;
        if (state && state.autoTile && state.windowOrder.includes(winId)) {
            state.focusedId = winId;
            let grp = Layouts.findTabGroupForWindow(state, winId);
            if (grp && state.activeTabMap) {
                state.activeTabMap.set(grp[0], winId);
            }
        }

        WindowRules.safeRaiseWindow(targetWin);
        WindowRules.safeActivateWindow(targetWin, now);
        this.queueRetile(true);
        this._scheduleCursorWarp(targetWin, 50);
        if (state && wsIdx >= 0) {
            this._showStackPositionOsd(state, targetWin, wsIdx, monIdx);
        }
        return true;
    }

    closeWindowById(winId) {
        let targetWin = this._findWindowById(winId);
        if (!targetWin) return false;
        if (typeof targetWin.can_close === 'function' && !targetWin.can_close()) {
            return false;
        }
        try {
            targetWin.delete(global.get_current_time());
            return true;
        } catch (e) {
            return false;
        }
    }

    snapWindowToCustomRect(metaWindow, rect) {
        if (!metaWindow || !rect) return;
        let winId = metaWindow.get_stable_sequence();
        let ws = metaWindow.get_workspace();
        if (ws) {
            let state = this.getState(ws.index(), metaWindow.get_monitor());
            Layouts.detachWindowFromState(state, winId);
        }

        this.manualFloating.add(winId);
        this.manualTiled.delete(winId);

        WindowRules.safeApplyWindowFrame(metaWindow, rect.x, rect.y, rect.width, rect.height, true);
        WindowRules.safeRaiseWindow(metaWindow);
        WindowRules.safeActivateWindow(metaWindow, global.get_current_time());
        this.queueRetile(true);
    }

    centerFocusedWindow() {
        let focusWin = global.display.focus_window;
        if (!focusWin || focusWin.get_window_type() !== Meta.WindowType.NORMAL) return;

        let winId = focusWin.get_stable_sequence();
        let ws = focusWin.get_workspace();
        if (ws) {
            let state = this.getState(ws.index(), focusWin.get_monitor());
            if (state.autoTile && state.windowOrder.includes(winId)) {
                this.manualFloating.add(winId);
                this.manualTiled.delete(winId);
                Layouts.detachWindowFromState(state, winId);
                this.queueRetile(true);
            }
        }

        let wRatio = Layouts.clamp((this.settings.floatingCenterWidthPct || 70) / 100.0, 0.35, 0.95);
        let hRatio = Layouts.clamp((this.settings.floatingCenterHeightPct || 72) / 100.0, 0.35, 0.95);
        this.centerWindowOnMonitor(focusWin, wRatio, hRatio);
        if (this.osd) {
            this.osd.show('[C]', _('Window Centered'), focusWin.get_wm_class() || '', 'cinnawm-layout-floating-symbolic.svg');
        }
    }

    groupWindowsInState(state, sourceWinId, targetWinId, wsIdx, monIdx) {
        if (!state || sourceWinId === targetWinId) return false;
        let grp = Layouts.groupWindowsAsTabs(state, sourceWinId, targetWinId);
        if (!grp) return false;

        let tileableMap = this.getTileableWindowsMap(wsIdx, monIdx);
        let sourceWin = tileableMap.get(sourceWinId);
        if (sourceWin) {
            WindowRules.safeRaiseWindow(sourceWin);
            WindowRules.safeActivateWindow(sourceWin, global.get_current_time());
        }
        this._savePersistedStates();
        this.queueRetile(true);
        this._emitIpcStateChanged('tab-group-changed');

        if (this.osd && sourceWin) {
            let meta = Layouts.getLayoutMeta(state.layoutId);
            let idx = grp.indexOf(sourceWinId) + 1;
            let rawTitle = sourceWin.get_title() || sourceWin.get_wm_class() || _('Window');
            let cleanTitle = rawTitle.length > 40 ? `${rawTitle.slice(0, 37)}...` : rawTitle;
            this.osd.show(
                `📑 ${idx}/${grp.length}`,
                cleanTitle,
                `${_('Manual Tab Group')} — ${_(meta.name)}`,
                meta.iconFile,
                monIdx
            );
        }
        return true;
    }

    ungroupWindowById(winId, wsIdx, monIdx) {
        let state = this.getState(wsIdx, monIdx);
        if (!Layouts.ungroupWindowFromTabs(state, winId, this.settings)) return false;

        let tileableMap = this.getTileableWindowsMap(wsIdx, monIdx);
        let win = tileableMap.get(winId);
        if (win) {
            WindowRules.safeRaiseWindow(win);
            WindowRules.safeActivateWindow(win, global.get_current_time());
        }
        this._savePersistedStates();
        this.queueRetile(true);
        this._emitIpcStateChanged('tab-group-changed');

        if (this.osd) {
            let meta = Layouts.getLayoutMeta(state.layoutId);
            this.osd.show(
                '⊟',
                _('Detached from Tab Group'),
                win ? (win.get_title() || win.get_wm_class() || '') : '',
                meta.iconFile,
                monIdx
            );
        }
        return true;
    }

    dissolveTabGroupById(winId, wsIdx, monIdx) {
        let state = this.getState(wsIdx, monIdx);
        if (!Layouts.dissolveTabGroup(state, winId, this.settings)) return false;

        this._savePersistedStates();
        this.queueRetile(true);
        this._emitIpcStateChanged('tab-group-changed');

        if (this.osd) {
            let meta = Layouts.getLayoutMeta(state.layoutId);
            this.osd.show(
                '⊞',
                _('Tab Group Dissolved'),
                _('All tabs expanded into independent tiles'),
                meta.iconFile,
                monIdx
            );
        }
        return true;
    }

    toggleFocusedTabGroup() {
        let focusWin = this._getActiveNormalWindow();
        if (!focusWin) return;

        let ws = focusWin.get_workspace();
        if (!ws) return;
        let wsIdx = ws.index();
        let monIdx = focusWin.get_monitor();
        let state = this.getState(wsIdx, monIdx);
        if (!state.autoTile || state.layoutId === 'floating' || state.layoutId === 'monocle') return;

        let focusId = focusWin.get_stable_sequence();
        if (!state.windowOrder.includes(focusId)) return;

        let existingGroup = Layouts.findTabGroupForWindow(state, focusId);
        if (existingGroup) {
            this.ungroupWindowById(focusId, wsIdx, monIdx);
            return;
        }

        if (state.windowOrder.length < 2) return;

        let curIdx = state.windowOrder.indexOf(focusId);
        let targetWinId = (curIdx > 0)
            ? state.windowOrder[curIdx - 1]
            : state.windowOrder[curIdx + 1];
        if (targetWinId !== undefined && targetWinId !== focusId) {
            this.groupWindowsInState(state, focusId, targetWinId, wsIdx, monIdx);
        }
    }

    centerWindowOnMonitor(metaWindow, widthRatio = 0.70, heightRatio = 0.72) {
        if (!metaWindow) return;
        let monIdx = metaWindow.get_monitor();
        let ws = metaWindow.get_workspace() || global.workspace_manager.get_active_workspace();
        if (!ws) return;
        let workarea = ws.get_work_area_for_monitor(monIdx);
        if (!workarea || workarea.width <= 0 || workarea.height <= 0) return;

        let w = Math.round(workarea.width * widthRatio);
        let h = Math.round(workarea.height * heightRatio);
        let x = workarea.x + Math.round((workarea.width - w) / 2);
        let y = workarea.y + Math.round((workarea.height - h) / 2);

        WindowRules.safeApplyWindowFrame(metaWindow, x, y, w, h, true);
    }

    _emitIpcStateChanged(reason = 'updated') {
        if (this.ipcService && typeof this.ipcService.emitStateChanged === 'function') {
            this.ipcService.emitStateChanged(reason);
        }
    }

    _warpCursorToPoint(x, y) {
        let tx = Math.round(x);
        let ty = Math.round(y);
        try {
            let backend = Clutter.get_default_backend && Clutter.get_default_backend();
            let seat = backend && backend.get_default_seat && backend.get_default_seat();
            if (seat && typeof seat.warp_pointer === 'function') {
                seat.warp_pointer(tx, ty);
                return true;
            }
        } catch (e) {
            // Fall through to GDK pointer warp
        }
        try {
            let display = Gdk.Display.get_default();
            if (!display) return false;
            let screen = display.get_default_screen();
            let seat = typeof display.get_default_seat === 'function' ? display.get_default_seat() : null;
            let ptr = seat ? seat.get_pointer() : null;
            if (ptr && typeof ptr.warp === 'function' && screen) {
                ptr.warp(screen, tx, ty);
                return true;
            }
            if (typeof display.warp_pointer === 'function' && screen) {
                display.warp_pointer(screen, tx, ty);
                return true;
            }
        } catch (e) {
            // Ignore pointer warp errors outside graphical X11 display
        }
        return false;
    }

    _warpCursorToWindow(metaWindow) {
        if (!this.settings || !this.settings.cursorFollowsFocus || !metaWindow) return false;
        let rect = null;
        try {
            rect = metaWindow.get_frame_rect();
        } catch (e) {
            return false;
        }
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;

        try {
            let [px, py] = global.get_pointer();
            if (px >= rect.x && px < rect.x + rect.width &&
                py >= rect.y && py < rect.y + rect.height) {
                return false;
            }
        } catch (e) {
            // Proceed if pointer coordinates cannot be queried
        }

        return this._warpCursorToPoint(
            rect.x + Math.round(rect.width / 2),
            rect.y + Math.round(rect.height / 2)
        );
    }

    _scheduleCursorWarp(metaWindow, delayMs = 0) {
        if (!this.settings || !this.settings.cursorFollowsFocus || !metaWindow) return;
        let winId = metaWindow.get_stable_sequence();
        if (delayMs > 0) {
            this._addTimeout(delayMs, () => {
                if (this._windowSignals.has(winId)) {
                    this._warpCursorToWindow(metaWindow);
                }
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._warpCursorToWindow(metaWindow);
        }
    }

    _getOrderedMonitorIndices() {
        let n = global.display.get_n_monitors();
        let monitors = [];
        for (let i = 0; i < n; i++) {
            let geo = global.display.get_monitor_geometry(i);
            monitors.push({ idx: i, x: geo ? geo.x : i, y: geo ? geo.y : 0 });
        }
        monitors.sort((a, b) => (a.x - b.x) || (a.y - b.y) || (a.idx - b.idx));
        return monitors.map(m => m.idx);
    }

    moveFocusedToWorkspace(delta) {
        let focusWin = this._getActiveNormalWindow();
        if (!focusWin) return false;

        let wsMgr = global.workspace_manager;
        let nWs = wsMgr.get_n_workspaces();
        if (nWs < 2) return false;

        let curWs = focusWin.get_workspace() || wsMgr.get_active_workspace();
        let curIdx = curWs ? curWs.index() : 0;
        let step = delta < 0 ? -1 : (delta > 0 ? 1 : 0);
        if (step === 0) return false;

        let targetIdx = Math.max(0, Math.min(nWs - 1, curIdx + step));
        if (targetIdx === curIdx) return false;

        let targetWs = wsMgr.get_workspace_by_index(targetIdx);
        if (!targetWs) return false;

        let winId = focusWin.get_stable_sequence();
        let monIdx = focusWin.get_monitor();
        let srcState = this.getState(curIdx, monIdx);
        Layouts.detachWindowFromState(srcState, winId);

        let destState = this.getState(targetIdx, monIdx);
        if (destState && destState.autoTile && destState.layoutId !== 'floating' && !this.manualFloating.has(winId)) {
            try {
                if (focusWin.get_maximized()) {
                    focusWin.unmaximize(Meta.MaximizeFlags.BOTH);
                }
            } catch (e) {
                // ignore unmaximize errors on closing window
            }
            if (!destState.windowOrder.includes(winId)) {
                destState.windowOrder.push(winId);
            }
            if (Array.isArray(destState.fullWindowOrder) && !destState.fullWindowOrder.includes(winId)) {
                destState.fullWindowOrder.push(winId);
            }
        }

        try {
            focusWin.change_workspace(targetWs);
        } catch (e) {
            global.logError(`[${this.uuid}] Failed to move window to workspace ${targetIdx}: ${e}`);
            return false;
        }
        let now = global.get_current_time();
        if (typeof targetWs.activate_with_focus === 'function') {
            try {
                targetWs.activate_with_focus(focusWin, now);
            } catch (e) {
                targetWs.activate(now);
                WindowRules.safeActivateWindow(focusWin, now);
            }
        } else {
            targetWs.activate(now);
            WindowRules.safeActivateWindow(focusWin, now);
        }

        this._savePersistedStates();
        this.queueRetile(true);
        this._scheduleCursorWarp(focusWin, 50);
        this._emitIpcStateChanged('workspace-moved');

        if (this.osd) {
            let wsLabel = (typeof Main.getWorkspaceName === 'function' ? Main.getWorkspaceName(targetIdx) : null) ||
                _('Workspace %d').replace('%d', String(targetIdx + 1));
            let destMeta = Layouts.getLayoutMeta(destState && destState.autoTile ? destState.layoutId : 'floating');
            this.osd.show(
                `WS ${targetIdx + 1}`,
                wsLabel,
                focusWin.get_title() || focusWin.get_wm_class() || '',
                destMeta.iconFile,
                monIdx
            );
        }
        return true;
    }

    moveFocusedToAdjacentMonitor(step = 1) {
        let ordered = this._getOrderedMonitorIndices();
        if (ordered.length < 2) return false;

        let focusWin = this._getActiveNormalWindow();
        if (!focusWin) return false;

        let curMon = focusWin.get_monitor();
        let pos = ordered.indexOf(curMon);
        if (pos === -1) pos = 0;
        let dirStep = step < 0 ? -1 : 1;
        let targetMon = ordered[(pos + dirStep + ordered.length) % ordered.length];
        if (targetMon === curMon) return false;

        let ws = focusWin.get_workspace() || global.workspace_manager.get_active_workspace();
        if (!ws) return false;

        this._moveWindowAcrossMonitors(focusWin, ws.index(), curMon, targetMon, dirStep < 0 ? 'left' : 'right');
        this._scheduleCursorWarp(focusWin, 50);
        this._emitIpcStateChanged('monitor-moved');

        if (this.osd) {
            let destState = this.getState(ws.index(), targetMon);
            let meta = Layouts.getLayoutMeta(destState && destState.autoTile ? destState.layoutId : 'floating');
            this.osd.show(
                `MON ${targetMon + 1}`,
                _('Moved to Monitor %d').replace('%d', String(targetMon + 1)),
                focusWin.get_title() || focusWin.get_wm_class() || '',
                meta.iconFile,
                targetMon
            );
        }
        return true;
    }

    focusMonitorStep(step = 1) {
        let ordered = this._getOrderedMonitorIndices();
        if (ordered.length < 2) return false;

        let focusWin = this._getActiveNormalWindow();
        let curMon = focusWin ? focusWin.get_monitor() : global.display.get_current_monitor();
        let pos = ordered.indexOf(curMon);
        if (pos === -1) pos = 0;
        let dirStep = step < 0 ? -1 : 1;
        let targetMon = ordered[(pos + dirStep + ordered.length) % ordered.length];
        if (targetMon === curMon) return false;

        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs) return false;
        let wsIdx = activeWs.index();
        let targetState = this.getState(wsIdx, targetMon);

        let candidates = activeWs.list_windows().filter(w =>
            w &&
            w.get_monitor() === targetMon &&
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.minimized &&
            !w.is_skip_taskbar() &&
            !(this.scratchpad && this.scratchpad.has(w.get_stable_sequence()) && this.scratchpad.isHidden && this.scratchpad.isHidden(w.get_stable_sequence()))
        );

        let targetWin = null;
        if (targetState && targetState.focusedId) {
            targetWin = candidates.find(w => w.get_stable_sequence() === targetState.focusedId) || null;
        }
        if (!targetWin && candidates.length > 0) {
            candidates.sort((a, b) => (b.get_user_time() || 0) - (a.get_user_time() || 0));
            targetWin = candidates[0];
        }

        if (targetWin) {
            WindowRules.safeRaiseWindow(targetWin);
            WindowRules.safeActivateWindow(targetWin, global.get_current_time());
            this._scheduleCursorWarp(targetWin, 0);
            if (!this._showStackPositionOsd(targetState, targetWin, wsIdx, targetMon) && this.osd) {
                let meta = Layouts.getLayoutMeta(targetState && targetState.autoTile ? targetState.layoutId : 'floating');
                this.osd.show(
                    `MON ${targetMon + 1}`,
                    targetWin.get_title() || targetWin.get_wm_class() || '',
                    _('Monitor %d').replace('%d', String(targetMon + 1)),
                    meta.iconFile,
                    targetMon
                );
            }
        } else {
            if (this.settings && this.settings.cursorFollowsFocus) {
                let area = activeWs.get_work_area_for_monitor(targetMon);
                if (area) {
                    this._warpCursorToPoint(
                        area.x + Math.round(area.width / 2),
                        area.y + Math.round(area.height / 2)
                    );
                }
            }
            if (this.osd) {
                let meta = Layouts.getLayoutMeta(targetState && targetState.autoTile ? targetState.layoutId : 'floating');
                this.osd.show(
                    `MON ${targetMon + 1}`,
                    _('Monitor %d').replace('%d', String(targetMon + 1)),
                    _('Empty monitor'),
                    meta.iconFile,
                    targetMon
                );
            }
        }
        return true;
    }

    getOpenWindowsInfo() {
        let wsMgr = global.workspace_manager;
        let activeWs = wsMgr.get_active_workspace();
        let activeWsIdx = activeWs ? activeWs.index() : 0;
        let focusWin = global.display.focus_window;
        let focusId = focusWin ? focusWin.get_stable_sequence() : null;
        let actors = typeof Meta.get_window_actors === 'function'
            ? Meta.get_window_actors(global.display)
            : global.get_window_actors();
        let out = [];

        for (let actor of actors) {
            let mw = actor && typeof actor.get_meta_window === 'function' ? actor.get_meta_window() : null;
            if (!mw || mw.get_window_type() !== Meta.WindowType.NORMAL || mw.is_skip_taskbar()) continue;
            let winId = mw.get_stable_sequence();
            let ws = mw.get_workspace();
            let wsIdx = ws ? ws.index() : -1;
            let monIdx = mw.get_monitor();
            let state = wsIdx >= 0 ? this.getState(wsIdx, monIdx) : null;
            let rect = mw.get_frame_rect();
            let floating = !state || !state.autoTile || state.layoutId === 'floating' ||
                this.manualFloating.has(winId) || !state.windowOrder.includes(winId);
            let tileRect = state && state.lastRects ? state.lastRects.get(winId) : null;
            let tabGroup = state ? Layouts.findTabGroupForWindow(state, winId) : null;

            out.push({
                id: winId,
                title: mw.get_title() || '',
                wmClass: mw.get_wm_class() || '',
                workspace: wsIdx,
                onActiveWorkspace: wsIdx === activeWsIdx,
                monitor: monIdx,
                focused: winId === focusId,
                minimized: Boolean(mw.minimized),
                floating,
                stacked: Boolean((tabGroup && tabGroup.length > 1) || (tileRect && tileRect.stacked)),
                scratchpad: Boolean(this.scratchpad && this.scratchpad.has(winId)),
                pip: Boolean((this.pipWindows && this.pipWindows.has(winId)) ||
                    (mw.is_on_all_workspaces() && mw.is_above() && !(this.scratchpad && this.scratchpad.has(winId)))),
                rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
            });
        }

        return out;
    }
}

let extensionInstance = null;
let _lastMetadata = null;

function init(metadata) {
    _lastMetadata = metadata;
    if (extensionInstance && extensionInstance._enabled) {
        try {
            extensionInstance.disable();
        } catch (e) {
            global.logError(`[${_runtimeUuid}] Failed to disable previous instance during init: ${e}`);
        }
        if (global.__cinnawm === extensionInstance) {
            global.__cinnawm = null;
        }
    }
    try {
        extensionInstance = new CinnaWMExtension(metadata);
    } catch (e) {
        global.logError(`[${_runtimeUuid}] Failed to initialize extension: ${e}`);
        extensionInstance = null;
    }
}

function enable() {
    try {
        if (global.__cinnawm && global.__cinnawm !== extensionInstance) {
            try {
                global.__cinnawm.disable();
            } catch (e) {
                global.logError(`[${_runtimeUuid}] Failed to disable stale active instance before enable: ${e}`);
            } finally {
                global.__cinnawm = null;
            }
        }
        if (!extensionInstance && _lastMetadata) {
            extensionInstance = new CinnaWMExtension(_lastMetadata);
        }
        if (!extensionInstance) return null;
        extensionInstance.enable();
        global.__cinnawm = extensionInstance;
        return {
            instance: extensionInstance,
            onResetRatiosClicked: () => extensionInstance && extensionInstance.resetCurrentLayoutRatios(),
            onOpenQuickGridClicked: () => extensionInstance && extensionInstance.quickGrid && extensionInstance.quickGrid.open(),
            onCycleLayoutClicked: () => extensionInstance && extensionInstance.cycleLayout(1),
            setLayoutById: (id) => extensionInstance && extensionInstance.setLayoutById(id)
        };
    } catch (e) {
        global.logError(`[${_runtimeUuid}] Failed to enable extension: ${e}`);
        return null;
    }
}

function disable() {
    if (global.__cinnawm === extensionInstance) {
        global.__cinnawm = null;
    }
    if (extensionInstance) {
        try {
            extensionInstance.disable();
        } catch (e) {
            global.logError(`[${_runtimeUuid}] Failed to disable extension cleanly: ${e}`);
        } finally {
            extensionInstance = null;
        }
    }
}

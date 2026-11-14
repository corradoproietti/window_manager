// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Workspace/Monitor State Model & Disk Persistence
 */

const ByteArray = imports.byteArray;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Layouts = require('./layouts');
const RuntimeConfig = require('./runtime-config');

function getWindowPersistenceBase(metaWindow) {
    if (!metaWindow) return '';
    let wmClass = (metaWindow.get_wm_class() || '').trim().toLowerCase();
    let wmInstance = (metaWindow.get_wm_class_instance() || '').trim().toLowerCase();
    let role = (metaWindow.get_role() || '').trim().toLowerCase();
    return JSON.stringify([wmClass, wmInstance, role]);
}

function buildWindowPersistenceKeys(windowEntries) {
    let counts = new Map();
    let keys = new Map();
    for (let [winId, metaWindow] of windowEntries) {
        let base = getWindowPersistenceBase(metaWindow);
        let ordinal = counts.get(base) || 0;
        counts.set(base, ordinal + 1);
        keys.set(winId, `${base}#${ordinal}`);
    }
    return keys;
}

/**
 * Holds independent layout state for a single (workspaceIndex, monitorIndex) pair.
 */
class WorkspaceMonitorState {
    constructor(defaultSettings = {}) {
        this.layoutId = defaultSettings.defaultLayout || 'dwindle';
        this.previousLayoutId = null;
        this.autoTile = (defaultSettings.autoTilingEnabled !== false) && (this.layoutId !== 'floating');
        this.masterRatio = (defaultSettings.masterRatioPct || 55) / 100.0;
        this.centeredMasterRatio = (defaultSettings.centeredMasterRatioPct || 50) / 100.0;
        this.centeredLeftRatio = null;
        this.centeredRightRatio = null;
        this.masterCount = defaultSettings.masterCount || 1;
        this.masterOrientation = defaultSettings.masterOrientation || 'left';
        this.windowOrder = []; // ordered array of visible window stable sequences
        this.fullWindowOrder = []; // ordered array of all tiled window sequences (including minimized / show-desktop)
        this.pendingWindowKeys = null; // persistent semantic order awaiting current-session window IDs
        this.tabGroups = []; // array of manual tab group arrays: [[winId1, winId2, ...], ...]
        this.activeTabMap = new Map(); // leaderWinId -> active winId in that manual tab group
        this.pendingTabGroups = null; // persistent semantic tab groups awaiting current-session window IDs
        this.weights = new Map(); // winId -> relative vertical weight (default 1.0)
        this.colWeights = new Map(); // winId -> relative horizontal weight (default 1.0)
        this.gridRowWeights = new Map(); // rowIdx -> relative weight (default 1.0)
        this.bspTree = new Layouts.BspTree();
        this.savedBspSnapshot = null; // { root, windowOrder } preserved across Super+D / minimize
        this.savedFocusedId = null;
        this.savedScrollOffset = 0;
        this._hadMinimizedWindows = false;
        this._justRestoredFromMinimize = false;
        this.scrollOffset = 0;
        this.focusedId = null;
        this.lastFocusedId = null;
        this.lastRects = new Map(); // winId -> { x, y, width, height, offscreen? }
    }
}

function getPersistedStatesPath(uuid) {
    return RuntimeConfig.getSpicesConfigFile(uuid, 'workspace-layouts.json', true);
}

function loadPersistedStates(wm) {
    try {
        let path = getPersistedStatesPath(wm.uuid);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return;
        let [ok, bytes] = GLib.file_get_contents(path);
        if (!ok || !bytes) return;
        let data = JSON.parse(ByteArray.toString(bytes));
        if (!data || typeof data !== 'object') return;

        if (data.panelPosition && typeof data.panelPosition === 'object') {
            wm._panelPosition = {
                panelId: data.panelPosition.panelId || null,
                zone: ['left', 'center', 'right'].includes(data.panelPosition.zone) ? data.panelPosition.zone : 'right',
                index: Number.isFinite(data.panelPosition.index) ? Math.max(0, Math.round(data.panelPosition.index)) : 0
            };
        }

        if (data.customSettings && typeof data.customSettings === 'object') {
            for (let [k, v] of Object.entries(data.customSettings)) {
                if (Object.prototype.hasOwnProperty.call(wm.settings, k) && !k.startsWith('kb')) {
                    wm.settings[k] = v;
                }
            }
        }

        if (!data.states || typeof data.states !== 'object') return;

        for (let [key, saved] of Object.entries(data.states)) {
            if (!saved || typeof saved !== 'object') continue;
            let st = new WorkspaceMonitorState(wm.settings);
            if (typeof saved.layoutId === 'string' && Layouts.LAYOUTS.some(l => l.id === saved.layoutId)) {
                st.layoutId = saved.layoutId;
            }
            if (typeof saved.previousLayoutId === 'string' && Layouts.LAYOUTS.some(l => l.id === saved.previousLayoutId)) {
                st.previousLayoutId = saved.previousLayoutId;
            }
            if (typeof saved.autoTile === 'boolean') {
                st.autoTile = saved.autoTile && st.layoutId !== 'floating';
            } else {
                st.autoTile = (wm.settings.autoTilingEnabled !== false) && (st.layoutId !== 'floating');
            }
            if (typeof saved.masterRatio === 'number' && Number.isFinite(saved.masterRatio)) {
                st.masterRatio = Layouts.clamp(saved.masterRatio, 0.15, 0.85);
            }
            if (typeof saved.centeredMasterRatio === 'number' && Number.isFinite(saved.centeredMasterRatio)) {
                st.centeredMasterRatio = Layouts.clamp(saved.centeredMasterRatio, 0.20, 0.80);
            }
            if (typeof saved.centeredLeftRatio === 'number' && Number.isFinite(saved.centeredLeftRatio)) {
                st.centeredLeftRatio = Layouts.clamp(saved.centeredLeftRatio, 0.08, 0.70);
            }
            if (typeof saved.centeredRightRatio === 'number' && Number.isFinite(saved.centeredRightRatio)) {
                st.centeredRightRatio = Layouts.clamp(saved.centeredRightRatio, 0.08, 0.70);
            }
            if (typeof saved.masterCount === 'number' && Number.isFinite(saved.masterCount)) {
                st.masterCount = Layouts.clamp(Math.round(saved.masterCount), 1, 6);
            }
            if (typeof saved.masterOrientation === 'string') {
                st.masterOrientation = saved.masterOrientation;
            }
            if (Array.isArray(saved.windowOrder)) {
                st.windowOrder = saved.windowOrder.filter(id => typeof id === 'number');
                st.fullWindowOrder = st.windowOrder.slice();
            }
            if (Array.isArray(saved.tabGroups)) {
                st.tabGroups = saved.tabGroups
                    .filter(g => Array.isArray(g))
                    .map(g => g.filter(id => typeof id === 'number'))
                    .filter(g => g.length >= 2);
            }
            st.pendingWindowKeys = Array.isArray(saved.windowKeys) ? saved.windowKeys : null;
            st.pendingTabGroups = Array.isArray(saved.tabGroupKeys) ? saved.tabGroupKeys : null;
            if (saved.bspShape && typeof saved.bspShape === 'object') {
                st.bspTree._pendingShape = saved.bspShape;
            }
            st.pendingWeights = Array.isArray(saved.weights) ? saved.weights : null;
            st.pendingColWeights = Array.isArray(saved.colWeights) ? saved.colWeights : null;
            st.pendingGridRowWeights = Array.isArray(saved.gridRowWeights) ? saved.gridRowWeights : null;
            wm._states.set(key, st);
        }
    } catch (e) {
        if (typeof global !== 'undefined' && global.logError) {
            global.logError(`[${wm.uuid}] Failed to load persisted workspace layouts: ${e}`);
        }
    }
}

function savePersistedStates(wm) {
    try {
        let statesObj = {};
        let liveWindowEntries = [];
        if (typeof global !== 'undefined' && global.display) {
            for (let actor of Meta.get_window_actors(global.display)) {
                let win = actor.get_meta_window();
                if (win) liveWindowEntries.push([win.get_stable_sequence(), win]);
            }
        }
        for (let [key, st] of wm._states.entries()) {
            let [wsText, monText] = key.split(':');
            let wsIndex = Number(wsText);
            let monitorIndex = Number(monText);
            let stateWindowEntries = liveWindowEntries.filter(([, win]) => {
                let workspace = win.get_workspace();
                return workspace && workspace.index() === wsIndex && win.get_monitor() === monitorIndex;
            });
            let persistenceKeys = buildWindowPersistenceKeys(stateWindowEntries);
            let effectiveOrder = (Array.isArray(st.fullWindowOrder) && st.fullWindowOrder.length > (Array.isArray(st.windowOrder) ? st.windowOrder.length : 0))
                ? st.fullWindowOrder
                : (Array.isArray(st.windowOrder) ? st.windowOrder : []);
            let validTabGroups = Array.isArray(st.tabGroups)
                ? st.tabGroups.filter(g => Array.isArray(g) && g.length >= 2)
                : [];
            statesObj[key] = {
                layoutId: st.layoutId,
                previousLayoutId: st.previousLayoutId,
                autoTile: st.autoTile,
                masterRatio: st.masterRatio,
                centeredMasterRatio: st.centeredMasterRatio,
                centeredLeftRatio: st.centeredLeftRatio,
                centeredRightRatio: st.centeredRightRatio,
                masterCount: st.masterCount,
                masterOrientation: st.masterOrientation,
                windowOrder: effectiveOrder,
                windowKeys: st.pendingWindowKeys || effectiveOrder.map(id => persistenceKeys.get(id)).filter(Boolean),
                tabGroups: validTabGroups.map(g => g.slice()),
                tabGroupKeys: st.pendingTabGroups || validTabGroups
                    .map(g => g.map(id => persistenceKeys.get(id)).filter(Boolean))
                    .filter(g => g.length >= 2),
                bspShape: st.bspTree._pendingShape || st.bspTree.serializeShape(effectiveOrder),
                weights: st.pendingWeights || Array.from(st.weights.entries()).map(([id, value]) => [effectiveOrder.indexOf(id), value]).filter(([i]) => i >= 0),
                colWeights: st.pendingColWeights || Array.from(st.colWeights.entries()).map(([id, value]) => [effectiveOrder.indexOf(id), value]).filter(([i]) => i >= 0),
                gridRowWeights: st.pendingGridRowWeights || Array.from(st.gridRowWeights.entries())
            };
        }
        let customSettings = {};
        for (let [k, v] of Object.entries(wm.settings)) {
            if (!k.startsWith('kb')) {
                customSettings[k] = v;
            }
        }
        let payload = JSON.stringify({
            version: 2,
            panelPosition: wm._panelPosition,
            customSettings,
            states: statesObj
        }, null, 2);
        GLib.file_set_contents(getPersistedStatesPath(wm.uuid), payload);
    } catch (e) {
        if (typeof global !== 'undefined' && global.logError) {
            global.logError(`[${wm.uuid}] Failed to save persisted workspace layouts: ${e}`);
        }
    }
}

module.exports = {
    getWindowPersistenceBase,
    buildWindowPersistenceKeys,
    WorkspaceMonitorState,
    getPersistedStatesPath,
    loadPersistedStates,
    savePersistedStates
};

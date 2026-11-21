// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Scratchpad Manager (i3 / Sway inspired dropdown/floating scratchpad)
 */

const {
    parseCustomRules,
    isPopupOrDialogWindow,
    evaluateWindow,
    safeRaiseWindow,
    safeActivateWindow,
    safeApplyWindowFrame
} = require('./window-rules');

class ScratchpadManager {
    constructor(wmController) {
        this.wm = wmController;
        this.scratchpadIds = new Set();
        this.windowMap = new Map(); // winId -> Meta.Window
        this.lastShownId = null;
    }

    has(winId) {
        return this.scratchpadIds.has(winId);
    }

    registerWindow(metaWindow, hideImmediately = true) {
        if (!metaWindow) return false;
        let id = metaWindow.get_stable_sequence();
        this.scratchpadIds.add(id);
        this.windowMap.set(id, metaWindow);
        this.lastShownId = id;

        if (hideImmediately) {
            try {
                if (metaWindow.is_above()) {
                    metaWindow.unmake_above();
                }
                metaWindow.minimize();
            } catch (e) {
                // Window might already be closing
            }
        } else {
            this.centerScratchpadWindow(metaWindow);
        }
        return true;
    }

    unregisterWindow(metaWindow) {
        if (!metaWindow) return false;
        let id = metaWindow.get_stable_sequence();
        if (!this.scratchpadIds.has(id)) return false;

        this.scratchpadIds.delete(id);
        this.windowMap.delete(id);
        if (this.lastShownId === id) {
            let remaining = Array.from(this.scratchpadIds);
            this.lastShownId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        }
        try {
            if (metaWindow.is_above()) {
                metaWindow.unmake_above();
            }
            if (metaWindow.minimized) {
                metaWindow.unminimize();
            }
        } catch (e) {
            // Window might already be unmanaging or disposed
        }
        return true;
    }

    onWindowClosed(winId) {
        this.scratchpadIds.delete(winId);
        this.windowMap.delete(winId);
        if (this.lastShownId === winId) {
            let remaining = Array.from(this.scratchpadIds);
            this.lastShownId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        }
    }

    /**
     * Toggles whether the currently focused window is in the Scratchpad (Super+Shift+S)
     */
    toggleWindowRegistration(metaWindow) {
        if (!metaWindow) return { status: 'none' };
        let id = metaWindow.get_stable_sequence();
        if (this.scratchpadIds.has(id)) {
            this.unregisterWindow(metaWindow);
            return { status: 'removed', window: metaWindow };
        } else {
            this.registerWindow(metaWindow, true);
            return { status: 'added', window: metaWindow };
        }
    }

    /**
     * Shows or hides the Scratchpad window on the current workspace/monitor (Super+S / Super+Grave)
     */
    toggleShow() {
        // Prune dead windows
        for (let [id, win] of this.windowMap.entries()) {
            let alive = Boolean(win);
            if (alive) {
                try {
                    win.get_stable_sequence();
                } catch (e) {
                    alive = false;
                }
            }
            if (!alive) {
                this.onWindowClosed(id);
            }
        }

        if (this.scratchpadIds.size === 0) {
            return { status: 'empty' };
        }

        let focusWin = global.display.focus_window;
        if (focusWin) {
            let focusId = focusWin.get_stable_sequence();
            if (this.scratchpadIds.has(focusId) && !focusWin.minimized) {
                try {
                    if (focusWin.is_above()) {
                        focusWin.unmake_above();
                    }
                    focusWin.minimize();
                } catch (e) {
                    // ignore disposed focus window
                }
                return { status: 'hidden', window: focusWin };
            }
        }

        // Pick lastShownId or first available
        let targetId = (this.lastShownId && this.scratchpadIds.has(this.lastShownId))
            ? this.lastShownId
            : Array.from(this.scratchpadIds)[0];

        let targetWin = this.windowMap.get(targetId);
        if (!targetWin) {
            this.onWindowClosed(targetId);
            return { status: 'empty' };
        }

        this.lastShownId = targetId;
        this.showScratchpadWindow(targetWin);
        return { status: 'shown', window: targetWin };
    }

    showScratchpadWindow(metaWindow) {
        if (!metaWindow) return false;
        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs) return false;
        let activeWsIndex = activeWs.index();
        let currentMonitor = global.display.get_current_monitor();

        try {
            let winWs = metaWindow.get_workspace();
            if (winWs && winWs.index() !== activeWsIndex) {
                metaWindow.change_workspace_by_index(activeWsIndex, false);
            }
            if (metaWindow.get_monitor() !== currentMonitor) {
                metaWindow.move_to_monitor(currentMonitor);
            }
            if (metaWindow.minimized) {
                metaWindow.unminimize();
            }
        } catch (e) {
            if (typeof global !== 'undefined' && global.logError) {
                global.logError(`[${this.wm ? this.wm.uuid : 'cinnawm'}] showScratchpadWindow error: ${e}`);
            }
            return false;
        }

        this.centerScratchpadWindow(metaWindow, currentMonitor, activeWs);
        try {
            metaWindow.make_above();
        } catch (e) {
            // ignore if window no longer accepts above state
        }
        safeRaiseWindow(metaWindow);
        safeActivateWindow(metaWindow, global.get_current_time());
        return true;
    }

    centerScratchpadWindow(metaWindow, monitorIndex = null, workspace = null) {
        if (!metaWindow) return false;
        try {
            let monIdx = (monitorIndex !== null) ? monitorIndex : metaWindow.get_monitor();
            let ws = workspace || metaWindow.get_workspace();
            if (!ws) return false;
            let workarea = ws.get_work_area_for_monitor(monIdx);
            if (!workarea || workarea.width <= 0 || workarea.height <= 0) return false;

            let widthPct = (this.wm.settings.scratchpadWidthPct || 75) / 100.0;
            let heightPct = (this.wm.settings.scratchpadHeightPct || 70) / 100.0;

            let w = Math.round(workarea.width * widthPct);
            let h = Math.round(workarea.height * heightPct);
            let x = workarea.x + Math.round((workarea.width - w) / 2);
            let y = workarea.y + Math.round((workarea.height - h) / 2);

            return safeApplyWindowFrame(metaWindow, x, y, w, h, true);
        } catch (e) {
            return false;
        }
    }

    destroy() {
        for (let win of this.windowMap.values()) {
            try {
                if (win && win.is_above()) {
                    win.unmake_above();
                }
            } catch (e) {
                // ignore already destroyed windows
            }
        }
        this.scratchpadIds.clear();
        this.windowMap.clear();
    }
}

module.exports = {
    parseCustomRules,
    isPopupOrDialogWindow,
    evaluateWindow,
    ScratchpadManager
};

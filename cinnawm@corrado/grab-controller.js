// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Mouse Interaction Controller
 * Handles Drag-to-Swap, Drag-to-Split, Ctrl+Drag Edge Snap Zones, & Live Edge Resize
 */

const Clutter = imports.gi.Clutter;
const Gettext = imports.gettext;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
let Main = null;
try {
    Main = imports.ui.main;
} catch (e) {}

const Layouts = require('./layouts');
const RuntimeConfig = require('./runtime-config');
const WindowRules = require('./window-rules');

const UUID = RuntimeConfig.resolveUuid();
function _(str) {
    return Gettext.dgettext(UUID, str);
}

const MOUSE_RESIZE_GRAB_OPS = new Set([
    Meta.GrabOp.RESIZING_NW,
    Meta.GrabOp.RESIZING_N,
    Meta.GrabOp.RESIZING_NE,
    Meta.GrabOp.RESIZING_E,
    Meta.GrabOp.RESIZING_SW,
    Meta.GrabOp.RESIZING_S,
    Meta.GrabOp.RESIZING_SE,
    Meta.GrabOp.RESIZING_W
]);

const RESIZE_GRAB_OPS = new Set([
    ...MOUSE_RESIZE_GRAB_OPS,
    Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
    Meta.GrabOp.KEYBOARD_RESIZING_NW,
    Meta.GrabOp.KEYBOARD_RESIZING_N,
    Meta.GrabOp.KEYBOARD_RESIZING_NE,
    Meta.GrabOp.KEYBOARD_RESIZING_E,
    Meta.GrabOp.KEYBOARD_RESIZING_SW,
    Meta.GrabOp.KEYBOARD_RESIZING_S,
    Meta.GrabOp.KEYBOARD_RESIZING_SE,
    Meta.GrabOp.KEYBOARD_RESIZING_W
]);

/**
 * Safely extracts { window, op } from `grab-op-begin` / `grab-op-end` signal arguments
 * across Muffin versions (handles both 3-arg and 4-arg signal signatures).
 */
function parseGrabOpArgs(args) {
    let win = null;
    let op = Meta.GrabOp.NONE;
    for (let i = 1; i < args.length; i++) {
        if (args[i] instanceof Meta.Window) {
            win = args[i];
            if (i + 1 < args.length && typeof args[i + 1] === 'number') {
                op = args[i + 1];
            }
            break;
        }
    }
    if (!win && typeof args[args.length - 1] === 'number') {
        op = args[args.length - 1];
    }
    return { window: win, op };
}

/**
 * Disambiguates edge vs corner resize grabs so clicking along a vertical border (left/right)
 * never triggers vertical height changes even if Muffin classified the hit-zone as a corner.
 */
function normalizeResizeGrabOp(op, px, py, rect) {
    if (!rect) return op;
    let isCorner = (op === Meta.GrabOp.RESIZING_NW ||
                    op === Meta.GrabOp.RESIZING_NE ||
                    op === Meta.GrabOp.RESIZING_SW ||
                    op === Meta.GrabOp.RESIZING_SE);
    if (!isCorner) return op;

    let distLeft = Math.abs(px - rect.x);
    let distRight = Math.abs(px - (rect.x + rect.width));
    let distTop = Math.abs(py - rect.y);
    let distBottom = Math.abs(py - (rect.y + rect.height));
    let minX = Math.min(distLeft, distRight);
    let minY = Math.min(distTop, distBottom);

    if (minX <= 24 && minY > 28) {
        return (distLeft <= distRight) ? Meta.GrabOp.RESIZING_W : Meta.GrabOp.RESIZING_E;
    }
    if (minY <= 24 && minX > 28) {
        return (distTop <= distBottom) ? Meta.GrabOp.RESIZING_N : Meta.GrabOp.RESIZING_S;
    }
    return op;
}

function computeEdgeSnapZone(px, py, workarea, settings = {}) {
    let outer = Number.isFinite(settings.outerGap) ? settings.outerGap : 8;
    let inner = Number.isFinite(settings.innerGap) ? settings.innerGap : 8;
    let ax = workarea.x + outer;
    let ay = workarea.y + outer;
    let aw = Math.max(100, workarea.width - 2 * outer);
    let ah = Math.max(100, workarea.height - 2 * outer);

    let leftW = Math.round((aw - inner) / 2);
    let rightX = ax + leftW + inner;
    let rightW = (ax + aw) - rightX;

    let topH = Math.round((ah - inner) / 2);
    let bottomY = ay + topH + inner;
    let bottomH = (ay + ah) - bottomY;

    let rx = (px - workarea.x) / Math.max(1, workarea.width);
    let ry = (py - workarea.y) / Math.max(1, workarea.height);

    if (rx < 0.25 && ry < 0.25) {
        return { label: '↖ Top-Left ¼', rect: { x: ax, y: ay, width: leftW, height: topH } };
    }
    if (rx > 0.75 && ry < 0.25) {
        return { label: '↗ Top-Right ¼', rect: { x: rightX, y: ay, width: rightW, height: topH } };
    }
    if (rx < 0.25 && ry > 0.75) {
        return { label: '↙ Bottom-Left ¼', rect: { x: ax, y: bottomY, width: leftW, height: bottomH } };
    }
    if (rx > 0.75 && ry > 0.75) {
        return { label: '↘ Bottom-Right ¼', rect: { x: rightX, y: bottomY, width: rightW, height: bottomH } };
    }
    if (rx < 0.22) {
        return { label: '← Left ½', rect: { x: ax, y: ay, width: leftW, height: ah } };
    }
    if (rx > 0.78) {
        return { label: '→ Right ½', rect: { x: rightX, y: ay, width: rightW, height: ah } };
    }
    if (ry < 0.18) {
        return { label: '↑ Center 70%', rect: { x: ax + Math.round(aw * 0.15), y: ay, width: Math.round(aw * 0.70), height: ah } };
    }
    return null;
}

class GrabController {
    constructor(wm) {
        this.wm = wm;
    }

    onGrabOpBegin(metaWindow, op) {
        let wm = this.wm;
        if (!metaWindow || metaWindow.get_window_type() !== Meta.WindowType.NORMAL) return;

        let winId = metaWindow.get_stable_sequence();
        if (wm.scratchpad && wm.scratchpad.has(winId)) return;
        if (WindowRules.isPopupOrDialogWindow(metaWindow)) return;

        let ws = metaWindow.get_workspace();
        if (!ws) return;
        let wsIdx = ws.index();
        let monIdx = metaWindow.get_monitor();
        let state = wm.getState(wsIdx, monIdx);

        let isMoving = (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING);
        let isResizing = RESIZE_GRAB_OPS.has(op);

        if (!isMoving && !isResizing) return;

        // Floating windows (not in state.windowOrder) move and resize freely as independent windows
        if (!state.windowOrder.includes(winId)) return;

        let [startPx, startPy, startMods] = global.get_pointer();
        let buttonMask = Clutter.ModifierType.BUTTON1_MASK |
                         Clutter.ModifierType.BUTTON2_MASK |
                         Clutter.ModifierType.BUTTON3_MASK;
        let isMouseResize = MOUSE_RESIZE_GRAB_OPS.has(op) && (startMods & buttonMask) !== 0;
        let usePreviewResize = isMouseResize &&
                               Boolean(wm.settings.mouseEdgeResize) &&
                               state.autoTile &&
                               state.layoutId !== 'floating' &&
                               state.windowOrder.includes(winId);

        let startRect = metaWindow.get_frame_rect();
        let tiledRect = state.lastRects.get(winId);
        let effStartRect = tiledRect
            ? { ...tiledRect }
            : { x: startRect.x, y: startRect.y, width: startRect.width, height: startRect.height };
        if (isResizing) {
            op = normalizeResizeGrabOp(op, startPx, startPy, effStartRect);
        }

        let startLastRects = new Map();
        for (let [id, r] of state.lastRects.entries()) {
            startLastRects.set(id, { ...r });
        }

        wm._grabState = {
            window: metaWindow,
            winId,
            op,
            isMoving,
            isResizing,
            usePreviewResize,
            ignoringEndGrabSignal: usePreviewResize,
            startPx,
            startPy,
            lastPx: startPx,
            lastPy: startPy,
            startWsIdx: wsIdx,
            startMonIdx: monIdx,
            startRect: effStartRect,
            startLastRects,
            startMasterRatio: state.masterRatio,
            startCenteredMasterRatio: state.centeredMasterRatio,
            startCenteredLeftRatio: state.centeredLeftRatio,
            startCenteredRightRatio: state.centeredRightRatio,
            startWeights: new Map(state.weights),
            startColWeights: new Map(state.colWeights),
            startGridRowWeights: new Map(state.gridRowWeights),
            startBspRoot: state.bspTree.snapshot(),
            lastPolledRect: null,
            hoverTargetWinId: null,
            hoverSnapRect: null
        };

        if (usePreviewResize) {
            if (wm.resizePreview) {
                wm.resizePreview.showOverlay();
            }
            this.updateResizePreview(startPx, startPy);

            if (wm._previewIdleId) {
                GLib.source_remove(wm._previewIdleId);
                wm._previewIdleId = 0;
            }
            wm._previewIdleId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                wm._previewIdleId = 0;
                if (wm._enabled && wm._grabState && wm._grabState.usePreviewResize) {
                    try {
                        if (typeof global.display.end_grab_op === 'function' &&
                            global.display.get_grab_op() !== Meta.GrabOp.NONE) {
                            global.display.end_grab_op(global.get_current_time());
                        }
                    } catch (e) {
                        // ignore
                    }
                    wm._isApplyingLayout = true;
                    try {
                        wm._applyWindowRect(metaWindow, wm._grabState.startRect);
                    } finally {
                        wm._isApplyingLayout = false;
                    }
                    if (wm.activeBorder) {
                        wm.activeBorder.sync();
                    }
                    if (wm.resizePreview) {
                        wm.resizePreview.acquireModal();
                        this.updateResizePreview(wm._grabState.lastPx, wm._grabState.lastPy);
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
        }

        if ((isMoving && wm.settings.mouseDragSwap) || (isResizing && wm.settings.mouseEdgeResize)) {
            this.startDragPolling();
        }
    }

    restoreResizeSnapshot(grab, state) {
        if (!grab || !state) return;
        state.masterRatio = grab.startMasterRatio;
        state.centeredMasterRatio = grab.startCenteredMasterRatio;
        state.centeredLeftRatio = grab.startCenteredLeftRatio;
        state.centeredRightRatio = grab.startCenteredRightRatio;
        state.weights = new Map(grab.startWeights);
        state.colWeights = new Map(grab.startColWeights);
        state.gridRowWeights = new Map(grab.startGridRowWeights);
        if (grab.startBspRoot) {
            state.bspTree.restore(grab.startBspRoot);
            grab.startBspRoot = state.bspTree.snapshot();
        }
    }

    updateResizePreview(px, py) {
        let wm = this.wm;
        let grab = wm._grabState;
        if (!grab || !grab.window || !wm.resizePreview) return;
        let ws = grab.window.get_workspace();
        if (!ws) return;
        let wsIdx = ws.index();
        let monIdx = grab.window.get_monitor();
        let state = wm.getState(wsIdx, monIdx);
        if (!state.autoTile || state.layoutId === 'floating') return;

        this.applyMouseEdgeResize(grab, px, py);
        let workarea = ws.get_work_area_for_monitor(monIdx);
        let previewRects = Layouts.computeLayoutRects(
            state.layoutId,
            state.windowOrder,
            workarea,
            state,
            wm.settings,
            wm._windowMinSizes
        );
        wm.resizePreview.showRects(previewRects, grab.startLastRects, grab.winId, workarea, grab.snappedPct);
    }

    finishPreviewResize(cancelled = false) {
        let wm = this.wm;
        let grab = wm._grabState;
        if (!grab) return;
        wm._grabState = null;
        this.stopDragPolling();

        let state = wm.getState(grab.startWsIdx, grab.startMonIdx);
        if (cancelled) {
            this.restoreResizeSnapshot(grab, state);
            wm.queueRetile(true);
            return;
        }

        let [px, py] = global.get_pointer();
        this.applyMouseEdgeResize(grab, px, py);
        wm._savePersistedStates();
        wm.queueRetile(true);
    }

    startDragPolling() {
        let wm = this.wm;
        this.stopDragPolling();
        let intervalMs = (wm._grabState && wm._grabState.usePreviewResize) ? 16 : 28;
        wm._dragPollTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            if (!wm._enabled || !wm._grabState || (!wm._grabState.isMoving && !wm._grabState.isResizing)) {
                wm._dragPollTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            }

            try {
                if (wm._grabState.usePreviewResize) {
                    let [px, py, mods] = global.get_pointer();
                    let buttonMask = Clutter.ModifierType.BUTTON1_MASK |
                                     Clutter.ModifierType.BUTTON2_MASK |
                                     Clutter.ModifierType.BUTTON3_MASK;
                    if ((mods & buttonMask) === 0) {
                        wm._dragPollTimeoutId = 0;
                        this.finishPreviewResize(false);
                        return GLib.SOURCE_REMOVE;
                    }
                    if (px !== wm._grabState.lastPx || py !== wm._grabState.lastPy) {
                        wm._grabState.lastPx = px;
                        wm._grabState.lastPy = py;
                        this.updateResizePreview(px, py);
                    }
                    return GLib.SOURCE_CONTINUE;
                }

                if (typeof global.display.get_grab_op === 'function' &&
                    global.display.get_grab_op() === Meta.GrabOp.NONE) {
                    wm._dragPollTimeoutId = 0;
                    wm._grabState = null;
                    if (wm.dropPreview) wm.dropPreview.hide();
                    if (wm.resizePreview) wm.resizePreview.hide();
                    return GLib.SOURCE_REMOVE;
                }
                if (wm._grabState.isMoving) {
                    this.updateDragPreview();
                }
                return GLib.SOURCE_CONTINUE;
            } catch (e) {
                if (typeof global !== 'undefined' && global.logError) {
                    global.logError(`[${wm.uuid || 'cinnawm'}] Drag polling error: ${e}`);
                }
                wm._dragPollTimeoutId = 0;
                wm._grabState = null;
                if (wm.dropPreview) wm.dropPreview.hide();
                if (wm.resizePreview) wm.resizePreview.hide();
                return GLib.SOURCE_REMOVE;
            }
        });
    }

    stopDragPolling() {
        let wm = this.wm;
        if (wm._previewIdleId) {
            GLib.source_remove(wm._previewIdleId);
            wm._previewIdleId = 0;
        }
        if (wm._dragPollTimeoutId) {
            GLib.source_remove(wm._dragPollTimeoutId);
            wm._dragPollTimeoutId = 0;
        }
        if (wm.dropPreview) {
            wm.dropPreview.hide();
        }
        if (wm.resizePreview) {
            wm.resizePreview.hide();
        }
    }

    updateDragPreview() {
        let wm = this.wm;
        if (!wm._grabState) return;
        let [px, py, mods] = global.get_pointer();
        let ctrlHeld = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        let shiftHeld = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;

        let ws = global.workspace_manager.get_active_workspace();
        let wsIdx = ws.index();
        let monIdx = wm._findMonitorAtPoint(px, py);
        let state = wm.getState(wsIdx, monIdx);

        wm._grabState.hoverTargetWinId = null;
        wm._grabState.hoverInsertSide = null;
        wm._grabState.hoverSnapRect = null;

        if (ctrlHeld) {
            let workarea = ws.get_work_area_for_monitor(monIdx);
            let snapZone = computeEdgeSnapZone(px, py, workarea, wm.settings);
            if (snapZone) {
                wm._grabState.hoverSnapRect = snapZone.rect;
                wm.dropPreview.showRect(snapZone.rect, snapZone.label, 'swap');
                return;
            }
        }

        if (state.autoTile && state.layoutId !== 'floating') {
            let tileableMap = wm.getTileableWindowsMap(wsIdx, monIdx);
            let innerGap = Number.isFinite(wm.settings.innerGap) ? wm.settings.innerGap : 8;
            let halfGap = Math.round(innerGap / 2);

            for (let [candidateId, cellRect] of state.lastRects.entries()) {
                if (candidateId === wm._grabState.winId) continue;
                if (px >= cellRect.x && px <= cellRect.x + cellRect.width &&
                    py >= cellRect.y && py <= cellRect.y + cellRect.height) {
                    let targetWin = tileableMap.get(candidateId);
                    let targetName = targetWin ? (targetWin.get_wm_class() || targetWin.get_title() || 'Window') : 'Window';
                    wm._grabState.hoverTargetWinId = candidateId;
                    wm._grabState.hoverTargetMonIdx = monIdx;

                    let relX = (px - cellRect.x) / Math.max(1, cellRect.width);
                    let relY = (py - cellRect.y) / Math.max(1, cellRect.height);
                    let insertSide = null;

                    if (shiftHeld && state.layoutId !== 'monocle') {
                        insertSide = 'tab-group';
                    } else if (state.layoutId === 'scrolling') {
                        if (relX < 0.26) insertSide = 'left';
                        else if (relX > 0.74) insertSide = 'right';
                    } else if (state.layoutId !== 'monocle') {
                        let edgeZone = 0.24;
                        let inCenter = (relX >= edgeZone && relX <= (1 - edgeZone) &&
                                        relY >= edgeZone && relY <= (1 - edgeZone));
                        if (!inCenter) {
                            let dLeft = relX;
                            let dRight = 1 - relX;
                            let dTop = relY;
                            let dBottom = 1 - relY;
                            let minDist = Math.min(dLeft, dRight, dTop, dBottom);
                            if (minDist === dLeft) insertSide = 'left';
                            else if (minDist === dRight) insertSide = 'right';
                            else if (minDist === dTop) insertSide = 'top';
                            else insertSide = 'bottom';
                        }
                    }

                    wm._grabState.hoverInsertSide = insertSide;

                    if (insertSide === 'tab-group') {
                        wm.dropPreview.showRect(cellRect, `📑 ${_('Group as Tabs with')} ${targetName}`, 'split');
                    } else if (insertSide) {
                        let halfW = Math.round(cellRect.width / 2);
                        let halfH = Math.round(cellRect.height / 2);
                        let splitRect = cellRect;
                        let splitLabel = '';

                        if (insertSide === 'left') {
                            splitRect = {
                                x: cellRect.x,
                                y: cellRect.y,
                                width: Math.max(40, halfW - halfGap),
                                height: cellRect.height
                            };
                            splitLabel = `◧ ${_('Insert Left of')} ${targetName}`;
                        } else if (insertSide === 'right') {
                            splitRect = {
                                x: cellRect.x + halfW + halfGap,
                                y: cellRect.y,
                                width: Math.max(40, cellRect.width - halfW - halfGap),
                                height: cellRect.height
                            };
                            splitLabel = `◨ ${_('Insert Right of')} ${targetName}`;
                        } else if (insertSide === 'top') {
                            splitRect = {
                                x: cellRect.x,
                                y: cellRect.y,
                                width: cellRect.width,
                                height: Math.max(40, halfH - halfGap)
                            };
                            splitLabel = `⬒ ${_('Insert Above')} ${targetName}`;
                        } else if (insertSide === 'bottom') {
                            splitRect = {
                                x: cellRect.x,
                                y: cellRect.y + halfH + halfGap,
                                width: cellRect.width,
                                height: Math.max(40, cellRect.height - halfH - halfGap)
                            };
                            splitLabel = `⬓ ${_('Insert Below')} ${targetName}`;
                        }

                        wm.dropPreview.showRect(splitRect, splitLabel, 'split');
                    } else {
                        wm.dropPreview.showRect(cellRect, `⇄ ${_('Swap with')} ${targetName}`, 'swap');
                    }
                    return;
                }
            }
        }

        wm.dropPreview.hide();
    }

    onGrabOpEnd(_metaWindow, _op) {
        let wm = this.wm;
        if (wm._grabState && wm._grabState.ignoringEndGrabSignal) {
            wm._grabState.ignoringEndGrabSignal = false;
            return;
        }
        if (wm._grabState && wm._grabState.usePreviewResize) {
            this.finishPreviewResize(false);
            return;
        }

        let grab = wm._grabState;
        wm._grabState = null;
        this.stopDragPolling();

        if (!grab) return;
        let win = grab.window;
        if (!win) return;

        if (grab.isMoving) {
            if (grab.hoverSnapRect) {
                wm.snapWindowToCustomRect(win, grab.hoverSnapRect);
                return;
            }

            let ws = win.get_workspace();
            if (!ws) return;
            let wsIdx = ws.index();
            let monIdx = (grab.hoverTargetMonIdx !== undefined && grab.hoverTargetMonIdx !== null)
                ? grab.hoverTargetMonIdx
                : win.get_monitor();
            let state = wm.getState(wsIdx, monIdx);

            if (grab.hoverTargetWinId !== null && state.autoTile) {
                if (grab.startMonIdx !== monIdx) {
                    // Cross-monitor drag-and-drop onto a specific cell on target monitor
                    let startState = wm.getState(wsIdx, grab.startMonIdx);
                    Layouts.detachWindowFromState(startState, grab.winId);

                    if (win.get_monitor() !== monIdx) {
                        win.move_to_monitor(monIdx);
                    }
                    if (grab.hoverInsertSide === 'tab-group' && typeof wm.groupWindowsInState === 'function') {
                        if (!state.windowOrder.includes(grab.winId)) {
                            state.windowOrder.push(grab.winId);
                        }
                        if (Array.isArray(state.fullWindowOrder) && !state.fullWindowOrder.includes(grab.winId)) {
                            state.fullWindowOrder.push(grab.winId);
                        }
                        wm.groupWindowsInState(state, grab.winId, grab.hoverTargetWinId, wsIdx, monIdx);
                    } else {
                        wm._insertWindowRelativeInState(
                            state,
                            grab.winId,
                            grab.hoverTargetWinId,
                            grab.hoverInsertSide || 'left'
                        );
                    }
                } else if (grab.hoverInsertSide === 'tab-group' && typeof wm.groupWindowsInState === 'function') {
                    wm.groupWindowsInState(state, grab.winId, grab.hoverTargetWinId, wsIdx, monIdx);
                } else if (grab.hoverInsertSide) {
                    wm._insertWindowRelativeInState(
                        state,
                        grab.winId,
                        grab.hoverTargetWinId,
                        grab.hoverInsertSide
                    );
                    wm._savePersistedStates();
                } else {
                    wm._swapWindowIdsInState(state, grab.winId, grab.hoverTargetWinId);
                    wm._savePersistedStates();
                }
            }

            wm.queueRetile(true);
            return;
        }

        if (grab.isResizing && wm.settings.mouseEdgeResize) {
            this.applyMouseEdgeResize(grab);
            wm._savePersistedStates();
            wm.queueRetile(true);
        }
    }

    /**
     * Adjusts weights for an ordered column/row of windows `groupIds` so that dragging an edge
     * of `grab.winId` along `axis` ('x' or 'y') moves ONLY the shared border with its immediate
     * neighbor to the exact pixel coordinate where the user dragged it, leaving all other
     * windows in the stack untouched.
     */
    resizeStackNeighborPair(groupIds, grab, axis, weightsMap, newRect, snapTolerancePx = 0) {
        if (!Array.isArray(groupIds) || groupIds.length < 2 || !grab || !weightsMap) return;
        let pos = groupIds.indexOf(grab.winId);
        if (pos === -1) return;

        let oldSizes = groupIds.map(id => {
            let r = grab.startLastRects && grab.startLastRects.get(id);
            if (!r) return 200;
            return (axis === 'y') ? r.height : r.width;
        });
        let availSpan = oldSizes.reduce((a, b) => a + b, 0);
        if (availSpan <= 0) return;

        let oldRect = grab.startRect;
        let dStart = (axis === 'y') ? (newRect.y - oldRect.y) : (newRect.x - oldRect.x);
        let dEnd = (axis === 'y')
            ? ((newRect.y + newRect.height) - (oldRect.y + oldRect.height))
            : ((newRect.x + newRect.width) - (oldRect.x + oldRect.width));

        let op = grab.op;
        let opStart = (axis === 'y')
            ? (op === Meta.GrabOp.RESIZING_N || op === Meta.GrabOp.RESIZING_NW || op === Meta.GrabOp.RESIZING_NE)
            : (op === Meta.GrabOp.RESIZING_W || op === Meta.GrabOp.RESIZING_NW || op === Meta.GrabOp.RESIZING_SW);
        let opEnd = (axis === 'y')
            ? (op === Meta.GrabOp.RESIZING_S || op === Meta.GrabOp.RESIZING_SW || op === Meta.GrabOp.RESIZING_SE)
            : (op === Meta.GrabOp.RESIZING_E || op === Meta.GrabOp.RESIZING_NE || op === Meta.GrabOp.RESIZING_SE);

        let newSizes = [...oldSizes];
        let k = groupIds.length;
        let modifiedIdx = -1;
        let modifiedPairSum = 0;

        if ((opStart || Math.abs(dStart) > Math.abs(dEnd)) && Math.abs(dStart) >= 1) {
            if (pos > 0) {
                let pairSum = oldSizes[pos - 1] + oldSizes[pos];
                newSizes[pos - 1] = Layouts.clamp(oldSizes[pos - 1] + dStart, 60, Math.max(60, pairSum - 60));
                newSizes[pos] = pairSum - newSizes[pos - 1];
                modifiedIdx = pos;
                modifiedPairSum = pairSum;
            } else {
                let pairSum = oldSizes[0] + oldSizes[1];
                newSizes[0] = Layouts.clamp(oldSizes[0] - dStart, 60, Math.max(60, pairSum - 60));
                newSizes[1] = pairSum - newSizes[0];
                modifiedIdx = 0;
                modifiedPairSum = pairSum;
            }
        } else if ((opEnd || Math.abs(dEnd) >= Math.abs(dStart)) && Math.abs(dEnd) >= 1) {
            if (pos < k - 1) {
                let pairSum = oldSizes[pos] + oldSizes[pos + 1];
                newSizes[pos] = Layouts.clamp(oldSizes[pos] + dEnd, 60, Math.max(60, pairSum - 60));
                newSizes[pos + 1] = pairSum - newSizes[pos];
                modifiedIdx = pos;
                modifiedPairSum = pairSum;
            } else {
                let pairSum = oldSizes[k - 2] + oldSizes[k - 1];
                newSizes[k - 1] = Layouts.clamp(oldSizes[k - 1] + dEnd, 60, Math.max(60, pairSum - 60));
                newSizes[k - 2] = pairSum - newSizes[k - 1];
                modifiedIdx = k - 1;
                modifiedPairSum = pairSum;
            }
        } else {
            return;
        }

        if (snapTolerancePx > 0 && modifiedIdx >= 0 && modifiedPairSum > 120) {
            let snapRes = Layouts.snapRatioValue(newSizes[modifiedIdx] / availSpan, availSpan, snapTolerancePx);
            if (snapRes.snapped) {
                let snappedSize = Layouts.clamp(Math.round(snapRes.ratio * availSpan), 60, Math.max(60, modifiedPairSum - 60));
                let neighborIdx = (modifiedIdx === pos)
                    ? ((opStart || Math.abs(dStart) > Math.abs(dEnd)) ? (pos > 0 ? pos - 1 : 1) : (pos < k - 1 ? pos + 1 : k - 2))
                    : pos;
                if (neighborIdx >= 0 && neighborIdx < k && neighborIdx !== modifiedIdx) {
                    newSizes[modifiedIdx] = snappedSize;
                    newSizes[neighborIdx] = modifiedPairSum - snappedSize;
                    grab.snappedPct = snapRes.snappedPct;
                }
            }
        }

        for (let i = 0; i < k; i++) {
            let w = (newSizes[i] / availSpan) * k;
            weightsMap.set(groupIds[i], Layouts.clamp(w, 0.10, 8.0));
        }
    }

    applyMouseEdgeResize(grab, pointerX = null, pointerY = null) {
        let wm = this.wm;
        let win = grab.window;
        if (!win) return;

        let ws = win.get_workspace();
        if (!ws) return;
        let wsIdx = ws.index();
        let monIdx = win.get_monitor();
        let state = wm.getState(wsIdx, monIdx);

        if (!state.autoTile || state.layoutId === 'floating') return;
        if (!state.windowOrder.includes(grab.winId)) return;

        // Restore initial pre-drag snapshot so cumulative drag deltas never drift
        this.restoreResizeSnapshot(grab, state);
        grab.snappedPct = null;

        let snapTolerancePx = 10;
        try {
            let [, , mods] = global.get_pointer();
            if ((mods & Clutter.ModifierType.SHIFT_MASK) !== 0) {
                snapTolerancePx = 0;
            }
        } catch (e) {
            // ignore in headless tests
        }

        let rawWorkarea = ws.get_work_area_for_monitor(monIdx);
        let cellWinId = Layouts.getTabGroupLeaderId(state, grab.winId);
        let activeTabGroups = Layouts.sanitizeTabGroups(state, state.windowOrder);
        let nonLeaderTabMembers = new Set();
        for (let grp of activeTabGroups) {
            for (let i = 1; i < grp.length; i++) nonLeaderTabMembers.add(grp[i]);
        }
        let effectiveOrder = nonLeaderTabMembers.size > 0
            ? state.windowOrder.filter(id => !nonLeaderTabMembers.has(id))
            : state.windowOrder;
        let cellGrab = (cellWinId !== grab.winId) ? { ...grab, winId: cellWinId } : grab;
        let n = effectiveOrder.length;
        let { area, innerGap } = Layouts.computeEffectiveWorkarea(
            rawWorkarea,
            state.windowOrder.length,
            wm.settings,
            state.layoutId
        );
        let bspConstraints = {
            minSizes: wm._windowMinSizes,
            overflowMinWidth: Math.max(60, Number.isFinite(wm.settings.overflowMinWidthPx) ? wm.settings.overflowMinWidthPx : 220),
            overflowMinHeight: Math.max(60, Number.isFinite(wm.settings.overflowMinHeightPx) ? wm.settings.overflowMinHeightPx : 150)
        };

        let oldRect = grab.startRect;
        let op = grab.op;
        let isLeftOp = (op === Meta.GrabOp.RESIZING_W || op === Meta.GrabOp.RESIZING_NW || op === Meta.GrabOp.RESIZING_SW ||
                        op === Meta.GrabOp.KEYBOARD_RESIZING_W || op === Meta.GrabOp.KEYBOARD_RESIZING_NW || op === Meta.GrabOp.KEYBOARD_RESIZING_SW);
        let isRightOp = (op === Meta.GrabOp.RESIZING_E || op === Meta.GrabOp.RESIZING_NE || op === Meta.GrabOp.RESIZING_SE ||
                         op === Meta.GrabOp.KEYBOARD_RESIZING_E || op === Meta.GrabOp.KEYBOARD_RESIZING_NE || op === Meta.GrabOp.KEYBOARD_RESIZING_SE);
        let isTopOp = (op === Meta.GrabOp.RESIZING_N || op === Meta.GrabOp.RESIZING_NW || op === Meta.GrabOp.RESIZING_NE ||
                       op === Meta.GrabOp.KEYBOARD_RESIZING_N || op === Meta.GrabOp.KEYBOARD_RESIZING_NW || op === Meta.GrabOp.KEYBOARD_RESIZING_NE);
        let isBottomOp = (op === Meta.GrabOp.RESIZING_S || op === Meta.GrabOp.RESIZING_SW || op === Meta.GrabOp.RESIZING_SE ||
                          op === Meta.GrabOp.KEYBOARD_RESIZING_S || op === Meta.GrabOp.KEYBOARD_RESIZING_SW || op === Meta.GrabOp.KEYBOARD_RESIZING_SE);

        let newRect, dLeft, dRight, dTop, dBottom;
        if (Number.isFinite(pointerX) && Number.isFinite(pointerY) &&
            Number.isFinite(grab.startPx) && Number.isFinite(grab.startPy)) {
            let dx = Math.round(pointerX - grab.startPx);
            let dy = Math.round(pointerY - grab.startPy);

            if ((isLeftOp || isRightOp) && (isTopOp || isBottomOp)) {
                if (Math.abs(dx) > Math.abs(dy) * 2.2 && Math.abs(dy) < 18) {
                    dy = 0;
                } else if (Math.abs(dy) > Math.abs(dx) * 2.2 && Math.abs(dx) < 18) {
                    dx = 0;
                }
            }

            dLeft = isLeftOp ? dx : 0;
            dRight = isRightOp ? dx : 0;
            dTop = isTopOp ? dy : 0;
            dBottom = isBottomOp ? dy : 0;

            newRect = {
                x: oldRect.x + dLeft,
                y: oldRect.y + dTop,
                width: Math.max(60, oldRect.width - dLeft + dRight),
                height: Math.max(60, oldRect.height - dTop + dBottom)
            };
        } else {
            newRect = win.get_frame_rect();
            dLeft = newRect.x - oldRect.x;
            dRight = (newRect.x + newRect.width) - (oldRect.x + oldRect.width);
            dTop = newRect.y - oldRect.y;
            dBottom = (newRect.y + newRect.height) - (oldRect.y + oldRect.height);
        }

        if (state.layoutId === 'dwindle') {
            state.bspTree.lastSnappedPct = null;
            if ((isRightOp || Math.abs(dRight) >= Math.abs(dLeft)) && Math.abs(dRight) >= 1) {
                if (!state.bspTree.resizeEdge(cellWinId, 'right', dRight, area, innerGap, snapTolerancePx, bspConstraints) && Math.abs(dLeft) >= 1) {
                    state.bspTree.resizeEdge(cellWinId, 'left', dLeft, area, innerGap, snapTolerancePx, bspConstraints);
                }
            } else if (Math.abs(dLeft) >= 1) {
                if (!state.bspTree.resizeEdge(cellWinId, 'left', dLeft, area, innerGap, snapTolerancePx, bspConstraints) && Math.abs(dRight) >= 1) {
                    state.bspTree.resizeEdge(cellWinId, 'right', dRight, area, innerGap, snapTolerancePx, bspConstraints);
                }
            }

            if ((isBottomOp || Math.abs(dBottom) >= Math.abs(dTop)) && Math.abs(dBottom) >= 1) {
                if (!state.bspTree.resizeEdge(cellWinId, 'bottom', dBottom, area, innerGap, snapTolerancePx, bspConstraints) && Math.abs(dTop) >= 1) {
                    state.bspTree.resizeEdge(cellWinId, 'top', dTop, area, innerGap, snapTolerancePx, bspConstraints);
                }
            } else if (Math.abs(dTop) >= 1) {
                if (!state.bspTree.resizeEdge(cellWinId, 'top', dTop, area, innerGap, snapTolerancePx, bspConstraints) && Math.abs(dBottom) >= 1) {
                    state.bspTree.resizeEdge(cellWinId, 'bottom', dBottom, area, innerGap, snapTolerancePx, bspConstraints);
                }
            }
            if (state.bspTree.lastSnappedPct !== null) {
                grab.snappedPct = state.bspTree.lastSnappedPct;
            }
            return;
        }

        if (state.layoutId === 'master-stack') {
            let masterCount = Layouts.clamp(state.masterCount || 1, 1, n);
            let effOrient = Layouts.resolveEffectiveMasterOrientation(
                state.masterOrientation,
                area,
                !wm.settings || wm.settings.masterAutoOrientation !== false
            );
            let horizMaster = (effOrient === 'top' || effOrient === 'bottom');
            if (n <= masterCount) {
                this.resizeStackNeighborPair(
                    effectiveOrder,
                    cellGrab,
                    horizMaster ? 'y' : 'x',
                    horizMaster ? state.weights : state.colWeights,
                    newRect,
                    snapTolerancePx
                );
                if (cellGrab.snappedPct !== undefined) grab.snappedPct = cellGrab.snappedPct;
                return;
            }

            let masterIds = effectiveOrder.slice(0, masterCount);
            let stackIds = effectiveOrder.slice(masterCount);
            let isMaster = masterIds.includes(cellWinId);

            if (!horizMaster) {
                let availW = Math.max(120, area.width - innerGap);
                if (Math.abs(newRect.width - oldRect.width) >= 1) {
                    let targetMasterW = isMaster ? newRect.width : (availW - newRect.width);
                    let rawRatio = Layouts.clamp(targetMasterW / availW, 0.12, 0.88);
                    let snapRes = Layouts.snapRatioValue(rawRatio, availW, snapTolerancePx);
                    state.masterRatio = Layouts.clamp(snapRes.ratio, 0.12, 0.88);
                    if (snapRes.snapped) grab.snappedPct = snapRes.snappedPct;
                }
                this.resizeStackNeighborPair(
                    isMaster ? masterIds : stackIds,
                    cellGrab,
                    'y',
                    state.weights,
                    newRect,
                    snapTolerancePx
                );
                if (cellGrab.snappedPct !== undefined && grab.snappedPct === null) grab.snappedPct = cellGrab.snappedPct;
            } else {
                let availH = Math.max(120, area.height - innerGap);
                if (Math.abs(newRect.height - oldRect.height) >= 1) {
                    let targetMasterH = isMaster ? newRect.height : (availH - newRect.height);
                    let rawRatio = Layouts.clamp(targetMasterH / availH, 0.12, 0.88);
                    let snapRes = Layouts.snapRatioValue(rawRatio, availH, snapTolerancePx);
                    state.masterRatio = Layouts.clamp(snapRes.ratio, 0.12, 0.88);
                    if (snapRes.snapped) grab.snappedPct = snapRes.snappedPct;
                }
                this.resizeStackNeighborPair(
                    isMaster ? masterIds : stackIds,
                    cellGrab,
                    'x',
                    state.colWeights,
                    newRect,
                    snapTolerancePx
                );
                if (cellGrab.snappedPct !== undefined && grab.snappedPct === null) grab.snappedPct = cellGrab.snappedPct;
            }
            return;
        }

        if (state.layoutId === 'centered-master') {
            let masterCount = Layouts.clamp(wm.settings.centeredMasterCount || state.masterCount || 1, 1, n);
            if (n <= masterCount + 1) {
                let effMasterCount = (n === 2) ? 1 : Layouts.clamp(masterCount, 1, n - 1);
                let masterIds = effectiveOrder.slice(0, effMasterCount);
                let stackIds = effectiveOrder.slice(effMasterCount);
                let isMaster = masterIds.includes(cellWinId);
                let availW = Math.max(120, area.width - innerGap);
                if (Math.abs(newRect.width - oldRect.width) >= 1) {
                    let targetMasterW = isMaster ? newRect.width : (availW - newRect.width);
                    let rawRatio = Layouts.clamp(targetMasterW / availW, 0.20, 0.80);
                    let snapRes = Layouts.snapRatioValue(rawRatio, availW, snapTolerancePx);
                    state.centeredMasterRatio = Layouts.clamp(snapRes.ratio, 0.20, 0.80);
                    state.masterRatio = state.centeredMasterRatio;
                    state.centeredLeftRatio = null;
                    state.centeredRightRatio = null;
                    if (snapRes.snapped) grab.snappedPct = snapRes.snappedPct;
                }
                this.resizeStackNeighborPair(
                    isMaster ? masterIds : stackIds,
                    cellGrab,
                    'y',
                    state.weights,
                    newRect,
                    snapTolerancePx
                );
                if (cellGrab.snappedPct !== undefined && grab.snappedPct === null) grab.snappedPct = cellGrab.snappedPct;
                return;
            }

            let masterIds = effectiveOrder.slice(0, masterCount);
            let remainingIds = effectiveOrder.slice(masterCount);
            let sideBalance = wm.settings.centeredMasterSideBalance || 'alternate';
            let rightIds = [];
            let leftIds = [];

            if (sideBalance === 'left-first') {
                for (let i = 0; i < remainingIds.length; i++) {
                    if (i % 2 === 0) leftIds.push(remainingIds[i]);
                    else rightIds.push(remainingIds[i]);
                }
            } else if (sideBalance === 'equal-split') {
                let half = Math.ceil(remainingIds.length / 2);
                leftIds = remainingIds.slice(0, half);
                rightIds = remainingIds.slice(half);
            } else {
                for (let i = 0; i < remainingIds.length; i++) {
                    if (i % 2 === 0) rightIds.push(remainingIds[i]);
                    else leftIds.push(remainingIds[i]);
                }
            }

            let availW = Math.max(240, area.width - 2 * innerGap);
            let baseCenterRatio = Number.isFinite(grab.startCenteredMasterRatio)
                ? grab.startCenteredMasterRatio
                : ((wm.settings.centeredMasterRatioPct || 50) / 100.0);
            let oldLeftRect = grab.startLastRects && grab.startLastRects.get(leftIds[0]);
            let oldCenterRect = grab.startLastRects && grab.startLastRects.get(masterIds[0]);
            let oldRightRect = grab.startLastRects && grab.startLastRects.get(rightIds[0]);

            let oldLeftW = oldLeftRect ? oldLeftRect.width : Math.floor((availW * (1 - baseCenterRatio)) / 2);
            let oldCenterW = oldCenterRect ? oldCenterRect.width : Math.round(availW * baseCenterRatio);
            let oldRightW = oldRightRect ? oldRightRect.width : (availW - oldLeftW - oldCenterW);

            let inLeft = leftIds.includes(cellWinId);
            let inCenter = masterIds.includes(cellWinId);
            let inRight = rightIds.includes(cellWinId);

            if (Math.abs(newRect.width - oldRect.width) >= 1 || Math.abs(dLeft) >= 1 || Math.abs(dRight) >= 1) {
                let newLeftW = oldLeftW;
                let newCenterW = oldCenterW;
                let newRightW = oldRightW;

                if (inLeft) {
                    let deltaW = newRect.width - oldLeftW;
                    newLeftW = Layouts.clamp(oldLeftW + deltaW, 80, Math.max(80, availW - oldRightW - 100));
                    let snapRes = Layouts.snapRatioValue(newLeftW / availW, availW, snapTolerancePx, [0.20, 0.25, 1 / 3, 0.50]);
                    if (snapRes.snapped) {
                        newLeftW = Layouts.clamp(Math.round(snapRes.ratio * availW), 80, Math.max(80, availW - oldRightW - 100));
                        grab.snappedPct = snapRes.snappedPct;
                    }
                    newCenterW = availW - newLeftW - oldRightW;
                } else if (inRight) {
                    let deltaW = newRect.width - oldRightW;
                    newRightW = Layouts.clamp(oldRightW + deltaW, 80, Math.max(80, availW - oldLeftW - 100));
                    let snapRes = Layouts.snapRatioValue(newRightW / availW, availW, snapTolerancePx, [0.20, 0.25, 1 / 3, 0.50]);
                    if (snapRes.snapped) {
                        newRightW = Layouts.clamp(Math.round(snapRes.ratio * availW), 80, Math.max(80, availW - oldLeftW - 100));
                        grab.snappedPct = snapRes.snappedPct;
                    }
                    newCenterW = availW - oldLeftW - newRightW;
                } else if (inCenter) {
                    if (isLeftOp || (Math.abs(dLeft) > Math.abs(dRight) && Math.abs(dLeft) >= 1)) {
                        newLeftW = Layouts.clamp(oldLeftW + dLeft, 80, Math.max(80, availW - oldRightW - 100));
                    }
                    if (isRightOp || (Math.abs(dRight) >= Math.abs(dLeft) && Math.abs(dRight) >= 1)) {
                        newRightW = Layouts.clamp(oldRightW - dRight, 80, Math.max(80, availW - newLeftW - 100));
                    }
                    newCenterW = availW - newLeftW - newRightW;
                    let snapRes = Layouts.snapRatioValue(newCenterW / availW, availW, snapTolerancePx);
                    if (snapRes.snapped) {
                        let targetCenterW = Layouts.clamp(Math.round(snapRes.ratio * availW), 100, Math.max(100, availW - 160));
                        let diff = targetCenterW - newCenterW;
                        if (isLeftOp || Math.abs(dLeft) > Math.abs(dRight)) {
                            newLeftW = Layouts.clamp(newLeftW - diff, 80, Math.max(80, availW - newRightW - 100));
                        } else {
                            newRightW = Layouts.clamp(newRightW - diff, 80, Math.max(80, availW - newLeftW - 100));
                        }
                        newCenterW = availW - newLeftW - newRightW;
                        grab.snappedPct = snapRes.snappedPct;
                    }
                }

                state.centeredLeftRatio = Layouts.clamp(newLeftW / availW, 0.08, 0.75);
                state.centeredRightRatio = Layouts.clamp(newRightW / availW, 0.08, 0.75);
                state.centeredMasterRatio = Layouts.clamp(newCenterW / availW, 0.15, 0.80);
                state.masterRatio = state.centeredMasterRatio;
            }

            let colGroup = inLeft ? leftIds : (inCenter ? masterIds : rightIds);
            this.resizeStackNeighborPair(colGroup, cellGrab, 'y', state.weights, newRect, snapTolerancePx);
            if (cellGrab.snappedPct !== undefined && grab.snappedPct === null) grab.snappedPct = cellGrab.snappedPct;
            return;
        }

        if (state.layoutId === 'grid') {
            let dims = Layouts.computeGridDimensions(effectiveOrder, area, {
                innerGap,
                gridMaxCols: wm.settings.gridMaxCols,
                minSizes: wm.settings.dwindleRespectMinSize !== false ? wm._windowMinSizes : null,
                overflowMinWidthPx: wm.settings.overflowMinWidthPx,
                overflowMinHeightPx: wm.settings.overflowMinHeightPx
            });
            let cols = dims.cols;
            let cellOrder = dims.cellIds;
            let cellN = cellOrder.length;
            let rows = dims.rows;
            let winIdx = cellOrder.indexOf(cellWinId);
            if (winIdx === -1 || rows === 0) return;

            let rowIdx = Math.floor(winIdx / cols);
            let rowStart = rowIdx * cols;
            let rowEnd = Math.min(cellN, rowStart + cols);
            let rowWinIds = cellOrder.slice(rowStart, rowEnd);

            this.resizeStackNeighborPair(rowWinIds, cellGrab, 'x', state.colWeights, newRect, snapTolerancePx);
            if (cellGrab.snappedPct !== undefined) grab.snappedPct = cellGrab.snappedPct;

            if (rows > 1 && (Math.abs(dTop) >= 1 || Math.abs(dBottom) >= 1)) {
                let rowHeights = [];
                for (let r = 0; r < rows; r++) {
                    let repId = cellOrder[r * cols];
                    let repRect = grab.startLastRects && grab.startLastRects.get(repId);
                    rowHeights.push(repRect ? repRect.height : Math.floor(area.height / rows));
                }
                let availH = rowHeights.reduce((a, b) => a + b, 0);
                if (availH > 0) {
                    let newRowHeights = [...rowHeights];
                    if ((isTopOp || Math.abs(dTop) > Math.abs(dBottom)) && Math.abs(dTop) >= 1) {
                        if (rowIdx > 0) {
                            let pairSum = rowHeights[rowIdx - 1] + rowHeights[rowIdx];
                            newRowHeights[rowIdx - 1] = Layouts.clamp(rowHeights[rowIdx - 1] + dTop, 60, Math.max(60, pairSum - 60));
                            newRowHeights[rowIdx] = pairSum - newRowHeights[rowIdx - 1];
                        } else {
                            let pairSum = rowHeights[0] + rowHeights[1];
                            newRowHeights[0] = Layouts.clamp(rowHeights[0] - dTop, 60, Math.max(60, pairSum - 60));
                            newRowHeights[1] = pairSum - newRowHeights[0];
                        }
                    } else if ((isBottomOp || Math.abs(dBottom) >= Math.abs(dTop)) && Math.abs(dBottom) >= 1) {
                        if (rowIdx < rows - 1) {
                            let pairSum = rowHeights[rowIdx] + rowHeights[rowIdx + 1];
                            newRowHeights[rowIdx] = Layouts.clamp(rowHeights[rowIdx] + dBottom, 60, Math.max(60, pairSum - 60));
                            newRowHeights[rowIdx + 1] = pairSum - newRowHeights[rowIdx];
                        } else {
                            let pairSum = rowHeights[rows - 2] + rowHeights[rows - 1];
                            newRowHeights[rows - 1] = Layouts.clamp(rowHeights[rows - 1] + dBottom, 60, Math.max(60, pairSum - 60));
                            newRowHeights[rows - 2] = pairSum - newRowHeights[rows - 1];
                        }
                    }
                    for (let r = 0; r < rows; r++) {
                        let rw = (newRowHeights[r] / availH) * rows;
                        state.gridRowWeights.set(r, Layouts.clamp(rw, 0.10, 8.0));
                    }
                }
            }
            return;
        }

        if (state.layoutId === 'scrolling') {
            if (Math.abs(newRect.width - oldRect.width) >= 1) {
                let baseColRatio = Layouts.clamp((wm.settings.scrollingColumnWidthPct || 60) / 100.0, 0.30, 1.0);
                let rawRatio = Layouts.clamp(newRect.width / Math.max(200, area.width), 0.30, 1.0);
                let snapRes = Layouts.snapRatioValue(rawRatio, area.width, snapTolerancePx, [1 / 3, 0.50, 2 / 3, 0.75, 1.0]);
                let targetColRatio = Layouts.clamp(snapRes.ratio, 0.30, 1.0);
                if (snapRes.snapped) grab.snappedPct = snapRes.snappedPct;
                let exactWeight = targetColRatio / baseColRatio;
                state.weights.set(cellWinId, Layouts.clamp(exactWeight, 0.5, 1.65));
            }
        }
    }
}

module.exports = {
    MOUSE_RESIZE_GRAB_OPS,
    RESIZE_GRAB_OPS,
    parseGrabOpArgs,
    normalizeResizeGrabOp,
    computeEdgeSnapZone,
    GrabController
};

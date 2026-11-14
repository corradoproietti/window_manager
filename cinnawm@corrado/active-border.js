// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Active Window Border Highlight & Stacked/Tabbed Titlebar Badges
 */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Main = imports.ui.main;

const Layouts = require('./layouts');
const {
    _,
    safePushModal,
    safePopModal,
    createLayoutIcon,
    formatPrimaryShortcut
} = require('./modal-utils');

/**
 * Draws a rounded highlight frame strictly outside the window frame rect (offset by -bw)
 * so that the border never eats into the interior of the client window.
 */
class ActiveBorderOverlay {
    constructor(wm) {
        this.wm = wm;
        this.actor = new St.Widget({
            style_class: 'cinnawm-active-border',
            reactive: false,
            can_focus: false,
            track_hover: false,
            visible: false
        });

        global.window_group.add_actor(this.actor);
        this._trackedWindow = null;
        this._signalIds = [];
        this._stackedBadges = [];
        this._stackedWinSignals = [];
        this._stackPopupBackdrop = null;
        this._stackPopupMenu = null;
        this.isStackPopupOpen = false;
        this._lastBorderStyle = null;
        this._badgeSyncIdleId = 0;
    }

    attachToWindow(metaWindow) {
        this._disconnectTracked();
        this._trackedWindow = metaWindow;

        if (!metaWindow) {
            this.actor.hide();
            this._syncStackedBadges();
            return;
        }

        let posId = metaWindow.connect('position-changed', () => this.sync(true));
        let sizeId = metaWindow.connect('size-changed', () => this.sync(true));
        let unmId = metaWindow.connect('unmanaging', () => {
            this.attachToWindow(null);
        });

        this._signalIds.push({ obj: metaWindow, id: posId });
        this._signalIds.push({ obj: metaWindow, id: sizeId });
        this._signalIds.push({ obj: metaWindow, id: unmId });

        this.sync();
    }

    _disconnectTracked() {
        for (let item of this._signalIds) {
            try {
                item.obj.disconnect(item.id);
            } catch (e) {
                // ignore
            }
        }
        this._signalIds = [];
        this._trackedWindow = null;
    }

    _disconnectStackedSignals() {
        for (let item of this._stackedWinSignals) {
            try {
                item.obj.disconnect(item.id);
            } catch (e) {
                // ignore
            }
        }
        this._stackedWinSignals = [];
    }

    _cancelPendingBadgeSync() {
        if (this._badgeSyncIdleId) {
            GLib.source_remove(this._badgeSyncIdleId);
            this._badgeSyncIdleId = 0;
        }
    }

    _scheduleBadgeSync() {
        if (this._badgeSyncIdleId) return;
        this._badgeSyncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._badgeSyncIdleId = 0;
            if (this.actor) {
                this._syncStackedBadges();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _getOrCreateStackedBadge(index) {
        while (this._stackedBadges.length <= index) {
            let badge = new St.BoxLayout({
                style_class: 'cinnawm-stacked-title-badge',
                vertical: false,
                reactive: true,
                can_focus: false,
                track_hover: true,
                visible: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'background-color: rgba(24, 28, 44, 0.92); border: 1px solid rgba(130, 170, 255, 0.85); border-radius: 5px; padding: 2px 5px;'
            });
            if (this.wm && this.wm.meta && this.wm.meta.path) {
                let icon = createLayoutIcon(
                    this.wm.meta.path,
                    'cinnawm-stacked-symbolic.svg',
                    13,
                    'cinnawm-stacked-title-icon'
                );
                badge.add_child(icon);
            }
            let countLbl = new St.Label({
                text: '',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: #e0e8ff; font-family: monospace; font-weight: bold; font-size: 8.5pt; margin-left: 4px;'
            });
            badge.add_child(countLbl);
            badge._countLabel = countLbl;

            badge._stackContext = null;
            badge._lastScrollMs = 0;

            badge.connect('notify::hover', () => {
                if (badge.hover) {
                    badge.style = 'background-color: rgba(52, 68, 125, 0.96); border: 1px solid rgba(170, 205, 255, 1.0); border-radius: 5px; padding: 2px 5px;';
                } else {
                    badge.style = 'background-color: rgba(24, 28, 44, 0.92); border: 1px solid rgba(130, 170, 255, 0.85); border-radius: 5px; padding: 2px 5px;';
                }
            });

            badge.connect('button-press-event', () => Clutter.EVENT_STOP);

            badge.connect('button-release-event', (_actor, event) => {
                let ctx = badge._stackContext;
                if (!ctx || !this.wm) return Clutter.EVENT_STOP;
                let btn = event.get_button();
                let mods = event.get_state ? event.get_state() : 0;
                let shiftHeld = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
                if (btn === 1) {
                    if (shiftHeld || (ctx.groupIds && ctx.groupIds.length === 1)) {
                        if (typeof this.wm.toggleMonocleZoom === 'function') {
                            this.wm.toggleMonocleZoom(ctx.topWin || null);
                        }
                    } else {
                        this._cycleStackGroup(ctx, 1);
                    }
                } else if (btn === 2) {
                    this._cycleStackGroup(ctx, -1);
                } else if (btn === 3) {
                    this._openStackPopup(badge, ctx);
                }
                return Clutter.EVENT_STOP;
            });

            badge.connect('scroll-event', (_actor, event) => {
                let ctx = badge._stackContext;
                if (!ctx || !this.wm) return Clutter.EVENT_STOP;
                let dir = event.get_scroll_direction();
                let now = Date.now();
                if (dir === Clutter.ScrollDirection.UP) {
                    this._cycleStackGroup(ctx, -1);
                } else if (dir === Clutter.ScrollDirection.DOWN) {
                    this._cycleStackGroup(ctx, 1);
                } else if (dir === Clutter.ScrollDirection.SMOOTH && (now - badge._lastScrollMs) > 150) {
                    let [, dy] = event.get_scroll_delta();
                    if (Math.abs(dy) > 0.15) {
                        badge._lastScrollMs = now;
                        this._cycleStackGroup(ctx, dy > 0 ? 1 : -1);
                    }
                }
                return Clutter.EVENT_STOP;
            });

            try {
                if (Main.layoutManager && typeof Main.layoutManager.addChrome === 'function') {
                    Main.layoutManager.addChrome(badge, {
                        affectsStruts: false,
                        affectsInputRegion: true,
                        addToWindowgroup: true
                    });
                } else {
                    global.window_group.add_actor(badge);
                }
            } catch (e) {
                global.window_group.add_actor(badge);
            }

            this._stackedBadges.push(badge);
        }
        return this._stackedBadges[index];
    }

    _cycleStackGroup(ctx, step) {
        if (!ctx || !Array.isArray(ctx.groupIds) || ctx.groupIds.length < 2 || !this.wm) return;
        let state = this.wm.getState(ctx.wsIdx, ctx.monIdx);
        let tileableMap = this.wm.getTileableWindowsMap(ctx.wsIdx, ctx.monIdx);
        let curId = (state.focusedId && ctx.groupIds.includes(state.focusedId))
            ? state.focusedId
            : ctx.topWinId;
        let idx = ctx.groupIds.indexOf(curId);
        if (idx === -1) idx = 0;
        let nextIdx = (idx + step + ctx.groupIds.length) % ctx.groupIds.length;
        let targetId = ctx.groupIds[nextIdx];
        let targetWin = tileableMap.get(targetId);
        if (targetWin) {
            state.focusedId = targetId;
            if (state.activeTabMap && ctx.groupIds.length > 0) {
                state.activeTabMap.set(ctx.groupIds[0], targetId);
            }
            targetWin.raise();
            targetWin.activate(global.get_current_time());
            this.wm.queueRetile(true);
            if (typeof this.wm._showStackPositionOsd === 'function') {
                this.wm._showStackPositionOsd(state, targetWin, ctx.wsIdx, ctx.monIdx);
            }
        }
    }

    _ensureStackPopupActors() {
        if (this._stackPopupBackdrop) return;
        this._stackPopupBackdrop = new St.Widget({
            style_class: 'cinnawm-selector-backdrop',
            reactive: true,
            can_focus: true,
            visible: false
        });
        this._stackPopupMenu = new St.BoxLayout({
            style_class: 'cinnawm-selector-popup',
            vertical: true,
            reactive: true,
            style: 'background-color: #27272b; border: 1px solid #18181b; border-radius: 6px; padding: 6px;'
        });
        this._stackPopupBackdrop.add_child(this._stackPopupMenu);
        Main.uiGroup.add_child(this._stackPopupBackdrop);

        this._stackPopupBackdrop.connect('button-press-event', (_actor, event) => {
            let [px, py] = event.get_coords();
            let [mx, my] = this._stackPopupMenu.get_transformed_position();
            let [mw, mh] = this._stackPopupMenu.get_transformed_size();
            if (px < mx || px > mx + mw || py < my || py > my + mh) {
                this._closeStackPopup();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._stackPopupBackdrop.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeStackPopup();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _openStackPopup(badge, ctx) {
        if (!ctx || !this.wm) return;
        this._ensureStackPopupActors();
        this._stackPopupMenu.destroy_all_children();

        let state = this.wm.getState(ctx.wsIdx, ctx.monIdx);
        let tileableMap = this.wm.getTileableWindowsMap(ctx.wsIdx, ctx.monIdx);
        let total = ctx.groupIds.length;

        let headerTitle = ctx.isManualTabGroup ? _('Manual Tab Group') : _('Stacked Windows');
        let header = new St.Label({
            text: `${headerTitle} (${total})`,
            style: 'color: #9aa5ce; font-weight: bold; font-size: 9pt; padding: 4px 10px 6px 10px;'
        });
        this._stackPopupMenu.add_child(header);

        for (let i = 0; i < total; i++) {
            let winId = ctx.groupIds[i];
            let mw = tileableMap.get(winId);
            if (!mw) continue;
            let isCurrent = (winId === ctx.topWinId || winId === state.focusedId);
            let rawTitle = mw.get_title() || mw.get_wm_class() || _('Window');
            let cleanTitle = rawTitle.length > 38 ? `${rawTitle.slice(0, 35)}...` : rawTitle;

            let btn = new St.Button({
                style_class: isCurrent ? 'cinnawm-selector-item active' : 'cinnawm-selector-item',
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_fill: true,
                style: isCurrent
                    ? 'background-color: rgba(94, 129, 244, 0.25); border-radius: 4px; padding: 6px 10px;'
                    : 'border-radius: 4px; padding: 6px 10px;'
            });
            let row = new St.BoxLayout({
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER
            });
            let idxLabel = new St.Label({
                text: `${i + 1}/${total}`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: #7aa2f7; font-family: monospace; font-weight: bold; font-size: 9.5pt; margin-right: 10px;'
            });
            let titleLabel = new St.Label({
                text: `${isCurrent ? '● ' : ''}${cleanTitle}`,
                y_align: Clutter.ActorAlign.CENTER,
                style: isCurrent
                    ? 'color: #ffffff; font-weight: bold; font-size: 10pt;'
                    : 'color: #dcdee8; font-size: 10pt;'
            });
            row.add_child(idxLabel);
            row.add_child(titleLabel);
            btn.set_child(row);

            btn.connect('clicked', () => {
                this._closeStackPopup();
                state.focusedId = winId;
                if (state.activeTabMap && ctx.groupIds.length > 0) {
                    state.activeTabMap.set(ctx.groupIds[0], winId);
                }
                mw.raise();
                mw.activate(global.get_current_time());
                this.wm.queueRetile(true);
                if (typeof this.wm._showStackPositionOsd === 'function') {
                    this.wm._showStackPositionOsd(state, mw, ctx.wsIdx, ctx.monIdx);
                }
            });
            this._stackPopupMenu.add_child(btn);
        }

        if (ctx.isManualTabGroup && typeof this.wm.ungroupWindowById === 'function') {
            let sepTab = new St.Widget({
                style: 'background-color: rgba(255, 255, 255, 0.12); height: 1px; margin: 4px 4px;'
            });
            this._stackPopupMenu.add_child(sepTab);

            let tabShortcut = formatPrimaryShortcut(this.wm.settings && this.wm.settings.kbToggleTabGroup, 'Super + W');
            let detachBtn = new St.Button({
                style_class: 'cinnawm-selector-item',
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_fill: true,
                style: 'border-radius: 4px; padding: 6px 10px;'
            });
            let detachLabel = new St.Label({
                text: `⊟ ${_('Detach Active Tab from Group')} (${tabShortcut})`,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: #ff9e64; font-weight: bold; font-size: 9.5pt;'
            });
            detachBtn.set_child(detachLabel);
            detachBtn.connect('clicked', () => {
                this._closeStackPopup();
                this.wm.ungroupWindowById(ctx.topWinId, ctx.wsIdx, ctx.monIdx);
            });
            this._stackPopupMenu.add_child(detachBtn);

            if (total > 2 && typeof this.wm.dissolveTabGroupById === 'function') {
                let dissolveBtn = new St.Button({
                    style_class: 'cinnawm-selector-item',
                    reactive: true,
                    can_focus: true,
                    track_hover: true,
                    x_fill: true,
                    style: 'border-radius: 4px; padding: 6px 10px;'
                });
                let dissolveLabel = new St.Label({
                    text: `⊞ ${_('Dissolve Entire Tab Group')}`,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'color: #f7768e; font-weight: bold; font-size: 9.5pt;'
                });
                dissolveBtn.set_child(dissolveLabel);
                dissolveBtn.connect('clicked', () => {
                    this._closeStackPopup();
                    this.wm.dissolveTabGroupById(ctx.topWinId, ctx.wsIdx, ctx.monIdx);
                });
                this._stackPopupMenu.add_child(dissolveBtn);
            }
        }

        if (typeof this.wm.toggleMonocleZoom === 'function') {
            let sep = new St.Widget({
                style: 'background-color: rgba(255, 255, 255, 0.12); height: 1px; margin: 4px 4px;'
            });
            this._stackPopupMenu.add_child(sep);

            let isZoomed = (state.layoutId === 'monocle');
            let prevId = state.previousLayoutId || (this.wm.settings && this.wm.settings.defaultLayout !== 'monocle' ? this.wm.settings.defaultLayout : 'dwindle');
            let prevMeta = Layouts.getLayoutMeta(prevId);
            let zoomShortcut = formatPrimaryShortcut(this.wm.settings && this.wm.settings.kbToggleMonocle, 'Super + Z');
            let zoomLabelText = isZoomed
                ? `↩ ${_('Exit Zoom')} (${_(prevMeta.name)})`
                : `🔍 ${_('Zoom / Zen Fullscreen')} (${zoomShortcut})`;

            let zoomBtn = new St.Button({
                style_class: 'cinnawm-selector-item',
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_fill: true,
                style: 'border-radius: 4px; padding: 6px 10px;'
            });
            let zoomLabel = new St.Label({
                text: zoomLabelText,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'color: #7dcfff; font-weight: bold; font-size: 9.5pt;'
            });
            zoomBtn.set_child(zoomLabel);
            zoomBtn.connect('clicked', () => {
                this._closeStackPopup();
                this.wm.toggleMonocleZoom(ctx.topWin || null);
            });
            this._stackPopupMenu.add_child(zoomBtn);
        }

        let monitor = (Main.layoutManager && Main.layoutManager.monitors[ctx.monIdx]) ||
                      Main.layoutManager.primaryMonitor;
        this._stackPopupBackdrop.set_position(monitor.x, monitor.y);
        this._stackPopupBackdrop.set_size(monitor.width, monitor.height);
        this._stackPopupBackdrop.show();

        let [bx, by] = badge.get_transformed_position();
        let [, bh] = badge.get_transformed_size();
        let [, menuW] = this._stackPopupMenu.get_preferred_width(-1);
        let [, menuH] = this._stackPopupMenu.get_preferred_height(-1);
        menuW = Math.max(220, menuW);
        menuH = Math.max(80, menuH);

        let targetX = Math.max(monitor.x + 8, Math.min(monitor.x + monitor.width - menuW - 8, Math.round(bx)));
        let targetY = Math.max(monitor.y + 8, Math.min(monitor.y + monitor.height - menuH - 8, Math.round(by + bh + 4)));
        this._stackPopupMenu.set_position(targetX - monitor.x, targetY - monitor.y);
        Main.uiGroup.set_child_above_sibling(this._stackPopupBackdrop, null);

        if (safePushModal(this.wm, this, this._stackPopupBackdrop)) {
            this.isStackPopupOpen = true;
        } else {
            this._stackPopupBackdrop.hide();
            this.isStackPopupOpen = false;
        }
    }

    _closeStackPopup() {
        if (!this._stackPopupBackdrop) return;
        safePopModal(this._stackPopupBackdrop);
        this.isStackPopupOpen = false;
        this._stackPopupBackdrop.hide();
    }

    _syncStackedBadges() {
        this._cancelPendingBadgeSync();
        this._disconnectStackedSignals();

        if (!this.wm || !global.workspace_manager) {
            for (let b of this._stackedBadges) b.hide();
            return;
        }

        let activeWs = global.workspace_manager.get_active_workspace();
        if (!activeWs) {
            for (let b of this._stackedBadges) b.hide();
            return;
        }

        let wsIdx = activeWs.index();
        let monitorsCount = (Main.layoutManager && Main.layoutManager.monitors)
            ? Main.layoutManager.monitors.length
            : 1;
        let windowActors = Meta.get_window_actors(global.display);
        let usedCount = 0;

        for (let monIdx = 0; monIdx < monitorsCount; monIdx++) {
            let state = this.wm.getState(wsIdx, monIdx);
            if (!state || !state.autoTile || state.layoutId === 'floating') continue;

            let tileableMap = this.wm.getTileableWindowsMap(wsIdx, monIdx);
            let stackedGroups = [];

            if (state.layoutId === 'monocle') {
                let ids = state.windowOrder.filter(id => tileableMap.has(id));
                if (ids.length > 1 || (ids.length === 1 && state.previousLayoutId)) {
                    stackedGroups.push({ ids, isManualTabGroup: false });
                }
            } else {
                let byCell = new Map();
                for (let id of state.windowOrder) {
                    if (!tileableMap.has(id)) continue;
                    let r = state.lastRects.get(id);
                    if (!r || !r.stacked || r.offscreen) continue;
                    let cellKey = `${r.x}:${r.y}:${r.width}:${r.height}`;
                    if (!byCell.has(cellKey)) {
                        byCell.set(cellKey, { ids: [], isManualTabGroup: Boolean(r.manualTabGroup) });
                    }
                    let entry = byCell.get(cellKey);
                    entry.ids.push(id);
                    if (r.manualTabGroup) entry.isManualTabGroup = true;
                }
                for (let entry of byCell.values()) {
                    if (entry.ids.length > 1) {
                        stackedGroups.push(entry);
                    }
                }
            }

            for (let groupEntry of stackedGroups) {
                let groupIds = groupEntry.ids;
                let isManualTabGroup = groupEntry.isManualTabGroup;
                let topWin = null;
                if (state.focusedId && groupIds.includes(state.focusedId)) {
                    topWin = tileableMap.get(state.focusedId);
                }
                if (!topWin && state.activeTabMap && groupIds.length > 0) {
                    let activeTabId = state.activeTabMap.get(groupIds[0]);
                    if (activeTabId && groupIds.includes(activeTabId)) {
                        topWin = tileableMap.get(activeTabId);
                    }
                }
                if (!topWin) {
                    for (let i = windowActors.length - 1; i >= 0; i--) {
                        let mw = windowActors[i].get_meta_window();
                        if (mw && groupIds.includes(mw.get_stable_sequence())) {
                            topWin = mw;
                            break;
                        }
                    }
                }
                if (!topWin) {
                    topWin = tileableMap.get(groupIds[0]);
                }
                if (!topWin ||
                    topWin.minimized ||
                    topWin.is_fullscreen() ||
                    !topWin.showing_on_its_workspace() ||
                    topWin.get_window_type() !== Meta.WindowType.NORMAL) {
                    continue;
                }

                let f = topWin.get_frame_rect();
                let c = (typeof topWin.frame_rect_to_client_rect === 'function')
                    ? topWin.frame_rect_to_client_rect(f)
                    : null;
                let titlebarH = (c && (c.y - f.y) >= 18 && (c.y - f.y) <= 56)
                    ? (c.y - f.y)
                    : 32;

                let topWinId = topWin.get_stable_sequence();
                let activeIdx = Math.max(0, groupIds.indexOf(topWinId));
                let hasCounter = groupIds.length > 1;
                let badgeW = hasCounter ? 48 : 22;
                let badgeH = 20;
                let bx = f.x + 10;
                let by = f.y + Math.round((titlebarH - badgeH) / 2);

                let cx = bx + Math.round(badgeW / 2);
                let cy = by + Math.round(badgeH / 2);
                let coveredByHigherWindow = false;
                for (let i = windowActors.length - 1; i >= 0; i--) {
                    let mw = windowActors[i].get_meta_window();
                    if (!mw || mw.minimized || !mw.showing_on_its_workspace()) continue;
                    if (mw === topWin) break;
                    let wType = mw.get_window_type();
                    if (wType !== Meta.WindowType.NORMAL &&
                        wType !== Meta.WindowType.DIALOG &&
                        wType !== Meta.WindowType.MODAL_DIALOG &&
                        wType !== Meta.WindowType.UTILITY) {
                        continue;
                    }
                    let hr = mw.get_frame_rect();
                    if (cx >= hr.x && cx <= hr.x + hr.width &&
                        cy >= hr.y && cy <= hr.y + hr.height) {
                        coveredByHigherWindow = true;
                        break;
                    }
                }
                if (coveredByHigherWindow) {
                    continue;
                }

                let badge = this._getOrCreateStackedBadge(usedCount++);
                if (badge._countLabel) {
                    if (hasCounter) {
                        badge._countLabel.text = `${activeIdx + 1}/${groupIds.length}`;
                        badge._countLabel.show();
                    } else {
                        badge._countLabel.text = '';
                        badge._countLabel.hide();
                    }
                }
                badge._stackContext = {
                    wsIdx,
                    monIdx,
                    groupIds: groupIds.slice(),
                    isManualTabGroup,
                    topWinId,
                    topWin
                };
                badge.set_position(bx, by);
                badge.set_size(badgeW, badgeH);

                let winActor = topWin.get_compositor_private();
                if (winActor && winActor.get_parent() === global.window_group) {
                    global.window_group.set_child_above_sibling(badge, winActor);
                }
                if (this.actor && this.actor.visible && this.actor.get_parent() === global.window_group &&
                    topWin === this._trackedWindow) {
                    global.window_group.set_child_above_sibling(badge, this.actor);
                }
                badge.show();

                if (topWin !== this._trackedWindow) {
                    let posId = topWin.connect('position-changed', () => this._scheduleBadgeSync());
                    let sizeId = topWin.connect('size-changed', () => this._scheduleBadgeSync());
                    this._stackedWinSignals.push({ obj: topWin, id: posId });
                    this._stackedWinSignals.push({ obj: topWin, id: sizeId });
                }
            }
        }

        for (let i = usedCount; i < this._stackedBadges.length; i++) {
            this._stackedBadges[i]._stackContext = null;
            this._stackedBadges[i].hide();
        }
    }

    _resolveBorderColor(win, settings) {
        let tiledColor = settings.activeBorderColor || 'rgba(94, 129, 244, 0.95)';
        if (settings.activeBorderStateColors === false || !win || !this.wm) {
            return tiledColor;
        }

        let floatingColor = settings.activeBorderFloatingColor || 'rgba(245, 194, 17, 0.95)';
        let stackedColor = settings.activeBorderStackedColor || 'rgba(180, 142, 173, 0.95)';
        let winId = win.get_stable_sequence();

        if ((this.wm.scratchpad && this.wm.scratchpad.has(winId)) ||
            (this.wm.manualFloating && this.wm.manualFloating.has(winId))) {
            return floatingColor;
        }

        let ws = (typeof win.get_workspace === 'function') ? win.get_workspace() : null;
        if (!ws || typeof this.wm.getState !== 'function') {
            return floatingColor;
        }

        let state = this.wm.getState(ws.index(), win.get_monitor());
        if (!state || !state.autoTile || state.layoutId === 'floating') {
            return floatingColor;
        }
        if (!state.windowOrder || !state.windowOrder.includes(winId)) {
            return floatingColor;
        }

        let tileRect = state.lastRects ? state.lastRects.get(winId) : null;
        let tabGroup = Layouts.findTabGroupForWindow(state, winId);
        if ((tabGroup && tabGroup.length > 1) || (tileRect && tileRect.stacked)) {
            return stackedColor;
        }

        return tiledColor;
    }

    sync(deferBadges = false) {
        const updateBadges = () => {
            if (deferBadges) {
                this._scheduleBadgeSync();
            } else {
                this._syncStackedBadges();
            }
        };

        let s = this.wm.settings;
        if (!s.activeBorderEnabled || !this._trackedWindow) {
            this.actor.hide();
            updateBadges();
            return;
        }

        let win = this._trackedWindow;
        if (win.minimized ||
            win.is_fullscreen() ||
            !win.showing_on_its_workspace() ||
            win.get_window_type() !== Meta.WindowType.NORMAL) {
            this.actor.hide();
            updateBadges();
            return;
        }

        if (s.smartGaps && this.wm.isSingleTiledWindowOnMonitor(win)) {
            this.actor.hide();
            updateBadges();
            return;
        }

        let rect = win.get_frame_rect();
        let bw = Math.max(1, s.activeBorderWidth || 3);
        let color = this._resolveBorderColor(win, s);
        let innerRadius = Math.max(0, Number.isFinite(s.activeBorderRadius) ? s.activeBorderRadius : 8);
        let outerRadius = innerRadius > 0 ? (innerRadius + bw) : 0;

        this.actor.set_position(rect.x - bw, rect.y - bw);
        this.actor.set_size(rect.width + bw * 2, rect.height + bw * 2);
        let nextStyle = `border: ${bw}px solid ${color}; border-radius: ${outerRadius}px; background-color: transparent; box-shadow: none;`;
        if (this._lastBorderStyle !== nextStyle) {
            this._lastBorderStyle = nextStyle;
            this.actor.style = nextStyle;
        }

        let winActor = win.get_compositor_private();
        if (winActor && winActor.get_parent() === global.window_group) {
            global.window_group.set_child_above_sibling(this.actor, winActor);
        }

        this.actor.show();
        updateBadges();
    }

    hide() {
        this._cancelPendingBadgeSync();
        this._closeStackPopup();
        if (this.actor) this.actor.hide();
        this._disconnectStackedSignals();
        for (let b of this._stackedBadges) {
            b._stackContext = null;
            b.hide();
        }
    }

    destroy() {
        this._cancelPendingBadgeSync();
        this._closeStackPopup();
        if (this._stackPopupBackdrop) {
            try {
                this._stackPopupBackdrop.destroy();
            } catch (e) {
                // ignore
            }
            this._stackPopupBackdrop = null;
            this._stackPopupMenu = null;
        }
        this._disconnectTracked();
        this._disconnectStackedSignals();
        for (let b of this._stackedBadges) {
            try {
                if (Main.layoutManager && typeof Main.layoutManager.removeChrome === 'function') {
                    Main.layoutManager.removeChrome(b);
                } else {
                    b.destroy();
                }
            } catch (e) {
                try { b.destroy(); } catch (e2) { /* ignore */ }
            }
        }
        this._stackedBadges = [];
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
    }
}

module.exports = {
    ActiveBorderOverlay
};

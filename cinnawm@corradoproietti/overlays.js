// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Visual Overlays & Panel Layout Selector
 *
 * Re-exports split overlay modules (`modal-utils.js`, `active-border.js`,
 * `interactive-overlays.js`) while providing DropPreviewOverlay,
 * ResizePreviewOverlay, HudOsd, and LayoutSelectorPopup.
 */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Main = imports.ui.main;

const Layouts = require('./layouts');
const {
    _,
    closeAllOtherModals,
    safePushModal,
    safePopModal,
    createLayoutIcon,
    formatKeybinding,
    formatPrimaryShortcut
} = require('./modal-utils');
const { ActiveBorderOverlay } = require('./active-border');
const { QuickGridOverlay, ResizeModeController } = require('./interactive-overlays');

/**
 * Drop Preview Overlay (shown during Mouse Drag-to-Swap / Snap)
 */
class DropPreviewOverlay {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'cinnawm-drop-preview',
            vertical: true,
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
            style: 'background-color: rgba(94, 129, 244, 0.24); border: 2px solid rgba(130, 170, 255, 0.95); border-radius: 8px;'
        });
        this.label = new St.Label({
            style_class: 'cinnawm-drop-preview-label',
            text: '',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: #ffffff; background-color: rgba(18, 22, 36, 0.92); border: 1px solid rgba(130, 170, 255, 0.85); border-radius: 8px; padding: 6px 14px; font-weight: bold; font-size: 11pt;'
        });
        this.actor.add_child(this.label);
        Main.uiGroup.add_child(this.actor);
        this._currentRect = null;
    }

    showRect(rect, labelText = '', variant = 'swap') {
        if (!rect) {
            this.hide();
            return;
        }
        if (variant === 'split') {
            this.actor.style = 'background-color: rgba(46, 204, 170, 0.24); border: 2px solid rgba(72, 235, 196, 0.96); border-radius: 8px;';
            this.label.style = 'color: #ffffff; background-color: rgba(14, 28, 32, 0.94); border: 1px solid rgba(72, 235, 196, 0.90); border-radius: 8px; padding: 6px 14px; font-weight: bold; font-size: 11pt;';
        } else {
            this.actor.style = 'background-color: rgba(94, 129, 244, 0.24); border: 2px solid rgba(130, 170, 255, 0.95); border-radius: 8px;';
            this.label.style = 'color: #ffffff; background-color: rgba(18, 22, 36, 0.92); border: 1px solid rgba(130, 170, 255, 0.85); border-radius: 8px; padding: 6px 14px; font-weight: bold; font-size: 11pt;';
        }
        this.label.text = labelText || '';
        this.label.visible = Boolean(labelText);
        Main.uiGroup.set_child_above_sibling(this.actor, null);

        let sameRect = this._currentRect &&
            this._currentRect.x === rect.x &&
            this._currentRect.y === rect.y &&
            this._currentRect.width === rect.width &&
            this._currentRect.height === rect.height;

        if (!this.actor.visible) {
            this.actor.set_position(rect.x, rect.y);
            this.actor.set_size(rect.width, rect.height);
            this.actor.opacity = 0;
            this.actor.show();
            this.actor.ease({
                opacity: 255,
                duration: 110,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        } else if (!sameRect) {
            this.actor.ease({
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                opacity: 255,
                duration: 90,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
        }
        this._currentRect = { ...rect };
    }

    hide() {
        this._currentRect = null;
        if (!this.actor || !this.actor.visible) return;
        this.actor.remove_all_transitions();
        this.actor.hide();
    }

    destroy() {
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
    }
}

/**
 * Resize Preview Overlay (shown during Mouse Edge Resize in Preview mode)
 */
class ResizePreviewOverlay {
    constructor(wm) {
        this.wm = wm;
        this.active = false;
        this._hasModal = false;
        this.backdrop = new St.Widget({
            reactive: true,
            can_focus: true,
            visible: false,
            style: 'background-color: rgba(10, 14, 24, 0.14);'
        });
        Main.uiGroup.add_child(this.backdrop);
        this._tiles = new Map();

        this.backdrop.connect('button-release-event', () => {
            if (this.wm && typeof this.wm._finishPreviewResize === 'function') {
                this.wm._finishPreviewResize(false);
            }
            return Clutter.EVENT_STOP;
        });

        this.backdrop.connect('key-press-event', (_actor, event) => {
            let sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Escape) {
                if (this.wm && typeof this.wm._finishPreviewResize === 'function') {
                    this.wm._finishPreviewResize(true);
                }
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    showOverlay() {
        if (!this.backdrop) return;
        this.backdrop.set_position(0, 0);
        this.backdrop.set_size(global.screen_width, global.screen_height);
        this.backdrop.show();
        Main.uiGroup.set_child_above_sibling(this.backdrop, null);
        this.active = true;
    }

    acquireModal() {
        this.showOverlay();
        if (!this._hasModal && safePushModal(this.wm, this, this.backdrop)) {
            this._hasModal = true;
        }
        return this._hasModal;
    }

    begin() {
        this.showOverlay();
    }

    showRects(previewRects, startRects, grabbedWinId, workarea = null, snappedPct = null) {
        if (!previewRects || previewRects.size === 0) {
            this.hide();
            return;
        }
        if (!this.active) {
            this.showOverlay();
        } else if (this.backdrop) {
            this.backdrop.show();
            Main.uiGroup.set_child_above_sibling(this.backdrop, null);
        }

        let effective = workarea
            ? Layouts.computeEffectiveWorkarea(workarea, 2, this.wm ? this.wm.settings : {}, null)
            : null;
        let totalW = effective ? Math.max(1, effective.area.width) : Math.max(1, global.screen_width);
        let totalH = effective ? Math.max(1, effective.area.height) : Math.max(1, global.screen_height);

        let seenIds = new Set();
        for (let [winId, rect] of previewRects.entries()) {
            seenIds.add(winId);
            let tile = this._tiles.get(winId);
            if (!tile) {
                let box = new St.BoxLayout({
                    style_class: 'cinnawm-resize-preview-tile',
                    vertical: true,
                    reactive: false,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER
                });
                let label = new St.Label({
                    style_class: 'cinnawm-resize-preview-label',
                    text: '',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: 'color: #ffffff; background-color: rgba(18, 22, 36, 0.94); border: 1px solid rgba(130, 170, 255, 0.85); border-radius: 8px; padding: 6px 14px; font-family: monospace; font-weight: bold; font-size: 11.5pt;'
                });
                box.add_child(label);
                this.backdrop.add_child(box);
                tile = { box, label };
                this._tiles.set(winId, tile);
            }

            let oldRect = startRects ? startRects.get(winId) : null;
            let dw = oldRect ? Math.round(rect.width - oldRect.width) : 0;
            let dh = oldRect ? Math.round(rect.height - oldRect.height) : 0;
            let dx = oldRect ? Math.round(rect.x - oldRect.x) : 0;
            let dy = oldRect ? Math.round(rect.y - oldRect.y) : 0;
            let isPrimary = (winId === grabbedWinId);
            let isChanged = isPrimary || Math.abs(dw) > 1 || Math.abs(dh) > 1 || Math.abs(dx) > 1 || Math.abs(dy) > 1;
            let isSnappedPrimary = isPrimary && Number.isFinite(snappedPct);

            if (isSnappedPrimary) {
                tile.box.style_class = 'cinnawm-resize-preview-tile primary';
                tile.box.style = 'background-color: rgba(42, 195, 222, 0.28); border: 3px solid rgba(115, 218, 202, 1.0); border-radius: 8px;';
                tile.label.style = 'color: #ffffff; background-color: rgba(16, 28, 38, 0.96); border: 1px solid rgba(115, 218, 202, 0.95); border-radius: 8px; padding: 6px 14px; font-family: monospace; font-weight: bold; font-size: 11.5pt;';
            } else if (isPrimary) {
                tile.box.style_class = 'cinnawm-resize-preview-tile primary';
                tile.box.style = 'background-color: rgba(94, 129, 244, 0.30); border: 3px solid rgba(140, 180, 255, 1.0); border-radius: 8px;';
                tile.label.style = 'color: #ffffff; background-color: rgba(18, 22, 36, 0.94); border: 1px solid rgba(130, 170, 255, 0.85); border-radius: 8px; padding: 6px 14px; font-family: monospace; font-weight: bold; font-size: 11.5pt;';
            } else if (isChanged) {
                tile.box.style_class = 'cinnawm-resize-preview-tile';
                tile.box.style = 'background-color: rgba(94, 129, 244, 0.20); border: 2px solid rgba(120, 160, 255, 0.95); border-radius: 8px;';
                tile.label.style = 'color: #ffffff; background-color: rgba(18, 22, 36, 0.94); border: 1px solid rgba(130, 170, 255, 0.85); border-radius: 8px; padding: 6px 14px; font-family: monospace; font-weight: bold; font-size: 11.5pt;';
            } else {
                tile.box.style_class = 'cinnawm-resize-preview-tile unchanged';
                tile.box.style = 'background-color: rgba(255, 255, 255, 0.05); border: 1px solid rgba(169, 177, 214, 0.50); border-radius: 8px;';
            }

            tile.box.set_position(Math.round(rect.x), Math.round(rect.y));
            tile.box.set_size(Math.round(rect.width), Math.round(rect.height));
            tile.box.show();

            if (isChanged) {
                let deltaParts = [];
                if (Math.abs(dw) >= 1) deltaParts.push(`W ${dw > 0 ? '+' : ''}${dw}px`);
                if (Math.abs(dh) >= 1) deltaParts.push(`H ${dh > 0 ? '+' : ''}${dh}px`);
                let deltaStr = deltaParts.length > 0 ? `  (${deltaParts.join(', ')})` : '';

                let pctW = Math.round((rect.width / totalW) * 100);
                let pctH = Math.round((rect.height / totalH) * 100);
                let pctBadge = '';
                if (isSnappedPrimary) {
                    pctBadge = `  [🧲 ${snappedPct}%]`;
                } else if (Math.abs(dw) >= 1 && Math.abs(dh) < 1) {
                    pctBadge = `  [${pctW}%]`;
                } else if (Math.abs(dh) >= 1 && Math.abs(dw) < 1) {
                    pctBadge = `  [${pctH}%]`;
                } else {
                    pctBadge = `  [${pctW}%]`;
                }

                tile.label.text = `${Math.round(rect.width)} × ${Math.round(rect.height)} px${deltaStr}${pctBadge}`;
                tile.label.show();
            } else {
                tile.label.hide();
            }
        }

        for (let [winId, tile] of this._tiles.entries()) {
            if (!seenIds.has(winId)) {
                tile.box.hide();
            }
        }
    }

    stop() {
        this.hide();
    }

    hide() {
        if (this._hasModal) {
            this._hasModal = false;
            safePopModal(this.backdrop);
        }
        this.active = false;
        if (this.backdrop) {
            this.backdrop.hide();
        }
        for (let tile of this._tiles.values()) {
            tile.box.hide();
        }
    }

    destroy() {
        this.hide();
        this._tiles.clear();
        if (this.backdrop) {
            this.backdrop.destroy();
            this.backdrop = null;
        }
    }
}

/**
 * HUD / OSD Notification Overlay (with Representative Icon + Badge + Text)
 */
class HudOsd {
    constructor(wm) {
        this.wm = wm;
        this._timeoutId = 0;

        this.actor = new St.BoxLayout({
            style_class: 'cinnawm-osd-container',
            vertical: false,
            reactive: false,
            visible: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'background-color: rgba(20, 23, 34, 0.95); border: 2px solid rgba(94, 129, 244, 0.85); border-radius: 14px; padding: 10px 20px;'
        });

        this.iconBin = new St.Bin({
            style_class: 'cinnawm-osd-icon-bin',
            x_align: St.Align.MIDDLE,
            y_align: St.Align.MIDDLE,
            x_fill: false,
            y_fill: false,
            y_expand: false,
            style: 'margin-right: 12px;'
        });

        this.badgeLabel = new St.Label({
            style_class: 'cinnawm-osd-badge',
            text: '[@]',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
            style: 'color: #7aa2f7; background-color: rgba(94, 129, 244, 0.18); border: 1px solid rgba(94, 129, 244, 0.45); border-radius: 8px; padding: 4px 10px; margin-right: 14px; font-family: monospace; font-weight: bold; font-size: 11.5pt;'
        });

        this.textBox = new St.BoxLayout({
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false
        });

        this.titleLabel = new St.Label({
            style_class: 'cinnawm-osd-title',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
            style: 'color: #f8f9fa; font-weight: bold; font-size: 11.5pt; margin: 0; padding: 0;'
        });

        this.sepLabel = new St.Label({
            style_class: 'cinnawm-osd-subtitle',
            text: '  ·  ',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
            style: 'color: #6c7696; font-size: 11.5pt; margin: 0 6px; padding: 0;'
        });

        this.subtitleLabel = new St.Label({
            style_class: 'cinnawm-osd-subtitle',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
            style: 'color: #a9b1d6; font-size: 11pt; margin: 0; padding: 0;'
        });

        this.textBox.add(this.titleLabel, { y_fill: false, y_align: St.Align.MIDDLE });
        this.textBox.add(this.sepLabel, { y_fill: false, y_align: St.Align.MIDDLE });
        this.textBox.add(this.subtitleLabel, { y_fill: false, y_align: St.Align.MIDDLE });

        this.actor.add(this.iconBin, { y_fill: false, y_align: St.Align.MIDDLE });
        this.actor.add(this.badgeLabel, { y_fill: false, y_align: St.Align.MIDDLE });
        this.actor.add(this.textBox, { y_fill: false, y_align: St.Align.MIDDLE });

        Main.uiGroup.add_child(this.actor);
    }

    show(badge, title, subtitle = '', iconFile = null, monitorIndex = null, anchorRect = null) {
        if (!this.wm.settings.showOsd) return;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        if (iconFile && this.wm.meta && this.wm.meta.path) {
            let icon = createLayoutIcon(this.wm.meta.path, iconFile, 24, 'cinnawm-osd-svg-icon');
            this.iconBin.set_child(icon);
            this.iconBin.show();
        } else {
            this.iconBin.hide();
        }

        this.badgeLabel.text = badge || '[WM]';
        this.titleLabel.text = title || '';
        this.subtitleLabel.text = subtitle || '';
        let hasSubtitle = Boolean(subtitle);
        this.sepLabel.visible = hasSubtitle && Boolean(title);
        this.subtitleLabel.visible = hasSubtitle;

        let monIdx = (monitorIndex !== null) ? monitorIndex : global.display.get_current_monitor();
        let monitor = Main.layoutManager.monitors[monIdx] || Main.layoutManager.primaryMonitor;

        this.actor.opacity = 0;
        this.actor.show();

        let [, natW] = this.actor.get_preferred_width(-1);
        let [, natH] = this.actor.get_preferred_height(-1);
        let boxW = natW || 280;
        let boxH = natH || 48;
        let x, y;
        if (anchorRect && anchorRect.width > 0 && anchorRect.height > 0) {
            x = anchorRect.x + Math.round((anchorRect.width - boxW) / 2);
            y = anchorRect.y + Math.round((anchorRect.height - boxH) / 2);
            x = Math.max(monitor.x + 12, Math.min(monitor.x + monitor.width - boxW - 12, x));
            y = Math.max(monitor.y + 12, Math.min(monitor.y + monitor.height - boxH - 12, y));
        } else {
            x = monitor.x + Math.round((monitor.width - boxW) / 2);
            y = monitor.y + monitor.height - Math.max(90, natH) - 72;
        }

        this.actor.set_position(x, y);
        Main.uiGroup.set_child_above_sibling(this.actor, null);

        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 255,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
            this._timeoutId = 0;
            if (this.actor) {
                this.actor.ease({
                    opacity: 0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        if (this.actor) this.actor.hide();
                    }
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
    }
}

/**
 * Panel Layout Selector Popup Menu
 */
class LayoutSelectorPopup {
    constructor(wm) {
        this.wm = wm;
        this.isOpen = false;

        this.backdrop = new St.Widget({
            style_class: 'cinnawm-selector-backdrop',
            reactive: true,
            can_focus: true,
            visible: false
        });

        this.menuBox = new St.BoxLayout({
            style_class: 'cinnawm-selector-popup',
            vertical: true,
            reactive: true
        });

        this.itemsContainer = new St.BoxLayout({
            style_class: 'cinnawm-selector-items',
            vertical: true
        });
        this.menuBox.add_child(this.itemsContainer);

        this.backdrop.add_child(this.menuBox);
        Main.uiGroup.add_child(this.backdrop);

        this._backdropPressOutside = false;

        this.backdrop.connect('button-press-event', (actor, event) => {
            let [mx, my] = event.get_coords();
            let [px, py] = this.menuBox.get_transformed_position();
            let [pw, ph] = this.menuBox.get_transformed_size();
            if (mx < px || mx > px + pw || my < py || my > py + ph) {
                this._backdropPressOutside = true;
                return Clutter.EVENT_STOP;
            }
            this._backdropPressOutside = false;
            return Clutter.EVENT_PROPAGATE;
        });

        this.backdrop.connect('button-release-event', () => {
            if (this._backdropPressOutside) {
                this._backdropPressOutside = false;
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.backdrop.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _rebuildItems() {
        this.itemsContainer.destroy_all_children();

        let state = this.wm.getCurrentState();
        let activeLayoutId = state.autoTile ? state.layoutId : 'floating';

        for (let layout of Layouts.LAYOUTS) {
            let isSelected = (layout.id === activeLayoutId);
            let btn = new St.Button({
                style_class: isSelected
                    ? 'cinnawm-selector-item selected'
                    : 'cinnawm-selector-item',
                width: 236,
                height: 26,
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_expand: true,
                x_fill: true,
                x_align: St.Align.START,
                y_align: St.Align.MIDDLE
            });

            let row = new St.BoxLayout({
                vertical: false,
                width: 216,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });

            let icon = createLayoutIcon(this.wm.meta.path, layout.iconFile, 16, 'cinnawm-selector-icon');

            let nameLabel = new St.Label({
                style_class: 'cinnawm-selector-item-title',
                text: _(layout.name),
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER
            });

            row.add_child(icon);
            row.add_child(nameLabel);

            if (isSelected) {
                let checkLabel = new St.Label({
                    style_class: 'cinnawm-selector-check',
                    text: '•',
                    x_align: Clutter.ActorAlign.END,
                    y_align: Clutter.ActorAlign.CENTER
                });
                row.add_child(checkLabel);
            }

            btn.set_child(row);
            btn.connect('clicked', () => {
                this.close();
                this.wm.setLayoutById(layout.id);
            });

            this.itemsContainer.add_child(btn);
        }
    }

    toggle(anchorActor) {
        if (this.isOpen) {
            this.close();
        } else {
            this.open(anchorActor);
        }
    }

    open(anchorActor) {
        this._backdropPressOutside = false;
        this._rebuildItems();

        let monIdx = global.display.get_current_monitor();
        let monitor = Main.layoutManager.monitors[monIdx] || Main.layoutManager.primaryMonitor;

        this.backdrop.set_position(monitor.x, monitor.y);
        this.backdrop.set_size(monitor.width, monitor.height);
        this.backdrop.show();

        let [, menuW] = this.menuBox.get_preferred_width(-1);
        let [, menuH] = this.menuBox.get_preferred_height(-1);
        menuW = Math.max(210, menuW);
        menuH = Math.max(120, menuH);

        let targetX = monitor.x + monitor.width - menuW - 12;
        let targetY = monitor.y + 38;

        if (anchorActor) {
            let [ax, ay] = anchorActor.get_transformed_position();
            let [aw, ah] = anchorActor.get_transformed_size();
            targetX = Math.round(ax + aw / 2 - menuW / 2);
            targetX = Math.max(monitor.x + 8, Math.min(monitor.x + monitor.width - menuW - 8, targetX));

            if (ay > monitor.y + monitor.height / 2) {
                targetY = Math.max(monitor.y + 8, Math.round(ay - menuH - 8));
            } else {
                targetY = Math.round(ay + ah + 6);
            }
        }

        this.menuBox.set_position(targetX - monitor.x, targetY - monitor.y);
        Main.uiGroup.set_child_above_sibling(this.backdrop, null);

        if (safePushModal(this.wm, this, this.backdrop)) {
            this.isOpen = true;
        } else {
            this.isOpen = false;
            this.backdrop.hide();
        }
    }

    close() {
        this._backdropPressOutside = false;
        safePopModal(this.backdrop);
        this.isOpen = false;
        if (this.backdrop) {
            this.backdrop.hide();
        }
    }

    destroy() {
        this.close();
        if (this.backdrop) {
            this.backdrop.destroy();
            this.backdrop = null;
        }
    }
}

module.exports = {
    closeAllOtherModals,
    safePushModal,
    safePopModal,
    createLayoutIcon,
    formatKeybinding,
    formatPrimaryShortcut,
    ActiveBorderOverlay,
    DropPreviewOverlay,
    ResizePreviewOverlay,
    HudOsd,
    LayoutSelectorPopup,
    QuickGridOverlay,
    ResizeModeController
};

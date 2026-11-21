// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Interactive Modals (Quick Snap Grid & Modal Resize Mode)
 */

const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Main = imports.ui.main;

const Layouts = require('./layouts');
const { filterWindowDescriptors } = require('./window-rules');
const { _, safePushModal, safePopModal } = require('./modal-utils');

/**
 * Interactive Quick Grid Overlay (gTile / FancyZones inspired)
 */
class QuickGridOverlay {
    constructor(wm) {
        this.wm = wm;
        this.isOpen = false;
        this.targetWindow = null;
        this.cols = 4;
        this.rows = 3;

        this.anchorCol = 0;
        this.anchorRow = 0;
        this.endCol = 1;
        this.endRow = 2;
        this._mouseSelecting = false;
        this._backdropPressOutside = false;

        this.backdrop = new St.Widget({
            style_class: 'cinnawm-grid-backdrop',
            reactive: true,
            can_focus: true,
            visible: false
        });

        this.dialog = new St.BoxLayout({
            style_class: 'cinnawm-grid-dialog',
            vertical: true,
            reactive: true
        });

        this.headerLabel = new St.Label({
            style_class: 'cinnawm-grid-header',
            text: _('Quick Snap Grid'),
            x_align: Clutter.ActorAlign.CENTER
        });

        this.subHeaderLabel = new St.Label({
            style_class: 'cinnawm-grid-subheader',
            text: _('Drag across cells with the mouse or use Arrows/HJKL (+Shift to extend), Enter to confirm, Esc to close'),
            x_align: Clutter.ActorAlign.CENTER
        });

        this.presetsRow = new St.BoxLayout({
            style_class: 'cinnawm-grid-presets',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER
        });

        this.gridContainer = new St.BoxLayout({
            style_class: 'cinnawm-grid-table',
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER
        });

        this.dialog.add_child(this.headerLabel);
        this.dialog.add_child(this.subHeaderLabel);
        this.dialog.add_child(this.presetsRow);
        this.dialog.add_child(this.gridContainer);
        this.backdrop.add_child(this.dialog);

        Main.uiGroup.add_child(this.backdrop);

        this.cells = [];
        this._buildPresets();

        this.backdrop.connect('button-press-event', (actor, event) => {
            let [mx, my] = event.get_coords();
            let [dx, dy] = this.dialog.get_transformed_position();
            let [dw, dh] = this.dialog.get_transformed_size();
            if (mx < dx || mx > dx + dw || my < dy || my > dy + dh) {
                this._backdropPressOutside = true;
                return Clutter.EVENT_STOP;
            }
            this._backdropPressOutside = false;
            return Clutter.EVENT_PROPAGATE;
        });

        this.backdrop.connect('button-release-event', () => {
            if (this._mouseSelecting) {
                this._mouseSelecting = false;
                this._applyCurrentGridSelection();
                this.close();
                return Clutter.EVENT_STOP;
            }
            if (this._backdropPressOutside) {
                this._backdropPressOutside = false;
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this.backdrop.connect('key-press-event', (actor, event) => this._onKeyPress(event));
    }

    _buildPresets() {
        const presets = [
            { label: _('Left ½'),     col: 0, cols: 2 },
            { label: _('Right ½'),    col: 1, cols: 2 },
            { label: _('Center 70%'), nx: 0.15, ny: 0.05, nw: 0.70, nh: 0.90 },
            { label: _('Left ⅓'),     col: 0, cols: 3 },
            { label: _('Center ⅓'),   col: 1, cols: 3 },
            { label: _('Right ⅓'),    col: 2, cols: 3 },
            { label: _('Max'),        col: 0, cols: 1 }
        ];

        for (let p of presets) {
            let btn = new St.Button({
                style_class: 'cinnawm-grid-preset-btn',
                label: p.label,
                reactive: true,
                can_focus: true
            });
            btn.connect('clicked', () => {
                this._applyPresetRect(p);
                this.close();
            });
            this.presetsRow.add_child(btn);
        }
    }

    _rebuildGridCells() {
        this.gridContainer.destroy_all_children();
        this.cells = [];

        this.cols = Math.max(2, Math.min(8, this.wm.settings.gridCols || 4));
        this.rows = Math.max(2, Math.min(6, this.wm.settings.gridRows || 3));

        for (let r = 0; r < this.rows; r++) {
            let rowBox = new St.BoxLayout({
                style_class: 'cinnawm-grid-row',
                vertical: false
            });
            this.cells[r] = [];

            for (let c = 0; c < this.cols; c++) {
                let cell = new St.Button({
                    style_class: 'cinnawm-grid-cell',
                    label: `${c + 1},${r + 1}`,
                    reactive: true,
                    track_hover: true
                });

                cell.connect('button-press-event', () => {
                    this._mouseSelecting = true;
                    this.anchorCol = c;
                    this.anchorRow = r;
                    this.endCol = c;
                    this.endRow = r;
                    this._updateHighlight();
                    return Clutter.EVENT_STOP;
                });

                cell.connect('enter-event', () => {
                    if (this._mouseSelecting) {
                        this.endCol = c;
                        this.endRow = r;
                        this._updateHighlight();
                    }
                });

                cell.connect('button-release-event', () => {
                    if (this._mouseSelecting) {
                        this._mouseSelecting = false;
                        this.endCol = c;
                        this.endRow = r;
                        this._applyCurrentGridSelection();
                        this.close();
                    }
                    return Clutter.EVENT_STOP;
                });

                this.cells[r][c] = cell;
                rowBox.add_child(cell);
            }
            this.gridContainer.add_child(rowBox);
        }
    }

    _updateHighlight() {
        let c1 = Math.min(this.anchorCol, this.endCol);
        let c2 = Math.max(this.anchorCol, this.endCol);
        let r1 = Math.min(this.anchorRow, this.endRow);
        let r2 = Math.max(this.anchorRow, this.endRow);

        for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
                let active = (c >= c1 && c <= c2 && r >= r1 && r <= r2);
                if (active) {
                    this.cells[r][c].add_style_class_name('selected');
                } else {
                    this.cells[r][c].remove_style_class_name('selected');
                }
            }
        }

        let rect = this._computeSelectionRect();
        if (rect && this.wm.dropPreview) {
            this.wm.dropPreview.showRect(rect, `${c2 - c1 + 1}×${r2 - r1 + 1}`);
        }
    }

    _getTargetGridArea() {
        let monIdx = this.targetWindow.get_monitor();
        let ws = this.targetWindow.get_workspace();
        let workarea = ws.get_work_area_for_monitor(monIdx);
        let { area, innerGap } = Layouts.computeEffectiveWorkarea(
            workarea,
            Math.max(2, this.cols),
            this.wm.settings,
            null
        );
        return {
            availX: area.x,
            availY: area.y,
            availW: Math.max(100, area.width),
            availH: Math.max(100, area.height),
            innerGap
        };
    }

    _computeSelectionRect() {
        if (!this.targetWindow) return null;
        let { availX, availY, availW, availH, innerGap } = this._getTargetGridArea();

        let c1 = Math.min(this.anchorCol, this.endCol);
        let c2 = Math.max(this.anchorCol, this.endCol);
        let r1 = Math.min(this.anchorRow, this.endRow);
        let r2 = Math.max(this.anchorRow, this.endRow);

        let cellW = (availW - innerGap * (this.cols - 1)) / this.cols;
        let cellH = (availH - innerGap * (this.rows - 1)) / this.rows;

        let x = (c1 === 0) ? availX : Math.round(availX + c1 * (cellW + innerGap));
        let right = (c2 === this.cols - 1) ? (availX + availW) : Math.round(availX + (c2 + 1) * cellW + c2 * innerGap);
        let y = (r1 === 0) ? availY : Math.round(availY + r1 * (cellH + innerGap));
        let bottom = (r2 === this.rows - 1) ? (availY + availH) : Math.round(availY + (r2 + 1) * cellH + r2 * innerGap);

        return {
            x,
            y,
            width: Math.max(60, right - x),
            height: Math.max(60, bottom - y)
        };
    }

    _applyCurrentGridSelection() {
        let rect = this._computeSelectionRect();
        if (!rect || !this.targetWindow) return;
        this.wm.snapWindowToCustomRect(this.targetWindow, rect);
    }

    _applyPresetRect(preset) {
        if (!this.targetWindow || !preset) return;
        let { availX, availY, availW, availH, innerGap } = this._getTargetGridArea();

        let rect;
        if (typeof preset.col === 'number' && typeof preset.cols === 'number') {
            let cols = Math.max(1, preset.cols);
            let col = Math.max(0, Math.min(cols - 1, preset.col));
            let colW = (availW - innerGap * (cols - 1)) / cols;
            let x = (col === 0) ? availX : Math.round(availX + col * (colW + innerGap));
            let right = (col === cols - 1) ? (availX + availW) : Math.round(availX + (col + 1) * colW + col * innerGap);
            rect = {
                x,
                y: availY,
                width: Math.max(60, right - x),
                height: availH
            };
        } else {
            rect = {
                x: Math.round(availX + availW * (preset.nx || 0)),
                y: Math.round(availY + availH * (preset.ny || 0)),
                width: Math.round(availW * (preset.nw || 1)),
                height: Math.round(availH * (preset.nh || 1))
            };
        }
        this.wm.snapWindowToCustomRect(this.targetWindow, rect);
    }

    _onKeyPress(event) {
        let symbol = event.get_key_symbol();
        let state = event.get_state();
        let shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_space) {
            this._applyCurrentGridSelection();
            this.close();
            return Clutter.EVENT_STOP;
        }

        let dc = 0;
        let dr = 0;
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_h || symbol === Clutter.KEY_H) dc = -1;
        else if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_l || symbol === Clutter.KEY_L) dc = 1;
        else if (symbol === Clutter.KEY_Up || symbol === Clutter.KEY_k || symbol === Clutter.KEY_K) dr = -1;
        else if (symbol === Clutter.KEY_Down || symbol === Clutter.KEY_j || symbol === Clutter.KEY_J) dr = 1;

        if (dc !== 0 || dr !== 0) {
            if (shift) {
                this.endCol = Math.max(0, Math.min(this.cols - 1, this.endCol + dc));
                this.endRow = Math.max(0, Math.min(this.rows - 1, this.endRow + dr));
            } else {
                let c1 = Math.min(this.anchorCol, this.endCol);
                let c2 = Math.max(this.anchorCol, this.endCol);
                let r1 = Math.min(this.anchorRow, this.endRow);
                let r2 = Math.max(this.anchorRow, this.endRow);
                let spanC = c2 - c1;
                let spanR = r2 - r1;
                let nextC1 = Math.max(0, Math.min(this.cols - 1 - spanC, c1 + dc));
                let nextR1 = Math.max(0, Math.min(this.rows - 1 - spanR, r1 + dr));
                this.anchorCol = nextC1;
                this.endCol = nextC1 + spanC;
                this.anchorRow = nextR1;
                this.endRow = nextR1 + spanR;
            }
            this._updateHighlight();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        let win = global.display.focus_window;
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL) {
            return;
        }

        this.targetWindow = win;
        this._mouseSelecting = false;
        this._backdropPressOutside = false;
        this._rebuildGridCells();

        this.anchorCol = 0;
        this.anchorRow = 0;
        this.endCol = Math.min(1, this.cols - 1);
        this.endRow = this.rows - 1;

        let title = win.get_title() || win.get_wm_class() || _('Window');
        if (title.length > 44) title = title.substring(0, 41) + '...';
        this.headerLabel.text = `${_('Quick Snap Grid')} — ${title}`;
        this.subHeaderLabel.text = _('Drag across cells with the mouse or use Arrows/HJKL (+Shift to extend), Enter to confirm, Esc to close');

        let monIdx = win.get_monitor();
        let monitor = Main.layoutManager.monitors[monIdx] || Main.layoutManager.primaryMonitor;

        this.backdrop.set_position(monitor.x, monitor.y);
        this.backdrop.set_size(monitor.width, monitor.height);
        this.backdrop.show();

        let [, dw] = this.dialog.get_preferred_width(-1);
        let [, dh] = this.dialog.get_preferred_height(-1);
        this.dialog.set_position(
            Math.round((monitor.width - dw) / 2),
            Math.round((monitor.height - dh) / 2)
        );

        Main.uiGroup.set_child_above_sibling(this.backdrop, null);
        if (safePushModal(this.wm, this, this.backdrop)) {
            this.isOpen = true;
            this._updateHighlight();
        } else {
            this.isOpen = false;
            this.backdrop.hide();
        }
    }

    close() {
        if (this.wm.dropPreview) {
            this.wm.dropPreview.hide();
        }
        this._mouseSelecting = false;
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

/**
 * Modal Resize Mode Controller (i3 / Sway inspired)
 */
class ResizeModeController {
    constructor(wm) {
        this.wm = wm;
        this.active = false;

        this.banner = new St.BoxLayout({
            style_class: 'cinnawm-resize-banner',
            vertical: false,
            reactive: true,
            can_focus: true,
            visible: false
        });

        this.label = new St.Label({
            style_class: 'cinnawm-resize-banner-label',
            text: _('[RESIZE MODE]  ←/→ or H/L: Width  |  ↑/↓ or K/J: Height  |  Shift: Fine  |  0: Reset  |  Esc/Enter: Exit')
        });

        this.banner.add_child(this.label);
        Main.uiGroup.add_child(this.banner);

        this.banner.connect('key-press-event', (actor, event) => this._onKeyPress(event));
        this.banner.connect('button-press-event', () => Clutter.EVENT_STOP);
        this.banner.connect('button-release-event', () => {
            this.stop();
            return Clutter.EVENT_STOP;
        });
    }

    toggle() {
        if (this.active) {
            this.stop();
        } else {
            this.start();
        }
    }

    start() {
        let monIdx = global.display.get_current_monitor();
        let monitor = Main.layoutManager.monitors[monIdx] || Main.layoutManager.primaryMonitor;

        this.label.text = _('[RESIZE MODE]  ←/→ or H/L: Width  |  ↑/↓ or K/J: Height  |  Shift: Fine  |  0: Reset  |  Esc/Enter: Exit');
        this.banner.show();
        let [, bw] = this.banner.get_preferred_width(-1);
        this.banner.set_position(
            monitor.x + Math.round((monitor.width - bw) / 2),
            monitor.y + 42
        );
        Main.uiGroup.set_child_above_sibling(this.banner, null);

        if (safePushModal(this.wm, this, this.banner)) {
            this.active = true;
        } else {
            this.active = false;
            this.banner.hide();
        }
    }

    stop() {
        safePopModal(this.banner);
        this.active = false;
        if (this.banner) {
            this.banner.hide();
        }
    }

    _onKeyPress(event) {
        let sym = event.get_key_symbol();
        let state = event.get_state();
        let shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        let step = shift ? 0.02 : 0.05;

        if (sym === Clutter.KEY_Escape || sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_r) {
            this.stop();
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Left || sym === Clutter.KEY_h || sym === Clutter.KEY_H) {
            this.wm.resizeFocusedDirectional(-step, 0);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Right || sym === Clutter.KEY_l || sym === Clutter.KEY_L) {
            this.wm.resizeFocusedDirectional(step, 0);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Up || sym === Clutter.KEY_k || sym === Clutter.KEY_K) {
            this.wm.resizeFocusedDirectional(0, -step);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_j || sym === Clutter.KEY_J) {
            this.wm.resizeFocusedDirectional(0, step);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_0 || sym === Clutter.KEY_equal) {
            this.wm.resetCurrentLayoutRatios();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_space) {
            this.wm.cycleLayout(1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_STOP;
    }

    destroy() {
        this.stop();
        if (this.banner) {
            this.banner.destroy();
            this.banner = null;
        }
    }
}

/**
 * Modal Quick Window & Tab Switcher (Rofi / Telescope style)
 */
class WindowSwitcherOverlay {
    constructor(wm) {
        this.wm = wm;
        this.isOpen = false;
        this._query = '';
        this._allWindows = [];
        this._filteredWindows = [];
        this._selectedIndex = 0;
        this._backdropPressOutside = false;

        this.backdrop = new St.Widget({
            style_class: 'cinnawm-grid-backdrop',
            reactive: true,
            can_focus: true,
            visible: false
        });

        this.dialog = new St.BoxLayout({
            style_class: 'cinnawm-switcher-dialog',
            vertical: true,
            reactive: true
        });

        this.headerLabel = new St.Label({
            style_class: 'cinnawm-switcher-header',
            text: _('Quick Window & Tab Switcher')
        });

        this.searchLabel = new St.Label({
            style_class: 'cinnawm-switcher-search',
            text: ''
        });

        this.listContainer = new St.BoxLayout({
            style_class: 'cinnawm-switcher-list',
            vertical: true
        });

        this.hintLabel = new St.Label({
            style_class: 'cinnawm-switcher-hint',
            text: _('Type to filter  •  ↑/↓ or Tab: Select  •  Enter: Activate  •  Esc: Close')
        });

        this.dialog.add_child(this.headerLabel);
        this.dialog.add_child(this.searchLabel);
        this.dialog.add_child(this.listContainer);
        this.dialog.add_child(this.hintLabel);
        this.backdrop.add_child(this.dialog);

        Main.uiGroup.add_child(this.backdrop);

        this.backdrop.connect('button-press-event', (_actor, event) => {
            let [mx, my] = event.get_coords();
            let [dx, dy] = this.dialog.get_transformed_position();
            let [dw, dh] = this.dialog.get_transformed_size();
            if (mx < dx || mx > dx + dw || my < dy || my > dy + dh) {
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

        this.backdrop.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
    }

    _formatRowBadge(win) {
        if (win.pip) return '[PiP]';
        if (win.scratchpad) return '[Scratch]';
        if (win.minimized) return '[Min]';
        if (win.stacked) return '[Tab]';
        if (win.floating) return '[Float]';
        return '[Tile]';
    }

    _rebuildList() {
        this._filteredWindows = filterWindowDescriptors(this._allWindows, this._query);
        if (this._filteredWindows.length === 0) {
            this._selectedIndex = 0;
        } else {
            this._selectedIndex = Math.max(0, Math.min(this._selectedIndex, this._filteredWindows.length - 1));
        }

        this.searchLabel.text = this._query
            ? `🔍 ${this._query}|`
            : `🔍 ${_('Type to filter by title, app, ws1, tab, pip, scratchpad...')}`;

        this.listContainer.destroy_all_children();

        if (this._filteredWindows.length === 0) {
            let emptyLbl = new St.Label({
                style_class: 'cinnawm-switcher-meta',
                text: _('No matching windows')
            });
            this.listContainer.add_child(emptyLbl);
            return;
        }

        const maxVisible = 10;
        let total = this._filteredWindows.length;
        let start = 0;
        if (total > maxVisible) {
            start = Math.max(0, Math.min(total - maxVisible, this._selectedIndex - Math.floor(maxVisible / 2)));
        }
        let end = Math.min(total, start + maxVisible);

        for (let i = start; i < end; i++) {
            let win = this._filteredWindows[i];
            let isSelected = (i === this._selectedIndex);
            let btn = new St.Button({
                style_class: isSelected ? 'cinnawm-switcher-row selected' : 'cinnawm-switcher-row',
                reactive: true,
                can_focus: false,
                x_expand: true
            });

            let rowBox = new St.BoxLayout({ vertical: false, x_expand: true });
            let badgeLbl = new St.Label({
                style_class: 'cinnawm-switcher-badge',
                text: this._formatRowBadge(win),
                y_align: Clutter.ActorAlign.CENTER
            });

            let rawTitle = (win.title || win.wmClass || _('Window')).replace(/\s+/g, ' ').trim();
            if (rawTitle.length > 52) rawTitle = `${rawTitle.slice(0, 49)}...`;
            let titleLbl = new St.Label({
                style_class: 'cinnawm-switcher-title',
                text: rawTitle,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER
            });

            let wsText = Number.isFinite(win.workspace) && win.workspace >= 0 ? `WS ${win.workspace + 1}` : 'ALL';
            let metaText = `${win.wmClass || ''}  •  ${wsText}${win.focused ? ' ★' : ''}`;
            let metaLbl = new St.Label({
                style_class: 'cinnawm-switcher-meta',
                text: metaText.trim(),
                y_align: Clutter.ActorAlign.CENTER
            });

            rowBox.add_child(badgeLbl);
            rowBox.add_child(titleLbl);
            rowBox.add_child(metaLbl);
            btn.set_child(rowBox);

            btn.connect('clicked', () => {
                this._activateAndClose(win);
            });
            this.listContainer.add_child(btn);
        }
    }

    _centerDialog() {
        let monIdx = global.display.get_current_monitor();
        let monitor = Main.layoutManager.monitors[monIdx] || Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        this.backdrop.set_position(monitor.x, monitor.y);
        this.backdrop.set_size(monitor.width, monitor.height);
        let [, dw] = this.dialog.get_preferred_width(-1);
        let [, dh] = this.dialog.get_preferred_height(-1);
        dw = Math.min(Math.max(580, dw), Math.max(320, monitor.width - 48));
        dh = Math.min(dh, Math.max(180, monitor.height - 64));
        this.dialog.set_position(
            Math.round((monitor.width - dw) / 2),
            Math.max(48, Math.round((monitor.height - dh) * 0.35))
        );
    }

    _activateAndClose(win) {
        this.close();
        if (win && this.wm && typeof this.wm.activateWindowById === 'function') {
            this.wm.activateWindowById(win.id);
        }
    }

    _onKeyPress(event) {
        let sym = event.get_key_symbol();
        let mods = event.get_state ? event.get_state() : 0;
        let ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        let alt = (mods & Clutter.ModifierType.MOD1_MASK) !== 0;

        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            let chosen = this._filteredWindows[this._selectedIndex] || this._filteredWindows[0];
            this._activateAndClose(chosen);
            return Clutter.EVENT_STOP;
        }

        let total = this._filteredWindows.length;
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Tab ||
            (ctrl && (sym === Clutter.KEY_j || sym === Clutter.KEY_n))) {
            if (total > 0) {
                this._selectedIndex = (this._selectedIndex + 1) % total;
                this._rebuildList();
            }
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Up || sym === Clutter.KEY_ISO_Left_Tab ||
            (ctrl && (sym === Clutter.KEY_k || sym === Clutter.KEY_p))) {
            if (total > 0) {
                this._selectedIndex = (this._selectedIndex - 1 + total) % total;
                this._rebuildList();
            }
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_BackSpace) {
            if (ctrl) {
                this._query = '';
            } else if (this._query.length > 0) {
                this._query = this._query.slice(0, -1);
            }
            this._selectedIndex = 0;
            this._rebuildList();
            this._centerDialog();
            return Clutter.EVENT_STOP;
        }

        if (ctrl && sym === Clutter.KEY_u) {
            this._query = '';
            this._selectedIndex = 0;
            this._rebuildList();
            this._centerDialog();
            return Clutter.EVENT_STOP;
        }

        if (!ctrl && !alt && typeof event.get_key_unicode === 'function') {
            let ch = event.get_key_unicode();
            if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32) {
                this._query += ch;
                this._selectedIndex = 0;
                this._rebuildList();
                this._centerDialog();
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_STOP;
    }

    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        if (!this.wm || typeof this.wm.getOpenWindowsInfo !== 'function') return;
        let raw = this.wm.getOpenWindowsInfo() || [];
        // Place non-focused active-workspace windows first so Super+Tab -> Enter jumps right away
        this._allWindows = raw.slice().sort((a, b) => {
            if (a.focused !== b.focused) return a.focused ? 1 : -1;
            if (a.onActiveWorkspace !== b.onActiveWorkspace) return a.onActiveWorkspace ? -1 : 1;
            if (a.minimized !== b.minimized) return a.minimized ? 1 : -1;
            return (a.workspace - b.workspace) || (a.id - b.id);
        });
        this._query = '';
        this._selectedIndex = 0;
        this._backdropPressOutside = false;
        this.headerLabel.text = _('Quick Window & Tab Switcher');
        this.hintLabel.text = _('Type to filter  •  ↑/↓ or Tab: Select  •  Enter: Activate  •  Esc: Close');

        this._rebuildList();
        this._centerDialog();
        this.backdrop.show();
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
    QuickGridOverlay,
    ResizeModeController,
    WindowSwitcherOverlay
};

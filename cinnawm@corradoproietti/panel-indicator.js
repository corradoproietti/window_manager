// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Panel Layout Selector Indicator & Panel Edit Mode DND Controller
 */

const Clutter = imports.gi.Clutter;
const Gettext = imports.gettext;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
let Applet = null;
let DND = null;
let Main = null;
let Tooltips = null;
try {
    Applet = imports.ui.applet;
    DND = imports.ui.dnd;
    Main = imports.ui.main;
    Tooltips = imports.ui.tooltips;
} catch (e) {}

const Layouts = require('./layouts');
const Overlays = require('./overlays');
const RuntimeConfig = require('./runtime-config');

const UUID = RuntimeConfig.resolveUuid();
function _(str) {
    return Gettext.dgettext(UUID, str);
}

class PanelIndicatorController {
    constructor(wm) {
        this.wm = wm;
        this.bar = null;
        this._draggable = null;
        this._isDragging = false;
        this._editModeSignalId = 0;
        this._tooltip = null;
        this._lastScrollTime = 0;
    }

    _installDndHooks() {
        if (!Main || !Main.panel || !Main.panel._rightBox || !Main.panel._rightBox._delegate) return;
        let proto = Object.getPrototypeOf(Main.panel._rightBox._delegate);
        if (!proto || proto._cinnawmOrigAcceptDrop) return;

        let origAcceptDrop = proto.acceptDrop;
        proto._cinnawmOrigAcceptDrop = origAcceptDrop;
        proto.acceptDrop = function(source, actor, x, y, time) {
            if (source && source._isCinnaWMIndicator && source._wm) {
                this._origAppletCenters = null;
                let wm = source._wm;
                let bar = source.actor;
                if (!bar) return false;

                let children = this._panelZone.get_children();
                let phActor = this._dragPlaceholder ? this._dragPlaceholder.actor : null;
                let phIdx = phActor ? children.indexOf(phActor) : -1;

                if (bar.get_parent() !== this._panelZone) {
                    if (bar.get_parent()) {
                        bar.get_parent().remove_child(bar);
                    }
                    let insertIdx = phIdx >= 0 ? phIdx : children.length;
                    this._panelZone.insert_child_at_index(bar, insertIdx);
                } else if (phIdx >= 0) {
                    let srcIdx = children.indexOf(bar);
                    let targetIdx = (srcIdx !== -1 && srcIdx < phIdx) ? phIdx - 1 : phIdx;
                    this._panelZone.set_child_at_index(bar, targetIdx);
                }

                let finalChildren = this._panelZone.get_children().filter(
                    c => !phActor || c !== phActor
                );
                let finalIdx = Math.max(0, finalChildren.indexOf(bar));

                this._clearDragPlaceholder();

                wm._panelPosition = {
                    panelId: this._panelId,
                    zone: this._zoneString,
                    index: finalIdx
                };

                if (bar._applet) {
                    let targetPanel = (Main.panelManager && Main.panelManager.panels)
                        ? (Main.panelManager.panels.find(p => p && p.panelId === this._panelId) || Main.panel)
                        : Main.panel;
                    bar._applet.panel = targetPanel;
                    bar._applet.locationLabel = this._zoneString;
                    bar._applet._zoneString = this._zoneString;
                    bar._applet._panelLocation = this._panelZone;
                }

                wm._savePersistedStates();
                return true;
            }
            return origAcceptDrop.call(this, source, actor, x, y, time);
        };
    }

    _removeDndHooks() {
        if (!Main || !Main.panel || !Main.panel._rightBox || !Main.panel._rightBox._delegate) return;
        let proto = Object.getPrototypeOf(Main.panel._rightBox._delegate);
        if (proto && proto._cinnawmOrigAcceptDrop) {
            proto.acceptDrop = proto._cinnawmOrigAcceptDrop;
            delete proto._cinnawmOrigAcceptDrop;
        }
    }

    _getTargetPanelBox() {
        let targetPanel = Main ? Main.panel : null;
        let pos = this.wm._panelPosition;
        if (pos && pos.panelId && Main && Main.panelManager && Main.panelManager.panels) {
            let found = Main.panelManager.panels.find(p => p && p.panelId === pos.panelId);
            if (found) targetPanel = found;
        }
        if (!targetPanel) return { panel: null, box: null, zone: 'right' };

        let zone = (pos && pos.zone) || 'right';
        let box = targetPanel._rightBox;
        if (zone === 'left' && targetPanel._leftBox) {
            box = targetPanel._leftBox;
        } else if (zone === 'center' && targetPanel._centerBox) {
            box = targetPanel._centerBox;
        }
        return { panel: targetPanel, box, zone };
    }

    setup() {
        if (!this.wm.settings.showPanelIndicator || this.bar || !Main || !Main.panel) {
            return;
        }

        let { panel, box, zone } = this._getTargetPanelBox();
        if (!box) return;

        this._installDndHooks();

        this.bar = new St.BoxLayout({
            style_class: 'applet-box cinnawm-panel-bar',
            vertical: false,
            reactive: true,
            track_hover: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER
        });

        // Set up Applet-compatible delegate for Cinnamon Panel Edit Mode DND
        let delegate = Object.create(Applet.IconApplet.prototype);
        delegate.actor = this.bar;
        delegate._isCinnaWMIndicator = true;
        delegate._wm = this.wm;
        delegate.getAllowedLayout = () => Applet.AllowedLayout.BOTH;
        delegate.getDragActor = () => {
            let clone = new Clutter.Clone({ source: this.bar });
            clone.width = this.bar.width;
            clone.height = this.bar.height;
            return clone;
        };
        delegate.getDragActorSource = () => this.bar;

        this.bar._delegate = delegate;
        this.bar._applet = {
            panel,
            locationLabel: zone,
            _zoneString: zone,
            _panelLocation: box,
            _newOrder: null,
            _newPanelId: null
        };

        this._draggable = DND.makeDraggable(this.bar);
        const syncEditMode = () => {
            if (this._draggable) {
                this._draggable.inhibit = !global.settings.get_boolean('panel-edit-mode');
            }
        };
        syncEditMode();

        this._editModeSignalId = global.settings.connect('changed::panel-edit-mode', () => {
            syncEditMode();
        });

        this._draggable.connect('drag-begin', () => {
            this._isDragging = true;
            if (this.wm.layoutSelector && this.wm.layoutSelector.isOpen) {
                this.wm.layoutSelector.close();
            }
            if (Main.panelManager && Main.panelManager.resetPanelDND) {
                Main.panelManager.resetPanelDND();
            }
        });
        this._draggable.connect('drag-end', () => {
            this._isDragging = false;
        });
        this._draggable.connect('drag-cancelled', () => {
            this._isDragging = false;
        });

        this.bar.connect('scroll-event', (_actor, event) => {
            if (global.settings.get_boolean('panel-edit-mode')) {
                return Clutter.EVENT_PROPAGATE;
            }
            let dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP) {
                this.wm.cycleLayout(-1);
                return Clutter.EVENT_STOP;
            } else if (dir === Clutter.ScrollDirection.DOWN) {
                this.wm.cycleLayout(1);
                return Clutter.EVENT_STOP;
            } else if (dir === Clutter.ScrollDirection.SMOOTH) {
                let [, dy] = event.get_scroll_delta();
                if (Math.abs(dy) >= 0.4) {
                    let now = GLib.get_monotonic_time();
                    if (!this._lastScrollTime || (now - this._lastScrollTime) > 160000) {
                        this._lastScrollTime = now;
                        this.wm.cycleLayout(dy > 0 ? 1 : -1);
                    }
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        try {
            this._tooltip = new Tooltips.Tooltip(this.bar, '');
        } catch (e) {
            this._tooltip = null;
        }

        this.bar.connect('button-release-event', (_actor, event) => {
            if (global.settings.get_boolean('panel-edit-mode') || this._isDragging) {
                return Clutter.EVENT_PROPAGATE;
            }
            let b = event.get_button();
            if (b === 1) {
                if (this.wm.layoutSelector) {
                    this.wm.layoutSelector.toggle(this.bar);
                }
                return Clutter.EVENT_STOP;
            } else if (b === 2) {
                this.wm.toggleWorkspaceTiling();
                return Clutter.EVENT_STOP;
            } else if (b === 3) {
                let state = this.wm.getCurrentState();
                let activeId = (!state.autoTile || state.layoutId === 'floating') ? 'floating' : state.layoutId;
                this.wm.openSettingsDialog(activeId);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        let pos = this.wm._panelPosition;
        let targetIdx = (pos && Number.isFinite(pos.index))
            ? Math.max(0, Math.min(pos.index, box.get_children().length))
            : 0;
        box.insert_child_at_index(this.bar, targetIdx);
        this.update();
    }

    remove() {
        if (this._editModeSignalId) {
            try {
                global.settings.disconnect(this._editModeSignalId);
            } catch (e) {
                // ignore
            }
            this._editModeSignalId = 0;
        }
        this._draggable = null;
        this._isDragging = false;
        this._removeDndHooks();
        if (this._tooltip) {
            try {
                this._tooltip.destroy();
            } catch (e) {
                // ignore
            }
            this._tooltip = null;
        }
        if (this.bar) {
            this.bar.destroy();
            this.bar = null;
        }
    }

    syncVisibility() {
        if (this.wm.settings.showPanelIndicator) {
            if (!this.bar) {
                this.setup();
            } else {
                this.update();
            }
        } else {
            this.remove();
        }
    }

    update() {
        if (!this.bar) return;
        this.bar.destroy_all_children();

        let state = this.wm.getCurrentState();
        let activeId = (!state.autoTile || state.layoutId === 'floating') ? 'floating' : state.layoutId;
        let meta = Layouts.getLayoutMeta(activeId);

        let icon = Overlays.createLayoutIcon(this.wm.meta.path, meta.iconFile, 16, 'cinnawm-panel-icon');
        icon.reactive = false;
        icon.opacity = (activeId === 'floating') ? 150 : 255;

        this.bar.add_child(icon);

        if (this._tooltip) {
            try {
                let activeWs = global.workspace_manager.get_active_workspace();
                let wsIdx = activeWs ? activeWs.index() : 0;
                let monIdx = global.display.get_current_monitor();
                let tileableMap = this.wm.getTileableWindowsMap(wsIdx, monIdx);
                let tiledCount = (activeId === 'floating') ? 0 : tileableMap.size;
                let stackedCount = 0;
                if (activeId !== 'floating' && state.lastRects) {
                    for (let [winId, rect] of state.lastRects.entries()) {
                        if (rect && rect.stacked && tileableMap.has(winId)) {
                            stackedCount++;
                        }
                    }
                }

                let floatingCount = 0;
                if (activeWs) {
                    let allWsWins = activeWs.list_windows();
                    for (let mw of allWsWins) {
                        if (!mw || mw.minimized || mw.get_window_type() !== Meta.WindowType.NORMAL) continue;
                        if (mw.get_monitor() !== monIdx) continue;
                        let wid = mw.get_stable_sequence();
                        if (this.wm.scratchpad && this.wm.scratchpad.has(wid)) continue;
                        if (activeId === 'floating' || !tileableMap.has(wid)) {
                            floatingCount++;
                        }
                    }
                }

                let scratchCount = (this.wm.scratchpad && this.wm.scratchpad.scratchpadIds)
                    ? this.wm.scratchpad.scratchpadIds.size
                    : 0;

                let escapedLayout = GLib.markup_escape_text(_(meta.name), -1);
                let wsTitle = GLib.markup_escape_text(`${_('Workspace')} ${wsIdx + 1}`, -1);
                let layoutLine = `${GLib.markup_escape_text(_('Layout'), -1)}: <b>${escapedLayout}</b>`;
                let statsParts = [
                    `${GLib.markup_escape_text(_('Tiled'), -1)}: <b>${tiledCount}</b>`
                ];
                if (stackedCount > 0) {
                    statsParts.push(`${GLib.markup_escape_text(_('Stacked'), -1)}: <b>${stackedCount}</b>`);
                }
                statsParts.push(`${GLib.markup_escape_text(_('Floating'), -1)}: <b>${floatingCount}</b>`);
                if (scratchCount > 0) {
                    statsParts.push(`${GLib.markup_escape_text(_('Scratchpad'), -1)}: <b>${scratchCount}</b>`);
                }
                let hintLine = GLib.markup_escape_text(
                    _('Click: Layout  •  Scroll: Cycle layout  •  Middle: Tiling On/Off  •  Right: Settings'),
                    -1
                );
                let lines = [
                    `<b>CinnaWM — ${wsTitle}</b>`,
                    layoutLine,
                    statsParts.join('  •  '),
                    `<span size="small" alpha="75%">${hintLine}</span>`
                ];
                this._tooltip.set_markup(lines.join('\n'));
            } catch (e) {
                if (typeof global !== 'undefined' && global.logError) {
                    global.logError(`[${UUID}] Failed to update panel tooltip: ${e}`);
                }
            }
        }
    }
}

module.exports = {
    PanelIndicatorController
};

// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Shared Modal Helpers, Layout Icon Builder & Keybinding Formatting
 */

const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const St = imports.gi.St;
const Main = imports.ui.main;

const RuntimeConfig = require('./runtime-config');

const { uuid: UUID, _: _t } = RuntimeConfig.bindGettext();

function _(str) {
    return _t(str);
}

/**
 * Safely manages Cinnamon modal grabs so `Main.modalCount` and `Cinnamon.StageInputMode`
 * can never desynchronize or leave a phantom FULLSCREEN stage grab blocking desktop clicks.
 */
function closeAllOtherModals(wm, exceptModal) {
    if (!wm) return;
    if (wm.activeBorder && wm.activeBorder !== exceptModal && wm.activeBorder.isStackPopupOpen) {
        wm.activeBorder._closeStackPopup();
    }
    const modals = [wm.layoutSelector, wm.quickGrid, wm.resizeMode, wm.resizePreview];
    for (let m of modals) {
        if (m && m !== exceptModal) {
            if (typeof m.close === 'function' && m.isOpen) {
                m.close();
            } else if (typeof m.stop === 'function' && m.active) {
                m.stop();
            }
        }
    }
}

function safePushModal(wm, ownerModal, actor) {
    if (!actor) return false;
    closeAllOtherModals(wm, ownerModal);

    if (typeof Main._findModal === 'function' && Main._findModal(actor) >= 0) {
        actor.grab_key_focus();
        return true;
    }

    try {
        if (Main.pushModal(actor)) {
            actor.grab_key_focus();
            return true;
        }
    } catch (e) {
        global.logError(`[CinnaWM] safePushModal error: ${e}`);
    }
    return false;
}

function safePopModal(actor) {
    if (!actor) return;
    try {
        if (typeof Main._findModal === 'function') {
            while (Main._findModal(actor) >= 0) {
                Main.popModal(actor);
            }
        } else {
            Main.popModal(actor);
        }
    } catch (e) {
        global.logError(`[CinnaWM] safePopModal error: ${e}`);
    }

    try {
        if (Main.modalCount <= 0) {
            global.set_stage_input_mode(Cinnamon.StageInputMode.NORMAL);
        }
        if (!Meta.is_wayland_compositor()) {
            let gdkDisplay = Gdk.Display.get_default();
            if (gdkDisplay) gdkDisplay.sync();
        }
        global.sync_pointer();
    } catch (e) {
        // Ignore sync errors
    }
}

/**
 * Creates an St.Icon from our custom SVG files in `cinnawm@corrado/icons/`
 */
function createLayoutIcon(extensionPath, iconFile, iconSize = 16, styleClass = 'cinnawm-layout-icon') {
    let fullPath = `${extensionPath}/icons/${iconFile}`;
    let file = Gio.file_new_for_path(fullPath);
    if (file.query_exists(null)) {
        let gicon = new Gio.FileIcon({ file });
        return new St.Icon({
            gicon,
            icon_size: iconSize,
            style_class: styleClass,
            y_align: Clutter.ActorAlign.CENTER
        });
    }
    return new St.Icon({
        icon_name: 'view-grid-symbolic',
        icon_size: iconSize,
        icon_type: St.IconType.SYMBOLIC,
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER
    });
}

/**
 * Formats a Cinnamon keybinding string (e.g. "<Super>h::<Super>Left")
 * into a human-friendly representation (e.g. "Super + H / Super + ←").
 */
function formatKeybinding(raw) {
    if (!raw || typeof raw !== 'string') return _('Unassigned');
    let parts = raw.split('::').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return _('Unassigned');

    const keyMap = {
        'Return': 'Enter',
        'KP_Enter': 'Enter',
        'space': 'Space',
        'Left': '←',
        'Right': '→',
        'Up': '↑',
        'Down': '↓',
        'equal': '=',
        'plus': '+',
        'KP_Add': 'Num +',
        'minus': '-',
        'KP_Subtract': 'Num -',
        'period': '.',
        'comma': ',',
        'bracketleft': '[',
        'bracketright': ']',
        'grave': '`',
        'Escape': 'Esc'
    };

    return parts.map(part => {
        let mods = [];
        let key = part.replace(/<([^>]+)>/g, (_, m) => {
            let ml = m.toLowerCase();
            if (ml === 'super' || ml === 'mod4') mods.push('Super');
            else if (ml === 'shift') mods.push('Shift');
            else if (ml === 'control' || ml === 'ctrl' || ml === 'primary') mods.push('Ctrl');
            else if (ml === 'alt' || ml === 'mod1') mods.push('Alt');
            else mods.push(m);
            return '';
        });
        if (keyMap[key]) key = keyMap[key];
        else if (key.length === 1) key = key.toUpperCase();
        return [...mods, key].join(' + ');
    }).join(' / ');
}

function formatPrimaryShortcut(raw, fallback = '') {
    if (!raw || typeof raw !== 'string') return fallback;
    let first = raw.split('::').map(s => s.trim()).find(Boolean);
    return first ? formatKeybinding(first) : fallback;
}

module.exports = {
    _,
    closeAllOtherModals,
    safePushModal,
    safePopModal,
    createLayoutIcon,
    formatKeybinding,
    formatPrimaryShortcut
};

// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Dedicated Session D-Bus IPC Service (/org/cinnawm/Service)
 *
 * Replaces arbitrary org.Cinnamon.Eval evaluation with a fixed, typed D-Bus
 * interface for reading settings snapshots and applying live updates from
 * the standalone GTK3 preferences window.
 */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const RuntimeConfig = require('./runtime-config');

const IPC_CONFIG = RuntimeConfig.getIpcConfig();
const BUS_NAME = IPC_CONFIG.busName;
const OBJECT_PATH = IPC_CONFIG.objectPath;
const INTERFACE_NAME = IPC_CONFIG.interfaceName;

const CINNAWM_IFACE_XML = `
<node>
  <interface name="${INTERFACE_NAME}">
    <signal name="StateChanged">
      <arg type="s" name="reason"/>
    </signal>
    <method name="GetSnapshot">
      <arg type="s" direction="out" name="payload"/>
    </method>
    <method name="UpdateSetting">
      <arg type="s" direction="in" name="prop"/>
      <arg type="s" direction="in" name="valueJson"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ActivateLayout">
      <arg type="s" direction="in" name="layoutId"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ResetRatios">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ImportSettings">
      <arg type="s" direction="in" name="payloadJson"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="CycleLayout">
      <arg type="i" direction="in" name="direction"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="FocusDirection">
      <arg type="s" direction="in" name="direction"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="SwapDirection">
      <arg type="s" direction="in" name="direction"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ToggleFloating">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ToggleTiling">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ToggleScratchpad">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="MoveToWorkspace">
      <arg type="i" direction="in" name="delta"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="MoveToNextMonitor">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="FocusNextMonitor">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="GetOpenWindows">
      <arg type="s" direction="out" name="windowsJson"/>
    </method>
  </interface>
</node>
`;

class CinnaWMIpcService {
    constructor(wm) {
        this.wm = wm;
        this._dbusImpl = null;
        this._ownerId = 0;
    }

    start() {
        if (this._dbusImpl) return;
        try {
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(CINNAWM_IFACE_XML, this);
            this._dbusImpl.export(Gio.DBus.session, OBJECT_PATH);
            this._ownerId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                BUS_NAME,
                Gio.BusNameOwnerFlags.REPLACE | Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT,
                null,
                null,
                null
            );
        } catch (e) {
            if (typeof global !== 'undefined' && global.logError) {
                global.logError(`[${this.wm ? this.wm.uuid : 'cinnawm'}] Failed to start D-Bus IPC service: ${e}`);
            }
        }
    }

    GetSnapshot() {
        if (!this.wm) return '{}';
        let st = this.wm.getCurrentState();
        let activeLayout = (!st.autoTile || st.layoutId === 'floating') ? 'floating' : st.layoutId;
        return JSON.stringify({
            settings: this.wm.settings,
            activeLayout
        });
    }

    UpdateSetting(prop, valueJson) {
        if (!this.wm || typeof prop !== 'string') return false;
        try {
            let value = JSON.parse(valueJson);
            this.wm.updateSettingValue(prop, value);
            return true;
        } catch (e) {
            return false;
        }
    }

    ActivateLayout(layoutId) {
        if (!this.wm || typeof layoutId !== 'string') return false;
        this.wm.setLayoutById(layoutId);
        return true;
    }

    ResetRatios() {
        if (!this.wm) return false;
        this.wm.resetCurrentLayoutRatios();
        return true;
    }

    ImportSettings(payloadJson) {
        if (!this.wm || typeof this.wm.importSettingsSnapshot !== 'function') return false;
        try {
            let parsed = JSON.parse(payloadJson);
            return Boolean(this.wm.importSettingsSnapshot(parsed));
        } catch (e) {
            return false;
        }
    }

    _normalizeDirection(direction) {
        if (typeof direction !== 'string') return null;
        let d = direction.trim().toLowerCase();
        return ['left', 'right', 'up', 'down'].includes(d) ? d : null;
    }

    CycleLayout(direction) {
        if (!this.wm || typeof this.wm.cycleLayout !== 'function') return false;
        let step = Number(direction) < 0 ? -1 : 1;
        this.wm.cycleLayout(step);
        return true;
    }

    FocusDirection(direction) {
        let dir = this._normalizeDirection(direction);
        if (!this.wm || !dir || typeof this.wm.focusDirectional !== 'function') return false;
        this.wm.focusDirectional(dir);
        return true;
    }

    SwapDirection(direction) {
        let dir = this._normalizeDirection(direction);
        if (!this.wm || !dir || typeof this.wm.swapDirectional !== 'function') return false;
        this.wm.swapDirectional(dir);
        return true;
    }

    ToggleFloating() {
        if (!this.wm || typeof this.wm.toggleFocusedFloating !== 'function') return false;
        this.wm.toggleFocusedFloating();
        return true;
    }

    ToggleTiling() {
        if (!this.wm || typeof this.wm.toggleWorkspaceTiling !== 'function') return false;
        this.wm.toggleWorkspaceTiling();
        return true;
    }

    ToggleScratchpad() {
        if (!this.wm || typeof this.wm.handleScratchpadToggle !== 'function') return false;
        this.wm.handleScratchpadToggle();
        return true;
    }

    MoveToWorkspace(delta) {
        if (!this.wm || typeof this.wm.moveFocusedToWorkspace !== 'function') return false;
        let d = Math.trunc(Number(delta) || 0);
        if (d === 0) return false;
        return Boolean(this.wm.moveFocusedToWorkspace(d));
    }

    MoveToNextMonitor() {
        if (!this.wm || typeof this.wm.moveFocusedToAdjacentMonitor !== 'function') return false;
        return Boolean(this.wm.moveFocusedToAdjacentMonitor(1));
    }

    FocusNextMonitor() {
        if (!this.wm || typeof this.wm.focusMonitorStep !== 'function') return false;
        return Boolean(this.wm.focusMonitorStep(1));
    }

    GetOpenWindows() {
        if (!this.wm || typeof this.wm.getOpenWindowsInfo !== 'function') return '[]';
        try {
            return JSON.stringify(this.wm.getOpenWindowsInfo() || []);
        } catch (e) {
            return '[]';
        }
    }

    emitStateChanged(reason = 'updated') {
        if (!this._dbusImpl || typeof this._dbusImpl.emit_signal !== 'function') return false;
        try {
            this._dbusImpl.emit_signal('StateChanged', new GLib.Variant('(s)', [String(reason || 'updated')]));
            return true;
        } catch (e) {
            return false;
        }
    }

    destroy() {
        if (this._ownerId) {
            try {
                Gio.bus_unown_name(this._ownerId);
            } catch (e) {
                // ignore
            }
            this._ownerId = 0;
        }
        if (this._dbusImpl) {
            try {
                this._dbusImpl.unexport();
            } catch (e) {
                // ignore
            }
            this._dbusImpl = null;
        }
    }
}

module.exports = {
    BUS_NAME,
    OBJECT_PATH,
    INTERFACE_NAME,
    CINNAWM_IFACE_XML,
    CinnaWMIpcService
};

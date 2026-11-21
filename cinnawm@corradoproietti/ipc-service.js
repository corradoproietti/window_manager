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
    <method name="TogglePip">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ActivateWindow">
      <arg type="i" direction="in" name="winId"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="CloseWindow">
      <arg type="i" direction="in" name="winId"/>
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

    _safeCall(methodName, fallback, fn) {
        if (!this.wm) return fallback;
        try {
            return fn();
        } catch (e) {
            if (typeof global !== 'undefined' && global.logError) {
                global.logError(`[${this.wm.uuid || 'cinnawm'}] IPC ${methodName} failed: ${e}`);
            }
            return fallback;
        }
    }

    _isValidSettingValue(prop, value) {
        if (typeof prop !== 'string' || !this.wm || !this.wm.settings ||
            !Object.prototype.hasOwnProperty.call(this.wm.settings, prop)) {
            return false;
        }
        let expectedType = typeof this.wm.settings[prop];
        if (typeof value !== expectedType) return false;
        if (expectedType === 'number' && !Number.isFinite(value)) return false;
        return true;
    }

    GetSnapshot() {
        return this._safeCall('GetSnapshot', '{}', () => {
            let st = this.wm.getCurrentState();
            let activeLayout = (!st.autoTile || st.layoutId === 'floating') ? 'floating' : st.layoutId;
            return JSON.stringify({
                settings: this.wm.settings,
                activeLayout
            });
        });
    }

    UpdateSetting(prop, valueJson) {
        return this._safeCall('UpdateSetting', false, () => {
            let value = JSON.parse(valueJson);
            if (!this._isValidSettingValue(prop, value)) {
                return false;
            }
            this.wm.updateSettingValue(prop, value);
            return true;
        });
    }

    ActivateLayout(layoutId) {
        if (typeof layoutId !== 'string' || !layoutId.trim()) return false;
        return this._safeCall('ActivateLayout', false, () => {
            this.wm.setLayoutById(layoutId);
            return true;
        });
    }

    ResetRatios() {
        return this._safeCall('ResetRatios', false, () => {
            this.wm.resetCurrentLayoutRatios();
            return true;
        });
    }

    ImportSettings(payloadJson) {
        if (typeof payloadJson !== 'string') return false;
        return this._safeCall('ImportSettings', false, () => {
            if (typeof this.wm.importSettingsSnapshot !== 'function') return false;
            let parsed = JSON.parse(payloadJson);
            return Boolean(this.wm.importSettingsSnapshot(parsed));
        });
    }

    _normalizeDirection(direction) {
        if (typeof direction !== 'string') return null;
        let d = direction.trim().toLowerCase();
        return ['left', 'right', 'up', 'down'].includes(d) ? d : null;
    }

    CycleLayout(direction) {
        return this._safeCall('CycleLayout', false, () => {
            if (typeof this.wm.cycleLayout !== 'function') return false;
            let step = Number(direction) < 0 ? -1 : 1;
            this.wm.cycleLayout(step);
            return true;
        });
    }

    FocusDirection(direction) {
        let dir = this._normalizeDirection(direction);
        if (!dir) return false;
        return this._safeCall('FocusDirection', false, () => {
            if (typeof this.wm.focusDirectional !== 'function') return false;
            this.wm.focusDirectional(dir);
            return true;
        });
    }

    SwapDirection(direction) {
        let dir = this._normalizeDirection(direction);
        if (!dir) return false;
        return this._safeCall('SwapDirection', false, () => {
            if (typeof this.wm.swapDirectional !== 'function') return false;
            this.wm.swapDirectional(dir);
            return true;
        });
    }

    ToggleFloating() {
        return this._safeCall('ToggleFloating', false, () => {
            if (typeof this.wm.toggleFocusedFloating !== 'function') return false;
            this.wm.toggleFocusedFloating();
            return true;
        });
    }

    ToggleTiling() {
        return this._safeCall('ToggleTiling', false, () => {
            if (typeof this.wm.toggleWorkspaceTiling !== 'function') return false;
            this.wm.toggleWorkspaceTiling();
            return true;
        });
    }

    ToggleScratchpad() {
        return this._safeCall('ToggleScratchpad', false, () => {
            if (typeof this.wm.handleScratchpadToggle !== 'function') return false;
            this.wm.handleScratchpadToggle();
            return true;
        });
    }

    MoveToWorkspace(delta) {
        let d = Math.trunc(Number(delta) || 0);
        if (d === 0) return false;
        return this._safeCall('MoveToWorkspace', false, () => {
            if (typeof this.wm.moveFocusedToWorkspace !== 'function') return false;
            return Boolean(this.wm.moveFocusedToWorkspace(d));
        });
    }

    MoveToNextMonitor() {
        return this._safeCall('MoveToNextMonitor', false, () => {
            if (typeof this.wm.moveFocusedToAdjacentMonitor !== 'function') return false;
            return Boolean(this.wm.moveFocusedToAdjacentMonitor(1));
        });
    }

    FocusNextMonitor() {
        return this._safeCall('FocusNextMonitor', false, () => {
            if (typeof this.wm.focusMonitorStep !== 'function') return false;
            return Boolean(this.wm.focusMonitorStep(1));
        });
    }

    TogglePip() {
        return this._safeCall('TogglePip', false, () => {
            if (typeof this.wm.toggleFocusedPip !== 'function') return false;
            return Boolean(this.wm.toggleFocusedPip());
        });
    }

    ActivateWindow(winId) {
        return this._safeCall('ActivateWindow', false, () => {
            let id = Number(winId);
            if (!Number.isInteger(id) || id <= 0 || typeof this.wm.activateWindowById !== 'function') {
                return false;
            }
            return Boolean(this.wm.activateWindowById(id));
        });
    }

    CloseWindow(winId) {
        return this._safeCall('CloseWindow', false, () => {
            let id = Number(winId);
            if (!Number.isInteger(id) || id <= 0 || typeof this.wm.closeWindowById !== 'function') {
                return false;
            }
            return Boolean(this.wm.closeWindowById(id));
        });
    }

    GetOpenWindows() {
        return this._safeCall('GetOpenWindows', '[]', () => {
            if (typeof this.wm.getOpenWindowsInfo !== 'function') return '[]';
            return JSON.stringify(this.wm.getOpenWindowsInfo() || []);
        });
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

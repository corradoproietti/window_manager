// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/**
 * CinnaWM - Parameterized Runtime Paths, Extension Metadata & IPC Configuration
 *
 * Centralizes UUID resolution, XDG directories, Gettext domain binding, and
 * D-Bus identifiers cleanly without hardcoding user-specific paths.
 */

const ByteArray = imports.byteArray;
const Gettext = imports.gettext;
const GLib = imports.gi.GLib;

const DEFAULT_UUID = 'cinnawm@corrado';
const DEFAULT_DBUS_NAME = 'org.cinnawm.Service';
const DEFAULT_DBUS_PATH = '/org/cinnawm/Service';

let _cachedMetadata = null;

function _envOrDefault(varName, fallback) {
    try {
        let val = GLib.getenv(varName);
        if (typeof val === 'string' && val.trim().length > 0) {
            return val.trim();
        }
    } catch (e) {
        // Ignore getenv errors in restricted environments
    }
    return fallback;
}

function getExtensionObject() {
    try {
        if (imports.misc && imports.misc.extensionUtils &&
            typeof imports.misc.extensionUtils.getCurrentExtension === 'function') {
            return imports.misc.extensionUtils.getCurrentExtension();
        }
    } catch (e) {
        // Not running inside Cinnamon extension loader (e.g. headless cjs test runner)
    }
    return null;
}

function readMetadata(extensionPath = null) {
    if (!extensionPath && _cachedMetadata) {
        return _cachedMetadata;
    }

    let basePath = extensionPath;
    if (!basePath) {
        let ext = getExtensionObject();
        if (ext && ext.path) {
            basePath = ext.path;
        }
    }

    if (basePath) {
        let metaPath = GLib.build_filenamev([basePath, 'metadata.json']);
        if (GLib.file_test(metaPath, GLib.FileTest.EXISTS)) {
            try {
                let [ok, contents] = GLib.file_get_contents(metaPath);
                if (ok && contents) {
                    let parsed = JSON.parse(ByteArray.toString(contents));
                    if (!extensionPath) {
                        _cachedMetadata = parsed;
                    }
                    return parsed;
                }
            } catch (e) {
                // Fall through to defaults
            }
        }
    }

    return null;
}

function resolveUuid(extensionMeta = null) {
    let envUuid = _envOrDefault('CINNAWM_UUID', '');
    if (envUuid) return envUuid;

    if (extensionMeta && typeof extensionMeta.uuid === 'string' && extensionMeta.uuid.length > 0) {
        return extensionMeta.uuid;
    }

    let ext = getExtensionObject();
    if (ext && ext.metadata && typeof ext.metadata.uuid === 'string' && ext.metadata.uuid.length > 0) {
        return ext.metadata.uuid;
    }

    let parsedMeta = readMetadata(null);
    if (parsedMeta && typeof parsedMeta.uuid === 'string' && parsedMeta.uuid.length > 0) {
        return parsedMeta.uuid;
    }

    return DEFAULT_UUID;
}

function getConfigRoot() {
    return _envOrDefault('CINNAWM_CONFIG_DIR', GLib.get_user_config_dir());
}

function getDataRoot() {
    return _envOrDefault('CINNAWM_DATA_DIR', GLib.get_user_data_dir());
}

function getSpicesConfigDir(uuid, create = false) {
    let effUuid = uuid || resolveUuid();
    let dir = GLib.build_filenamev([getConfigRoot(), 'cinnamon', 'spices', effUuid]);
    if (create) {
        GLib.mkdir_with_parents(dir, 0o755);
    }
    return dir;
}

function getSpicesConfigFile(uuid, filename, createDir = false) {
    return GLib.build_filenamev([getSpicesConfigDir(uuid, createDir), filename]);
}

function hasCompiledLocale(localeRoot, uuid) {
    if (!localeRoot || !uuid || !GLib.file_test(localeRoot, GLib.FileTest.IS_DIR)) {
        return false;
    }
    try {
        let dir = GLib.Dir.open(localeRoot, 0);
        let entry;
        while ((entry = dir.read_name()) !== null) {
            let moPath = GLib.build_filenamev([localeRoot, entry, 'LC_MESSAGES', `${uuid}.mo`]);
            if (GLib.file_test(moPath, GLib.FileTest.EXISTS)) {
                dir.close();
                return true;
            }
        }
        dir.close();
    } catch (e) {
        // Ignore directory traversal errors
    }
    return false;
}

function getLocaleDir(uuid = null, extensionPath = null) {
    let override = _envOrDefault('CINNAWM_LOCALE_DIR', '');
    if (override) return override;

    let effUuid = uuid || resolveUuid();
    let userLocale = GLib.build_filenamev([getDataRoot(), 'locale']);
    let ext = getExtensionObject();
    let effExtPath = extensionPath || (ext && ext.path ? ext.path : null);

    if (effExtPath && !hasCompiledLocale(userLocale, effUuid)) {
        let bundled = GLib.build_filenamev([effExtPath, 'locale']);
        if (hasCompiledLocale(bundled, effUuid)) {
            return bundled;
        }
    }

    return userLocale;
}

function bindGettext(uuid = null, extensionPath = null) {
    let effUuid = uuid || resolveUuid();
    let localeDir = getLocaleDir(effUuid, extensionPath);
    try {
        Gettext.bindtextdomain(effUuid, localeDir);
    } catch (e) {
        // Ignore bindtextdomain errors in standalone test runners
    }
    return {
        uuid: effUuid,
        localeDir,
        _: (str) => Gettext.dgettext(effUuid, str)
    };
}

function getIpcConfig() {
    let busName = _envOrDefault('CINNAWM_DBUS_NAME', DEFAULT_DBUS_NAME);
    let objectPath = _envOrDefault('CINNAWM_DBUS_PATH', DEFAULT_DBUS_PATH);
    let interfaceName = DEFAULT_DBUS_NAME;
    return {
        busName,
        objectPath,
        interfaceName
    };
}

module.exports = {
    DEFAULT_UUID,
    DEFAULT_DBUS_NAME,
    DEFAULT_DBUS_PATH,
    readMetadata,
    resolveUuid,
    getConfigRoot,
    getDataRoot,
    getSpicesConfigDir,
    getSpicesConfigFile,
    hasCompiledLocale,
    getLocaleDir,
    bindGettext,
    getIpcConfig
};

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CinnaWM Native GTK3 Preferences Window (Linux Mint / XApp style).

Provides a native GTK3 StackSidebar + Stack preferences dialog that inherits the
user's system GTK3 theme and font (e.g. Mint-Y-Dark-Orange) and synchronizes
settings live with the running CinnaWM Cinnamon extension.
"""

import datetime
import json
import os
import re
import sys

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gtk, Gdk, GdkPixbuf, Gio, GLib, Pango

from settings_data import (
    UUID,
    DBUS_BUS_NAME,
    DBUS_OBJECT_PATH,
    DBUS_INTERFACE_NAME,
    GTK_APP_ID,
    XLET_SETTINGS_CMD,
    _,
    DEFAULT_SETTINGS,
    format_keybinding_list,
    parse_workspace_default_layouts,
    format_workspace_default_layouts,
    get_sections_meta,
    get_layouts_guide_list,
    get_shortcut_groups,
    get_mouse_items,
)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ICONS_DIR = os.path.join(SCRIPT_DIR, 'icons')


def _log_warn(context, exc):
    print(f"[{UUID}] {context}: {exc}", file=sys.stderr)


class CinnaWMBridge:
    """Handles two-way IPC with the live CinnaWM extension inside Cinnamon."""

    DBUS_BUS_NAME = DBUS_BUS_NAME
    DBUS_OBJECT_PATH = DBUS_OBJECT_PATH
    DBUS_INTERFACE_NAME = DBUS_INTERFACE_NAME

    def __init__(self):
        self._bus = None
        config_root = os.environ.get('CINNAWM_CONFIG_DIR') or GLib.get_user_config_dir()
        self.state_file = os.path.join(
            config_root, 'cinnamon', 'spices', UUID, 'workspace-layouts.json'
        )
        try:
            self._bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except Exception as e:
            _log_warn('Session D-Bus unavailable', e)
            self._bus = None

    def _call_dbus(self, method_name, params_variant=None, reply_sig='(b)'):
        if not self._bus:
            return False, None
        try:
            res = self._bus.call_sync(
                self.DBUS_BUS_NAME,
                self.DBUS_OBJECT_PATH,
                self.DBUS_INTERFACE_NAME,
                method_name,
                params_variant,
                GLib.VariantType.new(reply_sig),
                Gio.DBusCallFlags.NONE,
                1500,
                None,
            )
            unpacked = res.unpack()
            return True, (unpacked[0] if len(unpacked) == 1 else unpacked)
        except Exception as e:
            _log_warn(f'D-Bus call {method_name} failed', e)
            return False, None

    def fetch_snapshot(self):
        """Returns (settings_dict, active_layout_id)."""
        ok, payload = self._call_dbus('GetSnapshot', None, '(s)')
        if ok and payload and payload != 'null':
            try:
                parsed = json.loads(payload)
                if isinstance(parsed, str):
                    parsed = json.loads(parsed)
                if isinstance(parsed, dict) and 'settings' in parsed:
                    merged = dict(DEFAULT_SETTINGS)
                    merged.update(parsed.get('settings') or {})
                    active_layout = parsed.get('activeLayout') or merged.get('defaultLayout', 'dwindle')
                    return merged, active_layout
            except Exception as e:
                _log_warn('Failed to parse GetSnapshot payload', e)

        # Fallback: read persisted workspace-layouts.json on disk
        merged = dict(DEFAULT_SETTINGS)
        active_layout = merged['defaultLayout']
        if os.path.exists(self.state_file):
            try:
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    if isinstance(data.get('customSettings'), dict):
                        merged.update(data['customSettings'])
                    active_layout = merged.get('defaultLayout', 'dwindle')
                    if not merged.get('autoTilingEnabled', True):
                        active_layout = 'floating'
            except Exception as e:
                _log_warn(f'Failed to read fallback state file {self.state_file}', e)
        return merged, active_layout

    def update_setting(self, prop, value):
        ok, updated = self._call_dbus(
            'UpdateSetting',
            GLib.Variant('(ss)', (str(prop), json.dumps(value))),
            '(b)',
        )
        if not ok or not updated:
            self._update_file_fallback(prop, value)

    def activate_layout(self, layout_id):
        ok, res = self._call_dbus(
            'ActivateLayout',
            GLib.Variant('(s)', (str(layout_id),)),
            '(b)',
        )
        return bool(ok and res)

    def reset_ratios(self):
        ok, res = self._call_dbus('ResetRatios', None, '(b)')
        return bool(ok and res)

    def subscribe_state_changed(self, callback):
        if not self._bus or not callable(callback):
            return 0
        try:
            return self._bus.signal_subscribe(
                None,
                self.DBUS_INTERFACE_NAME,
                'StateChanged',
                self.DBUS_OBJECT_PATH,
                None,
                Gio.DBusSignalFlags.NONE,
                lambda _conn, _sender, _path, _iface, _sig, params: callback(
                    params.unpack()[0] if params else 'updated'
                ),
            )
        except Exception as e:
            _log_warn('Failed to subscribe to StateChanged D-Bus signal', e)
            return 0

    def unsubscribe_state_changed(self, sub_id):
        if self._bus and sub_id:
            try:
                self._bus.signal_unsubscribe(sub_id)
            except Exception as e:
                _log_warn('Failed to unsubscribe StateChanged D-Bus signal', e)

    def _update_file_fallback(self, prop, value):
        try:
            data = {}
            if os.path.exists(self.state_file):
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    data = json.load(f) or {}
            custom = data.setdefault('customSettings', {})
            custom[prop] = value
            os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
            with open(self.state_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            _log_warn(f'Failed to write fallback setting {prop} to {self.state_file}', e)

    def import_settings(self, settings_dict):
        if not isinstance(settings_dict, dict):
            return False

        clean = {}
        for k, default_val in DEFAULT_SETTINGS.items():
            if k in settings_dict:
                val = settings_dict[k]
                if isinstance(default_val, bool):
                    clean[k] = bool(val)
                elif isinstance(default_val, int) and not isinstance(val, bool):
                    try:
                        clean[k] = int(round(float(val)))
                    except Exception:
                        _log_warn(f'Ignoring invalid integer setting {k}', val)
                elif isinstance(default_val, str) and isinstance(val, str):
                    clean[k] = val

        if not clean:
            return False

        payload_json = json.dumps(clean)
        self._call_dbus(
            'ImportSettings',
            GLib.Variant('(s)', (payload_json,)),
            '(b)',
        )

        # Persist into workspace-layouts.json
        try:
            data = {}
            if os.path.exists(self.state_file):
                with open(self.state_file, 'r', encoding='utf-8') as f:
                    data = json.load(f) or {}
            custom = data.setdefault('customSettings', {})
            for k, v in clean.items():
                if not k.startswith('kb'):
                    custom[k] = v
            os.makedirs(os.path.dirname(self.state_file), exist_ok=True)
            with open(self.state_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            _log_warn(f'Failed to persist imported settings to {self.state_file}', e)

        # Also sync into Cinnamon's spice config JSON files if they exist on disk
        config_root = os.environ.get('CINNAWM_CONFIG_DIR') or GLib.get_user_config_dir()
        legacy_root = os.environ.get('CINNAWM_LEGACY_CONFIG_DIR') or os.path.join(os.path.expanduser('~'), '.cinnamon', 'configs')
        spice_paths = [
            os.path.join(config_root, 'cinnamon', 'spices', UUID, f'{UUID}.json'),
            os.path.join(legacy_root, UUID, f'{UUID}.json'),
        ]
        for sp in spice_paths:
            if os.path.exists(sp):
                try:
                    with open(sp, 'r', encoding='utf-8') as f:
                        sp_data = json.load(f)
                    if isinstance(sp_data, dict):
                        changed = False
                        for prop_key, val in clean.items():
                            hyphen_key = re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', prop_key).lower()
                            if hyphen_key in sp_data and isinstance(sp_data[hyphen_key], dict):
                                sp_data[hyphen_key]['value'] = val
                                changed = True
                        if changed:
                            with open(sp, 'w', encoding='utf-8') as f:
                                json.dump(sp_data, f, indent=4)
                except Exception as e:
                    _log_warn(f'Failed to sync spice config {sp}', e)

        return True


class CinnaWMSettingsWindow(Gtk.ApplicationWindow):
    """Native GTK3 Preferences Window styled like Linux Mint System Settings."""

    def __init__(self, app, bridge, initial_section=None):
        super().__init__(application=app, title=_("CinnaWM Preferences"))
        self.bridge = bridge
        self.settings, self.active_layout_id = self.bridge.fetch_snapshot()
        self._updating_widgets = False
        self._widget_updaters = []
        self._sidebar_rows = {}
        self._sidebar_dots = {}
        self._activate_buttons = {}
        self._guide_card_frames = {}
        self._page_scrolls = {}
        self._scroll_idle_id = 0
        self._destroyed = False
        self._ipc_refresh_idle_id = 0
        self._dbus_sub_id = 0

        self.set_default_size(1020, 680)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.set_role("cinnawm-settings-dialog")
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        self.set_keep_above(True)

        icon_path = os.path.join(ICONS_DIR, 'cinnawm-preferences.svg')
        if not os.path.exists(icon_path):
            icon_path = os.path.join(ICONS_DIR, 'cinnawm-layout-dwindle-symbolic.svg')
        if os.path.exists(icon_path):
            try:
                pixbufs = []
                for sz in (16, 24, 32, 48, 64, 128, 256):
                    pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(icon_path, sz, sz, True)
                    if pb:
                        pixbufs.append(pb)
                if pixbufs:
                    Gtk.Window.set_default_icon_list(pixbufs)
                    self.set_icon_list(pixbufs)
                else:
                    self.set_icon_from_file(icon_path)
            except Exception as e:
                _log_warn(f'Failed to load window icon {icon_path}', e)

        self._apply_custom_css()
        self._build_ui()

        target = initial_section or self.active_layout_id or 'general'
        self.select_section(target)

        self.connect('key-press-event', self._on_key_press)
        self.connect('focus-in-event', self._on_focus_in)
        self.connect('destroy', self._on_destroy)
        self._dbus_sub_id = self.bridge.subscribe_state_changed(self._on_wm_state_changed)

    def _apply_custom_css(self):
        css = b"""
        .cinnawm-sidebar-list {
            background-color: @theme_base_color;
        }
        .cinnawm-sidebar-row {
            padding: 8px 12px;
        }
        .cinnawm-active-dot {
            font-weight: bold;
            opacity: 0.85;
            color: @theme_selected_bg_color;
        }
        .cinnawm-banner-title {
            font-weight: bold;
            font-size: 1.15em;
        }
        .cinnawm-row-title {
            font-weight: 500;
        }
        .cinnawm-row-desc {
            font-size: 0.90em;
        }
        .cinnawm-section-header {
            font-weight: bold;
            font-size: 1.02em;
            color: @theme_fg_color;
        }
        .cinnawm-badge {
            background-color: alpha(@theme_selected_bg_color, 0.16);
            border: 1px solid alpha(@theme_selected_bg_color, 0.45);
            border-radius: 5px;
            padding: 2px 7px;
            color: @theme_selected_bg_color;
            font-family: monospace;
            font-weight: bold;
            font-size: 0.90em;
        }
        .cinnawm-kbd-badge {
            background-color: shade(@theme_bg_color, 0.92);
            border: 1px solid alpha(@theme_fg_color, 0.22);
            border-bottom-width: 2px;
            border-radius: 5px;
            padding: 3px 8px;
            color: @theme_fg_color;
            font-family: monospace;
            font-weight: bold;
            font-size: 0.90em;
        }
        .cinnawm-guide-card-active {
            border: 1px solid alpha(@theme_selected_bg_color, 0.75);
        }
        .cinnawm-mockup-monitor {
            background-color: shade(@theme_bg_color, 0.88);
            border: 1px solid alpha(@theme_fg_color, 0.22);
            border-radius: 6px;
        }
        .cinnawm-mockup-tile {
            background-color: shade(@theme_base_color, 1.08);
            border: 1px solid alpha(@theme_fg_color, 0.28);
            border-radius: 4px;
        }
        .cinnawm-mockup-tile-master {
            background-color: alpha(@theme_selected_bg_color, 0.24);
            border: 2px solid @theme_selected_bg_color;
            border-radius: 4px;
        }
        .cinnawm-mockup-tile-ghost {
            background-color: alpha(@theme_fg_color, 0.05);
            border: 1px dashed alpha(@theme_fg_color, 0.25);
            border-radius: 4px;
        }
        .cinnawm-mockup-label {
            font-size: 0.80em;
            font-weight: bold;
            color: alpha(@theme_fg_color, 0.85);
        }
        .cinnawm-mockup-label-master {
            font-size: 0.80em;
            font-weight: bold;
            color: @theme_selected_bg_color;
        }
        .cinnawm-guide-meta-label {
            font-size: 0.92em;
        }
        """
        provider = Gtk.CssProvider()
        provider.load_from_data(css)
        screen = Gdk.Screen.get_default()
        if screen:
            Gtk.StyleContext.add_provider_for_screen(
                screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
            )

    def _create_symbolic_image(self, icon_filename, pixel_size=16):
        path = os.path.join(ICONS_DIR, icon_filename)
        if os.path.exists(path):
            gfile = Gio.File.new_for_path(path)
            gicon = Gio.FileIcon.new(gfile)
            img = Gtk.Image.new_from_gicon(gicon, Gtk.IconSize.MENU)
            img.set_pixel_size(pixel_size)
            return img
        img = Gtk.Image.new_from_icon_name('preferences-system-windows-symbolic', Gtk.IconSize.MENU)
        img.set_pixel_size(pixel_size)
        return img

    def _build_ui(self):
        root_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.add(root_vbox)

        # Main Paned / Split body (Left Sidebar + Right Stack)
        body_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        body_hbox.set_vexpand(True)
        body_hbox.set_hexpand(True)
        root_vbox.pack_start(body_hbox, True, True, 0)

        # Left Sidebar
        sidebar_scroll = Gtk.ScrolledWindow()
        sidebar_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        sidebar_scroll.set_size_request(240, -1)
        sidebar_scroll.set_hexpand(False)

        self.sidebar_list = Gtk.ListBox()
        self.sidebar_list.set_selection_mode(Gtk.SelectionMode.BROWSE)
        self.sidebar_list.set_hexpand(False)
        self.sidebar_list.get_style_context().add_class('sidebar')
        self.sidebar_list.get_style_context().add_class('cinnawm-sidebar-list')
        self.sidebar_list.connect('row-selected', self._on_sidebar_row_selected)
        sidebar_scroll.add(self.sidebar_list)

        body_hbox.pack_start(sidebar_scroll, False, True, 0)
        body_hbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL), False, False, 0)

        # Right Stack (each page has its own ScrolledWindow so heights are independent)
        self.stack = Gtk.Stack()
        self.stack.set_vhomogeneous(False)
        self.stack.set_hhomogeneous(False)
        self.stack.set_hexpand(True)
        self.stack.set_vexpand(True)
        self.stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.stack.set_transition_duration(120)
        body_hbox.pack_start(self.stack, True, True, 0)

        # Populate sections
        for sec in get_sections_meta():
            sec_id = sec['id']
            row = Gtk.ListBoxRow()
            row.section_id = sec_id
            row.get_style_context().add_class('cinnawm-sidebar-row')

            hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            hbox.set_margin_start(10)
            hbox.set_margin_end(10)
            hbox.set_margin_top(6)
            hbox.set_margin_bottom(6)

            icon = self._create_symbolic_image(sec['icon'], 16)
            icon.set_halign(Gtk.Align.START)
            icon.set_valign(Gtk.Align.CENTER)

            lbl = Gtk.Label(label=sec['title'], xalign=0.0)
            lbl.set_halign(Gtk.Align.FILL)
            lbl.set_valign(Gtk.Align.CENTER)
            lbl.set_justify(Gtk.Justification.LEFT)

            dot_lbl = Gtk.Label(label='●')
            dot_lbl.get_style_context().add_class('cinnawm-active-dot')
            dot_lbl.set_valign(Gtk.Align.CENTER)
            dot_lbl.set_no_show_all(True)

            hbox.pack_start(icon, False, False, 0)
            hbox.pack_start(lbl, True, True, 0)
            hbox.pack_end(dot_lbl, False, False, 0)
            row.add(hbox)

            self.sidebar_list.add(row)
            self._sidebar_rows[sec_id] = row
            self._sidebar_dots[sec_id] = dot_lbl

            page_widget = self._build_section_page(sec)
            page_scroll = Gtk.ScrolledWindow()
            page_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
            page_scroll.set_hexpand(True)
            page_scroll.set_vexpand(True)
            page_scroll.add(page_widget)
            self._page_scrolls[sec_id] = page_scroll
            self.stack.add_named(page_scroll, sec_id)

        # Bottom ActionBar (native Linux Mint action bar)
        action_bar = Gtk.ActionBar()

        left_btns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        left_btns.set_margin_start(6)
        left_btns.set_margin_end(28)

        reset_btn = Gtk.Button(label=_("↺ Reset Current Ratios & Splits"))
        reset_btn.connect('clicked', self._on_reset_ratios_clicked)
        left_btns.pack_start(reset_btn, False, False, 0)

        export_btn = Gtk.Button(label=_("⬇ Export Profile..."))
        export_btn.connect('clicked', self._on_export_config_clicked)
        left_btns.pack_start(export_btn, False, False, 0)

        import_btn = Gtk.Button(label=_("⬆ Import Profile..."))
        import_btn.connect('clicked', self._on_import_config_clicked)
        left_btns.pack_start(import_btn, False, False, 0)

        action_bar.pack_start(left_btns)

        right_btns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        right_btns.set_margin_start(28)
        right_btns.set_margin_end(6)

        sys_btn = Gtk.Button(label=_("⌨ System Shortcuts & Window Rules..."))
        sys_btn.get_style_context().add_class('suggested-action')
        sys_btn.connect('clicked', self._on_sys_settings_clicked)
        right_btns.pack_start(sys_btn, False, False, 0)

        close_btn = Gtk.Button(label=_("Close"))
        close_btn.connect('clicked', lambda *_: self.close())
        right_btns.pack_start(close_btn, False, False, 0)

        action_bar.pack_end(right_btns)

        root_vbox.pack_end(action_bar, False, False, 0)

        self.show_all()
        self._sync_active_layout_indicators()

    def _register_activate_button(self, layout_id, btn):
        self._activate_buttons.setdefault(layout_id, []).append(btn)

    def _build_section_page(self, sec):
        sec_id = sec['id']
        if sec_id == 'visual-guide':
            return self._build_visual_guide_page(sec)
        if sec_id == 'shortcuts':
            return self._build_shortcuts_page(sec)

        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
        page.set_margin_start(32)
        page.set_margin_end(32)
        page.set_margin_top(22)
        page.set_margin_bottom(22)

        # 1. Top Banner Card (Mint .view Frame)
        banner_frame = Gtk.Frame()
        banner_frame.set_shadow_type(Gtk.ShadowType.IN)
        banner_frame.get_style_context().add_class('view')

        banner_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
        banner_box.set_margin_start(18)
        banner_box.set_margin_end(18)
        banner_box.set_margin_top(14)
        banner_box.set_margin_bottom(14)

        icon = self._create_symbolic_image(sec['icon'], 28)
        icon.set_valign(Gtk.Align.START if sec_id != 'general' else Gtk.Align.CENTER)
        icon.set_margin_top(4 if sec_id != 'general' else 0)
        banner_box.pack_start(icon, False, False, 0)

        text_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=5)
        text_vbox.set_valign(Gtk.Align.CENTER)
        text_vbox.set_halign(Gtk.Align.FILL)

        guide_map = {item['id']: item for item in get_layouts_guide_list()}
        guide_item = guide_map.get(sec_id)

        title_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        title_hbox.set_halign(Gtk.Align.FILL)
        if guide_item:
            badge_lbl = Gtk.Label(label=guide_item['badge'])
            badge_lbl.get_style_context().add_class('cinnawm-badge')
            badge_lbl.set_valign(Gtk.Align.CENTER)
            title_hbox.pack_start(badge_lbl, False, False, 0)

        title_lbl = Gtk.Label(label=sec['title'], xalign=0.0)
        title_lbl.get_style_context().add_class('cinnawm-banner-title')
        title_lbl.set_halign(Gtk.Align.START)
        title_lbl.set_justify(Gtk.Justification.LEFT)
        title_lbl.set_line_wrap(True)
        title_hbox.pack_start(title_lbl, True, True, 0)

        sub_lbl = Gtk.Label(label=sec['subtitle'], xalign=0.0)
        sub_lbl.get_style_context().add_class('dim-label')
        sub_lbl.set_halign(Gtk.Align.START)
        sub_lbl.set_justify(Gtk.Justification.LEFT)
        sub_lbl.set_line_wrap(True)
        sub_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        sub_lbl.set_max_width_chars(62)

        text_vbox.pack_start(title_hbox, False, False, 0)
        text_vbox.pack_start(sub_lbl, False, False, 0)

        if guide_item:
            for tag_title, body_text in (
                (_('How it works:'), guide_item['how']),
                (_('Best for:'), guide_item['best']),
                (_('Tip:'), guide_item['tips']),
            ):
                meta_lbl = Gtk.Label(xalign=0.0)
                meta_lbl.set_use_markup(True)
                meta_lbl.set_markup(
                    f"<b>{GLib.markup_escape_text(tag_title)}</b> {GLib.markup_escape_text(body_text)}"
                )
                meta_lbl.get_style_context().add_class('cinnawm-guide-meta-label')
                meta_lbl.set_halign(Gtk.Align.START)
                meta_lbl.set_justify(Gtk.Justification.LEFT)
                meta_lbl.set_line_wrap(True)
                meta_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
                meta_lbl.set_max_width_chars(62)
                text_vbox.pack_start(meta_lbl, False, False, 0)

        banner_box.pack_start(text_vbox, True, True, 0)

        if sec_id != 'general':
            act_btn = Gtk.Button(label=_("Activate Layout"))
            act_btn.set_valign(Gtk.Align.START)
            act_btn.set_margin_top(2)
            act_btn.connect('clicked', lambda _b, lid=sec_id: self._on_activate_layout_clicked(lid))
            banner_box.pack_end(act_btn, False, False, 0)
            self._register_activate_button(sec_id, act_btn)

        banner_frame.add(banner_box)
        page.pack_start(banner_frame, False, False, 0)

        # 2. Settings Rows Card (Mint .view Frame with ListBox rows)
        card_frame = Gtk.Frame()
        card_frame.set_shadow_type(Gtk.ShadowType.IN)
        card_frame.get_style_context().add_class('view')

        card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        card_frame.add(card_vbox)

        size_group = Gtk.SizeGroup(mode=Gtk.SizeGroupMode.HORIZONTAL)
        state = {'need_sep': False}

        def add_row_widget(hbox, click_handler=None):
            if state['need_sep']:
                card_vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)
            state['need_sep'] = True

            lb = Gtk.ListBox()
            lb.set_selection_mode(Gtk.SelectionMode.NONE)
            row = Gtk.ListBoxRow()
            row.set_can_focus(False)
            row.set_activatable(bool(click_handler))
            row.add(hbox)
            if click_handler:
                lb.connect('row-activated', lambda *_a: click_handler())
            lb.add(row)
            card_vbox.pack_start(lb, False, False, 0)

        def make_label_column(title, desc):
            hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=20)
            hbox.set_margin_start(18)
            hbox.set_margin_end(18)
            hbox.set_margin_top(11)
            hbox.set_margin_bottom(11)

            vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
            vbox.set_valign(Gtk.Align.CENTER)
            vbox.set_halign(Gtk.Align.FILL)

            t_lbl = Gtk.Label(label=title, xalign=0.0)
            t_lbl.get_style_context().add_class('cinnawm-row-title')
            t_lbl.set_halign(Gtk.Align.START)
            t_lbl.set_justify(Gtk.Justification.LEFT)
            t_lbl.set_line_wrap(True)
            t_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)

            d_lbl = Gtk.Label(label=desc, xalign=0.0)
            d_lbl.get_style_context().add_class('dim-label')
            d_lbl.get_style_context().add_class('cinnawm-row-desc')
            d_lbl.set_halign(Gtk.Align.START)
            d_lbl.set_justify(Gtk.Justification.LEFT)
            d_lbl.set_line_wrap(True)
            d_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
            d_lbl.set_max_width_chars(64)

            vbox.pack_start(t_lbl, False, False, 0)
            vbox.pack_start(d_lbl, False, False, 0)
            hbox.pack_start(vbox, True, True, 0)
            return hbox

        def add_switch(title, desc, prop):
            hbox = make_label_column(title, desc)
            sw = Gtk.Switch()
            sw.set_valign(Gtk.Align.CENTER)
            sw.set_active(bool(self.settings.get(prop, DEFAULT_SETTINGS.get(prop, False))))

            def on_notify_active(widget, _pspec):
                if self._updating_widgets:
                    return
                val = bool(widget.get_active())
                self.settings[prop] = val
                self.bridge.update_setting(prop, val)
                if prop == 'autoTilingEnabled':
                    self._refresh_from_wm()

            sw.connect('notify::active', on_notify_active)
            self._widget_updaters.append(
                lambda: sw.set_active(bool(self.settings.get(prop, DEFAULT_SETTINGS.get(prop, False))))
            )

            hbox.pack_end(sw, False, False, 0)
            add_row_widget(hbox, click_handler=lambda: sw.set_active(not sw.get_active()))

        def add_spin(title, desc, prop, mini, maxi, step, unit=''):
            full_title = f"{title} ({unit.strip()})" if unit.strip() else title
            hbox = make_label_column(full_title, desc)

            cur_val = self.settings.get(prop, DEFAULT_SETTINGS.get(prop, mini))
            try:
                cur_val = int(cur_val)
            except Exception:
                cur_val = mini

            adj = Gtk.Adjustment(
                value=cur_val,
                lower=mini,
                upper=maxi,
                step_increment=step,
                page_increment=step * 2,
                page_size=0,
            )
            spin = Gtk.SpinButton(adjustment=adj, climb_rate=1.0, digits=0)
            spin.set_valign(Gtk.Align.CENTER)
            spin.set_numeric(True)
            size_group.add_widget(spin)

            def on_value_changed(widget):
                if self._updating_widgets:
                    return
                val = int(round(widget.get_value()))
                self.settings[prop] = val
                self.bridge.update_setting(prop, val)

            spin.connect('value-changed', on_value_changed)
            self._widget_updaters.append(
                lambda: spin.set_value(float(self.settings.get(prop, DEFAULT_SETTINGS.get(prop, mini))))
            )

            hbox.pack_end(spin, False, False, 0)
            add_row_widget(hbox)

        def add_choice(title, desc, prop, choices):
            hbox = make_label_column(title, desc)
            combo = Gtk.ComboBoxText()
            combo.set_valign(Gtk.Align.CENTER)
            for item in choices:
                combo.append(str(item['value']), item['label'])

            cur_val = str(self.settings.get(prop, DEFAULT_SETTINGS.get(prop, choices[0]['value'])))
            if not combo.set_active_id(cur_val):
                combo.set_active(0)

            size_group.add_widget(combo)

            def on_changed(widget):
                if self._updating_widgets:
                    return
                active_id = widget.get_active_id()
                if active_id is not None:
                    self.settings[prop] = active_id
                    self.bridge.update_setting(prop, active_id)
                    if prop == 'defaultLayout':
                        self._refresh_from_wm()

            combo.connect('changed', on_changed)
            self._widget_updaters.append(
                lambda: combo.set_active_id(str(self.settings.get(prop, DEFAULT_SETTINGS.get(prop, choices[0]['value']))))
            )

            hbox.pack_end(combo, False, False, 0)
            add_row_widget(hbox)

        def parse_rgba(color_str, fallback='rgba(94, 129, 244, 0.95)'):
            rgba = Gdk.RGBA()
            if isinstance(color_str, str) and color_str.strip():
                if rgba.parse(color_str.strip()):
                    return rgba
            rgba.parse(fallback)
            return rgba

        def format_rgba(rgba):
            r = max(0, min(255, int(round(rgba.red * 255))))
            g = max(0, min(255, int(round(rgba.green * 255))))
            b = max(0, min(255, int(round(rgba.blue * 255))))
            a = round(max(0.0, min(1.0, float(rgba.alpha))), 2)
            return f'rgba({r}, {g}, {b}, {a})'

        def add_color(title, desc, prop):
            hbox = make_label_column(title, desc)
            btn = Gtk.ColorButton()
            btn.set_use_alpha(True)
            btn.set_title(title)
            btn.set_valign(Gtk.Align.CENTER)
            btn.set_halign(Gtk.Align.END)
            btn.set_size_request(56, -1)

            default_str = str(DEFAULT_SETTINGS.get(prop, 'rgba(94, 129, 244, 0.95)'))
            cur_str = str(self.settings.get(prop, default_str))
            btn.set_rgba(parse_rgba(cur_str, default_str))

            def on_color_set(widget):
                if self._updating_widgets:
                    return
                val = format_rgba(widget.get_rgba())
                self.settings[prop] = val
                self.bridge.update_setting(prop, val)

            btn.connect('color-set', on_color_set)
            self._widget_updaters.append(
                lambda: btn.set_rgba(parse_rgba(str(self.settings.get(prop, default_str)), default_str))
            )

            hbox.pack_end(btn, False, False, 0)
            add_row_widget(hbox, click_handler=lambda: btn.clicked())

        # Populate section-specific controls
        if sec_id == 'general':
            add_choice(
                _('Default Layout'),
                _('Layout applied by default to new workspaces and sessions.'),
                'defaultLayout',
                [
                    {'label': _('Dwindle / BSP'), 'value': 'dwindle'},
                    {'label': _('Master & Stack'), 'value': 'master-stack'},
                    {'label': _('Centered Master'), 'value': 'centered-master'},
                    {'label': _('Scrolling Columns'), 'value': 'scrolling'},
                    {'label': _('Monocle / Zen'), 'value': 'monocle'},
                    {'label': _('Balanced Grid'), 'value': 'grid'},
                    {'label': _('Floating & Tools'), 'value': 'floating'},
                ],
            )
            ws_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
            ws_vbox.set_margin_start(18)
            ws_vbox.set_margin_end(18)
            ws_vbox.set_margin_top(11)
            ws_vbox.set_margin_bottom(12)
            ws_title = Gtk.Label(label=_('Per-Workspace Default Layouts'), xalign=0.0)
            ws_title.get_style_context().add_class('cinnawm-row-title')
            ws_title.set_halign(Gtk.Align.START)
            ws_desc = Gtk.Label(
                label=_('Optional initial layout overrides for Workspaces 1–6 (others inherit Global Default Layout).'),
                xalign=0.0,
            )
            ws_desc.get_style_context().add_class('dim-label')
            ws_desc.get_style_context().add_class('cinnawm-row-desc')
            ws_desc.set_halign(Gtk.Align.START)
            ws_desc.set_line_wrap(True)
            ws_desc.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
            ws_vbox.pack_start(ws_title, False, False, 0)
            ws_vbox.pack_start(ws_desc, False, False, 0)

            ws_grid = Gtk.Grid()
            ws_grid.set_row_spacing(6)
            ws_grid.set_column_spacing(14)
            ws_choices = [
                ('', _('Inherit Global')),
                ('dwindle', _('Dwindle / BSP')),
                ('master-stack', _('Master & Stack')),
                ('centered-master', _('Centered Master')),
                ('scrolling', _('Scrolling Columns')),
                ('monocle', _('Monocle / Zen')),
                ('grid', _('Balanced Grid')),
                ('floating', _('Floating')),
            ]
            ws_combos = {}
            cur_ws_map = parse_workspace_default_layouts(
                str(self.settings.get('workspaceDefaultLayouts', DEFAULT_SETTINGS.get('workspaceDefaultLayouts', '')))
            )

            for idx_ws in range(6):
                ws_num = idx_ws + 1
                cell = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
                lbl = Gtk.Label(label=f'WS {ws_num}:')
                lbl.get_style_context().add_class('dim-label')
                lbl.set_valign(Gtk.Align.CENTER)
                combo = Gtk.ComboBoxText()
                combo.set_valign(Gtk.Align.CENTER)
                for cid, clabel in ws_choices:
                    combo.append(cid, clabel)
                if not combo.set_active_id(cur_ws_map.get(ws_num, '')):
                    combo.set_active(0)

                def on_ws_combo_changed(widget, num=ws_num):
                    if self._updating_widgets:
                        return
                    merged = parse_workspace_default_layouts(
                        str(self.settings.get('workspaceDefaultLayouts', ''))
                    )
                    sel = widget.get_active_id() or ''
                    if sel:
                        merged[num] = sel
                    else:
                        merged.pop(num, None)
                    formatted = format_workspace_default_layouts(merged)
                    self.settings['workspaceDefaultLayouts'] = formatted
                    self.bridge.update_setting('workspaceDefaultLayouts', formatted)

                combo.connect('changed', on_ws_combo_changed)
                ws_combos[ws_num] = combo
                cell.pack_start(lbl, False, False, 0)
                cell.pack_start(combo, True, True, 0)
                ws_grid.attach(cell, idx_ws % 3, idx_ws // 3, 1, 1)

            def sync_ws_combos():
                m = parse_workspace_default_layouts(
                    str(self.settings.get('workspaceDefaultLayouts', ''))
                )
                for num, cb in ws_combos.items():
                    if not cb.set_active_id(m.get(num, '')):
                        cb.set_active(0)

            self._widget_updaters.append(sync_ws_combos)
            ws_vbox.pack_start(ws_grid, False, False, 2)
            add_row_widget(ws_vbox)
            add_switch(
                _('Enable Auto-Tiling'),
                _('Automatically tile normal windows opened on the active workspace.'),
                'autoTilingEnabled',
            )
            add_spin(
                _('Minimum Tile Width Before Stacking'),
                _('When a layout cannot keep each window this wide, it groups overflow windows in a stack navigable with directional focus keys.'),
                'overflowMinWidthPx', 120, 600, 20, 'px',
            )
            add_spin(
                _('Minimum Tile Height Before Stacking'),
                _('When a layout cannot keep each window this tall, it groups overflow windows in a stack navigable with directional focus keys.'),
                'overflowMinHeightPx', 80, 400, 10, 'px',
            )
            add_spin(
                _('Inner Gap'),
                _('Spacing in pixels between adjacent tiled windows.'),
                'innerGap', 0, 48, 2, 'px',
            )
            add_spin(
                _('Outer Gap'),
                _('Distance in pixels between tiled windows and monitor or panel edges.'),
                'outerGap', 0, 48, 2, 'px',
            )
            add_switch(
                _('Smart Gaps (No Gaps When Single)'),
                _('Hide outer gaps and active border when only a single window is open on the monitor.'),
                'smartGaps',
            )
            add_switch(
                _('Mouse Drag-to-Swap'),
                _('Drag a window onto another tile to swap positions; hold Ctrl while dragging to snap to screen edges.'),
                'mouseDragSwap',
            )
            add_switch(
                _('Live Shared Edge Resize'),
                _('Resizing a tiled window border with the mouse automatically adjusts the adjacent window.'),
                'mouseEdgeResize',
            )
            add_switch(
                _('Cursor Follows Focus'),
                _('Move the mouse pointer to the newly focused window on keyboard or monitor navigation.'),
                'cursorFollowsFocus',
            )
            add_switch(
                _('Active Window Border'),
                _('Draw a colored highlight frame outside the currently focused window.'),
                'activeBorderEnabled',
            )
            add_color(
                _('Active Border Color (Tiled)'),
                _('Highlight color used outside the focused window when it is tiled.'),
                'activeBorderColor',
            )
            add_switch(
                _('State-Aware Border Colors'),
                _('Use distinct border colors for Floating/Scratchpad and Stacked/Tabbed windows.'),
                'activeBorderStateColors',
            )
            add_color(
                _('Floating & Scratchpad Border Color'),
                _('Highlight color used when the focused window is Floating or in the Scratchpad.'),
                'activeBorderFloatingColor',
            )
            add_color(
                _('Stacked & Tabbed Border Color'),
                _('Highlight color used when the focused window belongs to an Overflow Stack or Manual Tab Group.'),
                'activeBorderStackedColor',
            )
            add_spin(
                _('Active Border Width'),
                _('Thickness in pixels of the outer highlight frame around the focused window.'),
                'activeBorderWidth', 1, 10, 1, 'px',
            )
            add_spin(
                _('Active Border Corner Radius'),
                _('Corner rounding radius in pixels for the active window highlight frame.'),
                'activeBorderRadius', 0, 24, 1, 'px',
            )
            add_switch(
                _('Smart No-Border (Single Window)'),
                _('Hide the active border frame automatically when only a single tiled window is visible on the monitor.'),
                'smartNoBorder',
            )
            add_switch(
                _('Dim Unfocused Windows'),
                _('Slightly reduce opacity of unfocused windows to highlight the currently focused window.'),
                'inactiveDimmingEnabled',
            )
            add_spin(
                _('Unfocused Window Opacity'),
                _('Opacity percentage applied to inactive windows when window dimming is enabled.'),
                'inactiveWindowOpacityPct', 40, 100, 2, '%',
            )
            add_switch(
                _('On-Screen HUD / OSD Notifications'),
                _('Show an on-screen badge when switching layouts, rotating splits, or toggling the Scratchpad.'),
                'showOsd',
            )

        elif sec_id == 'dwindle':
            add_choice(
                _('Split Direction Mode'),
                _('How the binary tree chooses whether to split a tile vertically (side-by-side) or horizontally (stacked).'),
                'dwindleSplitDirection',
                [
                    {'label': _('Auto (W ≥ H)'), 'value': 'auto'},
                    {'label': _('Spiral V/H'), 'value': 'spiral'},
                    {'label': _('Vertical'), 'value': 'vertical'},
                    {'label': _('Horizontal'), 'value': 'horizontal'},
                ],
            )
            add_spin(
                _('Default Split Ratio'),
                _('Percentage assigned to the first branch when a new split is created (50% = equal halves).'),
                'dwindleDefaultSplitRatioPct', 30, 70, 5, '%',
            )
            add_choice(
                _('New Window Insertion Point'),
                _('Which tree leaf is split when a new window is opened.'),
                'dwindleNewWindowPlacement',
                [
                    {'label': _('Focused Window'), 'value': 'focused'},
                    {'label': _('Spiral End'), 'value': 'end'},
                    {'label': _('Tree Start'), 'value': 'start'},
                ],
            )
            add_spin(
                _('Keyboard Resize Step'),
                _('Percentage change per step when resizing splits with Super+= / Super+- (or Super+] / Super+[).'),
                'dwindleResizeStepPct', 2, 20, 1, '%',
            )
            add_switch(
                _('Respect Window Minimum Hints'),
                _('Automatically adjust split ratios when an application (e.g. browsers) enforces a minimum X11 width.'),
                'dwindleRespectMinSize',
            )

        elif sec_id == 'master-stack':
            add_spin(
                _('Master Area Size (mfact)'),
                _('Percentage of the screen reserved for the primary Master column or row.'),
                'masterRatioPct', 20, 80, 5, '%',
            )
            add_spin(
                _('Master Window Count (nmaster)'),
                _('Number of windows placed in the primary Master area before stacking remaining windows.'),
                'masterCount', 1, 6, 1, '',
            )
            add_choice(
                _('Master Area Orientation'),
                _('Screen side where the primary Master area is placed (can also be rotated via Super+O).'),
                'masterOrientation',
                [
                    {'label': _('Left'), 'value': 'left'},
                    {'label': _('Right'), 'value': 'right'},
                    {'label': _('Top'), 'value': 'top'},
                    {'label': _('Bottom'), 'value': 'bottom'},
                ],
            )
            add_switch(
                _('Auto Portrait Rotation'),
                _('Automatically switch Left/Right Master splits to Top/Bottom on vertical (portrait) monitors.'),
                'masterAutoOrientation',
            )
            add_choice(
                _('New Window Placement'),
                _('Where newly opened windows are inserted in Master & Stack mode.'),
                'masterNewWindowPlacement',
                [
                    {'label': _('Stack End'), 'value': 'stack-end'},
                    {'label': _('Stack Top'), 'value': 'stack-top'},
                    {'label': _('Become Master'), 'value': 'master'},
                ],
            )
            add_spin(
                _('Single Window Width'),
                _('Width used when only 1 window is open (100% = full screen, <100% = centered column).'),
                'masterSingleWindowWidthPct', 40, 100, 5, '%',
            )

        elif sec_id == 'centered-master':
            add_spin(
                _('Center Master Column Width'),
                _('Percentage of monitor width assigned to the central Master column.'),
                'centeredMasterRatioPct', 25, 75, 5, '%',
            )
            add_spin(
                _('Center Master Window Count'),
                _('How many windows are stacked in the center column before distributing others to the side wings.'),
                'centeredMasterCount', 1, 4, 1, '',
            )
            add_choice(
                _('Side Column Balancing'),
                _('Order in which secondary windows are distributed between the right and left side columns.'),
                'centeredMasterSideBalance',
                [
                    {'label': _('Alternate R/L'), 'value': 'alternate'},
                    {'label': _('Alternate L/R'), 'value': 'left-first'},
                    {'label': _('Equal Split L/R'), 'value': 'equal-split'},
                ],
            )
            add_spin(
                _('Single Window Width'),
                _('Window width when only a single window is open on the monitor (ideal for ultrawide displays).'),
                'centeredMasterSingleWidthPct', 40, 100, 5, '%',
            )

        elif sec_id == 'scrolling':
            add_spin(
                _('Default Column Width'),
                _('Base width of each column in the horizontal ribbon as a percentage of monitor width.'),
                'scrollingColumnWidthPct', 30, 100, 5, '%',
            )
            add_spin(
                _('Single Window Column Width'),
                _('Column width when only a single window is open on the workspace.'),
                'scrollingSingleColumnWidthPct', 40, 100, 5, '%',
            )
            add_choice(
                _('Viewport Focus Alignment'),
                _('Scroll only when the focused column crosses screen edges (Niri style) or always keep it centered (PaperWM style).'),
                'scrollingFocusAlignment',
                [
                    {'label': _('On Edge (Niri)'), 'value': 'edge'},
                    {'label': _('Always Centered'), 'value': 'center'},
                ],
            )
            add_spin(
                _('Minimum Edge Visibility Threshold'),
                _('Minimum visible width in pixels for a partially off-screen column to be fitted at the monitor edge.'),
                'scrollingMinVisibleWidthPx', 80, 300, 20, 'px',
            )
            add_spin(
                _('Column Resize Step'),
                _('Percentage width change for the focused column with Super+= / Super+- (or Super+] / Super+[).'),
                'scrollingResizeStepPct', 2, 20, 2, '%',
            )

        elif sec_id == 'monocle':
            add_spin(
                _('Monocle / Zen Window Width'),
                _('100% maximizes across the work area; lower values center the window in distraction-free Zen mode.'),
                'monocleZenWidthPct', 40, 100, 5, '%',
            )
            add_spin(
                _('Monocle / Zen Window Height'),
                _('Window height as a percentage of the monitor work area.'),
                'monocleZenHeightPct', 50, 100, 5, '%',
            )
            add_spin(
                _('Zen Frame Extra Margin'),
                _('Additional margin in pixels around the Monocle deck to visually isolate the active window.'),
                'monocleOuterMarginPx', 0, 96, 4, 'px',
            )
            add_switch(
                _('Wrap-Around Deck Navigation'),
                _('Moving past the last window with Super+J/L or Arrow keys wraps around to the first window.'),
                'monocleWrapNavigation',
            )

        elif sec_id == 'grid':
            add_spin(
                _('Maximum Columns (0 = Auto √N)'),
                _('Set to 0 to compute columns automatically (√N), or fix the maximum number of columns per row.'),
                'gridMaxCols', 0, 6, 1, '',
            )
            add_choice(
                _('Incomplete Last Row Behavior'),
                _('How windows in the last row are arranged when the total window count is not a multiple of the columns.'),
                'gridLastRowBehavior',
                [
                    {'label': _('Stretch'), 'value': 'stretch'},
                    {'label': _('Center Cells'), 'value': 'center'},
                    {'label': _('Align Left'), 'value': 'left'},
                ],
            )

        elif sec_id == 'floating':
            add_switch(
                _('Auto-Center New Floating Windows'),
                _('Automatically position newly opened windows at the center of the screen when in Floating mode.'),
                'floatingCenterNewWindows',
            )
            add_spin(
                _('Center Window Action Width (Super+C)'),
                _('Width percentage relative to the monitor applied when pressing Super+C on a window.'),
                'floatingCenterWidthPct', 35, 95, 5, '%',
            )
            add_spin(
                _('Center Window Action Height (Super+C)'),
                _('Height percentage relative to the monitor applied when pressing Super+C on a window.'),
                'floatingCenterHeightPct', 35, 95, 5, '%',
            )
            add_spin(
                _('Quick Snap Grid Columns (Super+G)'),
                _('Number of columns in the interactive Quick Snap Grid overlay.'),
                'gridCols', 2, 8, 1, '',
            )
            add_spin(
                _('Quick Snap Grid Rows (Super+G)'),
                _('Number of rows in the interactive Quick Snap Grid overlay.'),
                'gridRows', 2, 6, 1, '',
            )
            add_spin(
                _('Scratchpad Window Width (Super+S)'),
                _('Width as a percentage of the screen for the drop-down Scratchpad window.'),
                'scratchpadWidthPct', 30, 95, 5, '%',
            )
            add_spin(
                _('Scratchpad Window Height (Super+S)'),
                _('Height as a percentage of the screen for the drop-down Scratchpad window.'),
                'scratchpadHeightPct', 30, 95, 5, '%',
            )
            add_choice(
                _('Picture-in-Picture Corner (Super+Y)'),
                _('Screen corner where sticky Picture-in-Picture windows are placed.'),
                'pipCorner',
                [
                    {'label': _('Bottom Right'), 'value': 'bottom-right'},
                    {'label': _('Bottom Left'), 'value': 'bottom-left'},
                    {'label': _('Top Right'), 'value': 'top-right'},
                    {'label': _('Top Left'), 'value': 'top-left'},
                ],
            )
            add_spin(
                _('Picture-in-Picture Width (Super+Y)'),
                _('Width as a percentage of the monitor work area for PiP windows.'),
                'pipWidthPct', 15, 50, 1, '%',
            )
            add_spin(
                _('Picture-in-Picture Height (Super+Y)'),
                _('Height as a percentage of the monitor work area for PiP windows.'),
                'pipHeightPct', 15, 50, 1, '%',
            )

        page.pack_start(card_frame, False, False, 0)
        return page

    def _create_layout_mockup(self, layout_id):
        W = 184
        H = 112
        fixed = Gtk.Fixed()
        fixed.set_size_request(W, H)
        fixed.get_style_context().add_class('cinnawm-mockup-monitor')
        fixed.set_valign(Gtk.Align.CENTER)

        def add_tile(x, y, w, h, label_text, kind='stack'):
            tile = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
            tile.set_size_request(w, h)
            ctx = tile.get_style_context()
            if kind == 'master':
                ctx.add_class('cinnawm-mockup-tile-master')
            elif kind == 'ghost':
                ctx.add_class('cinnawm-mockup-tile-ghost')
            else:
                ctx.add_class('cinnawm-mockup-tile')

            if label_text:
                lbl = Gtk.Label(label=label_text)
                lbl.set_halign(Gtk.Align.CENTER)
                lbl.set_valign(Gtk.Align.CENTER)
                lbl.set_vexpand(True)
                lbl.get_style_context().add_class(
                    'cinnawm-mockup-label-master' if kind == 'master' else 'cinnawm-mockup-label'
                )
                tile.pack_start(lbl, True, True, 0)
            fixed.put(tile, x, y)

        if layout_id == 'dwindle':
            add_tile(6, 6, 86, 100, '1', 'master')
            add_tile(96, 6, 82, 48, '2', 'stack')
            add_tile(96, 58, 39, 48, '3', 'stack')
            add_tile(139, 58, 39, 48, '4', 'stack')
        elif layout_id == 'master-stack':
            add_tile(6, 6, 96, 100, 'Master', 'master')
            add_tile(106, 6, 72, 30, '2', 'stack')
            add_tile(106, 41, 72, 30, '3', 'stack')
            add_tile(106, 76, 72, 30, '4', 'stack')
        elif layout_id == 'centered-master':
            add_tile(6, 6, 40, 48, '2', 'stack')
            add_tile(6, 58, 40, 48, '4', 'stack')
            add_tile(50, 6, 84, 100, 'Master', 'master')
            add_tile(138, 6, 40, 48, '3', 'stack')
            add_tile(138, 58, 40, 48, '5', 'stack')
        elif layout_id == 'scrolling':
            add_tile(4, 10, 26, 92, '←', 'ghost')
            add_tile(34, 6, 64, 100, '1', 'master')
            add_tile(102, 6, 56, 100, '2', 'stack')
            add_tile(162, 10, 18, 92, '→', 'ghost')
        elif layout_id == 'monocle':
            add_tile(20, 4, 144, 92, '', 'ghost')
            add_tile(13, 8, 158, 94, '', 'ghost')
            add_tile(6, 12, 172, 94, '1 / 3  [M]', 'master')
        elif layout_id == 'grid':
            add_tile(6, 6, 84, 48, '1', 'master')
            add_tile(94, 6, 84, 48, '2', 'stack')
            add_tile(6, 58, 84, 48, '3', 'stack')
            add_tile(94, 58, 84, 48, '4', 'stack')
        else:
            add_tile(14, 10, 96, 62, 'Float 1', 'stack')
            add_tile(64, 34, 106, 68, 'Float 2', 'master')

        return fixed

    def _build_page_banner(self, sec, right_widget=None):
        banner_frame = Gtk.Frame()
        banner_frame.set_shadow_type(Gtk.ShadowType.IN)
        banner_frame.get_style_context().add_class('view')

        banner_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
        banner_box.set_margin_start(18)
        banner_box.set_margin_end(18)
        banner_box.set_margin_top(14)
        banner_box.set_margin_bottom(14)

        icon = self._create_symbolic_image(sec['icon'], 28)
        icon.set_valign(Gtk.Align.CENTER)
        banner_box.pack_start(icon, False, False, 0)

        text_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        text_vbox.set_valign(Gtk.Align.CENTER)
        text_vbox.set_halign(Gtk.Align.FILL)
        title_lbl = Gtk.Label(label=sec['title'], xalign=0.0)
        title_lbl.get_style_context().add_class('cinnawm-banner-title')
        title_lbl.set_halign(Gtk.Align.START)
        title_lbl.set_justify(Gtk.Justification.LEFT)
        title_lbl.set_line_wrap(True)

        sub_lbl = Gtk.Label(label=sec['subtitle'], xalign=0.0)
        sub_lbl.get_style_context().add_class('dim-label')
        sub_lbl.set_halign(Gtk.Align.START)
        sub_lbl.set_justify(Gtk.Justification.LEFT)
        sub_lbl.set_line_wrap(True)
        sub_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        sub_lbl.set_max_width_chars(62)

        text_vbox.pack_start(title_lbl, False, False, 0)
        text_vbox.pack_start(sub_lbl, False, False, 0)
        banner_box.pack_start(text_vbox, True, True, 0)

        if right_widget is not None:
            right_widget.set_valign(Gtk.Align.CENTER)
            banner_box.pack_end(right_widget, False, False, 0)

        banner_frame.add(banner_box)
        return banner_frame

    def _build_visual_guide_page(self, sec):
        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
        page.set_margin_start(32)
        page.set_margin_end(32)
        page.set_margin_top(22)
        page.set_margin_bottom(22)

        page.pack_start(self._build_page_banner(sec), False, False, 0)

        for item in get_layouts_guide_list():
            lid = item['id']
            card_frame = Gtk.Frame()
            card_frame.set_shadow_type(Gtk.ShadowType.IN)
            card_frame.get_style_context().add_class('view')
            self._guide_card_frames[lid] = card_frame

            card_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=18)
            card_hbox.set_margin_start(18)
            card_hbox.set_margin_end(18)
            card_hbox.set_margin_top(14)
            card_hbox.set_margin_bottom(14)

            mockup = self._create_layout_mockup(lid)
            card_hbox.pack_start(mockup, False, False, 0)

            info_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
            info_vbox.set_halign(Gtk.Align.FILL)

            # Title row: Badge + Name + Activate button
            header_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            header_hbox.set_halign(Gtk.Align.FILL)
            badge_lbl = Gtk.Label(label=item['badge'])
            badge_lbl.get_style_context().add_class('cinnawm-badge')
            badge_lbl.set_valign(Gtk.Align.CENTER)

            name_lbl = Gtk.Label(label=item['name'], xalign=0.0)
            name_lbl.get_style_context().add_class('cinnawm-section-header')
            name_lbl.set_halign(Gtk.Align.START)
            name_lbl.set_valign(Gtk.Align.CENTER)
            name_lbl.set_justify(Gtk.Justification.LEFT)

            act_btn = Gtk.Button(label=_("Activate Layout"))
            act_btn.set_valign(Gtk.Align.CENTER)
            act_btn.connect('clicked', lambda _b, layout_id=lid: self._on_activate_layout_clicked(layout_id))
            self._register_activate_button(lid, act_btn)

            header_hbox.pack_start(badge_lbl, False, False, 0)
            header_hbox.pack_start(name_lbl, True, True, 0)
            header_hbox.pack_end(act_btn, False, False, 0)
            info_vbox.pack_start(header_hbox, False, False, 0)

            summary_lbl = Gtk.Label(label=item['summary'], xalign=0.0)
            summary_lbl.get_style_context().add_class('dim-label')
            summary_lbl.set_halign(Gtk.Align.START)
            summary_lbl.set_justify(Gtk.Justification.LEFT)
            summary_lbl.set_line_wrap(True)
            summary_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
            info_vbox.pack_start(summary_lbl, False, False, 2)

            for tag_title, body_text in (
                (_('How it works:'), item['how']),
                (_('Best for:'), item['best']),
                (_('Tip:'), item['tips']),
            ):
                meta_lbl = Gtk.Label(xalign=0.0)
                meta_lbl.set_use_markup(True)
                meta_lbl.set_markup(
                    f"<b>{GLib.markup_escape_text(tag_title)}</b> {GLib.markup_escape_text(body_text)}"
                )
                meta_lbl.get_style_context().add_class('cinnawm-guide-meta-label')
                meta_lbl.set_halign(Gtk.Align.START)
                meta_lbl.set_justify(Gtk.Justification.LEFT)
                meta_lbl.set_line_wrap(True)
                meta_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
                meta_lbl.set_max_width_chars(64)
                info_vbox.pack_start(meta_lbl, False, False, 0)

            card_hbox.pack_start(info_vbox, True, True, 0)
            card_frame.add(card_hbox)
            page.pack_start(card_frame, False, False, 0)

        return page

    def _build_shortcuts_page(self, sec):
        page = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=18)
        page.set_margin_start(32)
        page.set_margin_end(32)
        page.set_margin_top(22)
        page.set_margin_bottom(22)

        customize_btn = Gtk.Button(label=_("⌨ Customize Keybindings..."))
        customize_btn.connect('clicked', self._on_sys_settings_clicked)
        page.pack_start(self._build_page_banner(sec, right_widget=customize_btn), False, False, 0)

        def populate_key_badges(container, combos):
            for child in container.get_children():
                container.remove(child)
            for idx, combo in enumerate(combos):
                if idx > 0:
                    sep = Gtk.Label(label='/')
                    sep.get_style_context().add_class('dim-label')
                    sep.set_valign(Gtk.Align.CENTER)
                    container.pack_start(sep, False, False, 2)
                badge = Gtk.Label(label=combo)
                badge.get_style_context().add_class('cinnawm-kbd-badge')
                badge.set_valign(Gtk.Align.CENTER)
                container.pack_start(badge, False, False, 0)
            container.show_all()

        for group_title, items in get_shortcut_groups():
            group_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
            hdr = Gtk.Label(label=group_title, xalign=0.0)
            hdr.get_style_context().add_class('cinnawm-section-header')
            hdr.set_halign(Gtk.Align.START)
            hdr.set_justify(Gtk.Justification.LEFT)
            group_vbox.pack_start(hdr, False, False, 0)

            card_frame = Gtk.Frame()
            card_frame.set_shadow_type(Gtk.ShadowType.IN)
            card_frame.get_style_context().add_class('view')

            card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
            card_frame.add(card_vbox)

            for i, entry in enumerate(items):
                if i > 0:
                    card_vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)

                prop_key = entry[0]
                desc_text = entry[1]
                static_combos = entry[2] if len(entry) > 2 else None

                row_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=16)
                row_hbox.set_margin_start(18)
                row_hbox.set_margin_end(18)
                row_hbox.set_margin_top(10)
                row_hbox.set_margin_bottom(10)

                desc_lbl = Gtk.Label(label=desc_text, xalign=0.0)
                desc_lbl.get_style_context().add_class('cinnawm-row-title')
                desc_lbl.set_halign(Gtk.Align.START)
                desc_lbl.set_valign(Gtk.Align.CENTER)
                desc_lbl.set_justify(Gtk.Justification.LEFT)
                desc_lbl.set_line_wrap(True)
                desc_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)

                badges_hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
                badges_hbox.set_valign(Gtk.Align.CENTER)

                if prop_key:
                    raw_val = self.settings.get(prop_key, DEFAULT_SETTINGS.get(prop_key, ''))
                    populate_key_badges(badges_hbox, format_keybinding_list(raw_val))
                    self._widget_updaters.append(
                        lambda box=badges_hbox, pk=prop_key: populate_key_badges(
                            box, format_keybinding_list(self.settings.get(pk, DEFAULT_SETTINGS.get(pk, '')))
                        )
                    )
                else:
                    populate_key_badges(badges_hbox, static_combos or [])

                row_hbox.pack_start(desc_lbl, True, True, 0)
                row_hbox.pack_end(badges_hbox, False, False, 0)
                card_vbox.pack_start(row_hbox, False, False, 0)

            group_vbox.pack_start(card_frame, False, False, 0)
            page.pack_start(group_vbox, False, False, 0)

        # Mouse & Multi-Monitor Interactions Card
        mouse_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        mouse_hdr = Gtk.Label(label=_('Mouse & Multi-Monitor Interactions'), xalign=0.0)
        mouse_hdr.get_style_context().add_class('cinnawm-section-header')
        mouse_hdr.set_halign(Gtk.Align.START)
        mouse_hdr.set_justify(Gtk.Justification.LEFT)
        mouse_vbox.pack_start(mouse_hdr, False, False, 0)

        mouse_frame = Gtk.Frame()
        mouse_frame.set_shadow_type(Gtk.ShadowType.IN)
        mouse_frame.get_style_context().add_class('view')
        mouse_card_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)
        mouse_frame.add(mouse_card_vbox)

        for idx, (m_title, m_desc) in enumerate(get_mouse_items()):
            if idx > 0:
                mouse_card_vbox.pack_start(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL), False, False, 0)
            m_row = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
            m_row.set_margin_start(18)
            m_row.set_margin_end(18)
            m_row.set_margin_top(10)
            m_row.set_margin_bottom(10)
            m_row.set_halign(Gtk.Align.FILL)

            t_lbl = Gtk.Label(label=m_title, xalign=0.0)
            t_lbl.get_style_context().add_class('cinnawm-row-title')
            t_lbl.set_halign(Gtk.Align.START)
            t_lbl.set_justify(Gtk.Justification.LEFT)
            d_lbl = Gtk.Label(label=m_desc, xalign=0.0)
            d_lbl.get_style_context().add_class('dim-label')
            d_lbl.get_style_context().add_class('cinnawm-row-desc')
            d_lbl.set_halign(Gtk.Align.START)
            d_lbl.set_justify(Gtk.Justification.LEFT)
            d_lbl.set_line_wrap(True)
            d_lbl.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)

            m_row.pack_start(t_lbl, False, False, 0)
            m_row.pack_start(d_lbl, False, False, 0)
            mouse_card_vbox.pack_start(m_row, False, False, 0)

        mouse_vbox.pack_start(mouse_frame, False, False, 0)
        page.pack_start(mouse_vbox, False, False, 0)

        return page

    def _scroll_section_to_top(self, section_id):
        if getattr(self, '_scroll_idle_id', 0):
            GLib.source_remove(self._scroll_idle_id)
            self._scroll_idle_id = 0

        scroll = self._page_scrolls.get(section_id)
        if not scroll:
            return
        vadj = scroll.get_vadjustment()
        if vadj:
            vadj.set_value(vadj.get_lower())

        def _reset_idle():
            self._scroll_idle_id = 0
            adj = scroll.get_vadjustment()
            if adj:
                adj.set_value(adj.get_lower())
            return False

        self._scroll_idle_id = GLib.idle_add(_reset_idle)

    def select_section(self, section_id):
        if section_id not in self._sidebar_rows:
            section_id = 'general'
        row = self._sidebar_rows[section_id]
        self.sidebar_list.select_row(row)
        self.stack.set_visible_child_name(section_id)
        self._scroll_section_to_top(section_id)

    def _on_sidebar_row_selected(self, _listbox, row):
        if row and hasattr(row, 'section_id'):
            self.stack.set_visible_child_name(row.section_id)
            self._scroll_section_to_top(row.section_id)

    def _sync_active_layout_indicators(self):
        for sec_id, dot_lbl in self._sidebar_dots.items():
            if sec_id == self.active_layout_id:
                dot_lbl.show()
            else:
                dot_lbl.hide()

        for sec_id, btn_list in self._activate_buttons.items():
            for btn in btn_list:
                ctx = btn.get_style_context()
                if sec_id == self.active_layout_id:
                    btn.set_label(_("✓ Active Layout"))
                    btn.set_sensitive(False)
                    ctx.remove_class('suggested-action')
                else:
                    btn.set_label(_("Activate Layout"))
                    btn.set_sensitive(True)
                    ctx.add_class('suggested-action')

        for lid, frame in self._guide_card_frames.items():
            ctx = frame.get_style_context()
            if lid == self.active_layout_id:
                ctx.add_class('cinnawm-guide-card-active')
            else:
                ctx.remove_class('cinnawm-guide-card-active')

    def _refresh_from_wm(self):
        self.settings, self.active_layout_id = self.bridge.fetch_snapshot()
        self._updating_widgets = True
        try:
            for updater in self._widget_updaters:
                try:
                    updater()
                except Exception as e:
                    _log_warn('Widget refresh callback failed', e)
        finally:
            self._updating_widgets = False
        self._sync_active_layout_indicators()

    def _on_activate_layout_clicked(self, layout_id):
        self.bridge.activate_layout(layout_id)
        self._refresh_from_wm()

    def _on_reset_ratios_clicked(self, _btn):
        self.bridge.reset_ratios()
        self._refresh_from_wm()

    def _show_message_dialog(self, msg_type, primary_text, secondary_text=""):
        dlg = Gtk.MessageDialog(
            transient_for=self,
            modal=True,
            destroy_with_parent=True,
            message_type=msg_type,
            buttons=Gtk.ButtonsType.OK,
            text=primary_text,
        )
        try:
            if secondary_text:
                dlg.format_secondary_text(secondary_text)
            dlg.set_keep_above(True)
            dlg.run()
        finally:
            dlg.destroy()

    def _on_export_config_clicked(self, _btn):
        self._refresh_from_wm()
        dlg = Gtk.FileChooserDialog(
            title=_("Export CinnaWM Configuration"),
            transient_for=self,
            action=Gtk.FileChooserAction.SAVE,
        )
        dlg.add_buttons(
            Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
            Gtk.STOCK_SAVE, Gtk.ResponseType.ACCEPT,
        )
        dlg.set_modal(True)
        dlg.set_keep_above(True)
        dlg.set_do_overwrite_confirmation(True)
        dlg.set_current_name("cinnawm-profile.json")

        json_filter = Gtk.FileFilter()
        json_filter.set_name(_("JSON Configuration (*.json)"))
        json_filter.add_pattern("*.json")
        dlg.add_filter(json_filter)

        try:
            resp = dlg.run()
            filepath = dlg.get_filename()
        finally:
            dlg.destroy()

        if resp != Gtk.ResponseType.ACCEPT or not filepath:
            return
        if not filepath.lower().endswith('.json'):
            filepath += '.json'

        payload = {
            'app': UUID,
            'version': 1,
            'exportedAt': datetime.datetime.now().isoformat(timespec='seconds'),
            'settings': dict(self.settings),
        }
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(payload, f, indent=2, ensure_ascii=False)
            self._show_message_dialog(
                Gtk.MessageType.INFO,
                _("Configuration Exported"),
                _("Profile saved to:\n") + filepath,
            )
        except Exception as e:
            _log_warn('Configuration export failed', e)
            self._show_message_dialog(
                Gtk.MessageType.ERROR,
                _("Export Failed"),
                str(e),
            )

    def _on_import_config_clicked(self, _btn):
        dlg = Gtk.FileChooserDialog(
            title=_("Import CinnaWM Configuration"),
            transient_for=self,
            action=Gtk.FileChooserAction.OPEN,
        )
        dlg.add_buttons(
            Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
            Gtk.STOCK_OPEN, Gtk.ResponseType.ACCEPT,
        )
        dlg.set_modal(True)
        dlg.set_keep_above(True)

        json_filter = Gtk.FileFilter()
        json_filter.set_name(_("JSON Configuration (*.json)"))
        json_filter.add_pattern("*.json")
        dlg.add_filter(json_filter)

        try:
            resp = dlg.run()
            filepath = dlg.get_filename()
        finally:
            dlg.destroy()

        if resp != Gtk.ResponseType.ACCEPT or not filepath:
            return

        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                raise ValueError(_("Invalid JSON format: root must be an object."))
            settings_obj = raw.get('settings') if isinstance(raw.get('settings'), dict) else raw
            if not self.bridge.import_settings(settings_obj):
                raise ValueError(_("No valid CinnaWM settings found in the selected file."))
            self._refresh_from_wm()
            self._show_message_dialog(
                Gtk.MessageType.INFO,
                _("Configuration Imported"),
                _("All preferences, layouts, and shortcuts have been restored."),
            )
        except Exception as e:
            _log_warn('Configuration import failed', e)
            self._show_message_dialog(
                Gtk.MessageType.ERROR,
                _("Import Failed"),
                str(e),
            )

    def _on_sys_settings_clicked(self, _btn):
        try:
            GLib.spawn_command_line_async(f"{XLET_SETTINGS_CMD} extension {UUID}")
        except Exception as e:
            _log_warn(f'Failed to launch {XLET_SETTINGS_CMD}', e)
            self._show_message_dialog(
                Gtk.MessageType.ERROR,
                _("Failed to open System Settings"),
                str(e),
            )

    def _on_wm_state_changed(self, _reason=None):
        if self._destroyed or self._ipc_refresh_idle_id:
            return

        def _do_refresh():
            self._ipc_refresh_idle_id = 0
            if not self._destroyed:
                self._refresh_from_wm()
            return False

        self._ipc_refresh_idle_id = GLib.idle_add(_do_refresh)

    def _on_focus_in(self, *_args):
        self._refresh_from_wm()
        return False

    def _on_key_press(self, _widget, event):
        if event.keyval == Gdk.KEY_Escape:
            self.close()
            return True
        return False

    def _on_destroy(self, *_args):
        self._destroyed = True
        if getattr(self, '_ipc_refresh_idle_id', 0):
            GLib.source_remove(self._ipc_refresh_idle_id)
            self._ipc_refresh_idle_id = 0
        if getattr(self, '_dbus_sub_id', 0):
            self.bridge.unsubscribe_state_changed(self._dbus_sub_id)
            self._dbus_sub_id = 0
        if getattr(self, '_scroll_idle_id', 0):
            GLib.source_remove(self._scroll_idle_id)
            self._scroll_idle_id = 0


class CinnaWMSettingsApp(Gtk.Application):
    """Single-instance GTK3 Application for CinnaWM Preferences."""

    def __init__(self):
        super().__init__(
            application_id=GTK_APP_ID,
            flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
        )
        self.bridge = CinnaWMBridge()
        self.window = None

    def do_command_line(self, command_line):
        args = command_line.get_arguments()
        section = args[1] if len(args) > 1 else None

        if not self.window:
            self.window = CinnaWMSettingsWindow(self, self.bridge, initial_section=section)
        else:
            self.window._refresh_from_wm()
            if section:
                self.window.select_section(section)

        self.window.present()
        return 0


def main():
    GLib.set_prgname('cinnawm-settings')
    app = CinnaWMSettingsApp()
    return app.run(sys.argv)


if __name__ == '__main__':
    sys.exit(main())

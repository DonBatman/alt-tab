import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AltTab from 'resource:///org/gnome/shell/ui/altTab.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const APP_KEYBINDINGS = [
    'switch-applications',
    'switch-applications-backward',
];

const WIN_KEYBINDINGS = [
    'switch-windows',
    'switch-windows-backward',
];

const VALID_LAYOUTS = new Set([
    'wall',
    'carousel1',
    'carousel2',
    'fan',
    'toss',
    'spinswap',
    'zoom',
    'rolodex',
]);

export default class AltTabSwitcherExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._switcher = null;

        for (const binding of APP_KEYBINDINGS) {
            Main.wm.setCustomKeybindingHandler(
                binding,
                Shell.ActionMode.NORMAL,
                this._startFromWm.bind(this)
            );
        }

        for (const binding of WIN_KEYBINDINGS) {
            Meta.keybindings_set_custom_handler(
                binding,
                this._startFromMeta.bind(this)
            );
        }
    }

    disable() {
        for (const binding of APP_KEYBINDINGS) {
            Main.wm.setCustomKeybindingHandler(
                binding,
                Shell.ActionMode.NORMAL,
                (display, window, kb) => {
                    const tabPopup = new AltTab.AppSwitcherPopup();
                    if (!tabPopup.show(kb.is_reversed(), kb.get_name(), kb.get_mask()))
                        tabPopup.destroy();
                }
            );
        }

        for (const binding of WIN_KEYBINDINGS) {
            Meta.keybindings_set_custom_handler(
                binding,
                (display, window, event, kb) => {
                    const tabPopup = new AltTab.WindowSwitcherPopup();
                    if (!tabPopup.show(kb.is_reversed(), kb.get_name(), kb.get_mask()))
                        tabPopup.destroy();
                }
            );
        }

        this._destroySwitcher();
        this._settings = null;
    }

    _destroySwitcher() {
        if (this._switcher) {
            this._switcher.destroy();
            this._switcher = null;
        }
    }

    _startFromWm(display, window, binding) {
        this._launchSwitcher(binding);
    }

    _startFromMeta(display, window, event, binding) {
        this._launchSwitcher(binding);
    }

    _getSwitchableWindows() {
        const workspace = global.workspace_manager.get_active_workspace();
        let windows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);

        if (!windows || windows.length === 0)
            windows = global.display.get_tab_list(Meta.TabList.NORMAL, null);

        if (!windows || windows.length === 0) {
            windows = global.get_window_actors()
                .map(actor => actor.get_meta_window())
                .filter(win => win && !win.skip_taskbar && win.get_window_type() === Meta.WindowType.NORMAL);
        }
        return windows;
    }

    _safeGetString(key, fallback) {
        try {
            const schema = this._settings.settings_schema;
            if (schema && schema.has_key(key))
                return this._settings.get_string(key);
        } catch (e) {
            logError(e, `[AltTabSwitcher] Failed reading setting ${key}`);
        }
        return fallback;
    }

    _launchSwitcher(binding) {
        const name = binding ? binding.get_name() : '';
        const backward = name.endsWith('-backward') || (binding && binding.is_reversed());

        if (this._switcher) {
            this._switcher.step(backward ? -1 : 1);
            return;
        }

        const windows = this._getSwitchableWindows();
        if (!windows || windows.length === 0)
            return;

        let layoutMode = this._safeGetString('layout-mode', 'wall');
        if (layoutMode === 'carousel')
            layoutMode = 'carousel1';
        if (layoutMode === 'deck')
            layoutMode = 'fan';
        if (!VALID_LAYOUTS.has(layoutMode))
            layoutMode = 'wall';

        const themeKey = `theme-${layoutMode}`;
        const themeName = this._safeGetString(themeKey, 'glass');

        try {
            this._switcher = new CustomSwitcherPopup({
                windows,
                layoutMode,
                themeName,
                backward,
                onClose: () => {
                    this._switcher = null;
                },
            });
        } catch (e) {
            logError(e, '[AltTabSwitcher] Failed to create popup');
            this._destroySwitcher();
        }
    }
}

class CustomSwitcherPopup {
    constructor({windows, layoutMode, themeName, backward, onClose}) {
        this._windows = windows;
        this._layoutMode = layoutMode;
        this._themeName = themeName;
        this._onClose = onClose;
        this._cards = [];
        this._grab = null;
        this._stageCaptureId = 0;
        this._spinTimerId = 0;

        this._currentIndex = windows.length > 1
            ? (backward ? windows.length - 1 : 1)
            : 0;
        this._prevIndex = 0;
        this._lastDelta = backward ? -1 : 1;

        this._targetStep = this._currentIndex;
        this._renderStep = this._currentIndex;

        const stSettings = St.Settings.get();
        this._animEnabled = stSettings.enable_animations;
        this._animDuration = this._animEnabled ? 280 : 0;

        try {
            this._buildUI();
            this._setupInput();
            this._updateLayout(false);
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._monitor = monitor;

        this._container = new St.Widget({
            style_class: 'ats-overlay',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            reactive: true,
            can_focus: true,
        });

        Main.uiGroup.add_child(this._container);
        this._grab = Main.pushModal(this._container, {
            actionMode: Shell.ActionMode.POPUP,
        });
        this._container.grab_key_focus();

        const tracker = Shell.WindowTracker.get_default();
        const pivotY = this._layoutMode === 'fan' ? 0.92 : 0.5;

        this._windows.forEach((metaWin, idx) => {
            const card = new St.Button({
                style_class: `ats-card ats-theme-${this._themeName}`,
                reactive: true,
                can_focus: false,
            });
            card.set_pivot_point(0.5, pivotY);

            const innerBox = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_expand: true,
            });
            card.set_child(innerBox);

            const compositor = metaWin.get_compositor_private();
            const cloneContainer = new St.Widget({
                clip_to_allocation: true,
                x_expand: true,
                y_expand: true,
            });

            if (compositor) {
                const clone = new Clutter.Clone({
                    source: compositor,
                    reactive: false,
                });
                cloneContainer.add_child(clone);
                card._clone = clone;
            }

            const titleBox = new St.BoxLayout({
                orientation: Clutter.Orientation.HORIZONTAL,
                style_class: 'ats-title-box',
                x_align: Clutter.ActorAlign.CENTER,
            });

            const app = tracker.get_window_app(metaWin);
            if (app) {
                const icon = app.create_icon_texture(24);
                titleBox.add_child(icon);
            }

            const label = new St.Label({
                text: metaWin.get_title() || (app ? app.get_name() : 'Window'),
                style_class: 'ats-title',
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            titleBox.add_child(label);

            innerBox.add_child(cloneContainer);
            innerBox.add_child(titleBox);

            card.connect('clicked', () => {
                this._currentIndex = idx;
                this._targetStep = idx;
                this._renderStep = idx;
                this._activateAndClose();
            });

            this._container.add_child(card);
            this._cards.push({card, metaWin, cloneContainer});
        });
    }

    _handleKeyPress(event) {
        const symbol = event.get_key_symbol();
        const keyCode = event.get_key_code();
        const state = event.get_state();
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

        if (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab || keyCode === 23) {
            this.step(shift || symbol === Clutter.KEY_ISO_Left_Tab ? -1 : 1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_Down) {
            this.step(1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Up) {
            this.step(-1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_space) {
            this._activateAndClose();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Escape) {
            this.destroy();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _handleKeyRelease(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Alt_L || symbol === Clutter.KEY_Alt_R ||
            symbol === Clutter.KEY_Meta_L || symbol === Clutter.KEY_Meta_R ||
            symbol === Clutter.KEY_Super_L || symbol === Clutter.KEY_Super_R) {
            this._activateAndClose();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _setupInput() {
        this._container.connect('key-press-event', (_actor, event) => this._handleKeyPress(event));
        this._container.connect('key-release-event', (_actor, event) => this._handleKeyRelease(event));

        this._stageCaptureId = global.stage.connect('captured-event', (_actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.KEY_PRESS)
                return this._handleKeyPress(event);
            if (type === Clutter.EventType.KEY_RELEASE)
                return this._handleKeyRelease(event);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    step(delta) {
        const count = this._cards.length;
        if (count === 0)
            return;

        this._prevIndex = this._currentIndex;
        this._lastDelta = delta;
        this._targetStep += delta;
        this._currentIndex = ((this._targetStep % count) + count) % count;

        if (this._layoutMode === 'carousel1' || this._layoutMode === 'rolodex') {
            this._startAngularSpin();
        } else {
            this._renderStep = this._targetStep;
            this._updateLayout(true);
        }
    }

    _startAngularSpin() {
        if (!this._animEnabled) {
            this._renderStep = this._targetStep;
            this._updateLayout(false);
            return;
        }

        if (this._spinTimerId) {
            GLib.source_remove(this._spinTimerId);
            this._spinTimerId = 0;
        }

        const startStep = this._renderStep;
        const endStep = this._targetStep;
        const durationMs = this._animDuration;
        const startTime = GLib.get_monotonic_time();

        this._spinTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!this._container) {
                this._spinTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }

            const elapsedMs = (GLib.get_monotonic_time() - startTime) / 1000;
            const t = Math.min(1, elapsedMs / durationMs);
            const eased = 1 - Math.pow(1 - t, 3);

            this._renderStep = startStep + (endStep - startStep) * eased;
            this._updateLayout(false);

            if (t >= 1) {
                this._renderStep = endStep;
                this._spinTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _sizeClone(item, targetW, targetH) {
        item.card.set_size(targetW, targetH);
        const thumbW = Math.max(40, targetW - 20);
        const thumbH = Math.max(40, targetH - 54);
        item.cloneContainer.set_size(thumbW, thumbH);

        if (item.card._clone && item.card._clone.source) {
            const [srcW, srcH] = item.card._clone.source.get_size();
            if (srcW > 0 && srcH > 0) {
                const scale = Math.min(thumbW / srcW, thumbH / srcH);
                item.card._clone.set_size(srcW * scale, srcH * scale);
                item.card._clone.set_position(
                    (thumbW - srcW * scale) / 2,
                    (thumbH - srcH * scale) / 2
                );
            }
        }
    }

    _updateLayout(animate) {
        this._cards.forEach((item, i) => {
            if (i === this._currentIndex)
                item.card.add_style_class_name('ats-active');
            else
                item.card.remove_style_class_name('ats-active');
        });

        switch (this._layoutMode) {
        case 'wall':
            this._layoutWall(animate);
            break;
        case 'carousel1':
            this._layoutCarouselCylinder();
            break;
        case 'carousel2':
            this._layoutCoverFlow(animate);
            break;
        case 'fan':
            this._layoutPokerFan(animate);
            break;
        case 'toss':
            this._layoutCardToss(animate);
            break;
        case 'spinswap':
            this._layoutSpinSwap(animate);
            break;
        case 'zoom':
            this._layoutDepthTunnel(animate);
            break;
        case 'rolodex':
            this._layoutRolodex();
            break;
        default:
            this._layoutWall(animate);
            break;
        }
    }

    /* ================= LAYOUT 1: WALL ================= */
    _layoutWall(animate) {
        const count = this._cards.length;
        const cols = Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / cols);

        const pad = 28;
        const maxAreaW = this._monitor.width * 0.85;
        const maxAreaH = this._monitor.height * 0.82;

        const cellW = Math.min(420, (maxAreaW - pad * (cols - 1)) / cols);
        const cellH = Math.min(280, (maxAreaH - pad * (rows - 1)) / rows);

        const totalGridW = cols * cellW + (cols - 1) * pad;
        const totalGridH = rows * cellH + (rows - 1) * pad;
        const startX = (this._monitor.width - totalGridW) / 2;
        const startY = (this._monitor.height - totalGridH) / 2;

        this._cards.forEach((item, i) => {
            this._sizeClone(item, cellW, cellH);

            const col = i % cols;
            const row = Math.floor(i / cols);
            const targetX = startX + col * (cellW + pad);
            const targetY = startY + row * (cellH + pad);
            const isSelected = i === this._currentIndex;

            this._applyTransform(item.card, {
                x: targetX,
                y: targetY,
                scale_x: isSelected ? 1.06 : 0.96,
                scale_y: isSelected ? 1.06 : 0.96,
                rotation_angle_x: 0,
                rotation_angle_y: 0,
                rotation_angle_z: 0,
                opacity: isSelected ? 255 : 210,
            }, animate);

            if (isSelected)
                this._container.set_child_above_sibling(item.card, null);
        });
    }

    /* ================= LAYOUT 2: CAROUSEL 1 (3D PAPER-STRIP CYLINDER) ================= */
    _layoutCarouselCylinder() {
        const count = this._cards.length;
        const densityScale = count <= 4 ? 1.0 : Math.max(0.68, 1.0 - (count - 4) * 0.07);
        const cardW = Math.min(440, this._monitor.width * 0.30) * densityScale;
        const cardH = Math.min(300, this._monitor.height * 0.30) * densityScale;

        const centerX = (this._monitor.width - cardW) / 2;
        const centerY = (this._monitor.height - cardH) / 2;

        const minRadius = this._monitor.width * 0.16;
        const maxRadius = this._monitor.width * 0.33;
        const countFactor = Math.min(1, Math.max(0, (count - 2) / 6));
        const radiusX = minRadius + (maxRadius - minRadius) * countFactor;
        const radiusY = this._monitor.height * (0.09 + 0.06 * countFactor);

        const angleStep = (2 * Math.PI) / count;
        const depthOrder = [];

        this._cards.forEach((item, i) => {
            this._sizeClone(item, cardW, cardH);

            const rawTheta = (i - this._renderStep) * angleStep;
            let normTheta = rawTheta % (2 * Math.PI);
            if (normTheta > Math.PI)
                normTheta -= 2 * Math.PI;
            if (normTheta < -Math.PI)
                normTheta += 2 * Math.PI;

            const sinT = Math.sin(normTheta);
            const cosT = Math.cos(normTheta);
            const depthNorm = (cosT + 1) / 2;

            const x = centerX + sinT * radiusX;
            const y = centerY + cosT * radiusY;
            const scale = 0.56 + 0.48 * Math.pow(depthNorm, 1.1);

            let rotYDeg = (normTheta * 180) / Math.PI;
            if (count === 4 && Math.abs(Math.abs(rotYDeg) - 90) < 5)
                rotYDeg = rotYDeg > 0 ? 98 : -98;

            const opacity = cosT >= 0
                ? Math.round(190 + 65 * cosT)
                : Math.round(105 + 75 * (1 + cosT));

            depthOrder.push({card: item.card, depth: cosT});

            item.card.remove_all_transitions();
            Object.assign(item.card, {
                x,
                y,
                scale_x: scale,
                scale_y: scale,
                rotation_angle_x: 0,
                rotation_angle_y: rotYDeg,
                rotation_angle_z: 0,
                opacity,
            });
        });

        depthOrder.sort((a, b) => a.depth - b.depth);
        depthOrder.forEach(entry => {
            this._container.set_child_above_sibling(entry.card, null);
        });
    }

    /* ================= LAYOUT 3: CAROUSEL 2 (3D COVERFLOW STAGE) ================= */
    _layoutCoverFlow(animate) {
        const count = this._cards.length;
        const cardW = Math.min(540, this._monitor.width * 0.38);
        const cardH = Math.min(360, this._monitor.height * 0.38);

        const centerX = (this._monitor.width - cardW) / 2;
        const centerY = (this._monitor.height - cardH) / 2;

        const wingStartOffset = cardW * 0.62;
        const wingStep = Math.min(95, (this._monitor.width * 0.34) / Math.max(1, Math.ceil(count / 2)));
        const zOrder = [];

        this._cards.forEach((item, i) => {
            this._sizeClone(item, cardW, cardH);

            let rel = i - this._currentIndex;
            if (rel > count / 2)
                rel -= count;
            if (rel < -count / 2)
                rel += count;

            const absDist = Math.abs(rel);

            if (rel === 0) {
                zOrder.push({card: item.card, priority: 100});
                this._applyTransform(item.card, {
                    x: centerX,
                    y: centerY - 12,
                    scale_x: 1.12,
                    scale_y: 1.12,
                    rotation_angle_x: 0,
                    rotation_angle_y: 0,
                    rotation_angle_z: 0,
                    opacity: 255,
                }, animate);
            } else {
                const dir = rel > 0 ? 1 : -1;
                const x = centerX + dir * (wingStartOffset + (absDist - 1) * wingStep);
                const y = centerY + 18 + Math.min(absDist * 6, 24);
                const scale = Math.max(0.56, 0.84 - (absDist - 1) * 0.06);
                const rotY = dir > 0 ? -58 : 58;
                const opacity = Math.max(115, 235 - (absDist - 1) * 26);

                zOrder.push({card: item.card, priority: 50 - absDist});

                this._applyTransform(item.card, {
                    x,
                    y,
                    scale_x: scale,
                    scale_y: scale,
                    rotation_angle_x: 0,
                    rotation_angle_y: rotY,
                    rotation_angle_z: 0,
                    opacity,
                }, animate);
            }
        });

        zOrder.sort((a, b) => a.priority - b.priority);
        zOrder.forEach(entry => {
            this._container.set_child_above_sibling(entry.card, null);
        });
    }

    /* ================= LAYOUT 4: POKER HAND FAN ================= */
    _layoutPokerFan(animate) {
        const count = this._cards.length;
        const cardW = Math.min(480, this._monitor.width * 0.34);
        const cardH = Math.min(320, this._monitor.height * 0.34);

        const centerX = (this._monitor.width - cardW) / 2;
        const baseY = (this._monitor.height - cardH) / 2 + 46;

        // Spread angle per step shrinks gently when many windows are open so the fan stays compact
        const maxTotalSpread = 76;
        const stepAngle = count <= 1 ? 0 : Math.min(11, maxTotalSpread / (count - 1));
        const arcRadius = this._monitor.height * 0.62;
        const zOrder = [];

        this._cards.forEach((item, i) => {
            this._sizeClone(item, cardW, cardH);

            // Center the active card in the middle of the hand, fanning remaining cards left & right
            const rel = i - this._currentIndex;
            const isSelected = rel === 0;

            if (isSelected) {
                zOrder.push({card: item.card, priority: 1000});
                this._applyTransform(item.card, {
                    x: centerX,
                    y: baseY - 68,
                    scale_x: 1.08,
                    scale_y: 1.08,
                    rotation_angle_x: 0,
                    rotation_angle_y: 0,
                    rotation_angle_z: 0,
                    opacity: 255,
                }, animate);
            } else {
                const angleDeg = rel * stepAngle;
                const angleRad = (angleDeg * Math.PI) / 180;

                // Radial playing-card arc around a pivot below the hand
                const x = centerX + Math.sin(angleRad) * arcRadius;
                const y = baseY + (1 - Math.cos(angleRad)) * arcRadius * 0.72;
                const scale = Math.max(0.76, 0.94 - Math.abs(rel) * 0.02);

                // Overlap left-to-right naturally like cards held in a hand, with active card pulled out on top
                zOrder.push({card: item.card, priority: 100 + i});

                this._applyTransform(item.card, {
                    x,
                    y,
                    scale_x: scale,
                    scale_y: scale,
                    rotation_angle_x: 0,
                    rotation_angle_y: 0,
                    rotation_angle_z: angleDeg,
                    opacity: Math.max(150, 238 - Math.abs(rel) * 14),
                }, animate);
            }
        });

        zOrder.sort((a, b) => a.priority - b.priority);
        zOrder.forEach(entry => {
            this._container.set_child_above_sibling(entry.card, null);
        });
    }

    /* ================= LAYOUT 5: CARD TOSS (FLICK & DISCARD) ================= */
    _layoutCardToss(animate) {
        const count = this._cards.length;
        const cardW = Math.min(560, this._monitor.width * 0.40);
        const cardH = Math.min(380, this._monitor.height * 0.40);

        const centerX = (this._monitor.width - cardW) / 2;
        const centerY = (this._monitor.height - cardH) / 2;

        for (let offset = count - 1; offset >= 1; offset--) {
            const idx = (this._currentIndex + offset) % count;
            const item = this._cards[idx];
            this._sizeClone(item, cardW, cardH);

            const wasJustTossed = animate && this._lastDelta > 0 && idx === this._prevIndex && count > 1;
            const stackDepth = Math.min(offset, 5);
            const targetScale = Math.max(0.76, 1.0 - stackDepth * 0.045);
            const targetX = centerX - stackDepth * 14;
            const targetY = centerY + stackDepth * 12;
            const targetRotZ = -stackDepth * 2.5;
            const targetOpacity = offset <= 5 ? Math.max(90, 235 - stackDepth * 28) : 0;

            this._container.set_child_above_sibling(item.card, null);

            if (wasJustTossed && this._animDuration > 0) {
                item.card.remove_all_transitions();
                item.card.ease({
                    x: this._monitor.width * 1.05,
                    y: -cardH * 0.45,
                    scale_x: 0.72,
                    scale_y: 0.72,
                    rotation_angle_z: 42,
                    opacity: 0,
                    duration: Math.round(this._animDuration * 0.65),
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (!this._container)
                            return;
                        Object.assign(item.card, {
                            x: targetX,
                            y: targetY,
                            scale_x: targetScale,
                            scale_y: targetScale,
                            rotation_angle_x: 0,
                            rotation_angle_y: 0,
                            rotation_angle_z: targetRotZ,
                            opacity: 0,
                        });
                        item.card.ease({
                            opacity: targetOpacity,
                            duration: 120,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    },
                });
            } else {
                this._applyTransform(item.card, {
                    x: targetX,
                    y: targetY,
                    scale_x: targetScale,
                    scale_y: targetScale,
                    rotation_angle_x: 0,
                    rotation_angle_y: 0,
                    rotation_angle_z: targetRotZ,
                    opacity: targetOpacity,
                }, animate);
            }
        }

        const activeItem = this._cards[this._currentIndex];
        this._sizeClone(activeItem, cardW, cardH);

        if (animate && this._lastDelta < 0 && count > 1) {
            activeItem.card.remove_all_transitions();
            Object.assign(activeItem.card, {
                x: this._monitor.width * 0.95,
                y: -cardH * 0.35,
                scale_x: 0.75,
                scale_y: 0.75,
                rotation_angle_x: 0,
                rotation_angle_y: 0,
                rotation_angle_z: 38,
                opacity: 60,
            });
        }

        this._applyTransform(activeItem.card, {
            x: centerX,
            y: centerY,
            scale_x: 1.04,
            scale_y: 1.04,
            rotation_angle_x: 0,
            rotation_angle_y: 0,
            rotation_angle_z: 0,
            opacity: 255,
        }, animate);
        this._container.set_child_above_sibling(activeItem.card, null);
    }

    /* ================= LAYOUT 6: SPIN-SWAP (360° CROSS-SCREEN SPIN) ================= */
    _layoutSpinSwap(animate) {
        const count = this._cards.length;
        const cardW = Math.min(520, this._monitor.width * 0.36);
        const cardH = Math.min(350, this._monitor.height * 0.36);

        const centerX = (this._monitor.width - cardW) / 2;
        const centerY = (this._monitor.height - cardH) / 2;

        const leftWingX = this._monitor.width * 0.05;
        const rightWingX = this._monitor.width * 0.95 - cardW;

        this._cards.forEach((item, i) => {
            this._sizeClone(item, cardW, cardH);
            const rel = (i - this._currentIndex + count) % count;

            if (rel === 0) {
                if (animate && count > 1) {
                    item.card.remove_all_transitions();
                    item.card.rotation_angle_z = this._lastDelta >= 0 ? -360 : 360;
                } else {
                    item.card.rotation_angle_z = 0;
                }

                this._applyTransform(item.card, {
                    x: centerX,
                    y: centerY,
                    scale_x: 1.06,
                    scale_y: 1.06,
                    rotation_angle_x: 0,
                    rotation_angle_y: 0,
                    rotation_angle_z: 0,
                    opacity: 255,
                }, animate);
                this._container.set_child_above_sibling(item.card, null);
            } else if (i === this._prevIndex && animate && count > 1) {
                item.card.remove_all_transitions();
                item.card.rotation_angle_z = 0;
                const exitX = this._lastDelta >= 0 ? leftWingX : rightWingX;

                this._applyTransform(item.card, {
                    x: exitX,
                    y: centerY + 30,
                    scale_x: 0.62,
                    scale_y: 0.62,
                    rotation_angle_x: 0,
                    rotation_angle_y: 0,
                    rotation_angle_z: this._lastDelta >= 0 ? -360 : 360,
                    opacity: 195,
                }, true);
            } else {
                const isLeftSide = rel > count / 2;
                const wingDepth = isLeftSide ? (count - rel) : rel;
                const x = isLeftSide
                    ? leftWingX + Math.min((wingDepth - 1) * 26, 110)
                    : rightWingX - Math.min((wingDepth - 1) * 26, 110);
                const scale = Math.max(0.50, 0.64 - (wingDepth - 1) * 0.04);

                this._applyTransform(item.card, {
                    x,
                    y: centerY + 30,
                    scale_x: scale,
                    scale_y: scale,
                    rotation_angle_x: 0,
                    rotation_angle_y: 0,
                    rotation_angle_z: 0,
                    opacity: Math.max(90, 200 - wingDepth * 22),
                }, animate);
            }
        });

        const activeCard = this._cards[this._currentIndex]?.card;
        if (activeCard)
            this._container.set_child_above_sibling(activeCard, null);
    }

    /* ================= LAYOUT 7: DEPTH TUNNEL (Z-AXIS ZOOM STACK) ================= */
    _layoutDepthTunnel(animate) {
        const count = this._cards.length;
        const cardW = Math.min(600, this._monitor.width * 0.44);
        const cardH = Math.min(400, this._monitor.height * 0.44);

        const centerX = (this._monitor.width - cardW) / 2;
        const centerY = (this._monitor.height - cardH) / 2 + 24;

        for (let offset = count - 1; offset >= 1; offset--) {
            const idx = (this._currentIndex + offset) % count;
            const item = this._cards[idx];
            this._sizeClone(item, cardW, cardH);

            const wasFrontZoomedPast = animate && this._lastDelta > 0 && idx === this._prevIndex && count > 1;
            const depth = Math.min(offset, 6);
            const targetScale = Math.max(0.42, 1.0 - depth * 0.11);
            const targetY = centerY - depth * 36;
            const targetOpacity = offset <= 6 ? Math.max(60, 245 - depth * 32) : 0;

            this._container.set_child_above_sibling(item.card, null);

            if (wasFrontZoomedPast && this._animDuration > 0) {
                item.card.remove_all_transitions();
                item.card.ease({
                    x: centerX,
                    y: centerY + 60,
                    scale_x: 1.75,
                    scale_y: 1.75,
                    opacity: 0,
                    duration: Math.round(this._animDuration * 0.6),
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => {
                        if (!this._container)
                            return;
                        Object.assign(item.card, {
                            x: centerX,
                            y: targetY,
                            scale_x: targetScale,
                            scale_y: targetScale,
                            rotation_angle_x: 0,
                            rotation_angle_y: 0,
                            rotation_angle_z: 0,
                            opacity: 0,
                        });
                        item.card.ease({
                            opacity: targetOpacity,
                            duration: 140,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    },
                });
            } else {
                this._applyTransform(item.card, {
                    x: centerX,
                    y: targetY,
                    scale_x: targetScale,
                    scale_y: targetScale,
                    rotation_angle_x: 0,
                    rotation_angle_y: 0,
                    rotation_angle_z: 0,
                    opacity: targetOpacity,
                }, animate);
            }
        }

        const activeItem = this._cards[this._currentIndex];
        this._sizeClone(activeItem, cardW, cardH);

        if (animate && this._lastDelta < 0 && count > 1) {
            activeItem.card.remove_all_transitions();
            Object.assign(activeItem.card, {
                x: centerX,
                y: centerY + 60,
                scale_x: 1.65,
                scale_y: 1.65,
                opacity: 40,
            });
        }

        this._applyTransform(activeItem.card, {
            x: centerX,
            y: centerY,
            scale_x: 1.04,
            scale_y: 1.04,
            rotation_angle_x: 0,
            rotation_angle_y: 0,
            rotation_angle_z: 0,
            opacity: 255,
        }, animate);
        this._container.set_child_above_sibling(activeItem.card, null);
    }

    /* ================= LAYOUT 8: ROLODEX (COMPACT VERTICAL 3D FLIP BUNDLE) ================= */
    _layoutRolodex() {
        const count = this._cards.length;
        const densityScale = count <= 4 ? 1.0 : Math.max(0.76, 1.0 - (count - 4) * 0.05);
        const cardW = Math.min(540, this._monitor.width * 0.38) * densityScale;
        const cardH = Math.min(340, this._monitor.height * 0.34) * densityScale;

        const centerX = (this._monitor.width - cardW) / 2;
        const centerY = (this._monitor.height - cardH) / 2;

        const minRadiusY = this._monitor.height * 0.08;
        const maxRadiusY = this._monitor.height * 0.14;
        const countFactor = Math.min(1, Math.max(0, (count - 2) / 6));
        const radiusY = minRadiusY + (maxRadiusY - minRadiusY) * countFactor;

        const angleStep = (2 * Math.PI) / count;
        const depthOrder = [];

        this._cards.forEach((item, i) => {
            this._sizeClone(item, cardW, cardH);

            const rawTheta = (i - this._renderStep) * angleStep;
            let normTheta = rawTheta % (2 * Math.PI);
            if (normTheta > Math.PI)
                normTheta -= 2 * Math.PI;
            if (normTheta < -Math.PI)
                normTheta += 2 * Math.PI;

            const sinT = Math.sin(normTheta);
            const cosT = Math.cos(normTheta);
            const depthNorm = (cosT + 1) / 2;

            const x = centerX;
            const y = centerY + sinT * radiusY;
            const scale = 0.52 + 0.52 * Math.pow(depthNorm, 1.35);
            const rotXDeg = -(normTheta * 180) / Math.PI;

            const opacity = cosT >= 0
                ? Math.round(180 + 75 * cosT)
                : Math.round(75 + 70 * (1 + cosT));

            depthOrder.push({card: item.card, depth: cosT});

            item.card.remove_all_transitions();
            Object.assign(item.card, {
                x,
                y,
                scale_x: scale,
                scale_y: scale,
                rotation_angle_x: rotXDeg,
                rotation_angle_y: 0,
                rotation_angle_z: 0,
                opacity,
            });
        });

        depthOrder.sort((a, b) => a.depth - b.depth);
        depthOrder.forEach(entry => {
            this._container.set_child_above_sibling(entry.card, null);
        });
    }

    _applyTransform(actor, props, animate) {
        actor.remove_all_transitions();
        if (animate && this._animDuration > 0) {
            actor.ease({
                ...props,
                duration: this._animDuration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            Object.assign(actor, props);
        }
    }

    _activateAndClose() {
        const selected = this._cards[this._currentIndex]?.metaWin;
        this.destroy();
        if (selected)
            Main.activateWindow(selected);
    }

    destroy() {
        if (this._spinTimerId) {
            GLib.source_remove(this._spinTimerId);
            this._spinTimerId = 0;
        }
        if (this._stageCaptureId) {
            global.stage.disconnect(this._stageCaptureId);
            this._stageCaptureId = 0;
        }
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        for (const item of this._cards) {
            if (item.card)
                item.card.remove_all_transitions();
        }
        this._cards = [];
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
        if (this._onClose) {
            this._onClose();
            this._onClose = null;
        }
    }
}

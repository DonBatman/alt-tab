import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AltTabSwitcherPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Switcher Settings',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(page);

        // Group 1: Active Switcher Mode (8 Types)
        const modeGroup = new Adw.PreferencesGroup({
            title: 'Switcher Layout Type',
            description: 'Select how windows are arranged and animated when pressing Alt+Tab.',
        });
        page.add(modeGroup);

        const layoutKeys = [
            'wall',
            'carousel1',
            'carousel2',
            'fan',
            'toss',
            'spinswap',
            'zoom',
            'rolodex',
        ];

        const layoutLabels = Gtk.StringList.new([
            'Wall (Dynamic Grid)',
            'Carousel 1 (3D Cylinder Strip)',
            'Carousel 2 (3D CoverFlow Stage)',
            'Poker Hand Fan (Curved Radial Arc)',
            'Card Toss (Flick & Discard)',
            'Spin-Swap (360° Cross-Screen Spin)',
            'Depth Tunnel (Z-Axis Zoom Stack)',
            'Rolodex (Vertical 3D Flip)',
        ]);

        const modeRow = new Adw.ComboRow({
            title: 'Active Layout',
            model: layoutLabels,
        });

        const currentLayout = settings.get_string('layout-mode');
        modeRow.set_selected(Math.max(0, layoutKeys.indexOf(currentLayout)));

        modeRow.connect('notify::selected', () => {
            settings.set_string('layout-mode', layoutKeys[modeRow.get_selected()]);
        });
        modeGroup.add(modeRow);

        // Group 2: Per-Layout Themes (8 Themes)
        const themeGroup = new Adw.PreferencesGroup({
            title: 'Per-Layout Visual Themes',
            description: 'Customize the visual style independently for each switcher type.',
        });
        page.add(themeGroup);

        const themeKeys = [
            'glass',
            'classic',
            'neon',
            'neon-red',
            'neon-lime',
            'pink',
            'forest',
            'purple',
        ];

        const themeOptions = [
            'Frosted Glass',
            'Classic High-Contrast',
            'Neon Cyan',
            'Neon Red',
            'Neon Lime',
            'Pink Rose',
            'Forest Green',
            'Royal Purple',
        ];

        const addThemeRow = (title, schemaKey) => {
            const row = new Adw.ComboRow({
                title,
                model: Gtk.StringList.new(themeOptions),
            });
            const saved = settings.get_string(schemaKey);
            row.set_selected(Math.max(0, themeKeys.indexOf(saved)));

            row.connect('notify::selected', () => {
                settings.set_string(schemaKey, themeKeys[row.get_selected()]);
            });
            themeGroup.add(row);
        };

        addThemeRow('Wall Theme', 'theme-wall');
        addThemeRow('Carousel 1 (Cylinder Strip) Theme', 'theme-carousel1');
        addThemeRow('Carousel 2 (CoverFlow Stage) Theme', 'theme-carousel2');
        addThemeRow('Poker Hand Fan Theme', 'theme-fan');
        addThemeRow('Card Toss Theme', 'theme-toss');
        addThemeRow('Spin-Swap Theme', 'theme-spinswap');
        addThemeRow('Depth Tunnel Theme', 'theme-zoom');
        addThemeRow('Rolodex Theme', 'theme-rolodex');
    }
}

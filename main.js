'use strict';

/*
 * Mobile Pinch Zoom — Obsidian plugin (mobile only) — v0.3.0
 * Pinch with two fingers to zoom the note in/out on iPad / iPhone / Android.
 * Desktop uses the separate "Ctrl+Scroll Zoom" plugin, so this no-ops on desktop.
 *
 * v0.2.0: floating 🔍 indicator (mobile has no status bar); tap to reset to 100%.
 * v0.3.0: smoother zooming —
 *   - pinch updates are throttled to one apply per animation frame (no thrash);
 *   - the Zoom in / Zoom out commands, the indicator tap, and Reset glide to the
 *     target with eased animation instead of jumping.
 */

const { Plugin, PluginSettingTab, Setting, Platform } = require('obsidian');

const DEFAULT_SETTINGS = {
  mode: 'content', // 'content' (CSS zoom) | 'font' (font-size)
  minZoom: 0.5,
  maxZoom: 4.0,
  step: 0.2, // amount per Zoom in / Zoom out command
  zoom: 1.0,
  showIndicator: true,
  indicatorPosition: 'bottom-right', // bottom-right | bottom-left | top-right | top-left
};

const POSITION_CLASS = {
  'bottom-right': 'mpz-pos-bottom-right',
  'bottom-left': 'mpz-pos-bottom-left',
  'top-right': 'mpz-pos-top-right',
  'top-left': 'mpz-pos-top-left',
};

const ANIM_MS = 180;

module.exports = class MobilePinchZoomPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Desktop has its own Ctrl+wheel zoom plugin; only run the gesture logic on mobile.
    if (!Platform.isMobile) {
      this.addSettingTab(new MPZSettingTab(this.app, this));
      return;
    }

    this._raf = null;
    this._pending = null;
    this._anim = null;

    this.injectStyle();
    this.createIndicator();
    this.applyZoom(this.settings.zoom);
    this.updateIndicator();

    this.pinch = null;
    const target = document.body;

    this.registerDomEvent(
      target,
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          this.cancelAnim(); // a finger gesture takes over from any glide
          this.pinch = { startDist: this.dist(e.touches), startZoom: this.settings.zoom };
        }
      },
      { passive: true, capture: true }
    );

    this.registerDomEvent(
      target,
      'touchmove',
      (e) => {
        if (this.pinch && e.touches.length === 2) {
          e.preventDefault(); // stop the webview from panning while pinching
          const factor = this.dist(e.touches) / this.pinch.startDist;
          this.requestApply(this.pinch.startZoom * factor); // throttled to one apply/frame
        }
      },
      { passive: false, capture: true }
    );

    const end = (e) => {
      if (this.pinch && (!e.touches || e.touches.length < 2)) {
        this.pinch = null;
        this.flushApply();
        this.saveSettings();
      }
    };
    this.registerDomEvent(target, 'touchend', end, { passive: true, capture: true });
    this.registerDomEvent(target, 'touchcancel', end, { passive: true, capture: true });

    this.addCommand({ id: 'reset-zoom', name: 'Reset zoom to 100%', callback: () => this.animateTo(1.0) });
    this.addCommand({ id: 'zoom-in', name: 'Zoom in', callback: () => this.animateTo(this.settings.zoom + this.settings.step) });
    this.addCommand({ id: 'zoom-out', name: 'Zoom out', callback: () => this.animateTo(this.settings.zoom - this.settings.step) });

    this.register(() => {
      this.cancelAnim();
      if (this._raf != null) cancelAnimationFrame(this._raf);
    });

    this.addSettingTab(new MPZSettingTab(this.app, this));
  }

  dist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  clamp(z) {
    if (isNaN(z)) return 1.0;
    return Math.min(this.settings.maxZoom, Math.max(this.settings.minZoom, z));
  }

  // --- zoom application -----------------------------------------------------

  // Apply a value immediately (clamps, updates CSS var + indicator). No save.
  commit(z) {
    const c = this.clamp(z);
    this.settings.zoom = c;
    this.applyZoom(c);
    this.updateIndicator();
  }

  // Live pinch: coalesce many touchmove events into one apply per frame.
  requestApply(z) {
    this._pending = z;
    if (this._raf != null) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      if (this._pending != null) this.commit(this._pending);
    });
  }

  flushApply() {
    if (this._raf != null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this._pending != null) {
      this.commit(this._pending);
      this._pending = null;
    }
  }

  cancelAnim() {
    if (this._anim != null) {
      cancelAnimationFrame(this._anim);
      this._anim = null;
    }
  }

  // Eased glide to a target zoom (commands, indicator tap, reset).
  animateTo(target) {
    this.cancelAnim();
    const from = this.settings.zoom;
    const to = this.clamp(target);
    if (Math.abs(to - from) < 0.001) {
      this.commit(to);
      this.saveSettings();
      return;
    }
    const start = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const step = (now) => {
      const t = Math.min(1, (now - start) / ANIM_MS);
      this.commit(from + (to - from) * ease(t));
      if (t < 1) {
        this._anim = requestAnimationFrame(step);
      } else {
        this._anim = null;
        this.commit(to);
        this.saveSettings();
      }
    };
    this._anim = requestAnimationFrame(step);
  }

  applyZoom(z) {
    document.body.style.setProperty('--mpz-zoom', String(z));
  }

  // --- indicator ------------------------------------------------------------

  createIndicator() {
    const el = document.createElement('div');
    el.setAttribute('aria-label', 'Tap to reset zoom to 100%');
    this.indicatorEl = el;
    document.body.appendChild(el);
    this.registerDomEvent(el, 'click', () => this.animateTo(1.0));
    this.register(() => {
      if (this.indicatorEl) this.indicatorEl.remove();
    });
    this.positionIndicator();
  }

  positionIndicator() {
    if (!this.indicatorEl) return;
    const posClass = POSITION_CLASS[this.settings.indicatorPosition] || POSITION_CLASS['bottom-right'];
    this.indicatorEl.className = 'mpz-indicator ' + posClass;
    this.updateIndicator();
  }

  updateIndicator() {
    if (!this.indicatorEl) return;
    const pct = Math.round(this.settings.zoom * 100);
    this.indicatorEl.setText('🔍 ' + pct + '%');
    this.indicatorEl.toggleClass('mpz-hidden', !this.settings.showIndicator);
  }

  // --- styling --------------------------------------------------------------

  injectStyle() {
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'mpz-style';
    document.head.appendChild(this.styleEl);
    this.register(() => {
      if (this.styleEl) this.styleEl.remove();
    });
    this.refreshStyle();
  }

  refreshStyle() {
    if (!this.styleEl) return;
    const zoomRule =
      this.settings.mode === 'font'
        ? '.markdown-source-view.mod-cm6 .cm-content, .markdown-preview-view { font-size: calc(var(--font-text-size, 16px) * var(--mpz-zoom, 1)) !important; }'
        : '.view-content .markdown-preview-view, .view-content .markdown-source-view .cm-sizer { zoom: var(--mpz-zoom, 1); }';
    const indicatorCss = [
      '.mpz-indicator {',
      '  position: fixed; z-index: 25;',
      '  display: flex; align-items: center; justify-content: center;',
      '  min-width: 56px; min-height: 32px; padding: 6px 12px;',
      '  border-radius: 16px; box-sizing: border-box;',
      '  background: var(--background-secondary-alt, rgba(30,30,30,0.85));',
      '  color: var(--text-normal, #ffffff);',
      '  font-size: 13px; font-weight: 500; line-height: 1;',
      '  box-shadow: 0 1px 6px rgba(0,0,0,0.35); opacity: 0.85;',
      '  cursor: pointer; -webkit-user-select: none; user-select: none;',
      '  -webkit-tap-highlight-color: transparent;',
      '}',
      '.mpz-indicator:active { opacity: 1; transform: scale(0.96); }',
      '.mpz-pos-bottom-right { bottom: calc(env(safe-area-inset-bottom, 0px) + 64px); right: calc(env(safe-area-inset-right, 0px) + 12px); }',
      '.mpz-pos-bottom-left  { bottom: calc(env(safe-area-inset-bottom, 0px) + 64px); left:  calc(env(safe-area-inset-left, 0px) + 12px); }',
      '.mpz-pos-top-right    { top: calc(env(safe-area-inset-top, 0px) + 12px); right: calc(env(safe-area-inset-right, 0px) + 12px); }',
      '.mpz-pos-top-left     { top: calc(env(safe-area-inset-top, 0px) + 12px); left:  calc(env(safe-area-inset-left, 0px) + 12px); }',
      '.mpz-hidden { display: none !important; }',
    ].join('\n');
    this.styleEl.textContent = zoomRule + '\n' + indicatorCss;
  }

  // --- settings io ----------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class MPZSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Zoom mode')
      .setDesc(
        'content = scale everything (text + images), smoothest, best in Reading view. ' +
          'font = scale text only, solid in the editor.'
      )
      .addDropdown((d) =>
        d
          .addOption('content', 'Content (scale everything)')
          .addOption('font', 'Font size only')
          .setValue(this.plugin.settings.mode)
          .onChange(async (v) => {
            this.plugin.settings.mode = v;
            await this.plugin.saveSettings();
            this.plugin.refreshStyle();
          })
      );

    new Setting(containerEl)
      .setName('Zoom step (buttons/commands)')
      .setDesc('How much each Zoom in / Zoom out command changes the zoom (0.2 = 20%).')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.step)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.step = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Show zoom indicator')
      .setDesc('Floating 🔍 badge showing the current zoom; tap it to reset to 100%.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showIndicator).onChange(async (v) => {
          this.plugin.settings.showIndicator = v;
          await this.plugin.saveSettings();
          this.plugin.updateIndicator();
        })
      );

    new Setting(containerEl)
      .setName('Indicator position')
      .addDropdown((d) =>
        d
          .addOption('bottom-right', 'Bottom right')
          .addOption('bottom-left', 'Bottom left')
          .addOption('top-right', 'Top right')
          .addOption('top-left', 'Top left')
          .setValue(this.plugin.settings.indicatorPosition)
          .onChange(async (v) => {
            this.plugin.settings.indicatorPosition = v;
            await this.plugin.saveSettings();
            this.plugin.positionIndicator();
          })
      );

    new Setting(containerEl)
      .setName('Minimum zoom')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.minZoom)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.minZoom = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Maximum zoom')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxZoom)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxZoom = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Reset zoom')
      .setDesc('Set the zoom back to 100% now.')
      .addButton((b) => b.setButtonText('Reset to 100%').onClick(() => this.plugin.animateTo(1.0)));
  }
}

'use strict';

/*
 * Mobile Pinch Zoom — Obsidian plugin (mobile only) — v0.8.0
 * Pinch with two fingers to zoom the note in/out on iPad / iPhone / Android.
 * Desktop uses the separate "Ctrl+Scroll Zoom" plugin, so this no-ops on desktop.
 *
 * v0.2.0: floating 🔍 indicator (mobile has no status bar); tap to reset to 100%.
 * v0.3.0: smoother zooming —
 *   - pinch updates are throttled to one apply per animation frame (no thrash);
 *   - the Zoom in / Zoom out commands, the indicator tap, and Reset glide to the
 *     target with eased animation instead of jumping.
 * v0.5.0: zoom standalone PDF and image files.
 * v0.6.0: iPad polish —
 *   - zoom is anchored: pinch zooms toward the point between your fingers,
 *     commands zoom toward the viewport center (scroll is compensated);
 *   - trackpad pinch (ctrl+wheel, e.g. iPad Magic Keyboard) zooms too;
 *   - zoom snaps to 100% when a gesture ends within ±5% of it;
 *   - the indicator auto-fades after zooming (modes: auto / always / hidden);
 *   - Canvas and Excalidraw are left alone — they have their own pinch;
 *   - settings writes are debounced; deprecated activeLeaf API replaced.
 * v0.6.1: fixes —
 *   - PDF zoom no longer scales the PDF toolbar, only the pages below it;
 *   - the auto-fading indicator stays visible while zoom ≠ 100% (it is the
 *     only reset button on mobile) and fades only once back at 100%;
 *   - the indicator sits above more of the app chrome (z-index raised).
 * v0.7.0: "Font size only" mode scales figures too —
 *   - images, videos, Mermaid diagrams and Excalidraw embeds now zoom with
 *     the text (each grows up to the pane width, same as in content mode).
 * v0.8.0: figures grow past the pane edge —
 *   - images carry max-width: 100%, so a figure that already filled the pane
 *     could not get any bigger in either mode; now the cap scales with the
 *     zoom and the part outside the pane pans inside the embed (toggleable).
 */

const { Plugin, PluginSettingTab, Setting, Platform } = require('obsidian');

const DEFAULT_SETTINGS = {
  mode: 'content', // 'content' (CSS zoom) | 'font' (font-size)
  minZoom: 0.5,
  maxZoom: 4.0,
  step: 0.2, // amount per Zoom in / Zoom out command
  zoom: 1.0,
  indicatorMode: 'auto', // auto (fade after zooming) | always | hidden
  zoomFigures: true, // let images grow past the pane edge (pan to see the rest)
  indicatorPosition: 'bottom-right', // bottom-right | bottom-left | top-right | top-left
};

const POSITION_CLASS = {
  'bottom-right': 'mpz-pos-bottom-right',
  'bottom-left': 'mpz-pos-bottom-left',
  'top-right': 'mpz-pos-top-right',
  'top-left': 'mpz-pos-top-left',
};

const ANIM_MS = 180;
const SNAP_RANGE = 0.05; // gesture ending within ±5% of 100% snaps to 100%
const INDICATOR_FADE_MS = 1500;
const SAVE_DEBOUNCE_MS = 800;
const WHEEL_SESSION_GAP_MS = 300; // a pause longer than this starts a new anchored session

// Views that implement their own pinch zoom — never intercept touches inside them.
const EXCLUDE_SELECTOR = '.canvas-wrapper, .excalidraw, .excalidraw-wrapper';

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
    this._anchor = null;
    this._wheel = null;
    this._wheelTimer = null;
    this._saveTimer = null;
    this._fadeTimer = null;
    this._mediaRetryTimer = null;
    this._mediaZoomTargets = new Set();

    this.injectStyle();
    this.createIndicator();
    this.applyZoom(this.settings.zoom);
    this.updateIndicator();
    this.applyMediaZoom();
    // PDF / image files render in their own view; re-apply zoom when the active view changes.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.applyMediaZoom()));

    this.pinch = null;
    const target = document.body;

    this.registerDomEvent(
      target,
      'touchstart',
      (e) => {
        if (e.touches.length === 2) {
          if (this.isExcluded(e.target)) return;
          this.cancelAnim(); // a finger gesture takes over from any glide
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          this._anchor = this.beginAnchor(e.target, midY);
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
        this._anchor = null;
        this.settleZoom();
      }
    };
    this.registerDomEvent(target, 'touchend', end, { passive: true, capture: true });
    this.registerDomEvent(target, 'touchcancel', end, { passive: true, capture: true });

    // Trackpad pinch (e.g. iPad Magic Keyboard) arrives as a wheel event with ctrlKey set.
    this.registerDomEvent(
      target,
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        if (this.isExcluded(e.target)) return;
        e.preventDefault();
        this.cancelAnim();
        const now = performance.now();
        if (!this._wheel || now - this._wheel.last > WHEEL_SESSION_GAP_MS) {
          this._anchor = this.beginAnchor(e.target, e.clientY);
          this._wheel = { target: this.settings.zoom, last: now };
        }
        this._wheel.last = now;
        this._wheel.target = this.clamp(this._wheel.target * Math.exp(-e.deltaY / 100));
        this.requestApply(this._wheel.target);
        clearTimeout(this._wheelTimer);
        this._wheelTimer = setTimeout(() => {
          this._wheel = null;
          this._anchor = null;
          this.settleZoom();
        }, WHEEL_SESSION_GAP_MS + 50);
      },
      { passive: false, capture: true }
    );

    this.addCommand({ id: 'reset-zoom', name: 'Reset zoom to 100%', callback: () => this.animateTo(1.0) });
    this.addCommand({ id: 'zoom-in', name: 'Zoom in', callback: () => this.animateTo(this.settings.zoom + this.settings.step) });
    this.addCommand({ id: 'zoom-out', name: 'Zoom out', callback: () => this.animateTo(this.settings.zoom - this.settings.step) });

    this.register(() => {
      this.cancelAnim();
      if (this._raf != null) cancelAnimationFrame(this._raf);
      clearTimeout(this._wheelTimer);
      clearTimeout(this._fadeTimer);
      clearTimeout(this._mediaRetryTimer);
      for (const el of this._mediaZoomTargets) el.style.zoom = '';
      this._mediaZoomTargets.clear();
      if (this._saveTimer != null) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
        this.saveSettings();
      }
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

  isExcluded(target) {
    return !!(target instanceof Element && target.closest(EXCLUDE_SELECTOR));
  }

  // --- scroll anchoring -------------------------------------------------------

  // The scrollable note container at/under the gesture, or in the active view.
  findScroller(target) {
    if (target instanceof Element) {
      const hit = target.closest('.cm-scroller, .markdown-preview-view');
      if (hit) return hit;
    }
    const leaf = this.app.workspace.getMostRecentLeaf();
    const contentEl = leaf && leaf.view && leaf.view.contentEl;
    return contentEl ? contentEl.querySelector('.cm-scroller, .markdown-preview-view') : null;
  }

  // Remember where the gesture is so commits can keep that point stationary.
  beginAnchor(target, clientY) {
    const scroller = this.findScroller(target);
    if (!scroller) return null;
    return {
      scroller,
      offsetY: clientY - scroller.getBoundingClientRect().top,
      startZoom: this.settings.zoom,
      startScroll: scroller.scrollTop,
      // In content mode the preview zooms the scroller itself, so its scroll
      // coordinates live in the zoomed space; the editor zooms a child (.cm-sizer).
      zoomedScroller: this.settings.mode === 'content' && scroller.classList.contains('markdown-preview-view'),
    };
  }

  applyAnchor(anchor, z) {
    const { scroller, offsetY, startZoom, startScroll, zoomedScroller } = anchor;
    scroller.scrollTop = zoomedScroller
      ? startScroll + offsetY / startZoom - offsetY / z
      : (startScroll + offsetY) * (z / startZoom) - offsetY;
  }

  // --- zoom application -----------------------------------------------------

  // Apply a value immediately (clamps, updates CSS var + indicator). No save.
  commit(z) {
    const c = this.clamp(z);
    this.settings.zoom = c;
    this.applyZoom(c);
    if (this._anchor) this.applyAnchor(this._anchor, c);
    this.updateIndicator();
    this.applyMediaZoom();
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

  // Gesture finished: snap to 100% if close, then persist.
  settleZoom() {
    const z = this.settings.zoom;
    if (z !== 1 && Math.abs(z - 1) <= SNAP_RANGE) {
      this.animateTo(1.0);
    } else {
      this.scheduleSave();
    }
  }

  // Eased glide to a target zoom (commands, indicator tap, reset, snap).
  animateTo(target) {
    this.cancelAnim();
    const from = this.settings.zoom;
    const to = this.clamp(target);
    if (Math.abs(to - from) < 0.001) {
      this.commit(to);
      this.scheduleSave();
      return;
    }
    // Anchor commands/reset to the viewport center so the middle of the note stays put.
    const scroller = this.findScroller(null);
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      this._anchor = this.beginAnchor(scroller, rect.top + rect.height / 2);
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
        this._anchor = null;
        this.scheduleSave();
      }
    };
    this._anim = requestAnimationFrame(step);
  }

  applyZoom(z) {
    document.body.style.setProperty('--mpz-zoom', String(z));
  }

  // PDF / image files render in their own view that CSS selectors don't reliably
  // hit; grab the active view's content element directly and scale it.
  applyMediaZoom(attempt = 0) {
    // The gesture state (incl. _mediaZoomTargets) only exists on mobile, but
    // the settings tab's Reset button can reach this on desktop too.
    if (!Platform.isMobile) return;
    // Drop entries whose view has been closed so their DOM can be GC'd.
    for (const old of this._mediaZoomTargets) {
      if (!old.isConnected) this._mediaZoomTargets.delete(old);
    }
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf && leaf.view;
    if (!view || !view.contentEl || !view.getViewType) return;
    const type = view.getViewType();
    if (type !== 'pdf' && type !== 'image') return;
    let el = view.contentEl;
    if (type === 'pdf') {
      // Scale only the pages, not the PDF toolbar that sits above them.
      const inner = view.contentEl.querySelector('.pdf-content-container, .pdf-viewer-container');
      if (!inner) {
        // The PDF renders asynchronously; retry briefly after the view opens
        // rather than falling back to contentEl (that would scale the toolbar).
        if (attempt < 12) {
          clearTimeout(this._mediaRetryTimer);
          this._mediaRetryTimer = setTimeout(() => this.applyMediaZoom(attempt + 1), 250);
        }
        return;
      }
      el = inner;
      view.contentEl.style.zoom = ''; // clear styling left by versions ≤ 0.6.0
    }
    el.style.zoom = String(this.settings.zoom);
    this._mediaZoomTargets.add(el);
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
    const mode = this.settings.indicatorMode;
    this.indicatorEl.toggleClass('mpz-hidden', mode === 'hidden');
    this.indicatorEl.removeClass('mpz-faded');
    clearTimeout(this._fadeTimer);
    // Auto mode: the badge is the only reset button on mobile, so keep it
    // visible while zoomed; fade it out only once back at 100%.
    if (mode === 'auto' && pct === 100) {
      this._fadeTimer = setTimeout(() => {
        if (this.indicatorEl) this.indicatorEl.addClass('mpz-faded');
      }, INDICATOR_FADE_MS);
    }
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
    // Font mode scales only the text, which leaves figures at 100%; zoom the
    // embedded media by the same factor so images, videos, Mermaid diagrams
    // and Excalidraw embeds follow the text. CSS zoom respects max-width, so
    // a figure grows until it fills the pane and never overflows sideways.
    const fontMediaRule =
      ['img', 'video', '.mermaid', '.excalidraw-svg']
        .map((m) => '.markdown-preview-view ' + m + ', .markdown-source-view.mod-cm6 .cm-content ' + m)
        .join(', ') + ' { zoom: var(--mpz-zoom, 1); }';
    const zoomRule =
      this.settings.mode === 'font'
        ? '.markdown-source-view.mod-cm6 .cm-content, .markdown-preview-view { font-size: calc(var(--font-text-size, 16px) * var(--mpz-zoom, 1)) !important; }\n' +
          fontMediaRule
        : '.view-content .markdown-preview-view, .view-content .markdown-source-view .cm-sizer { zoom: var(--mpz-zoom, 1); }';
    // Figure breakout: images carry max-width: 100%, so a figure that already
    // fills the pane cannot get any bigger when the note zooms in. Raise the
    // cap by the zoom factor and pan the overflow inside the embed; at 100%
    // the cap equals the normal one, so the layout is unchanged.
    const figureRule = this.settings.zoomFigures
      ? '.view-content .markdown-preview-view .image-embed, .view-content .markdown-source-view .image-embed { display: inline-block; max-width: 100%; overflow-x: auto; }\n' +
        '.view-content .markdown-preview-view .image-embed img, .view-content .markdown-source-view .image-embed img { max-width: calc(100% * var(--mpz-zoom, 1)); }'
      : '';
    const indicatorCss = [
      '.mpz-indicator {',
      // Above app chrome (status bar 15, popovers 30) but below modals (50),
      // so the now-persistent badge never covers or steals taps from dialogs.
      '  position: fixed; z-index: 45;',
      '  display: flex; align-items: center; justify-content: center;',
      '  min-width: 56px; min-height: 32px; padding: 6px 12px;',
      '  border-radius: 16px; box-sizing: border-box;',
      '  background: var(--background-secondary-alt, rgba(30,30,30,0.85));',
      '  color: var(--text-normal, #ffffff);',
      '  font-size: 13px; font-weight: 500; line-height: 1;',
      '  box-shadow: 0 1px 6px rgba(0,0,0,0.35); opacity: 0.85;',
      '  cursor: pointer; -webkit-user-select: none; user-select: none;',
      '  -webkit-tap-highlight-color: transparent;',
      '  transition: opacity 0.25s ease;',
      '}',
      '.mpz-indicator:active { opacity: 1; transform: scale(0.96); }',
      '.mpz-faded { opacity: 0 !important; pointer-events: none; }',
      '.mpz-pos-bottom-right { bottom: calc(env(safe-area-inset-bottom, 0px) + 64px); right: calc(env(safe-area-inset-right, 0px) + 12px); }',
      '.mpz-pos-bottom-left  { bottom: calc(env(safe-area-inset-bottom, 0px) + 64px); left:  calc(env(safe-area-inset-left, 0px) + 12px); }',
      '.mpz-pos-top-right    { top: calc(env(safe-area-inset-top, 0px) + 12px); right: calc(env(safe-area-inset-right, 0px) + 12px); }',
      '.mpz-pos-top-left     { top: calc(env(safe-area-inset-top, 0px) + 12px); left:  calc(env(safe-area-inset-left, 0px) + 12px); }',
      '.mpz-hidden { display: none !important; }',
    ].join('\n');
    this.styleEl.textContent = zoomRule + '\n' + figureRule + '\n' + indicatorCss;
  }

  // --- settings io ----------------------------------------------------------

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // v0.5.0 had a showIndicator boolean; fold it into indicatorMode.
    if (!data.indicatorMode && data.showIndicator === false) this.settings.indicatorMode = 'hidden';
    delete this.settings.showIndicator;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveSettings();
    }, SAVE_DEBOUNCE_MS);
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
          'font = scale the text via font-size (figures zoom along with it), solid in the editor.'
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
      .setName('Let figures grow past the pane edge')
      .setDesc(
        'Images normally stop growing once they fill the pane; with this on they keep scaling with the zoom and the part outside the pane can be swiped sideways inside the figure. At 100% nothing changes.'
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.zoomFigures).onChange(async (v) => {
          this.plugin.settings.zoomFigures = v;
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
      .setName('Zoom indicator')
      .setDesc('Floating 🔍 badge showing the current zoom; tap it to reset to 100%. Auto = fades out shortly after zooming.')
      .addDropdown((d) =>
        d
          .addOption('auto', 'Auto (fade after zooming)')
          .addOption('always', 'Always visible')
          .addOption('hidden', 'Hidden')
          .setValue(this.plugin.settings.indicatorMode)
          .onChange(async (v) => {
            this.plugin.settings.indicatorMode = v;
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
          if (!isNaN(n) && n > 0 && n <= this.plugin.settings.maxZoom) {
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
          if (!isNaN(n) && n >= this.plugin.settings.minZoom) {
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

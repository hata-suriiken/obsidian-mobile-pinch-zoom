# Mobile Pinch Zoom

Pinch with two fingers to zoom your notes in and out on **Obsidian mobile (iPad / iPhone / Android)**.

Obsidian mobile has no built-in content zoom and no status bar, so this plugin adds:

- **Two-finger pinch** to zoom the note in/out (smooth, frame-throttled).
- Also zooms **standalone PDF and image files** opened in their own tab (works in either zoom mode).
- A floating **🔍 indicator** showing the current zoom; **tap it to reset to 100%**.
- Commands **Zoom in / Zoom out / Reset zoom** with eased animation (assignable to hotkeys).

> **Desktop companion:** on desktop use [Ctrl+Scroll Zoom](https://github.com/hata-suriiken/obsidian-ctrl-scroll-zoom). This plugin activates only on mobile and no-ops on desktop.

## Zoom modes (Settings)

- **Content** (default) — scales the whole note via CSS `zoom` (text + images + formulas). Smoothest, best in Reading view. In the editor the cursor may sit slightly off at non-100% zoom.
- **Font size only** — scales just the text via font-size. Solid in the editor, but images/diagrams don't scale.

## Settings

- Zoom mode, zoom step (for the commands), minimum/maximum zoom
- Indicator: show/hide, and position (any of the four corners)

## Installation

### Via BRAT (recommended for mobile)

Install the **BRAT** community plugin, then add `hata-suriiken/obsidian-mobile-pinch-zoom`.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/hata-suriiken/obsidian-mobile-pinch-zoom/releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/mobile-pinch-zoom/`.
3. Reload Obsidian, then enable **Mobile Pinch Zoom** under Settings → Community plugins.

## Notes

- Mobile only: `isDesktopOnly` is `false` so it loads on mobile, but the gesture logic activates only when `Platform.isMobile` is true.
- Content mode uses CSS `zoom`; the in-editor cursor position can be slightly off at non-100% zoom — switch to **Font size only** for heavy editing.

## License

[MIT](LICENSE) © 2026 hata-suriiken

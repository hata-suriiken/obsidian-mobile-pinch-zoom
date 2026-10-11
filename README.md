# Mobile Pinch Zoom

Pinch with two fingers to zoom your notes in and out on **Obsidian mobile (iPad / iPhone / Android)**.

Obsidian mobile has no built-in content zoom and no status bar, so this plugin adds:

- **Two-finger pinch** to zoom the note in/out (smooth, frame-throttled).
- **Anchored zoom** — the point between your fingers stays put while you pinch; commands zoom toward the viewport center.
- **Trackpad pinch** (ctrl+wheel, e.g. iPad Magic Keyboard) zooms too.
- **Snap to 100%** — ending a gesture within ±5% of 100% glides back to exactly 100%.
- Also zooms **standalone PDF and image files** opened in their own tab (works in either zoom mode); the PDF toolbar keeps its normal size.
- A floating **🔍 indicator** showing the current zoom; **tap it to reset to 100%**. By default it stays visible while zoomed and fades out shortly after returning to 100% (configurable: auto / always / hidden).
- Commands **Zoom in / Zoom out / Reset zoom** with eased animation (assignable to hotkeys).
- **Canvas and Excalidraw are left alone** — they have their own pinch zoom.

> **Desktop companion:** on desktop use [Ctrl+Scroll Zoom](https://github.com/hata-suriiken/obsidian-ctrl-scroll-zoom). This plugin activates only on mobile and no-ops on desktop.

## Zoom modes (Settings)

- **Content** (default) — scales the whole note via CSS `zoom` (text + images + formulas). Smoothest, best in Reading view. In the editor the cursor may sit slightly off at non-100% zoom.
- **Font size only** — scales the text via font-size; since v0.7.0 figures (images, videos, Mermaid diagrams, Excalidraw embeds) zoom along with it, each growing up to the pane width. Solid in the editor.

## Settings

- Zoom mode, zoom step (for the commands), minimum/maximum zoom
- Indicator: auto-fade / always / hidden, and position (any of the four corners)

## Installation

### Via BRAT (recommended for mobile)

Install the **BRAT** community plugin, then add `hata-suriiken/obsidian-mobile-pinch-zoom`.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/hata-suriiken/obsidian-mobile-pinch-zoom/releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/mobile-pinch-zoom/`.
3. Reload Obsidian, then enable **Mobile Pinch Zoom** under Settings → Community plugins.

## Notes

- Mobile only: `isDesktopOnly` is `false` so it loads on mobile, but the gesture logic activates only when `Platform.isMobile` is true.
- Content mode uses CSS `zoom`; the in-editor cursor position can be slightly off at non-100% zoom — switch to **Font size only** for heavy editing (figures still zoom there too).

## License

[MIT](LICENSE) © 2026 hata-suriiken

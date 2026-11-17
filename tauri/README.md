# Classifieds — Tauri v3 host

Runs the static bundle (`../public`, including the built `js/app.js`) as a Tauri 3.0.0-alpha.6 (Wry) app. The
Worker, `src/classifieds` and the existing static hosting are unchanged; this directory is a second host.

- `npm run build` copies `../public` to `dist/`, adds the pinned consent broker (`runtime.js`), the host
  adapter (`host.js`) and the descriptor, and writes a per-page CSP derived from the descriptor (inline
  styles by hash; `style-src-attr` only where a page has inline style attributes).
- The descriptor declares **no external operation**. The bundle itself makes no network request: listings
  are kept in `localStorage` (`cloud-itonami.app-classifieds.local-listings.v1`). The CSP is
  `connect-src 'self'`, and `host.js` rejects any cross-origin `fetch`; links leaving the app origin are not
  followed. The server read and proposal surfaces of the Worker are not wired into this host: declare each
  one in `src/descriptor.mjs` with `consent: "each-operation"` (fixed method and path) before using it.
- `vendor/` is a pinned copy of the canonical `kotoba-client-runtime.js` and consent CSS
  (`kotoba-lang/kotoba` `lib/kotoba.wasmWebcomponent/src`, revision in `vendor/PINS.json`); the build fails
  if a digest drifts.
- `npm test` runs the node tests. `cd src-tauri && cargo check --locked` needs `npm run build` first.

Verified in a real browser on the built `dist/`: the board renders (32 listings), no CSP violation, a
cross-origin `fetch` is rejected before it leaves the page.

Not done here: identity, moderation, payment/shipment/contract authority, signed release, store publication,
an installed-app run on a device, license resolution.

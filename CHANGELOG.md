# Changelog

Test releases for the Carlinkit Mini Ultra 6 (v553, base 202610121756C).
Video forwarding is unchanged since the first pass-through build (~8 fps measured).

## 0.2.0-test.2 (2026-11-03)

- Redesigned adapter page: Status / Settings / Update / Tools tabs, dropdowns and
  switches that save on change, confirmation sheets, hashes and timing under Details.
- Upload button hides after verification; shorter messages throughout.

## 0.2.0-test.1 (2026-11-03)

- New adapter page replacing the stock page: live rates, settings, presets with
  export/import, built-in firmware updater, debug ZIP, recovery.
- Update gateway with locking; installer runs at most once per boot.
- Release manifest and release ID in every image.
- Generic first-install bookmark and a compact fallback.

## 0.1.0-diagnostics.1 (2026-11-03)

- Frame-hook timing in the shim and a main-page debug ZIP for the 8 fps
  investigation. Stock auto log upload, online version check and telemetry
  switched off.

## Original pass-through test (2026-11-02)

- First LD_PRELOAD pass-through shim, `/cpthru.html` status and audio delay page.

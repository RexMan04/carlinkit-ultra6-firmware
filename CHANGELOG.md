# Changelog

Test releases for the Carlinkit Mini Ultra 6 (v553, base 202610121756C).
Video forwarding has not changed since the first pass-through build, and the
owner's car still measures about 8 fps during motion. No release so far
claims a speed fix.

## 0.2.0-test.1 (2026-11-03)

- New main page at `http://192.168.50.100` replaces the stock page: live
  input/output frame rates, bitrate, mode, fallbacks, settings, presets,
  firmware update, debug ZIP, recovery and device info in one place.
- Built-in firmware updater: choose an SWU in Files, phone-side validation and
  identification, upload with progress, adapter MD5 check, separate
  **Install firmware** button, restart watcher that reports the running
  release. Later project releases install without a new bookmark.
- Settings on the main page, each checked against the stock CGI and its
  property: pass-through, audio delay (300 to 1000 ms or phone decides),
  audio stream mode, hotspot channel, startup delay, car GPS, force display.
  No frame-rate or bitrate controls, since none work in this firmware.
- Presets saved on the phone, plus settings export and import (validated,
  shown before applying).
- Recovery: switch back to stock video processing, reset project settings,
  stock factory reset (gated), and stock rollback through the same updater
  (not yet tested on an adapter).
- Server side: the stock upload, install and factory-reset CGIs sit behind
  locking gateways; the installer runs at most once per boot, after the staged
  copy is re-checked.
- Each image carries a release manifest (`cpthru-release.json` plus a copy in
  the rootfs padding) with a release ID that changes whenever any shipped file
  changes.
- Removed from the page: the stock language menu, vendor online update,
  vendor feedback form and activation screen. Stock rollback restores them.
- Generic first-install bookmark built from the same updater code, plus a
  compact exact-image fallback.

## 0.1.0-diagnostics.1 (2026-11-03)

- Frame-hook timing in the shim and a main-page debug ZIP for the 8 fps
  investigation. Stock auto log upload, online version check and telemetry
  switched off.

## Original pass-through test (2026-11-02)

- First LD_PRELOAD pass-through shim, `/cpthru.html` status and audio delay page.

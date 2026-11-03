# Carlinkit Mini Ultra 6 firmware research

An experimental CarPlay pass-through modification for the Allwinner v553
Mini Ultra 6, developed through firmware analysis, AI-assisted engineering,
independent code review, and physical-device testing.

The aim is to forward the iPhone's compressed video to the car while keeping
the stock transcoder available for AirPlay and fallback.

## Current result

As of November 3, 2026, the custom image is installed on one adapter. Its
status page reports active pass-through and no fallbacks. Live input/output
remain around 8 fps during movement, so the performance goal is **not yet
achieved**. This is an investigation, not a stable release or a demonstrated
60 fps upgrade.

## Diagnostic test build (`passthru_diag`)

This is a **test build for measurements, not a performance fix**. It keeps the
same pass-through forwarding and adds:

- frame-hook timing in the shim (callback time, time between frames, idle
  gaps, lock waits, car-send time, sends over 16/33/100 ms) using the
  firmware's 1 ms clock, kept as the last 24 five-second windows (~2 min);
- the last display mode the shim returned from `sd_get_info_int` (what the
  adapter asked for, not proof of what the phone was told);
- a **Diagnostics & debug ZIP** section on the adapter's main page
  (`http://192.168.50.100`) and on `/cpthru.html`, plus a read-only snapshot
  CGI (version, storage, saved log setting, CPU and sdDongle threads over 1 s).

Base: Carlinkit Mini Ultra 6, Allwinner v553, stock `v5_202610121756`
(`platform=v553`, `custom=yunlianAm`, version `202610121756C`). Do not assume
compatibility with any other model or firmware. The image, its build ID and
SHA256/MD5 are published in the release notes with
`v5_202610121756_passthru_diag.json`.

In this test build the stock main page's **automatic log upload, online
version check and periodic usage reporting to the vendor are switched off**.
Other stock settings keep working. The stock feedback form still sends its
typed text to the vendor if you press its Submit button, but no logs are
attached.

### Collect a debug ZIP

1. Park the car. Show a moving map or scroll a list on the car screen for
   about 30 seconds.
2. On the iPhone, join the adapter's Wi-Fi, open `http://192.168.50.100` in
   Safari, and tap **Prepare debug ZIP**. Use one phone and one tab only.
3. When it says Ready, tap **Download debug ZIP** and save it in Files.

The ZIP holds the adapter's own log ZIP byte for byte plus `status.json`,
`system.txt`, `manifest.json` and a README. If the adapter's log export fails
(low space, timeout, bad ZIP), you get a clearly labelled diagnostics-only
ZIP instead. If the page warns that log saving is off
(`persist.console.log.nosave=1`), the stock logs will not include this boot.
The logs are **unredacted** and may contain device or phone identifiers;
nothing is uploaded, so share the file deliberately.

### Install

Follow the [phone installation steps](phone-upload-diag/README.md). The
diagnostic helper accepts only this exact test image and the stock rollback
image. Upload verification and the explicit flash request are separate steps.
Upload verification does not prove installation compatibility.

Later milestones, not in this build: a full settings page redesign and an
integrated local updater/flash flow.

## Source map

- `shim/`: ARM interposition shim, host tests, ABI checks and QEMU checks.
- `web/`: adapter settings/status interface and allowlisted local CGIs.
- `build_fw.py`: rebuilds and verifies a firmware derived from the exact stock
  image, preserving kernel/recovery payload bytes.
- `phone-upload/`: original reviewed upload-only Safari bookmarklet;
  `build.mjs --spec spec-diag.json` generates the diagnostic-image helper in
  `phone-upload-diag/` without touching the original files.
- `tests/`: namespace-isolated QEMU tests (stock log exporter and new CGIs on
  the device busybox) and browser tests of the diagnostics panel.
- `phone-debug/`: temporary download-only log bookmarklet.
- Development notes will document verified behavior and remaining questions.

Vendor firmware, private log bundles, live screenshots and analysis databases
are kept out of Git source history. See [Releases](https://github.com/RexMan04/carlinkit-ultra6-firmware/releases)
for test images, the phone helper and exact hashes. Compatibility is limited
to the model and base firmware listed above.

## Development checks

The current workstation uses the paths configured in the Makefile and scripts.
Firmware input lives outside the repository under `~/models/staging/`.

```sh
make -C shim test
make -C shim arm
make -C shim qemu-test
python3 -I tests/ns_test.py
bun tests/status_poll.mjs
bun tests/diag_browser.mjs --fixture ~/models/staging/carlinkit-ultra6-fw/review/diag-tests/stock-logs-fixture.zip
python3 build_fw.py passthru_diag
bun phone-upload/build.mjs --spec phone-upload/spec-diag.json
bun phone-upload/test.mjs --dir phone-upload-diag
```

QEMU proves loading and hook binding, not real-time performance on the adapter.
`build_fw.py passthru` is retired so it can never overwrite the delivered
pass-through image.
Browser tests use loopback-only receivers and never flash a device.

## Research process

Kaden owns the hardware, set the objectives, chose the implementation path,
and performs physical-device tests. AI tools assist with decompilation,
source development and review. Findings distinguish static evidence, local
tests, and observations on the real device. Commit history records completed
work at its actual completion time.

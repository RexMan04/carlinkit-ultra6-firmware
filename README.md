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

The next build is planned to include a replacement main settings page,
downloadable diagnostic bundles, timing instrumentation, and local firmware
upload, verification, and an explicit flash button on the same page.

## Source map

- `shim/`: ARM interposition shim, host tests, ABI checks and QEMU checks.
- `web/`: adapter settings/status interface and allowlisted local CGIs.
- `build_fw.py`: rebuilds and verifies a firmware derived from the exact stock
  image, preserving kernel/recovery payload bytes.
- `phone-upload/`: original reviewed upload-only Safari bookmarklet.
- `phone-debug/`: temporary download-only log bookmarklet.
- Development notes will document verified behavior and remaining questions.

Vendor firmware, private log bundles, live screenshots and analysis databases
are kept separately. No installable GitHub release has been published. Public installation
instructions and release files will follow validated builds; do not infer
compatibility with other Carlinkit models.

## Development checks

The current workstation uses the paths configured in the Makefile and scripts.
Firmware input lives outside the repository under `~/models/staging/`.

```sh
make -C shim test
make -C shim arm
make -C shim qemu-test
bun phone-debug/build.mjs
bun phone-debug/test.mjs
```

QEMU proves loading and hook binding, not real-time performance on the adapter.
Browser tests use loopback-only receivers and never flash a device.

## Research process

Kaden owns the hardware, set the objectives, chose the implementation path,
and performs physical-device tests. AI tools assist with decompilation,
source development and review. Findings distinguish static evidence, local
tests, and observations on the real device. Commit history records completed
work at its actual completion time.

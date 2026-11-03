# Install the diagnostic test from an iPhone

For the Allwinner v553 Carlinkit Mini Ultra 6 on base firmware 202610121756C, custom yunlianAm. This build measures the unresolved ~8 fps issue.

1. From [the test release](https://github.com/RexMan04/carlinkit-ultra6-firmware/releases/tag/v0.1.0-diagnostics.1), save `v5_202610121756_passthru_diag.swu` to Files. Copy the entire contents of its `bookmarklet.txt`.
2. In Safari, edit your existing upload bookmark and replace its URL with that text, including `javascript:`. For a first install, bookmark any page, then edit that bookmark's URL. Safari requires this one manual edit.
3. Connect the iPhone to the adapter and open `http://192.168.50.100`. Run the bookmark, choose the downloaded SWU, then tap **Upload and verify**. It should identify the file as **Diagnostic test**. Wait for successful final verification; keep the adapter powered and this upload staged.
4. Only after verification succeeds, open this address **once** in Safari:

```text
http://192.168.50.100/cgi-bin/submition.cgi?filename=v5_202610121756_passthru_diag.swu&
```

Keep the adapter powered while it installs and reboots. Keep Safari in the foreground during submission; do not cancel or repeat the flash request. After the adapter reconnects, reopen its main page. The new shim build is `1b93a4b1163f`, and the main page includes **Diagnostics & debug ZIP**.

While parked, move a map or scroll a list on the car display for about 30 seconds. On the main page tap **Prepare debug ZIP**, then **Download debug ZIP** and save it to Files. Share that ZIP for debugging. A diagnostics-only ZIP is still useful if stock-log collection failed.

The helper also accepts the exact stock rollback bytes listed in `images.json`. The rollback image has its own staged filename, `v5_202610121756_STOCK_rollback.swu`; the diagnostic flash address above applies only to the verified diagnostic image. Rollback has not been physically tested on this adapter.

The helper checks size, SHA256 and MD5 before upload, transfers sequential 10 KiB chunks, and checks the adapter's final MD5 result. It never starts flashing itself. Do not retry a failed chunk or submit a flash after a failed or uncertain upload.

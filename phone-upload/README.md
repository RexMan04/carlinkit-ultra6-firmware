# Upload the firmware from an iPhone

This is a Safari bookmarklet, not a normal web link. It adds a local file
picker to the stock adapter page. It uploads and verifies only; it contains
no flash request. Nothing needs to be installed on the adapter beforehand.

1. Copy all of `bookmarklet.txt`, including `javascript:`.
2. In Safari, save any page as a bookmark named **Carlinkit upload**. Open
   Bookmarks, touch and hold that bookmark, choose Edit, and replace its URL
   with the copied text. Save. Use a bookmark, not Add to Home Screen.
3. Keep the firmware downloaded locally in Files, not only as an iCloud
   placeholder. Temporarily turn off Low Power Mode and set Settings >
   Display & Brightness > Auto-Lock to Never. Restore these when finished.
4. Connect to the adapter's VehiConn Wi-Fi. Open `http://192.168.50.100` in
   Safari and let the page load. Do not press its stock Upgrade button. If
   a stock update is already underway, wait for it to finish first.
5. While on that page, open Bookmarks and tap **Carlinkit upload**. At the
   top of the page, tap **Choose File**, then select the pass-through `.swu`.
6. Tap **Upload and verify**. Keep Safari in front and the phone unlocked.
   The file is sent as 2,694 small requests; the physical device may take
   several minutes. Do not use another tab/client to upload concurrently.
7. Stop at **Uploaded and verified ... NOT flashed**. Keep the adapter
   powered and this tab open, and report the result for the next step.

If the helper reports an error after upload starts, the staged file must not
be flashed. It never retries a chunk, because a lost response might follow a
successful append. A fresh attempt requires reloading and re-running the
bookmark, which starts from the beginning and invalidates prior successes.
Rebooting the adapter, or anything that restarts its swupdate service
(`S60swupdate`), clears the staged upload. Keep it powered until the deliberate
flash step.

It accepts only these exact files, even if Files has renamed them:
- Pass-through MD5: `3bbb773174a282a623860ecbb319b2ae`.
- Stock rollback MD5: `8cda8cf273d665c80b2a4b217b9bdf44`.

Both are 27,578,368 bytes. SHA256 is also verified before any upload.
`images.json` records the exact build and matching emailed source copies.
Only the pass-through image enables the modifications; the rollback image
restores the original firmware when a later flash is deliberately performed.

Upload verification does not prove installation compatibility or absence of
signature checks in subsequent recovery/install stages. The normal update
sequence rewrites recovery, kernel and rootfs. This helper does not start it.

Developer checks: `bun phone-upload/build.mjs` and
`bun phone-upload/test.mjs`, from the project root. The test loads the exact
stock page and CryptoJS, suppresses stock onload operations, and uses a
loopback-only HTTP proxy with no forwarding. It checks actual multipart bytes
using the decompiled CGI's byte arithmetic. WebKit's inspector alone omits
Blob payloads, so intercepted request metadata is insufficient for that check.
The iPhone bookmark editor and the physical adapter still require live use.

Apple bookmark instructions:
https://support.apple.com/en-au/guide/iphone/iph42ab2f3a7/ios

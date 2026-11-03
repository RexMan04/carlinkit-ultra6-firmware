# Install or update from an iPhone

For the Carlinkit Mini Ultra 6 (Allwinner v553) on base firmware
202610121756C, custom yunlianAm. Keep the car on (or the adapter powered) and
the iPhone joined to the adapter's Wi-Fi the whole time.

## Already on 0.2 or later: no bookmark

1. Download the new `.swu` from the
   [releases page](https://github.com/RexMan04/carlinkit-ultra6-firmware/releases) into Files
   (On My iPhone, not just an iCloud placeholder).
2. Open `http://192.168.50.100` in Safari. Scroll to **Firmware update**.
3. Choose the file. The page checks it on the phone and shows what it is
   (release, release ID, SHA-256). Tap **Upload and verify** and wait for
   **Uploaded and verified**. That only copies and checks the file.
4. Tap **Install firmware**, then tap again to confirm. Keep power on and
   Safari open. The adapter restarts, usually more than once. The page waits
   for it and then says which release it is running.

## First install (adapter on stock, the original pass-through, or diagnostics.1)

Those versions have no built-in updater, so Safari needs a bookmark once.

1. Copy the whole `bookmarklet.txt` from the release, including `javascript:`.
   It is long (about 29,000 characters); copy all of it.
2. In Safari, bookmark any page, then open Bookmarks, touch and hold it, tap
   **Edit**, and replace its address with the copied text. Safari only allows
   this by hand; no website can add it for you.
3. Join the adapter's Wi-Fi and open `http://192.168.50.100`. Let it load.
4. Open Bookmarks and tap the bookmark. A **Firmware update** box appears at
   the top. Choose the `.swu`, tap **Upload and verify**, then
   **Install firmware** (twice) as above.
5. After the restart, `http://192.168.50.100` is the new main page. From then
   on, updates use the page itself; the bookmark is not needed again.

If Safari will not keep the long bookmark, use `bookmarklet-compact.txt`
instead (about 6,500 characters). It only uploads and checks the exact
0.2.0-test.1 image or the stock image, and it never installs by itself. After
it says **Uploaded and verified**, open the ONE address that matches the file
it named, once:

- Release 0.2.0-test.1 (it says `cpthru.swu`):
  `http://192.168.50.100/cgi-bin/submition.cgi?filename=cpthru.swu&`
- Stock rollback (it says `v5_202610121756_STOCK_rollback.swu`):
  `http://192.168.50.100/cgi-bin/submition.cgi?filename=v5_202610121756_STOCK_rollback.swu&`

Opening the other address does nothing useful: the adapter only holds the
file you just uploaded.

## What the checks mean, and what they don't

- The phone checks the archive structure, every part's checksum and MD5, that
  the recovery, kernel and update script are byte-identical to stock
  202610121756C (so the image is for this model and base), and what the
  image is: stock firmware, a known older test build, or a project release
  identified by its embedded release file.
- The adapter checks the uploaded copy's MD5. On 0.2 and later it checks it
  again, under a lock, right before installing, and starts the installer at
  most once per boot. Uploads, settings and factory reset are refused once an
  install has started.
- None of this is a signature. It proves the file is intact and built on the
  right base, not who made it.
- Installing rewrites the recovery, kernel and system partitions. There is no
  known recovery mode if that fails, and going back to stock has not been
  tested on an adapter yet.

Never retry a failed upload chunk by hand or install after a failed or
uncertain upload; the page's **Upload again** starts over cleanly.

# Phone install

Car on, iPhone on the adapter's Wi-Fi, Safari.

## Update (adapter on 0.2 or later)

1. Save the `.swu` from Releases to Files.
2. Open `http://192.168.50.100` → **Update** → **Choose file** → **Upload** → **Install**.

## First install (stock, original pass-through, or diagnostics.1)

1. Save the `.swu` to Files.
2. Copy all of `bookmarklet.txt`. In Safari, bookmark any page, edit the bookmark, and paste it as the address.
3. Open `http://192.168.50.100`, tap the bookmark, then **Choose file** → **Upload** → **Install**.

If Safari won't keep the long bookmark, use `bookmarklet-compact.txt`. It only uploads.
Then open the matching address once:

- Project build: `http://192.168.50.100/cgi-bin/submition.cgi?filename=cpthru.swu&`
- Stock: `http://192.168.50.100/cgi-bin/submition.cgi?filename=v5_202610121756_STOCK_rollback.swu&`

# LG Store helpers

Files in this folder come from https://github.com/lennylxx/lg-ipk-download (Apache License 2.0,
see `LICENSE-lg-ipk-download.txt`):

- `download-ipk.js`, `ro-exchange.js`: unmodified. The app pushes them to the TV over SSH and runs
  them with the TV's own Node.js.

## Optional: `ncg_native.node`

Some store apps ship their files encrypted (NCG). Decrypting them needs a one-time key request,
which uses a small ARM addon that is **not in this repository** (the original project builds it
with Docker, `ncg/build.sh`, and ships it in its npm package).

To enable the "Fetch the decryption key" option, copy the prebuilt addon here as
`src/assets/lg-store/ncg_native.node` before building, for example from the npm package:

    npm pack lg-ipk && tar -xzf lg-ipk-*.tgz package/ncg/dist/ncg_native.node
    cp package/ncg/dist/ncg_native.node src/assets/lg-store/

Without it, unprotected apps install normally and protected ones report that the addon is missing.

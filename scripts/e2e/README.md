# End-to-end checks

Three small tools to check a bake against a real Minecraft server.

| Script | What it checks |
| --- | --- |
| `mcping.py` | The server itself: status ping and an offline-mode login, either directly or through the `/ws` bridge |
| `gpucheck.mjs` | That headless Chrome gives a worker a working WebGPU device on an OffscreenCanvas (no game involved) |
| `join.mjs` | The real client: boots `mc.wasm` in headless Chrome and joins the server with `--quickPlayMultiplayer` |

## Setup

```sh
cd scripts/e2e && npm install
# srv/server.mjs must be serving web/ with the baked web/game/mc.wasm, e.g.
BC_DEV=1 MC_ALLOW_PRIVATE=1 BC_ROOT=$PWD/../../web BC_DATA=$PWD/../../data PORT=8090 node ../../srv/server.mjs
```

`MC_ALLOW_PRIVATE=1` is only needed when the Minecraft server is on a private address.
The server must run the same version as the client (26.3), with `online-mode=false`.

## Run

```sh
python3 mcping.py 10.0.0.5 25565                               # direct
python3 mcping.py --ws ws://localhost:8090/ws 10.0.0.5 25565   # through the bridge
npm run gpucheck                                                # expect "OK ... device alive"
MC_SERVER=10.0.0.5:25565 node join.mjs                          # expect "PASS"
```

`join.mjs` takes `BC_ORIGIN` (default `http://localhost:8090`), `MC_SERVER`, `MC_NAME`, `SECS`
(default 240), `OUT` (log and screenshot, default `./e2e-out`) and `CHROME`. It passes when the
client connects and keeps presenting frames afterwards; the server log should also show
`<name> joined the game`.

## Things that look like game bugs but are not

- **WebGPU device lost on the first frame.** Headless Chrome on Linux falls back to SwiftShader
  unless it gets `--use-angle=vulkan`, and SwiftShader's WebGPU device is destroyed on the first
  OffscreenCanvas present. `gpucheck.mjs` reproduces this without the game. The game log says
  `Using graphics device: google` in that case.
- **Stuck on the title screen.** A fresh browser profile is a first launch: the accessibility
  onboarding screen holds back `--quickPlayMultiplayer`. `join.mjs` writes an `options.txt` that skips it.
- **Blank page screenshots.** The canvas belongs to a worker. Use the game's own screenshot (F2), which
  `join.mjs` saves to `OUT`.

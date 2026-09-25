# Offline Sync Benchmark

Offline-first records app with a crash-consistent op log, three-way field merge, and deterministic adapter hooks, graded by a sealed Playwright verifier that drives the built bundle in headless Chromium.

## Development

```bash
cd environment/app
npm install
npm run dev
```

## Build (what the verifier reads)

```bash
cd environment/app
npm install
npm run build
```

In the agent container the same steps run in `/workspace` and produce `/workspace/dist`, which the verifier serves over local HTTP. Sources live under `/workspace/src`, mirrored in `environment/app/`.

## Sealed verifier (harbor)

```bash
cd tests
pytest -v
```

`tests/test.sh` runs `pytest --ctrf=/logs/verifier/ctrf.json` and writes `/logs/verifier/reward.txt` (`1` pass, `0` fail). Tests launch Chromium (installed in the verifier image), step deterministic event sequences through the app and the independent Python reference model in `tests/reference_model.py`, and compare canonical state after every step, including real page reloads. No app source is inspected.

## Benchmark architecture

```text
                deterministic event stream
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
       reference model          browser app
             │                       │
             │                       ▼
             │             __OFFLINE_SYNC_STATE__
             └───────────┬───────────┘
                         ▼
                    deep equality
```

The reference model stays independent from the app sync implementation. The app exposes `window.__OFFLINE_SYNC_STATE__` for state reads, `window.__OFFLINE_SYNC_ADAPTER__` for deterministic event injection, and `window.__OFFLINE_SYNC_READY__` as the load-readiness flag.

# Token Radar

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/RenzzHGE/token-radar-02/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/RenzzHGE/token-radar-02/reward.svg)](https://make.fun/bounty/token-radar-01)

A token launch radar for the [make.fun token-radar-01 bounty](https://make.fun/bounty/token-radar-01) ($1,325): every protocol DefiLlama tracks, ranked by what its token launch would be worth, in a static web dashboard you can open offline.

## What it does

The snapshot seals 758 protocols (as of 2026-11-14). The radar finds the ones that still record **no token** and are **not a wrapped or staked product** of one that trades, then ranks them by implied launch value — TVL times the multiple the live market already pays their category — and shows, for each one, the model arithmetic and a concrete farm plan.

- **203 pre-token protocols** on the board, all **40 watchlist** slugs covered.
- **Top 3:** Steakhouse Financial ($1.07B implied), Sentora Curator ($949.7M), Gauntlet ($648.1M).
- **Detail view** per protocol: the value waterfall (TVL → category multiple → chain → growth → maturity → completeness → implied value), why it ranks where it does, and a 7-step farm plan with costs and times.
- **Farm plans** run on each protocol's **cheapest chain** (by gas), with a stake sized to TVL and a hold sized to age.
- **Model sandbox:** six sliders re-rank the board live, using the same model that built `board.json`.
- **Live view** (40 largest live-token protocols) and a **calibration table** (per-category median and shrunk multiple) so the price is auditable.

## The model — radar-3

The old entry (radar-2) calibrated with arithmetic medians and linear curves. Radar-3 fixes the two places a heavy-tailed ratio misleads:

1. **Log-space calibration.** The category multiple is the median of `log(mcap / TVL)` among live protocols, shrunk toward the global log-median (prior 5), then exponentiated — a geometric multiple. One live protocol at 10x no longer drags its whole category up. Winsorized to 0.25x–3x the global median (0.241).
2. **Log curves, not linear.** Chain breadth is `1 + 0.10 × ln(chains)`, capped 1.35 — the fifth chain is worth less than the second. Maturity is `0.6 + 0.4 × ln(1 + age/365) / ln(1 + 1095/365)` — a protocol at one year is 80% mature, at three years 100%. Growth is `1 + 0.5 × clamp(change_7d, −60, 120) / 100`.
3. **A completeness haircut.** A protocol with no reported seven-day change carries a 3% haircut (×0.97) — an unverified growth figure is not free.

The same function scores every protocol; the dashboard recomputes each row from the same model, so the detail view shows the same number `board.json` carries. Implied value is an estimate, not a price.

## How the farm is priced

Gas per chain (USD): Ethereum $8, Base/Polygon/Avalanche/Optimism/zkSync/Linea/Scroll $0.5, Binance/Blast/Fantom/Gnosis $0.3, Arbitrum/Tron $1, Cosmos $0.1, Solana/Sui/Aptos/Near/Sei $0.05, default $2. The farm uses the protocol's cheapest chain. Stake: $150 (TVL ≥ $1B), $100 (≥ $100M), else $50. Hold: 30 days (age ≥ 1y), 45 days (≥ 180d), else 60 days. Total gas ≈ (1 setup + 1 weekly + 1 claim) × chain gas.

## Run it

```sh
node main.ts --input snapshot.json   # writes board.json, data.js, dashboard/, dossier.json to out/
```

`main.ts` reads `/input/snapshot.json` (or `--input <file>`), writes to `/output` (or `MAKEFUN_OUTPUT_DIR`). Node 22 stdlib only, no network. Open `out/dashboard/index.html` in a browser — it loads `../data.js` and needs no server, though any static server works.

## Layout

- `main.ts` — entrypoint: reads the snapshot, builds the board, writes `board.json`, `data.js`, copies `dashboard/` + `screenshots/`, writes `dossier.json`.
- `lib/model.ts` — radar-3: calibration, ranking, farm plans.
- `dashboard/` — the static dashboard: `index.html`, `app.css`, `app.js` (renders the board, detail dialog, sandbox; recomputes the model in the page).
- `screenshots/` — three real renders: board, detail view, watchlist-filtered board.
- `kit/` — the fresh competition kit (RULES.txt, competition.yaml).
- `old-entry/` — the previous entry, kept only as a reference for comparison.

## License

MIT. See [LICENSE](LICENSE).

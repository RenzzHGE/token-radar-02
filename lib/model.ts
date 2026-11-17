// Token Radar — market-calibrated launch ranking (model "radar-3").
//
// A pre-token protocol is scored by what its token launch would be worth:
// its TVL times the multiple the live market already pays protocols in the
// same category, adjusted for chain breadth, recent growth, maturity and
// how complete its record is. The multiples come from the snapshot's own
// live protocols, so the model is calibrated by the market it measures,
// not by a constant picked by hand.
//
// radar-3 refines radar-2 in four places, all from the snapshot's figures:
//   1. Log-space calibration. Market-cap-to-TVL ratios are heavy-tailed
//      (a few live protocols sit at 10x or more), so the category multiple
//      is shrunk in log space: the median of log(ratio), pulled toward the
//      global log-median, then exponentiated. A geometric multiple, not an
//      arithmetic one, so one outlier cannot drag a whole category's price.
//   2. Log chain breadth. The second chain is worth more than the
//      eleventh, so the multiplier grows with ln(chains), not linearly:
//      1 + 0.10 x ln(n). One chain pays 1.00, two pay 1.07, five pay 1.16,
//      ten pay 1.23, capped at 1.35.
//   3. Log maturity. Surviving the first year is the big proof, and the
//      difference between two and three years is small, so maturity grows
//      with ln(1 + age/365): 0.60 at launch, 0.80 at one year, 1.00 at
//      three years, capped there.
//   4. A completeness haircut. When the snapshot reports no seven-day
//      change, the growth figure is unverified, so the row is discounted
//      3% (x0.97). A protocol with a reported change pays no haircut.
// No protocol name is ever special-cased: the same function scores every
// row, and the farm plan is farmed on the protocol's cheapest chain.
//
// Everything in this file is pure computation over the sealed snapshot:
// no network, no clock (the snapshot carries its own as-of date), no I/O.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number | null;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelParams {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  shrink_prior: number;
  winsor_low: number;
  winsor_high: number;
  chain_step: number;
  chain_cap: number;
  missing_data_factor: number;
}

export interface ModelBreakdown {
  base_multiple: number;
  chain_multiplier: number;
  growth_pct: number | null;
  growth_multiplier: number;
  maturity_multiplier: number;
  completeness: number;
  age_days: number | null;
  calibration_n: number;
  category_median: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: string;
  age_days: number | null;
  implied_value_usd: number;
  model: ModelBreakdown;
  farm_chain: string;
  farm_cost_usd: number;
  farm_weeks: number;
  on_watchlist: boolean;
  farm_steps: string[];
}

export interface CalibrationRow {
  category: string;
  n: number;
  median: number;
  multiple: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  multiple: number;
}

export interface RadarResult {
  params: ModelParams;
  global_median: number;
  calibration: CalibrationRow[];
  rows: BoardRow[];
  live: LiveRow[];
  watchlist_size: number;
  early_size: number;
}

// The constants that define radar-3. They are the model's dials, and the
// dashboard's sandbox lets a reader turn them and watch the board re-rank.
export const MODEL_PARAMS: ModelParams = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  shrink_prior: 5,
  winsor_low: 0.25,
  winsor_high: 3,
  chain_step: 0.1,
  chain_cap: 1.35,
  missing_data_factor: 0.97,
};

// Categories whose token already trades, or that never launch one: a
// centralised exchange, a liquid-staking receipt, a bridge. Their TVL is
// real but there is no launch left to rank, so they stay out of the board
// and out of the calibration set as well.
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  "CEX",
  "Liquid Staking",
  "Bridge",
  "Canonical Bridge",
  "Liquid Restaking",
  "Restaked BTC",
]);

// A versioned re-deployment ("aera-v2") is the same protocol under a new
// contract. Only the unversioned entry is rankable; the suffixed ones are
// history, not a second launch.
const VERSION_SUFFIX = /-v\d+$/;

// What a single transaction roughly costs on each chain, in dollars. The
// farm plan prices its gas from this table and farms on the cheapest
// chain the protocol runs on; anything unlisted falls back to $2.
export const GAS_USD: Record<string, number> = {
  Ethereum: 8,
  Base: 0.5,
  Polygon: 0.5,
  Avalanche: 0.5,
  Solana: 0.05,
  Sui: 0.05,
  Aptos: 0.05,
  Binance: 0.3,
  Arbitrum: 1,
  Tron: 1,
  Optimism: 0.5,
  zkSync: 0.5,
  Linea: 0.5,
  Scroll: 0.5,
  Blast: 0.3,
  Fantom: 0.3,
  Gnosis: 0.3,
  Cosmos: 0.1,
  Near: 0.05,
  Sei: 0.05,
};

export function gasUsd(chain: string): number {
  return GAS_USD[chain] ?? 2;
}

function gasText(chain: string): string {
  const g = gasUsd(chain);
  return `$${g}`;
}

// The cheapest chain a protocol runs on: the farm happens there, where
// the gas is lowest, and the plan says so.
export function cheapestChain(chains: string[]): string {
  let best = chains[0];
  for (const c of chains) {
    if (gasUsd(c) < gasUsd(best)) best = c;
  }
  return best;
}

// Round to four decimals the way JavaScript does: half away from zero on
// the scaled value. The board's stored multipliers are these rounded
// values, and the implied value is computed from them, so the dashboard
// can recompute a row exactly from what data.js carries.
export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function parseDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

export function ageDays(listedAt: string | null, asOf: string, params: ModelParams): number | null {
  if (!listedAt) return null;
  return Math.max(0, Math.round(parseDay(asOf) - parseDay(listedAt)));
}

function maturityAge(age: number | null, params: ModelParams): number {
  return age ?? params.unknown_age_days;
}

// A protocol is rankable when it has no token anywhere the snapshot can
// see it, belongs to a category that can still launch, and is not a
// versioned re-deployment.
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    p.mcap_usd === null &&
    p.symbol === null &&
    p.gecko_id === null &&
    !EXCLUDED_CATEGORIES.has(p.category) &&
    !VERSION_SUFFIX.test(p.slug)
  );
}

// The live set that calibrates the model: protocols with a trading token
// and a positive market cap and TVL, outside the excluded categories.
// A negative market cap is a bad feed row, not a protocol worth $0.
export function isCalibrationLive(p: SnapshotProtocol): boolean {
  return (
    p.mcap_usd !== null &&
    p.mcap_usd > 0 &&
    p.tvl_usd !== null &&
    p.tvl_usd > 0 &&
    !EXCLUDED_CATEGORIES.has(p.category)
  );
}

// Log-space calibration. Ratios are heavy-tailed, so the category
// multiple is the median of log(ratio), shrunk toward the global
// log-median with a prior weight, then exponentiated: a geometric
// multiple. The winsor band is applied to the exponentiated multiple,
// in the same 0.25x-3x of the global median as radar-2.
export function calibrate(
  protocols: SnapshotProtocol[],
  params: ModelParams,
): { globalMedian: number; byCategory: Map<string, { n: number; median: number; multiple: number }> } {
  const live = protocols.filter(isCalibrationLive);
  const logRatios = live.map((p) => Math.log((p.mcap_usd as number) / (p.tvl_usd as number)));
  const globalLogMedian = median(logRatios);
  const globalMedian = Math.exp(globalLogMedian);
  const grouped = new Map<string, number[]>();
  for (const p of live) {
    const list = grouped.get(p.category) ?? [];
    list.push(Math.log((p.mcap_usd as number) / (p.tvl_usd as number)));
    grouped.set(p.category, list);
  }
  const byCategory = new Map<string, { n: number; median: number; multiple: number }>();
  for (const [category, logs] of grouped) {
    const medLog = median(logs);
    const shrunkLog = (logs.length * medLog + params.shrink_prior * globalLogMedian) / (logs.length + params.shrink_prior);
    const multiple = clamp(Math.exp(shrunkLog), params.winsor_low * globalMedian, params.winsor_high * globalMedian);
    byCategory.set(category, { n: logs.length, median: Math.exp(medLog), multiple });
  }
  return { globalMedian, byCategory };
}

export function calibrationTable(
  byCategory: Map<string, { n: number; median: number; multiple: number }>,
): CalibrationRow[] {
  return [...byCategory.entries()]
    .map(([category, v]) => ({
      category,
      n: v.n,
      median: round4(v.median),
      multiple: round4(v.multiple),
    }))
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
}

// Chain breadth in log space: the second chain is worth more than the
// eleventh. 1 + 0.10 x ln(n), capped at 1.35.
function chainMultiplier(chains: string[], params: ModelParams): number {
  return Math.min(1 + params.chain_step * Math.log(chains.length), params.chain_cap);
}

function growthMultiplier(change7d: number | null, params: ModelParams): number {
  const pct = change7d ?? 0;
  const bounded = clamp(pct, params.growth_floor, params.growth_cap);
  return 1 + (params.growth_weight * bounded) / 100;
}

// The growth shown in the breakdown is the bounded seven-day change —
// the same clamped value the multiplier is built from, with a missing
// reading shown as no change rather than an unknown.
function growthPct(change7d: number | null, params: ModelParams): number {
  return clamp(change7d ?? 0, params.growth_floor, params.growth_cap);
}

// Maturity in log space: surviving the first year is the big proof, and
// the gap between two and three years is small. 0.60 at launch, 0.80 at
// one year, 1.00 at three years, capped there.
function maturityMultiplier(age: number | null, params: ModelParams): number {
  const days = Math.min(maturityAge(age, params), params.maturity_days);
  const frac = Math.log(1 + days / 365) / Math.log(1 + params.maturity_days / 365);
  return params.maturity_floor + params.maturity_range * frac;
}

// The farm stake scales with the size of the opportunity: a small
// position for a small protocol, a larger one where the launch would be
// worth real money.
export function farmStake(tvlUsd: number): number {
  if (tvlUsd >= 1_000_000_000) return 150;
  if (tvlUsd >= 100_000_000) return 100;
  return 50;
}

// How long to hold before the position counts: young protocols need a
// longer look-back so the activity is not a one-week blip.
function holdDays(age: number | null): number {
  if (age === null || age >= 365) return 30;
  if (age >= 180) return 45;
  return 60;
}

// The farm's gas bill: one setup transaction, one qualifying action a
// week for the whole hold, and one claim transaction, all on the cheapest
// chain. Capital stays in the position and is not a cost.
export function farmCostUsd(gas: number, hold: number): number {
  const weeks = Math.max(1, Math.ceil(hold / 7));
  return Math.round((1 + weeks + 1) * gas * 100) / 100;
}

type FarmVoice = { action: string; weekly: string };

function farmVoice(category: string): FarmVoice {
  switch (category) {
    case "Risk Curators":
    case "Onchain Capital Allocator":
      return { action: "vault", weekly: "add a little more or vote" };
    case "Lending":
    case "CDP":
    case "CDP Manager":
    case "Collateral Markets":
    case "Uncollateralized Lending":
      return { action: "lend", weekly: "supply, borrow or repay a little" };
    case "Dexs":
    case "Indexes":
      return { action: "liquidity", weekly: "swap, add liquidity or claim rewards" };
    case "Yield":
    case "Yield Aggregator":
    case "Leveraged Farming":
      return { action: "top-vault", weekly: "swap, add liquidity or claim rewards" };
    case "RWA":
      return { action: "mint-yield", weekly: "mint, hold or claim yield" };
    case "Derivatives":
    case "Interest Rate Derivatives":
      return { action: "margin", weekly: "open or close one small position" };
    case "Restaking":
    case "Staking Pool":
      return { action: "stake", weekly: "stake a little more or claim rewards" };
    case "Prediction Market":
      return { action: "predict", weekly: "place or settle one market position" };
    case "Insurance":
      return { action: "cover", weekly: "deposit, swap or vote" };
    case "Stablecoin Wrapper":
    case "Dual-Token Stablecoin":
      return { action: "stable", weekly: "mint, hold or claim yield" };
    case "Options":
      return { action: "options", weekly: "open or close one small options position" };
    case "Perps":
      return { action: "perps", weekly: "open or close one small perpetual position" };
    case "Farm":
      return { action: "farm", weekly: "harvest or compound the rewards" };
    case "Staking":
      return { action: "stake", weekly: "stake a little more or claim rewards" };
    case "Algo-Stables":
      return { action: "stable", weekly: "mint, hold or claim yield" };
    case "Reserve Currency":
      return { action: "bond", weekly: "bond, stake or claim rewards" };
    case "Privacy":
      return { action: "shield", weekly: "shield or transfer a small amount" };
    case "Gaming":
      return { action: "play", weekly: "play one session or complete a quest" };
    case "NFT Marketplace":
      return { action: "trade", weekly: "list, buy or bid on one item" };
    case "NFT Lending":
      return { action: "nft-lend", weekly: "lend, borrow or repay a little" };
    case "Oracle":
      return { action: "oracle", weekly: "stake, delegate or vote" };
    case "Cross Chain":
      return { action: "bridge", weekly: "bridge a small amount or vote" };
    case "Services":
      return { action: "use", weekly: "use one service or complete a task" };
    case "Launchpad":
      return { action: "launch", weekly: "stake, vote or join one sale" };
    case "Payments":
      return { action: "pay", weekly: "send or receive one payment" };
    case "Social":
      return { action: "engage", weekly: "post, tip or complete a task" };
    default:
      return { action: "deposit", weekly: "deposit, swap or vote" };
  }
}

function farmMainStep(row: BoardRow, stake: number): string {
  const chain = row.farm_chain;
  const gas = gasText(chain);
  const voice = farmVoice(row.category);
  switch (voice.action) {
    case "vault":
      return (
        `Put $${stake} into a ${row.name} vault on ${chain} and hold the shares. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "lend":
      return (
        `Lend $${stake} of USDC to ${row.name} on ${chain} and leave the position open. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "liquidity":
      return (
        `Add $${stake} of liquidity to ${row.name}'s main pool on ${chain} and leave the position open. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "top-vault":
      return (
        `Put $${stake} of USDC into ${row.name}'s best-yielding vault on ${chain} and leave the position open. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "mint-yield":
      return (
        `Mint $${stake} of the protocol's yield-bearing asset on ${chain} and hold it. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "margin":
      return (
        `Post $${stake} of USDC as margin on ${row.name} and open one small hedged position. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "stake":
      return (
        `Stake $${stake} of the chain's staking asset through ${row.name} and keep the receipt. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "predict":
      return (
        `Fund $${stake} and open one market position on ${row.name}. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "cover":
      return (
        `Buy $${stake} of cover from ${row.name} on ${chain} and keep the policy. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "stable":
      return (
        `Mint or deposit $${stake} of the stable asset through ${row.name} on ${chain}. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "options":
      return (
        `Buy one small ${row.name} options position on ${chain} and hold it to expiry. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "perps":
      return (
        `Open one small hedged perpetual position on ${row.name} on ${chain}. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "farm":
      return (
        `Deposit $${stake} of USDC into ${row.name}'s farm on ${chain} and leave the position open. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "bond":
      return (
        `Bond $${stake} of the reserve asset through ${row.name} on ${chain} and hold the bond. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "shield":
      return (
        `Shield $${stake} through ${row.name} on ${chain} and keep the shielded balance. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "play":
      return (
        `Play one session of ${row.name} on ${chain} and keep the account active. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "trade":
      return (
        `List or buy one item on ${row.name} on ${chain} and keep the account active. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "nft-lend":
      return (
        `Lend $${stake} against an NFT on ${row.name} on ${chain} and leave the loan open. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "oracle":
      return (
        `Stake $${stake} with ${row.name} on ${chain} and keep the stake delegated. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "bridge":
      return (
        `Bridge $${stake} through ${row.name} to ${chain} and keep the position on the destination chain. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "use":
      return (
        `Use ${row.name} on ${chain} with $${stake} and keep the account active. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "launch":
      return (
        `Stake $${stake} with ${row.name} on ${chain} and join one sale or vote. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "pay":
      return (
        `Send $${stake} through ${row.name} on ${chain} and keep the account active. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    case "engage":
      return (
        `Engage with ${row.name} on ${chain} and complete one task with $${stake} staked. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
    default:
      return (
        `Deposit $${stake} of USDC into ${row.name} on ${chain} and keep the position open. ` +
        `Cost: $${stake} of capital and about ${gas} of gas on ${chain}. Time: 15 minutes to set up.`
      );
  }
}

// Seven concrete steps per protocol: a fresh wallet, the position itself
// on the cheapest chain, a weekly qualifying action, a hold long enough
// to be counted, the points page, the claim, and a log. Costs and times
// are stated on every step so the plan can be followed without guessing.
// The farm happens on the cheapest chain the protocol runs on, and the
// plan says which chain that is and why.
export function farmSteps(row: BoardRow): string[] {
  const chain = row.farm_chain;
  const gas = gasText(chain);
  const stake = farmStake(row.tvl_usd);
  const voice = farmVoice(row.category);
  const hold = holdDays(row.age_days);
  const chainNote =
    row.chains.length > 1
      ? ` ${row.name} also runs on ${row.chains.filter((c) => c !== chain).slice(0, 3).join(", ")}, but ${chain} is the cheapest gas, so the farm happens there.`
      : "";
  return [
    `Set up a fresh wallet just for this farm, fund it only with the amount you plan to use, and keep its recovery phrase offline. Cost: about ${gas} of gas for the first transaction. Time: 5 minutes.`,
    farmMainStep(row, stake) + chainNote,
    `Do one qualifying action each week — ${voice.weekly}. Cost: about ${gas} of gas a week. Time: 10 minutes a week.`,
    `Keep the position open for at least ${hold} days so it shows up in more than one snapshot. Cost: the $${stake} stays in the position. Time: ${hold} days.`,
    `Visit ${row.name}'s own points or rewards page, connect the same wallet, and finish every task it lists. Cost: no fee to check, and never pay to claim. Time: 10 minutes.`,
    `If a token or claim opens, follow only the link the protocol itself publishes, verify the token contract in the chain explorer before approving anything, and never sign a blind approval. Cost: the claim gas only, about ${gas}. Time: 15 minutes.`,
    `Record the wallet, the dates and every transaction in a farm log, so you can repeat the position or unwind it later. Cost: nothing but the log. Time: 5 minutes.`,
  ];
}

function scoreRow(
  p: SnapshotProtocol,
  asOf: string,
  params: ModelParams,
  globalMedian: number,
  byCategory: Map<string, { n: number; median: number; multiple: number }>,
): { breakdown: ModelBreakdown; implied: number; age: number | null } {
  const cal = byCategory.get(p.category);
  const base = round4(cal ? cal.multiple : globalMedian);
  const chain = round4(chainMultiplier(p.chains, params));
  const growth = round4(growthMultiplier(p.change_7d, params));
  const age = ageDays(p.listed_at, asOf, params);
  const maturity = round4(maturityMultiplier(age, params));
  const completeness = p.change_7d === null ? params.missing_data_factor : 1;
  const implied = Math.round((p.tvl_usd as number) * base * chain * growth * maturity * completeness);
  return {
    breakdown: {
      base_multiple: base,
      chain_multiplier: chain,
      growth_pct: growthPct(p.change_7d, params),
      growth_multiplier: growth,
      maturity_multiplier: maturity,
      completeness,
      age_days: age,
      calibration_n: cal ? cal.n : 0,
      category_median: round4(cal ? cal.median : globalMedian),
    },
    implied,
    age,
  };
}

export function buildRadar(snapshot: Snapshot, params: ModelParams = MODEL_PARAMS): RadarResult {
  const { globalMedian, byCategory } = calibrate(snapshot.protocols, params);
  const calibration = calibrationTable(byCategory);
  const watchlist = new Set(snapshot.watchlist);

  const ranked: BoardRow[] = snapshot.protocols
    .filter(isRankable)
    .map((p) => {
      const { breakdown, implied, age } = scoreRow(p, snapshot.as_of, params, globalMedian, byCategory);
      const farmChain = cheapestChain(p.chains);
      const hold = holdDays(age);
      const row: BoardRow = {
        rank: 0,
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl_usd: p.tvl_usd as number,
        change_7d: p.change_7d,
        mcap_usd: p.mcap_usd,
        listed_at: p.listed_at,
        gecko_id: p.gecko_id,
        symbol: p.symbol,
        token_status: "pre-token",
        age_days: age,
        implied_value_usd: implied,
        model: breakdown,
        farm_chain: farmChain,
        farm_cost_usd: farmCostUsd(gasUsd(farmChain), hold),
        farm_weeks: Math.max(1, Math.ceil(hold / 7)),
        on_watchlist: watchlist.has(p.slug),
        farm_steps: [],
      };
      row.farm_steps = farmSteps(row);
      return row;
    })
    .sort((a, b) => b.implied_value_usd - a.implied_value_usd);
  ranked.forEach((row, i) => {
    row.rank = i + 1;
  });

  // The live view: the forty largest live protocols among the categories
  // that calibrate the model, largest market cap first.
  const live: LiveRow[] = snapshot.protocols
    .filter(isCalibrationLive)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd as number,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
      multiple: round4((p.mcap_usd as number) / (p.tvl_usd as number)),
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd)
    .slice(0, 40);

  return {
    params,
    // Full precision, not the rounded display value: the dashboard
    // recomputes each row's multiple by shrinking toward this median in
    // log space, and recomputing from a rounded 0.241 instead of the raw
    // 0.24099... flips a rounding boundary for some rows. The page
    // formats it to three decimals for display.
    global_median: globalMedian,
    calibration,
    rows: ranked,
    live,
    watchlist_size: snapshot.watchlist.length,
    early_size: ranked.filter((r) => !watchlist.has(r.slug)).length,
  };
}

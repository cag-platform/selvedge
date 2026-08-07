import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PRICING_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config/model-pricing.json');

type Rate = { provider: string; input_per_mtok: number; output_per_mtok: number };
type PricingTable = { models: Record<string, Rate>; fallback: Rate };

let cached: PricingTable | null = null;

function table(): PricingTable {
  if (!cached) cached = JSON.parse(readFileSync(PRICING_PATH, 'utf-8')) as PricingTable;
  return cached;
}

function rateFor(model: string): Rate {
  return table().models[model] ?? table().fallback;
}

/**
 * USD cost of a call. Unknown models price at the fallback (most expensive)
 * rate — cost must never be silently undercounted.
 */
export function costUsd(model: string, tokensIn: number, tokensOut: number): number {
  const rate = rateFor(model);
  return (tokensIn * rate.input_per_mtok + tokensOut * rate.output_per_mtok) / 1_000_000;
}

/**
 * Who served a model id, for attributing spend once more than one provider is
 * in play. The pricing table is the registry: a model nobody priced is
 * 'unknown' rather than being quietly filed under the incumbent, so an
 * unattributed row is visible in the ledger instead of misattributed.
 *
 * A client that knows its own provider should say so (LlmResult.provider) —
 * this is the fallback for callers and historical rows that don't.
 */
export function providerForModel(model: string): string {
  return rateFor(model).provider;
}

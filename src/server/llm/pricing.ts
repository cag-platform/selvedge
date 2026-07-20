import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PRICING_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config/model-pricing.json');

type Rate = { input_per_mtok: number; output_per_mtok: number };
type PricingTable = { models: Record<string, Rate>; fallback: Rate };

let cached: PricingTable | null = null;

function table(): PricingTable {
  if (!cached) cached = JSON.parse(readFileSync(PRICING_PATH, 'utf-8')) as PricingTable;
  return cached;
}

/**
 * USD cost of a call. Unknown models price at the fallback (most expensive)
 * rate — cost must never be silently undercounted.
 */
export function costUsd(model: string, tokensIn: number, tokensOut: number): number {
  const rate = table().models[model] ?? table().fallback;
  return (tokensIn * rate.input_per_mtok + tokensOut * rate.output_per_mtok) / 1_000_000;
}

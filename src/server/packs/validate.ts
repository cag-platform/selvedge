import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/context-pack.schema.json');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateFn = ajv.compile(schema);

export type ValidationResult = { valid: true } | { valid: false; errors: string[] };

/** Validates a candidate pack against docs/context-pack.schema.json. */
export function validatePack(candidate: unknown): ValidationResult {
  const valid = validateFn(candidate);
  if (valid) return { valid: true };
  const errors = (validateFn.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`);
  return { valid: false, errors };
}

export class PackValidationError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`Context pack failed schema validation:\n${errors.join('\n')}`);
    this.name = 'PackValidationError';
    this.errors = errors;
  }
}

/** Throws PackValidationError (with the ajv errors attached) on an invalid pack. */
export function assertValidPack(candidate: unknown): void {
  const result = validatePack(candidate);
  if (!result.valid) throw new PackValidationError(result.errors);
}

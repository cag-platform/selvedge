import type { Response } from 'express';
import type { Allowance } from '../../billing/entitlements.js';

/**
 * HOW A PLAN LIMIT SAYS NO.
 *
 * One function so every gated route refuses in the same shape, because a client
 * that has to recognise four different refusals will recognise three.
 *
 * 402 rather than 403: the difference is real and the client acts on it.
 * Forbidden means you may not, ever, and the answer is to stop asking; payment
 * required means you may, and here is what it takes — which is why the body
 * always carries the sentence as well as the code. A limit that doesn't say
 * what lifts it is just a closed door.
 */
export function refuse(res: Response, allowance: Allowance): void {
  res.status(402).json({
    error: allowance.note ?? 'That is more than this plan allows.',
    code: allowance.code,
    limit: allowance.limit,
    used: allowance.used,
  });
}

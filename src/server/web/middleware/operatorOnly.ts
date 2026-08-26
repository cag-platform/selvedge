import type { NextFunction, Request, Response } from 'express';

export function operatorUserIds(raw = process.env.SELVEDGE_OPERATOR_USER_IDS): ReadonlySet<string> {
  return new Set((raw ?? '').split(',').map((id) => id.trim()).filter(Boolean));
}

/** Fail closed: an empty or missing allowlist grants nobody operator access. */
export function operatorOnly(allowed = operatorUserIds()) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as Request & { userId?: string | null }).userId;
    if (!userId || !allowed.has(userId)) {
      res.status(403).json({ error: 'operator access required' });
      return;
    }
    next();
  };
}

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 doesn't forward a rejected promise from an async handler to
 * next() automatically — an uncaught rejection just hangs the request
 * instead of producing a response. Wrap every async route with this so
 * unexpected errors reach the error-handling middleware in app.ts instead
 * of leaving the client waiting forever.
 */
export function asyncHandler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

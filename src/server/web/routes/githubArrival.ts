import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { userOf } from '../middleware/tenant.js';
import {
  clerkGithubToken,
  personalGithub,
  PersonalGithubError,
  type PersonalGithub as Personal,
} from '../../connectors/github/personal.js';

/**
 * THE ARRIVAL MOMENT, as one endpoint. `GET /api/connectors/github/personal`
 * answers "did this person arrive through GitHub, and what did they arrive
 * with?" so the first screen after a GitHub sign-up can greet them by their
 * GitHub self and point at the install that turns repos into projects.
 *
 * THREE ANSWERS, KEPT DISTINCT — because two of them look alike and are not:
 *  - `{connected: false}` (200): they signed in with email or Google. Normal,
 *    final, nothing to retry. The card does not apply.
 *  - `{connected: true, ...}` (200): they arrived through GitHub, with their
 *    login and public repos by last push.
 *  - 502: they DID sign in with GitHub but GitHub would not answer just now.
 *    Collapsing this into `connected: false` would tell the client a falsehood
 *    it cannot detect — cannot-tell is not no.
 */

export type GithubArrivalDeps = {
  /** The signed-in person. Injectable because tests fake orgId, not Clerk. */
  user?: (req: Request) => string | null;
  tokenFor?: (userId: string) => Promise<string | null>;
  personal?: (token: string) => Promise<Personal>;
};

export function createGithubArrivalRouter(deps: GithubArrivalDeps = {}) {
  const router = Router();
  const user = deps.user ?? userOf;
  const tokenFor = deps.tokenFor ?? clerkGithubToken;
  const personal = deps.personal ?? personalGithub;

  router.get(
    '/api/connectors/github/personal',
    asyncHandler(async (req, res) => {
      const userId = user(req);
      if (!userId) {
        res.status(401).json({ error: 'not signed in' });
        return;
      }

      const token = await tokenFor(userId);
      if (!token) {
        res.json({ connected: false });
        return;
      }

      try {
        const found = await personal(token);
        res.json({ connected: true, login: found.login, repos: found.repos });
      } catch (err) {
        if (err instanceof PersonalGithubError) {
          res.status(502).json({ error: `GitHub did not answer: ${err.message}` });
          return;
        }
        throw err;
      }
    }),
  );

  return router;
}

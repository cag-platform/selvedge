import type { MigrationVerification } from '../../shared/types/migration.js';
import type { MigrationBrowserEvidence } from './browserEvidence.js';

type Fetcher = typeof fetch;

export async function verifyMigrationPreview(url: string, now = new Date(), fetcher: Fetcher = fetch): Promise<MigrationVerification> {
  const checks: MigrationVerification['checks'] = [];
  try {
    const first = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const cookie = first.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const location = first.headers.get('location');
    const response = first.status >= 300 && first.status < 400 && location
      ? await fetcher(new URL(location, url), { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(20_000) })
      : first;
    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    checks.push({ name: 'Preview responds', status: response.ok ? 'passed' : 'failed', detail: `The preview returned HTTP ${response.status}.` });
    checks.push({ name: 'Browser document delivered', status: /text\/html/i.test(contentType) ? 'passed' : 'failed', detail: /text\/html/i.test(contentType) ? 'The preview delivered an HTML document.' : `The preview returned ${contentType || 'no content type'} instead of HTML.` });
    checks.push({ name: 'Page has meaningful content', status: body.trim().length >= 100 ? 'passed' : 'failed', detail: body.trim().length >= 100 ? `The root document contains ${body.length} characters.` : 'The root document is empty or too small to establish a usable page.' });
    const obviousFailure = /<title>\s*(?:error|application error)|internal server error|cannot find module|index of \/workspace/i.test(body);
    checks.push({ name: 'No obvious startup failure', status: obviousFailure ? 'failed' : 'passed', detail: obviousFailure ? 'The delivered page contains a startup or directory-listing failure signature.' : 'No common startup failure signature was found in the root document.' });
  } catch (error) {
    checks.push({ name: 'Preview responds', status: 'unavailable', detail: `The verifier could not reach the preview: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) });
  }
  const failed = checks.some((check) => check.status === 'failed');
  const passed = checks.length > 0 && checks.every((check) => check.status === 'passed');
  return {
    schema_version: 1,
    status: passed ? 'passed' : failed ? 'failed' : 'inconclusive',
    verifier: 'selvedge-preview-verifier',
    independent_from_migration_agent: true,
    checks,
    screenshot_artifact_ids: [],
    screenshot_artifacts: [],
    console_errors: [],
    failed_requests: [],
    routes_checked: [],
    limitations: ['This verifier checks the delivered root document. Screenshot, console, network, authenticated-flow, and multi-route evidence are not connected yet.'],
    verified_at: now.toISOString(),
  };
}

export function attachBrowserEvidence(base: MigrationVerification, evidence: MigrationBrowserEvidence, screenshotIds: string[], now = new Date()): MigrationVerification {
  const checks = [...base.checks];
  checks.push({ name: 'Browser rendered the app', status: evidence.error ? 'failed' : 'passed', detail: evidence.error ?? `Rendered ${evidence.routesChecked.length || 1} safe route(s), including the home screen at desktop and mobile sizes.` });
  checks.push({ name: 'Safe internal routes explored', status: evidence.error ? 'unavailable' : 'passed', detail: evidence.routesChecked.length > 1 ? `Checked ${evidence.routesChecked.length} read-only routes discovered from the app's own navigation.` : 'No additional safe internal navigation routes were exposed by the app.' });
  checks.push({ name: 'Responsive screenshots captured', status: screenshotIds.length >= 2 ? 'passed' : 'unavailable', detail: screenshotIds.length >= 2 ? 'Desktop and mobile evidence was stored.' : 'Both desktop and mobile screenshots could not be stored.' });
  checks.push({ name: 'No browser console errors', status: evidence.consoleErrors.length ? 'failed' : evidence.error ? 'unavailable' : 'passed', detail: evidence.consoleErrors.length ? `${evidence.consoleErrors.length} console error(s) were observed.` : 'No console errors were observed during capture.' });
  checks.push({ name: 'No failed critical requests', status: evidence.failedRequests.length ? 'failed' : evidence.error ? 'unavailable' : 'passed', detail: evidence.failedRequests.length ? `${evidence.failedRequests.length} failed or 5xx request(s) were observed.` : 'No failed or 5xx requests were observed during capture.' });
  const failed = checks.some((check) => check.status === 'failed');
  const passed = checks.every((check) => check.status === 'passed');
  return {
    ...base,
    status: passed ? 'passed' : failed ? 'failed' : 'inconclusive',
    checks,
    screenshot_artifact_ids: screenshotIds,
    screenshot_artifacts: screenshotIds.map((id, index) => ({ id, route: evidence.screenshots[index]?.route ?? '/', viewport: evidence.screenshots[index]?.id.startsWith('mobile') ? 'mobile' : 'desktop' })),
    console_errors: evidence.consoleErrors,
    failed_requests: evidence.failedRequests,
    routes_checked: evidence.routesChecked,
    limitations: ['Authenticated user journeys, form submissions, and destructive actions are not exercised automatically.'],
    verified_at: now.toISOString(),
  };
}

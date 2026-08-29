import type { MigrationVerification } from '../../shared/types/migration.js';

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
    limitations: ['This verifier checks the delivered root document. Screenshot, console, network, authenticated-flow, and multi-route evidence are not connected yet.'],
    verified_at: now.toISOString(),
  };
}

import type { AppFile } from './replitApp.js';
import type { MigrationProjectMap, ProjectMapItem } from '../../shared/types/migration.js';

const text = (file: AppFile) => new TextDecoder().decode(file.bytes);
const paths = (files: AppFile[], pattern: RegExp) => files.filter((file) => pattern.test(file.path)).map((file) => file.path).slice(0, 12);
const contentPaths = (files: AppFile[], pattern: RegExp) => files.filter((file) => {
  if (file.bytes.length > 300_000 || !/\.(?:json|js|jsx|ts|tsx|py|toml|yaml|yml|env|md|sql)$/i.test(file.path)) return false;
  try { return pattern.test(text(file)); } catch { return false; }
}).map((file) => file.path).slice(0, 12);

function item(kind: ProjectMapItem['kind'], label: string, evidence: string[], absent: ProjectMapItem['status'] = 'not_detected'): ProjectMapItem {
  return { kind, label, status: evidence.length ? 'found' : absent, evidence, note: evidence.length ? `Observed in ${evidence.join(', ')}` : absent === 'needs_access' ? 'Not stored in the code export; access must be connected separately.' : 'No evidence found in the exported files.' };
}

export function inspectProjectFiles(files: AppFile[], now = new Date()): MigrationProjectMap {
  const packageFiles = paths(files, /(^|\/)package\.json$/i);
  const pythonFiles = paths(files, /(^|\/)(pyproject\.toml|requirements\.txt|Pipfile)$/i);
  const next = contentPaths(files, /["']next["']\s*:/i);
  const vite = contentPaths(files, /["']vite["']\s*:/i);
  const express = contentPaths(files, /["']express["']\s*:/i);
  const stack = [...(next.length ? ['Next.js'] : []), ...(vite.length ? ['Vite'] : []), ...(express.length ? ['Express'] : []), ...(packageFiles.length ? ['Node.js'] : []), ...(pythonFiles.length ? ['Python'] : [])];
  const database = contentPaths(files, /postgres|supabase|neon|prisma|drizzle|mongoose|mongodb|mysql/i);
  const auth = contentPaths(files, /clerk|auth0|next-auth|passport|supabase[^\n]{0,30}auth|firebase[^\n]{0,30}auth/i);
  const storage = contentPaths(files, /\bs3\b|cloudinary|uploadthing|supabase[^\n]{0,30}storage|firebase[^\n]{0,30}storage/i);
  const jobs = contentPaths(files, /cron|inngest|trigger\.dev|bullmq|celery/i);
  const integrations = contentPaths(files, /stripe|resend|twilio|sendgrid|openai|anthropic|gmail|googleapis|replit[^\n]{0,40}(?:connector|integration)/i);
  const env = paths(files, /(^|\/)(\.env(?:\.[^/]+)?|\.env\.example)$/i).concat(contentPaths(files, /process\.env|import\.meta\.env|os\.environ/i));
  const domain = paths(files, /(^|\/)(vercel\.json|netlify\.toml|railway\.json|CNAME)$/i);
  const hosting = paths(files, /(^|\/)(vercel\.json|netlify\.toml|railway\.json|Dockerfile|fly\.toml)$/i);
  return {
    schema_version: 1, generated_at: now.toISOString(), files_inspected: files.length, stack: [...new Set(stack)],
    items: [
      item('application', stack.join(' + ') || 'Web application', [...new Set([...packageFiles, ...pythonFiles, ...next, ...vite, ...express])]),
      item('database', 'Database', database, 'needs_access'), item('auth', 'Authentication', auth, 'needs_access'),
      item('storage', 'File storage', storage, 'needs_access'), item('job', 'Scheduled jobs', jobs),
      item('integration', 'External integrations', integrations), item('secret', 'Environment secrets', [...new Set(env)], 'needs_access'),
      item('domain', 'Domains', domain, 'needs_access'), item('hosting', 'Hosting', hosting, 'needs_access'),
    ],
    limitations: ['File inspection cannot read secrets held in the source platform vault.', 'A detected dependency is evidence to verify, not proof that the external service is reachable.'],
  };
}

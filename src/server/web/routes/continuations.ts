import { Router, type Request } from 'express';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Db } from '../../db/client.js';
import { acceptContinuation, addImportedThreadSource, addTextSource, analyzeContinuation, briefFor, claimFor, contextHealthForProject, createContinuation, getContinuation, resolveClaim, shapeSource } from '../../continuations/store.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { recordProductEvent, type ProductSurface } from '../../telemetry/productEvents.js';
import type { PushSender } from '../../push/types.js';
import { sendToOrgDevices } from '../../push/send.js';
import { contextChangeNotification } from '../../push/notifications.js';

function orgIdOf(req: Request): string { return (req as Request & { orgId: string }).orgId; }
function surfaceOf(req: Request): ProductSurface {
  const value = req.header('x-selvedge-surface');
  return value === 'desktop_web' || value === 'responsive_web' || value === 'ios_native' ? value : 'unknown';
}
function textField(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function observedAt(value: unknown): Date {
  if (typeof value !== 'string') return new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
function confirmationValue(value: unknown): unknown | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && encoded.length <= 20_000 ? value : null;
  } catch { return null; }
}

export function createContinuationsRouter(db: Db, deps: { pushSender?: PushSender } = {}) {
  const router = Router();
  router.get('/api/continuations/availability', (_req, res) => res.json({ available: true }));
  router.get('/api/projects/:projectId/context-health', asyncHandler(async (req, res) => {
    const health = await contextHealthForProject(db, orgIdOf(req), req.params.projectId ?? '');
    if (!health) { res.status(404).json({ error: 'no such project' }); return; }
    res.json(health);
  }));
  router.post('/api/continuations', asyncHandler(async (req, res) => {
    const projectId = typeof req.body?.project_id === 'string' ? req.body.project_id.trim() : '';
    if (!projectId) { res.status(400).json({ error: 'project_id is required' }); return; }
    const session = await createContinuation(db, orgIdOf(req), projectId);
    if (!session) { res.status(404).json({ error: 'no such project' }); return; }
    await recordProductEvent(db, orgIdOf(req), 'continuation_started', { surface: surfaceOf(req), continuationId: session.id, projectId });
    res.status(201).json({ continuation: session });
  }));
  router.get('/api/continuations/:id', asyncHandler(async (req, res) => {
    const session = await getContinuation(db, orgIdOf(req), req.params.id ?? '');
    if (!session) { res.status(404).json({ error: 'no such continuation' }); return; }
    res.json({ continuation: session });
  }));
  router.post('/api/continuations/:id/sources/imported-threads', asyncHandler(async (req, res) => {
    const threadId = typeof req.body?.thread_id === 'string' ? req.body.thread_id.trim() : '';
    if (!threadId) { res.status(400).json({ error: 'thread_id is required' }); return; }
    const out = await addImportedThreadSource(db, orgIdOf(req), req.params.id ?? '', threadId);
    if (out.kind === 'no_session') { res.status(404).json({ error: 'no such continuation' }); return; }
    if (out.kind === 'not_imported') { res.status(400).json({ error: 'that is not an imported conversation' }); return; }
    if (out.source) await recordProductEvent(db, orgIdOf(req), 'source_added', { surface: surfaceOf(req), continuationId: req.params.id, properties: { kind: 'imported_thread' } });
    res.status(out.source ? 201 : 200).json({ source: out.source, already_added: out.source === null });
  }));
  router.post('/api/continuations/:id/sources/notes', asyncHandler(async (req, res) => {
    const text = textField(req.body?.text, 50_000);
    if (!text) { res.status(400).json({ error: 'text is required' }); return; }
    const title = textField(req.body?.title, 160) || 'Pasted note';
    const source = await addTextSource(db, orgIdOf(req), req.params.id ?? '', {
      kind: 'pasted_note', title, sourceRef: `note:${ulid()}`, content: text, observedAt: observedAt(req.body?.observed_at),
      limitations: ['A pasted note reflects what its author recorded; it is not verified against the repository.'],
    });
    if (!source) { res.status(404).json({ error: 'no such continuation' }); return; }
    await recordProductEvent(db, orgIdOf(req), 'source_added', { surface: surfaceOf(req), continuationId: req.params.id, properties: { kind: 'pasted_note' } });
    res.status(201).json({ source: shapeSource(source) });
  }));
  router.post('/api/continuations/:id/sources/documents', asyncHandler(async (req, res) => {
    const text = textField(req.body?.text, 200_000);
    const title = textField(req.body?.title, 160);
    if (!title || !text) { res.status(400).json({ error: 'title and text are required' }); return; }
    const mime = textField(req.body?.mime_type, 120) || 'text/plain';
    const digest = createHash('sha256').update(`${title}\0${text}`).digest('hex');
    const source = await addTextSource(db, orgIdOf(req), req.params.id ?? '', {
      kind: 'document', title, sourceRef: `document:${digest}`, content: text, observedAt: observedAt(req.body?.observed_at), version: digest,
      limitations: mime === 'text/plain' ? [] : [`Text was supplied from ${mime}; layout and non-text content were not retained.`],
    });
    if (!source) { res.status(404).json({ error: 'no such continuation' }); return; }
    await recordProductEvent(db, orgIdOf(req), 'source_added', { surface: surfaceOf(req), continuationId: req.params.id, properties: { kind: 'document' } });
    res.status(201).json({ source: shapeSource(source) });
  }));
  router.post('/api/continuations/:id/sources/urls', asyncHandler(async (req, res) => {
    const rawUrl = textField(req.body?.url, 2_048);
    let url: URL;
    try { url = new URL(rawUrl); } catch { res.status(400).json({ error: 'a valid http or https URL is required' }); return; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { res.status(400).json({ error: 'a valid http or https URL is required' }); return; }
    url.username = ''; url.password = ''; url.hash = '';
    const excerpt = textField(req.body?.excerpt, 50_000) || null;
    const title = textField(req.body?.title, 160) || url.hostname;
    const source = await addTextSource(db, orgIdOf(req), req.params.id ?? '', {
      kind: 'live_url', title, sourceRef: url.toString(), content: excerpt, observedAt: observedAt(req.body?.observed_at),
      limitations: excerpt ? ['Only the supplied excerpt was retained; the URL was not fetched by Selvedge.'] : ['URL recorded but not fetched; no page contents are available yet.'],
    });
    if (!source) { res.status(404).json({ error: 'no such continuation' }); return; }
    await recordProductEvent(db, orgIdOf(req), 'source_added', { surface: surfaceOf(req), continuationId: req.params.id, properties: { kind: 'live_url' } });
    res.status(201).json({ source: shapeSource(source) });
  }));
  router.post('/api/continuations/:id/analyze', asyncHandler(async (req, res) => {
    const before = await getContinuation(db, orgIdOf(req), req.params.id ?? '');
    const brief = await analyzeContinuation(db, orgIdOf(req), req.params.id ?? '');
    if (!brief) { res.status(404).json({ error: 'no such continuation' }); return; }
    await recordProductEvent(db, orgIdOf(req), 'brief_ready', { surface: surfaceOf(req), continuationId: brief.continuation_id, projectId: brief.project.id,
      properties: { understood: brief.understood.length, needs_confirmation: brief.needs_confirmation.length, still_missing: brief.still_missing.length } });
    const question = brief.needs_confirmation[0];
    if (before?.state === 'collecting' && question && deps.pushSender) {
      await sendToOrgDevices(db, orgIdOf(req), deps.pushSender, contextChangeNotification({ projectId: brief.project.id,
        projectName: brief.project.name, continuationId: brief.continuation_id, claimId: question.id, summary: question.text })).catch(() => undefined);
    }
    res.json(brief);
  }));
  router.get('/api/continuations/:id/brief', asyncHandler(async (req, res) => {
    const brief = await briefFor(db, orgIdOf(req), req.params.id ?? '');
    if (!brief) { res.status(404).json({ error: 'no such continuation' }); return; }
    res.json(brief);
  }));
  router.patch('/api/continuations/:id/claims/:claimId', asyncHandler(async (req, res) => {
    if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'value')) { res.status(400).json({ error: 'value is required' }); return; }
    const value = confirmationValue(req.body.value);
    if (value === null && req.body.value !== null) { res.status(413).json({ error: 'value must be valid JSON no larger than 20,000 characters' }); return; }
    const claim = await resolveClaim(db, orgIdOf(req), req.params.id ?? '', req.params.claimId ?? '', value);
    if (!claim) { res.status(404).json({ error: 'no such claim' }); return; }
    res.json({ claim });
  }));
  router.get('/api/continuations/:id/claims/:claimId', asyncHandler(async (req, res) => {
    const claim = await claimFor(db, orgIdOf(req), req.params.id ?? '', req.params.claimId ?? '');
    if (!claim) { res.status(404).json({ error: 'no such claim' }); return; }
    res.json({ claim });
  }));
  router.post('/api/continuations/:id/accept', asyncHandler(async (req, res) => {
    const out = await acceptContinuation(db, orgIdOf(req), req.params.id ?? '');
    if (out.kind === 'not_found') { res.status(404).json({ error: 'no such continuation' }); return; }
    if (out.kind === 'not_ready') { res.status(409).json({ error: 'Add a repository and at least one conversation, note, document, or URL before continuing.' }); return; }
    if (out.created) await recordProductEvent(db, orgIdOf(req), 'brief_accepted', { surface: surfaceOf(req), continuationId: req.params.id, projectId: out.thread.projectId, threadId: out.thread.id });
    res.status(out.created ? 201 : 200).json({ thread: { id: out.thread.id, kind: out.thread.kind, title: out.thread.title, agent: out.thread.agent } });
  }));
  return router;
}

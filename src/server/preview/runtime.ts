export type PreviewSource = {
  kind: 'git';
  repository: string;
  ref: string;
};

export type CreatePreviewInput = {
  orgId: string;
  projectId: string;
  source: PreviewSource;
  variables: Record<string, string>;
  ttlMinutes: number;
};

export type PreviewHandle = {
  id: string;
  state: 'creating' | 'building' | 'ready' | 'failed' | 'destroyed';
  url: string | null;
  expiresAt: Date;
};

/** Provider-neutral disposable app preview. Agent workspaces never expose their own ports. */
export interface PreviewRuntime {
  createPreview(input: CreatePreviewInput): Promise<PreviewHandle>;
  inspectPreview(id: string): Promise<PreviewHandle>;
  destroyPreview(id: string): Promise<void>;
}

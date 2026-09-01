export type PreviewEvidence = {
  status: 'passed' | 'failed' | 'unavailable';
  screenshot_artifact_ids: string[];
  screenshots: Array<{ id: string; route: string; viewport: 'desktop' | 'mobile' }>;
  console_errors: string[];
  failed_requests: Array<{ url: string; status: number | null; detail: string }>;
  routes_checked: string[];
  limitation: string | null;
  captured_at: string;
};

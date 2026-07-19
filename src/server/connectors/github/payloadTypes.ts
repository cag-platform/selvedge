/**
 * Minimal shapes for the slice of each GitHub webhook payload the
 * normalizer reads. Deliberately not exhaustive — we only type what we
 * touch; everything else rides along in `raw` untouched and untyped.
 */

export type GithubRepository = {
  full_name: string;
  default_branch: string;
};

export type PushPayload = {
  ref: string; // e.g. "refs/heads/main"
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  commits: Array<{ id: string; message: string }>;
  head_commit: { id: string; timestamp: string } | null;
  repository: GithubRepository;
};

export type PullRequestPayload = {
  action: string; // opened | closed | reopened | ...
  number: number;
  pull_request: {
    title: string;
    merged: boolean;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    created_at: string;
    updated_at: string;
    html_url: string;
    head: { ref: string };
  };
  repository: GithubRepository;
};

export type WorkflowRunPayload = {
  action: string; // requested | in_progress | completed
  workflow_run: {
    id: number;
    name: string;
    head_branch: string;
    status: string; // queued | in_progress | completed
    conclusion: string | null; // success | failure | cancelled | ... | null until completed
    run_started_at: string;
    updated_at: string;
    html_url: string;
  };
  repository: GithubRepository;
};

export type CreateOrDeletePayload = {
  ref: string;
  ref_type: 'branch' | 'tag';
  repository: GithubRepository;
};

export type InstallationPayload = {
  action: string; // created | deleted | suspend | unsuspend | new_permissions_accepted
  installation: {
    id: number;
    account: { login: string };
  };
};

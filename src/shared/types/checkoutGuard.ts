export type CheckoutGuardState = 'clean' | 'attributable_existing_work' | 'unattributed_dirty' | 'active_mutation';
export type CheckoutResolution = 'continue_existing' | 'review_existing' | 'wait' | 'fresh_isolated';

export type CheckoutGuardChoice = {
  id: CheckoutResolution;
  label: string;
  available: boolean;
  effect: string;
  unavailable_reason: string | null;
};

export type BoundedChangePlan = {
  goal: string;
  expected_area: string;
  expected_files: string[];
  risk_boundary: string;
  verification: string[];
  expected_duration_minutes: { minimum: number; maximum: number };
  automatic_stop: { after_minutes: number; conditions: string[] };
};

export type CheckoutGuard = {
  project_id: string;
  thread_id: string | null;
  state: CheckoutGuardState;
  safe_to_start: boolean;
  inspected_at: string;
  ownership: { run_id: string; thread_id: string | null; agent: string | null; observed_at: string } | null;
  existing_work: { changed_paths: string[]; observed_at: string | null } | null;
  choices: CheckoutGuardChoice[];
  fresh_isolated_checkout: { supported: boolean; reason: string };
  preview: { state: 'not_started' | 'available'; url: string | null; starts_or_wakes_on_open: true };
  plan: BoundedChangePlan;
};

export type CheckoutConflict = {
  error: string;
  code: 'checkout_conflict';
  checkout_guard: CheckoutGuard;
};

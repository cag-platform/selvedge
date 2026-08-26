/**
 * Every table the code knows about. The tenancy test walks this list, so a
 * table that is not here is a table nothing structurally checks.
 *
 * SKETCH IS NOT HERE ANY MORE. It was "the cheap room next door to the
 * workshop" — a conversation about an idea before anything is built — shipped,
 * then retired, and its two tables stayed in this list for months afterwards
 * because a schema definition compiles whether or not a single line reads it.
 * The feature came back under a different design (an idea is a conversation
 * under a subject, which is what a subject already is), so the old tables
 * describe a shape nothing writes.
 *
 * `sketches` and `sketch_messages` STILL EXIST IN THE DATABASE and hold
 * whatever was written while the feature was live. Dropping them is a separate,
 * irreversible decision that belongs to whoever owns the data, not to a
 * cleanup pass — so this removes the definitions and leaves the rows alone.
 * The `'sketch'` LlmPurpose stays for the same reason: old usage rows carry it.
 */
export * from './orgs.js';
export * from './events.js';
export * from './packs.js';
export * from './connectorHealth.js';
export * from './connectorCredentials.js';
export * from './oauthStates.js';
export * from './healthChecks.js';
export * from './errorBeacon.js';
export * from './cards.js';
export * from './devices.js';
export * from './narrations.js';
export * from './digests.js';
export * from './llmUsage.js';
export * from './narrationLibrary.js';
export * from './feedback.js';
export * from './trustIncidents.js';
export * from './build.js';
export * from './threads.js';
export * from './companion.js';
export * from './subjects.js';
export * from './decisions.js';
export * from './ignoredSources.js';
export * from './billing.js';
export * from './previewEnv.js';
export * from './continuations.js';

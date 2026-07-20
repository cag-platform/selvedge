/**
 * Validates DATABASE_URL before it reaches the postgres driver. The driver's
 * URL-parse error echoes the raw input into logs — if someone pastes a
 * secret into the wrong variable, that would print the secret. Fail here
 * with a message that never includes the value.
 */
export function requireDatabaseUrl(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  if (!/^postgres(ql)?:\/\//.test(connectionString)) {
    throw new Error(
      'DATABASE_URL is set but is not a postgres:// connection string (value withheld from logs — check the service variables for a paste mix-up)',
    );
  }
  return connectionString;
}

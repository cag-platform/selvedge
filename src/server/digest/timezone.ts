function localParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** "YYYY-MM-DD" for `date` in `timeZone`. */
export function localDateString(date: Date, timeZone: string): string {
  const { year, month, day } = localParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The UTC instant corresponding to local midnight of the given calendar
 * day in `timeZone`. Converges in a couple of iterations by comparing a
 * guessed UTC instant's local wall-clock time against the target — the
 * standard technique for timezone-correct day boundaries without a
 * datetime library.
 */
export function localMidnightUtc(timeZone: string, year: number, month: number, day: number): Date {
  const targetUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guessMs = targetUtcMs;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guessMs), timeZone);
    const guessLocalAsUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diffMs = guessLocalAsUtcMs - targetUtcMs;
    if (diffMs === 0) break;
    guessMs -= diffMs;
  }
  return new Date(guessMs);
}

/** [start, end) UTC bounds of "yesterday" in `timeZone`, relative to `now`. */
export function yesterdayBoundsUtc(timeZone: string, now: Date): { start: Date; end: Date; dateString: string } {
  const today = localParts(now, timeZone);
  const todayMidnight = localMidnightUtc(timeZone, today.year, today.month, today.day);
  const yesterdayDate = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
  const yesterdayMidnight = localMidnightUtc(
    timeZone,
    yesterdayDate.getUTCFullYear(),
    yesterdayDate.getUTCMonth() + 1,
    yesterdayDate.getUTCDate(),
  );
  return {
    start: yesterdayMidnight,
    end: todayMidnight,
    dateString: `${yesterdayDate.getUTCFullYear()}-${String(yesterdayDate.getUTCMonth() + 1).padStart(2, '0')}-${String(
      yesterdayDate.getUTCDate(),
    ).padStart(2, '0')}`,
  };
}

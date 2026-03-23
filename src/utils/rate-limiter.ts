import Database from 'better-sqlite3';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  max_per_hour:           number;
  max_per_day:            number;
  min_interval_seconds:   number;
}

export interface RateLimitResult {
  allowed:      boolean;
  retryAfter?:  number;   // seconds until next allowed action
  reason?:      string;
}

// ─── Default limits per channel type ─────────────────────────────────────────

export function getDefaultLimits(channelType: string): RateLimitConfig {
  switch (channelType) {
    case 'email':
      return { max_per_hour: 50,  max_per_day: 200,  min_interval_seconds: 5   };
    case 'sms':
      return { max_per_hour: 10,  max_per_day: 50,   min_interval_seconds: 30  };
    case 'facebook':
    case 'instagram':
      return { max_per_hour: 5,   max_per_day: 20,   min_interval_seconds: 60  };
    case 'reddit':
    case 'wordpress_forum':
      return { max_per_hour: 3,   max_per_day: 10,   min_interval_seconds: 120 };
    case 'webhook':
      return { max_per_hour: 100, max_per_day: 1000, min_interval_seconds: 1   };
    default:
      return { max_per_hour: 10,  max_per_day: 50,   min_interval_seconds: 30  };
  }
}

// Built by Weblease

// ─── Main rate-limit check ────────────────────────────────────────────────────

export function checkRateLimit(
  db:            Database.Database,
  channelId:     number,
  channelConfig?: string,
): RateLimitResult {

  // 1. Resolve channel type from DB
  const channel = db
    .prepare<[number], { type: string; config: string | null }>
    ('SELECT type, config FROM channels WHERE id = ?')
    .get(channelId);

  if (!channel) {
    return { allowed: false, reason: `Channel ${channelId} not found` };
  }

  // 2. Build effective config: defaults → channel.config → caller override
  let limits = getDefaultLimits(channel.type);

  const rawConfig = channelConfig ?? channel.config ?? '{}';
  try {
    const parsed: Partial<RateLimitConfig & { rate_limit?: Partial<RateLimitConfig> }> =
      JSON.parse(rawConfig);

    // Support both top-level overrides and a nested rate_limit object
    const overrides = parsed.rate_limit ?? parsed;
    if (typeof overrides.max_per_hour         === 'number') limits.max_per_hour         = overrides.max_per_hour;
    if (typeof overrides.max_per_day          === 'number') limits.max_per_day          = overrides.max_per_day;
    if (typeof overrides.min_interval_seconds === 'number') limits.min_interval_seconds = overrides.min_interval_seconds;
  } catch {
    // Ignore malformed JSON — use defaults
  }

  const nowMs   = Date.now();
  const nowSec  = Math.floor(nowMs / 1000);
  const hourAgo = new Date(nowMs - 3_600_000).toISOString();
  const dayAgo  = new Date(nowMs - 86_400_000).toISOString();

  // 3. Count activity_log entries for this channel in the sliding windows
  const { count_hour } = db
    .prepare<[number, string], { count_hour: number }>
    ('SELECT COUNT(*) AS count_hour FROM activity_log WHERE channel_id = ? AND created_at >= ?')
    .get(channelId, hourAgo)!;

  const { count_day } = db
    .prepare<[number, string], { count_day: number }>
    ('SELECT COUNT(*) AS count_day  FROM activity_log WHERE channel_id = ? AND created_at >= ?')
    .get(channelId, dayAgo)!;

  // 4. Fetch the most recent entry to check min_interval
  const last = db
    .prepare<[number], { created_at: string } | undefined>
    ('SELECT created_at FROM activity_log WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(channelId);

  // 5. Evaluate limits — most restrictive takes precedence

  if (last) {
    const lastSec  = Math.floor(new Date(last.created_at).getTime() / 1000);
    const elapsed  = nowSec - lastSec;
    const remaining = limits.min_interval_seconds - elapsed;

    if (remaining > 0) {
      return {
        allowed:    false,
        retryAfter: remaining,
        reason:     `Min interval not met — wait ${remaining}s (min: ${limits.min_interval_seconds}s)`,
      };
    }
  }

  if (count_hour >= limits.max_per_hour) {
    // Oldest entry in hour window determines when a slot opens
    const oldest = db
      .prepare<[number, string], { created_at: string } | undefined>
      ('SELECT created_at FROM activity_log WHERE channel_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1')
      .get(channelId, hourAgo);

    const retryAfter = oldest
      ? Math.max(1, 3600 - (nowSec - Math.floor(new Date(oldest.created_at).getTime() / 1000)))
      : 60;

    return {
      allowed:    false,
      retryAfter,
      reason:     `Hourly limit reached (${count_hour}/${limits.max_per_hour})`,
    };
  }

  if (count_day >= limits.max_per_day) {
    const oldest = db
      .prepare<[number, string], { created_at: string } | undefined>
      ('SELECT created_at FROM activity_log WHERE channel_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1')
      .get(channelId, dayAgo);

    const retryAfter = oldest
      ? Math.max(1, 86400 - (nowSec - Math.floor(new Date(oldest.created_at).getTime() / 1000)))
      : 3600;

    return {
      allowed:    false,
      retryAfter,
      reason:     `Daily limit reached (${count_day}/${limits.max_per_day})`,
    };
  }

  return { allowed: true };
}

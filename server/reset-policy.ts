/** Internal quota rules; infrastructure supplies normalized provider snapshots. */
export interface QuotaWindow {
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
}

export interface QuotaBalance {
  used?: number | null;
  remaining?: number | null;
  limit?: number | null;
  resetsAt?: string | null;
}

export interface ProviderQuota {
  providerId: string;
  status: "available" | "unavailable" | "error";
  fetchedAt?: string | null;
  windows: readonly QuotaWindow[];
  balances?: readonly QuotaBalance[];
}

export interface QuotaAssessment {
  state: "available" | "exhausted" | "unknown";
  resetAt: number | null;
}

export const resetBufferMs = 60_000;
const clockGraceMs = 600_000;
const usageStopPattern =
  /(?:you(?:'ve| have) (?:hit|reached) (?:your|the) (?:[\w-]+ ){0,2}limit\b|(?:usage|rate|weekly|session|request|token) limit (?:has been )?(?:reached|exceeded)|(?:usage|rate)_limit|too many requests|insufficient_quota|out of (?:credits|usage)|exceeded (?:your )?(?:usage|quota)|API Error:\s*429)/i;
const durationResetPattern =
  /(?:try again in|retry (?:in|after)|resets? in)\s+((?:\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])(?:\s*(?:,|and)?\s*))+)/i;
// Claude: "resets 2:20am (Europe/Berlin)". Codex: "try again at Oct 14th, 2026 9:36 AM".
const clockResetPattern =
  /(?:try again at|resets?(?: at)?)\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?(?:\s*\(([\w+-]+(?:\/[\w+-]+)*)\))?/i;
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Owns usage-stop recognition and reset selection. Example: policy.assess(quota). */
export class UsageResetPolicy {
  private readonly localZone: string;

  /** Providers print zoneless clock times in the daemon machine's zone. */
  constructor(localZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    this.localZone = localZone;
  }

  isUsageStop(message: string, source: "error" | "output" = "error"): boolean {
    const match = message
      .trim()
      .replace(/[\u2018\u2019]/g, "'")
      .match(usageStopPattern);
    return match !== null && (source === "error" || match.index === 0);
  }

  /** Pick the provider's usable snapshot; Paseo lists one entry per login. */
  select(quotas: readonly ProviderQuota[], providerId: string): ProviderQuota | undefined {
    const matches = quotas.filter((quota) => quota.providerId === providerId);
    return matches.find((quota) => quota.status === "available") ?? matches[0];
  }

  reportedReset(message: string, now: number): number | null {
    return this.durationReset(message, now) ?? this.clockReset(message, now);
  }

  private durationReset(message: string, now: number): number | null {
    const duration = message.match(durationResetPattern)?.[1];
    if (!duration) return null;
    const units: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    const segments = [...duration.matchAll(/(\d+(?:\.\d+)?)\s*([smhd])/gi)];
    const wait = segments.reduce(
      (total, part) => total + Number(part[1]) * units[part[2].toLowerCase()],
      0,
    );
    return Number.isFinite(wait) && wait > 0 ? now + wait : null;
  }

  private clockReset(message: string, now: number): number | null {
    const match = message.match(clockResetPattern);
    if (!match) return null;
    const [, monthName, day, year, hourText, minuteText = "0", meridiem] = match;
    const zone = match[7] ?? this.localZone;
    const month = monthName ? months.indexOf(monthName.slice(0, 3).toLowerCase()) : null;
    const clockHour = Number(hourText);
    if (month === -1 || clockHour < 1 || clockHour > 12 || Number(minuteText) > 59) return null;
    const hour = (clockHour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0);
    try {
      const today = new Date(wallClock(now, zone));
      const at = (years: number, days: number): number =>
        zonedInstant(
          Date.UTC(
            year ? Number(year) : today.getUTCFullYear() + years,
            month ?? today.getUTCMonth(),
            day ? Number(day) : today.getUTCDate() + days,
            hour,
            Number(minuteText),
          ),
          zone,
        );
      // A time without a date or year means its next occurrence; one that just passed is now.
      const first = at(0, 0);
      if (year || first >= now - clockGraceMs) return first;
      return month == null ? at(0, 1) : at(1, 0);
    } catch {
      return null;
    }
  }

  assess(quota: ProviderQuota | undefined): QuotaAssessment {
    if (!quota || quota.status !== "available") return { state: "unknown", resetAt: null };
    const metered = quota.windows.some(
      (window) => window.usedPct != null || window.remainingPct != null,
    );
    const windows = quota.windows.filter(
      (window) => (window.usedPct ?? 0) >= 100 || (window.remainingPct ?? 100) <= 0,
    );
    // Plan windows govern a metered provider; an empty prepaid balance beside them never resets.
    const balances = (quota.balances ?? []).filter(
      (balance) =>
        (!metered || balance.resetsAt != null) &&
        ((balance.remaining ?? 1) <= 0 ||
          (balance.limit != null && balance.limit > 0 && (balance.used ?? 0) >= balance.limit)),
    );
    const exhausted = [...windows, ...balances];
    if (exhausted.length) return { state: "exhausted", resetAt: this.latestReset(exhausted) };
    const known = metered || (quota.balances ?? []).some((balance) => balance.remaining != null);
    return { state: known ? "available" : "unknown", resetAt: null };
  }

  private latestReset(exhausted: readonly { resetsAt?: string | null }[]): number | null {
    const resets = exhausted.map((window) => Date.parse(window.resetsAt ?? ""));
    if (resets.some((timestamp) => !Number.isFinite(timestamp))) return null;
    return Math.max(...resets);
  }
}

/** An instant's wall-clock fields in an IANA zone, encoded as a UTC timestamp. */
function wallClock(instant: number, zone: string): number {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const field = (type: string): number => Number(fields.find((part) => part.type === type)?.value);
  return Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
}

/** The instant at which the zone's wall clock reads the given UTC-encoded fields. */
function zonedInstant(wall: number, zone: string): number {
  const offset = (instant: number): number => wallClock(instant, zone) - instant;
  return wall - offset(wall - offset(wall));
}

/**
 * Cross-session aggregation: many per-session fold results → one card snapshot.
 *
 * Pure and synchronous, so the numbers the card shows are testable without a
 * host: the service layer owns the session listing, the cold reads and the
 * transport, this file owns only the arithmetic.
 *
 * The card offers four ranges, and each is computed from the same per-day
 * tables: a range is a lower date bound (`start = today - (days - 1)`) over
 * days, messages, per-day model tokens and the per-day hour histogram, while
 * each session is counted once when any of its active days falls inside the
 * range. `Peak hour` is computed inside the range too — since this fork added
 * `today`, an all-time peak would be the wrong answer on the default view.
 *
 * The one bounded output is the shipped day list: the ranges count every
 * active day, while `days` and `modelDays` carry only the most recent
 * {@link STATS_DAY_LIMIT} days so a long-lived install cannot grow the
 * response without limit.
 */
import {
  STATS_DAY_LIMIT, STATS_RANGES, STATS_VERSION,
  type StatsDay, type StatsModelDayRow, type StatsModelTokens,
  type StatsRangeId, type StatsRangeTotals, type StatsRanges, type StatsSessionUsage,
  type StatsSnapshot,
} from '../../shared/stats.ts';
import { rangeStart } from '../../shared/stats.ts';
import { HOURS_PER_DAY, UNKNOWN_MODEL } from './unit.ts';

/** Counters the aggregate needs from outside the fold. */
export interface AggregateOptions {
  /** Computation time, epoch ms. */
  readonly now: number;
  /** Sessions still being folded. */
  readonly pending: number;
  /** Sessions whose logs could not be read. */
  readonly missed: number;
}

/** Ascending comparator for day keys, which sort correctly as strings. */
const byKey = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Busiest first, ties broken by name so the answer is stable. */
const byTokens = (left: StatsModelTokens, right: StatsModelTokens): number =>
  (right[1] - left[1] || byKey(left[0], right[0]));

/** Highest-scoring key, ties broken by the smallest key so the answer is stable. */
function peak(counts: ReadonlyMap<string, number>, skip: string): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (key === skip || count <= 0) continue;
    if (count > bestCount || (count === bestCount && best !== null && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/** Everything the four ranges are computed from. */
interface Collected {
  /** One set of active days per session that did work of its own. */
  readonly sessionDates: Set<string>[];
  /** Local day → human prompts. */
  readonly prompts: Map<string, number>;
  /** Local day → local hour → prompts. */
  readonly hoursByDay: Map<string, Map<number, number>>;
  /** Local day → model → tokens. */
  readonly modelDays: Map<string, Map<string, number>>;
}

/** Sum one session's view into the collected tables. */
function collect(value: StatsSessionUsage, collected: Collected): void {
  if (value.prompts <= 0 && value.tokens <= 0) return;
  const dates = new Set<string>();
  for (const [date, count] of value.days) {
    dates.add(date);
    collected.prompts.set(date, (collected.prompts.get(date) ?? 0) + count);
  }
  for (const [day, hour, count] of value.dayHours) {
    dates.add(day);
    const perHour = collected.hoursByDay.get(day) ?? new Map<number, number>();
    perHour.set(hour, (perHour.get(hour) ?? 0) + count);
    collected.hoursByDay.set(day, perHour);
  }
  for (const [date, at, tokens] of value.modelDays) {
    /* The index addresses the session's own model table; a row that cannot be
       resolved is dropped rather than attributed to the wrong model. */
    const model = value.models[at]?.[0];
    if (model === undefined) continue;
    dates.add(date);
    const perModel = collected.modelDays.get(date) ?? new Map<string, number>();
    perModel.set(model, (perModel.get(model) ?? 0) + tokens);
    collected.modelDays.set(date, perModel);
  }
  collected.sessionDates.push(dates);
}

/**
 * Totals for one range.
 *
 * @param collected - the library's tables.
 * @param start - first day key the range covers, or null for `all`.
 * @returns the tiles' numbers and the range's model list.
 */
function totalsFor(collected: Collected, start: string | null): StatsRangeTotals {
  const inRange = (date: string): boolean => start === null || date >= start;
  let sessions = 0;
  for (const dates of collected.sessionDates) {
    for (const date of dates) {
      if (!inRange(date)) continue;
      sessions += 1;
      break;
    }
  }
  const active = new Set<string>();
  let messages = 0;
  for (const [date, count] of collected.prompts) {
    if (!inRange(date)) continue;
    messages += count;
    active.add(date);
  }
  const models = new Map<string, number>();
  let tokens = 0;
  for (const [date, perModel] of collected.modelDays) {
    if (!inRange(date)) continue;
    active.add(date);
    for (const [model, amount] of perModel) {
      tokens += amount;
      models.set(model, (models.get(model) ?? 0) + amount);
    }
  }
  const list: StatsModelTokens[] = [...models.entries()]
    .filter(([model, amount]) => model !== UNKNOWN_MODEL && amount > 0)
    .sort(byTokens);
  return {
    sessions,
    messages,
    tokens,
    activeDays: active.size,
    topModel: peak(models, UNKNOWN_MODEL),
    models: list,
  };
}

/**
 * The busiest local hour inside one range.
 *
 * Ties go to the earliest hour, which is the rule the single-histogram version
 * used; only hours the range actually saw can win, so `today` on a quiet
 * morning answers null instead of yesterday's peak.
 *
 * @param collected - the library's tables.
 * @param start - first day key the range covers, or null for `all`.
 * @returns the hour, or null when the range saw no prompt.
 */
function peakHour(collected: Collected, start: string | null): number | null {
  const counts = new Map<number, number>();
  for (const [day, perHour] of collected.hoursByDay) {
    if (start !== null && day < start) continue;
    for (const [hour, count] of perHour) counts.set(hour, (counts.get(hour) ?? 0) + count);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const count = counts.get(hour) ?? 0;
    if (count > bestCount) {
      best = hour;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Aggregate every session's fold result into the card's snapshot.
 *
 * @param values - one view per visible stored session.
 * @param options - computation time and the service's progress counters.
 * @returns the snapshot the route serves.
 */
export function aggregateUsage(
  values: Iterable<StatsSessionUsage>,
  options: AggregateOptions,
): StatsSnapshot {
  const collected: Collected = {
    sessionDates: [],
    prompts: new Map<string, number>(),
    hoursByDay: new Map<string, Map<number, number>>(),
    modelDays: new Map<string, Map<string, number>>(),
  };
  for (const value of values) collect(value, collected);

  const ranges = {} as Record<StatsRangeId, StatsRangeTotals>;
  const busyHours = {} as Record<StatsRangeId, number | null>;
  for (const range of STATS_RANGES) {
    const start = rangeStart(range, options.now);
    ranges[range] = totalsFor(collected, start);
    busyHours[range] = peakHour(collected, start);
  }

  /* Both shipped tables follow one cutoff, so the chart cannot reference a day
     the heatmap's own window dropped. */
  const dates = [...new Set([...collected.prompts.keys(), ...collected.modelDays.keys()])].sort(byKey);
  const cutoff = dates.length > STATS_DAY_LIMIT ? dates[dates.length - STATS_DAY_LIMIT] ?? null : null;
  const days: StatsDay[] = [];
  for (const date of dates) {
    if (cutoff !== null && date < cutoff) continue;
    const count = collected.prompts.get(date) ?? 0;
    if (count > 0) days.push([date, count]);
  }
  const modelDays: StatsModelDayRow[] = [];
  for (const [date, perModel] of [...collected.modelDays.entries()].sort(([left], [right]) => byKey(left, right))) {
    if (cutoff !== null && date < cutoff) continue;
    for (const [model, tokens] of [...perModel.entries()].sort(([left], [right]) => byKey(left, right))) {
      if (tokens > 0) modelDays.push([date, model, tokens]);
    }
  }
  return {
    version: STATS_VERSION,
    ranges: ranges as StatsRanges,
    busyHours,
    days,
    modelDays,
    pending: options.pending,
    missed: options.missed,
    computedAt: options.now,
  };
}

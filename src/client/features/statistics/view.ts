/**
 * Snapshot → card data: the card's own presentation rules.
 *
 * Two views share one snapshot. `Overview` draws 182 days (26 columns × 7 rows)
 * ending on the Saturday of the current week, with the day rows running
 * Sunday-first — the window the reference computes — and levels of
 * `ceil(count / busiest day * 4)`; days after today are transparent rather than
 * empty, which is why the card data marks them instead of giving them a level.
 * `Models` draws one bar per day that produced tokens, stacked by model and
 * scaled to the axis the reference derives from the busiest day.
 *
 * The range switch filters the tiles, the chart and the peak hour, but not the
 * heatmap: the heatmap is a fixed 182-day window, which is what keeps the
 * `today` view from reading as an empty card.
 */
import {
  localDayKey, rangeStart,
  type StatsDay, type StatsModelTokens, type StatsRangeId, type StatsSnapshot,
} from '../../../shared/stats.ts';
import { STATS_COPY } from './locales.ts';
import {
  HEAT_COLUMNS, HEAT_ROWS, LEGEND_LIMIT, heatLevel,
  type ChartDay, type HeatCell, type LegendRow, type StatsCardData, type StatsModelsData,
  type StatsOption, type StatsOverviewData, type StatsTabId, type StatsTile,
} from './card.ts';
import { formatCount, formatDayLabel, formatHour, formatTokens } from './format.ts';

export { formatCount, formatDayLabel, formatHour, formatTokens };

/** Days the heatmap draws: 26 weeks. */
export const HEAT_DAYS = HEAT_COLUMNS * HEAT_ROWS;

/** Placeholder the reference shows for a metric it has no data for. */
const EMPTY = '\u2014';

/** The reference's own tabs, in its order. */
export const STATS_TABS: readonly StatsOption<StatsTabId>[] = [
  { id: 'overview', label: '概览' },
  { id: 'models', label: '用量' },
];

/** The card's ranges, shortest first. */
export const STATS_RANGE_OPTIONS: readonly StatsOption<StatsRangeId>[] = [
  { id: 'today', label: '今天' },
  { id: '7d', label: '近7天' },
  { id: '30d', label: '近30天' },
  { id: 'all', label: '全部' },
];

/** Which view and range the card is showing. */
export interface StatsViewState {
  readonly tab: StatsTabId;
  readonly range: StatsRangeId;
}

/** What a freshly mounted card shows: today's numbers. */
export const INITIAL_STATS_VIEW: StatsViewState = { tab: 'overview', range: 'today' };

/**
 * Consecutive active days ending on or just before today.
 *
 * The streak survives an untouched morning: when today has no prompts yet the
 * run is counted from yesterday, which is the friendly rule calendars use.
 *
 * @param days - the snapshot's day table, oldest first.
 * @param now - the instant "today" is read from.
 * @returns the number of consecutive days, 0 when yesterday is empty too.
 */
export function activeStreak(days: readonly StatsDay[], now: Date): number {
  const active = new Set(days.filter(([, count]) => count > 0).map(([date]) => date));
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!active.has(localDayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (active.has(localDayKey(cursor.getTime()))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/**
 * The reference hides models below this share of the range's tokens, in the
 * chart's bars and in the legend alike (`totalTokens * 5e-4`).
 */
const MODEL_SHARE_FLOOR = 5e-4;

/** Distinct shades the reference's model ramp produces before it clamps. */
const MODEL_SHADES = 6;

/** What the card draws for the 182-day window. */
export interface HeatWindow {
  /** One cell per day, column-major: `column * 7 + row`, Monday first. */
  readonly heat: readonly HeatCell[];
  /** First index drawn after today; those cells stay transparent. */
  readonly futureFrom: number;
}

/**
 * Lay the host's sparse day counts out on the 26-week grid.
 *
 * Every column is one calendar week with Monday in the first row, so the grid
 * reads like a calendar rather than starting on Sunday. The window ends on the
 * Sunday of the current week, which is what makes the first cell of a column a
 * Monday; days after today stay transparent.
 *
 * @param days - local day keys with their counts.
 * @param now - the current instant (injectable for tests).
 * @returns the cells and where "today" ends.
 */
export function heatWindow(days: readonly StatsDay[], now: Date = new Date()): HeatWindow {
  const counts = new Map(days);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(today);
  end.setDate(end.getDate() + ((7 - end.getDay()) % 7));
  const start = new Date(end);
  start.setDate(start.getDate() - (HEAT_DAYS - 1));

  const keys: string[] = [];
  const raw: number[] = [];
  let peak = 0;
  let futureFrom = HEAT_DAYS;
  for (let index = 0; index < HEAT_DAYS; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = localDayKey(date.getTime());
    const future = date > today;
    const count = future ? 0 : counts.get(key) ?? 0;
    if (future && futureFrom === HEAT_DAYS) futureFrom = index;
    keys.push(key);
    raw.push(count);
    peak = Math.max(peak, count);
  }
  const heat = raw.map((count, index): HeatCell => ({
    date: keys[index] ?? '',
    count,
    level: index >= futureFrom ? null : heatLevel(count, peak),
  }));
  return { heat, futureFrom };
}

/**
 * The reference's y-axis steps: from `1/2/5/10/20/50` scaled to the magnitude
 * of `max / 6`, keep the candidates that fit in six steps and take the one
 * whose top is lowest, preferring four steps on a tie.
 *
 * @param max - the busiest day's tokens.
 * @returns the tick values, lowest first; empty when there is nothing to scale.
 */
export function tokenTicks(max: number): number[] {
  if (!(max > 0)) return [];
  const scale = 10 ** Math.floor(Math.log10(max / 6));
  const candidates = [1, 2, 5, 10, 20, 50]
    .map(step => ({ step: Math.max(1, step * scale), steps: 0 }))
    .map(candidate => ({ ...candidate, steps: Math.ceil(max / candidate.step) }))
    .filter(candidate => candidate.steps <= 6);
  if (candidates.length === 0) return [max];
  const best = candidates.reduce((left, right) => {
    const leftTop = left.step * left.steps;
    const rightTop = right.step * right.steps;
    if (rightTop < leftTop) return right;
    if (rightTop === leftTop && Math.abs(right.steps - 4) < Math.abs(left.steps - 4)) return right;
    return left;
  });
  return Array.from({ length: best.steps + 1 }, (_, index) => index * best.step);
}

/**
 * The colour of the n-th busiest model.
 *
 * The reference computes `hsl(217 70% min(88, 58 + 7n)%)`, which flattens into
 * six shades; the theme carries those six so both themes can express them.
 *
 * @param index - position in the range's model list.
 * @returns a theme variable holding that shade.
 */
export function modelColor(index: number): string {
  const shade = Math.min(Math.max(index, 0) + 1, MODEL_SHADES);
  return `var(--ccd-stats-model-${String(shade)})`;
}

/**
 * The `Overview` body for one range.
 *
 * @param snapshot - the host's aggregate.
 * @param range - the selected range.
 * @param now - the current instant (injectable for tests).
 * @param language - copy language.
 * @returns tiles, heat cells and today's cell index.
 */
export function buildOverview(
  snapshot: StatsSnapshot,
  range: StatsRangeId,
  now: Date = new Date(),
  language: 'zh' | 'en' = 'zh',
): StatsOverviewData {
  const copy = STATS_COPY[language];
  const totals = snapshot.ranges[range];
  const window = heatWindow(snapshot.days, now);
  const hour = snapshot.busyHours[range] ?? null;
  const tiles: StatsTile[] = [
    { label: copy.tiles[0], value: formatCount(totals.sessions) },
    { label: copy.tiles[1], value: formatCount(totals.messages) },
    { label: copy.tiles[2], value: formatTokens(totals.tokens) },
    /* `Active days` collapses to 0-or-1 inside a single day, so today's view
       shows the streak instead — the one habit number a one-day window can
       still answer honestly. */
    range === 'today'
      ? { label: copy.streak, value: formatCount(activeStreak(snapshot.days, now)) }
      : { label: copy.tiles[3], value: formatCount(totals.activeDays) },
    { label: copy.tiles[4], value: hour === null ? EMPTY : formatHour(hour) },
    { label: copy.tiles[5], value: totals.topModel ?? EMPTY, small: true },
  ];
  return {
    tiles,
    heat: window.heat,
    futureFrom: window.futureFrom,
    today: window.futureFrom - 1,
  };
}

/**
 * The `Models` body for one range.
 *
 * @param snapshot - the host's aggregate.
 * @param range - the selected range.
 * @param now - the current instant (injectable for tests).
 * @returns the chart and its legend.
 */
export function buildModels(
  snapshot: StatsSnapshot,
  range: StatsRangeId,
  now: Date = new Date(),
  language: 'zh' | 'en' = 'zh',
): StatsModelsData {
  const totals = snapshot.ranges[range];
  const start = rangeStart(range, now.getTime());
  const visible: readonly StatsModelTokens[] = totals.models.filter(([, tokens]) =>
    tokens >= totals.tokens * MODEL_SHARE_FLOOR);
  const index = new Map(visible.map(([model], at) => [model, at]));

  const rows = new Map<string, { model: string; tokens: number }[]>();
  for (const [date, model, tokens] of snapshot.modelDays) {
    if (start !== null && date < start) continue;
    const list = rows.get(date) ?? [];
    list.push({ model, tokens });
    rows.set(date, list);
  }
  const days: ChartDay[] = [...rows.keys()].sort().map(date => {
    const segments = (rows.get(date) ?? [])
      .filter(entry => index.has(entry.model))
      .sort((left, right) => (index.get(left.model) ?? 0) - (index.get(right.model) ?? 0))
      .map(entry => ({
        model: entry.model,
        tokens: entry.tokens,
        color: modelColor(index.get(entry.model) ?? 0),
      }));
    return {
      date,
      label: formatDayLabel(date, language),
      tokens: segments.reduce((sum, segment) => sum + segment.tokens, 0),
      segments,
    };
  });
  const steps = tokenTicks(days.reduce((max, day) => Math.max(max, day.tokens), 0));

  /* Every number in this view is the selected range's own: the legend prints
     the tokens that range attributed to the model and its share of the range.
     Lifetime in/out counters read the same under every range, which is exactly
     the confusion a four-range card must not create. */
  const legend: LegendRow[] = visible.map(([model, tokens], at) => ({
    model,
    color: modelColor(at),
    usage: formatTokens(tokens),
    percent: `${((tokens / (totals.tokens || 1)) * 100).toFixed(1)}%`,
  }));

  return {
    ticks: steps.map(formatTokens),
    top: steps.at(-1) ?? 1,
    days,
    legend,
    moreCount: Math.max(0, legend.length - LEGEND_LIMIT),
  };
}

/**
 * Build everything the card draws for one snapshot and view state.
 *
 * @param snapshot - the host's aggregate.
 * @param state - the selected tab and range.
 * @param now - the current instant (injectable for tests).
 * @param language - copy language.
 * @returns the card data.
 */
export function buildCardData(
  snapshot: StatsSnapshot,
  state: StatsViewState,
  now: Date = new Date(),
  language: 'zh' | 'en' = 'zh',
): StatsCardData {
  const copy = STATS_COPY[language];
  /* `today` has one day of history, so the daily chart has nothing to draw:
     the card hides the view and always lands on the overview. */
  const tab: StatsTabId = state.range === 'today' ? 'overview' : state.tab;
  const tabs = tab === 'overview' && state.range === 'today' ? STATS_TABS.slice(0, 1) : STATS_TABS;
  return {
    tab,
    tabs: tabs.map((option, index) => ({ ...option, label: copy.tabs[index]! })),
    ranges: STATS_RANGE_OPTIONS.map((option, index) => ({ ...option, label: copy.ranges[index]! })),
    range: state.range,
    overview: tab === 'overview' ? buildOverview(snapshot, state.range, now, language) : null,
    models: tab === 'models' ? buildModels(snapshot, state.range, now, language) : null,
  };
}

/**
 * The hero's continue card: the sessions this installation touched last.
 *
 * Plain DOM for the same reason the statistics card is: it lives in a container
 * the host does not render, so there is no React root to mount into. The rows
 * come from {@link RecentSessionsPort}, which is a snapshot read of the host's
 * own session catalog — the card keeps no state, so a title landing or a
 * session disappearing is one re-render away.
 *
 * The card is deliberately quiet: a title line and a `workspace · when` line
 * per row, no badges, no counts. It sits beside the statistics card, and two
 * loud cards on the blank page would read as a dashboard.
 */
import type { RecentSessionsPort } from '../../contracts/ports.ts';
import { formatDayLabel } from './format.ts';
import { localDayKey } from '../../../shared/stats.ts';
import { RECENT_COPY } from './locales.ts';

/** Marks the card container; the hero grid positions it. */
export const RECENT_ATTRIBUTE = 'data-ccd-recent-card';

/** The mounted card. */
export interface RecentCard {
  readonly element: HTMLElement;
  /** Redraw from the port's current list. */
  refresh(): void;
  /** Stop observing the catalog. */
  dispose(): void;
}

/**
 * How long ago one session was touched, in the card's own words.
 *
 * Below a day the phrasing counts minutes and hours; then calendar days, which
 * is what makes "yesterday" survive a time zone or a daylight-saving step that
 * a millisecond division would get wrong.
 *
 * @param time - last update, epoch ms.
 * @param now - the current instant.
 * @param language - copy language.
 * @returns the label.
 */
export function relativeTime(time: number, now: number, language: 'zh' | 'en' = 'zh'): string {
  const copy = RECENT_COPY[language];
  const delta = now - time;
  if (delta < 60_000) return copy.justNow;
  if (delta < 3_600_000) return copy.minutes(Math.max(1, Math.floor(delta / 60_000)));
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThen = new Date(time);
  startOfThen.setHours(0, 0, 0, 0);
  const days = Math.round((startOfToday.getTime() - startOfThen.getTime()) / 86_400_000);
  if (days <= 0) return copy.hours(Math.max(1, Math.floor(delta / 3_600_000)));
  if (days === 1) return copy.yesterday;
  if (days < 7) return copy.days(days);
  return formatDayLabel(localDayKey(time), language);
}

/**
 * Build the continue card.
 *
 * @param document - renderer document the card belongs to.
 * @param port - the session catalog the rows are read from.
 * @param language - copy language.
 * @returns the detached card and its lifecycle hooks.
 */
export function createRecentCard(
  document: Document,
  port: RecentSessionsPort,
  language: 'zh' | 'en' = 'zh',
): RecentCard {
  const copy = RECENT_COPY[language];
  const card = document.createElement('div');
  card.setAttribute(RECENT_ATTRIBUTE, 'true');

  const header = document.createElement('div');
  header.className = 'ccd-recent-header';
  header.textContent = copy.title;

  const list = document.createElement('ul');
  list.className = 'ccd-recent-list';

  const render = (): void => {
    const rows = port.get();
    list.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'ccd-recent-empty';
      empty.textContent = copy.empty;
      list.append(empty);
      return;
    }
    const now = Date.now();
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'ccd-recent-item';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ccd-recent-row';
      button.title = row.title;
      if (row.running) button.dataset['running'] = 'true';

      const line = document.createElement('span');
      line.className = 'ccd-recent-line';
      if (row.running) {
        const dot = document.createElement('span');
        dot.className = 'ccd-recent-dot';
        dot.setAttribute('aria-hidden', 'true');
        line.append(dot);
      }
      const title = document.createElement('span');
      title.className = 'ccd-recent-title';
      title.textContent = row.title;
      line.append(title);

      const meta = document.createElement('span');
      meta.className = 'ccd-recent-meta';
      if (row.workspace !== null) {
        const space = document.createElement('span');
        space.className = 'ccd-recent-space';
        space.textContent = row.workspace;
        const separator = document.createElement('span');
        separator.className = 'ccd-recent-separator';
        separator.setAttribute('aria-hidden', 'true');
        separator.textContent = '\u00B7';
        meta.append(space, separator);
      }
      const when = document.createElement('span');
      when.className = 'ccd-recent-when';
      when.textContent = relativeTime(row.updatedAt, now, language);
      meta.append(when);

      button.append(line, meta);
      button.addEventListener('click', () => port.open(row.id));
      item.append(button);
      list.append(item);
    }
  };

  card.append(header, list);
  render();
  const unsubscribe = port.subscribe(render);
  return {
    element: card,
    refresh: render,
    dispose: unsubscribe,
  };
}

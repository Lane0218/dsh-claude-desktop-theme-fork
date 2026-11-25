/**
 * Append the hero's card group to the composer stack and position it under the
 * greeting. The observer recreates the container after phase changes. Render
 * when StatsSource supplies the first completed snapshot.
 *
 * The group is two cards in one 770px grid: the statistics card and the
 * "continue" card. They are one container because they are one composition —
 * equal height, one left edge, one right edge with the Composer — but their
 * lifecycles differ: the statistics card is rebuilt whenever the snapshot, the
 * view, the day or the language changes, while the continue card subscribes to
 * the session catalog itself and is only rebuilt with the container.
 */
import { localDayKey, sameStatsDisplay, type StatsRangeId, type StatsSnapshot } from '../../../shared/stats.ts';
import type { CleanupScope } from '../../core/cleanup.ts';
import type { Logger, RecentSessionsPort } from '../../contracts/ports.ts';
import { frameScheduler } from '../../compat/frame.ts';
import { hostSelectors } from '../../compat/host-dom.ts';
import { recordsIntroduce, recordsTouch } from '../../compat/mutation-scope.ts';
import { CARDS_ATTRIBUTE, createStatsCard, type StatsCard } from './card.ts';
import { createRecentCard, type RecentCard } from './recent.ts';
import type { StatsSource } from './source.ts';
import { buildCardData, INITIAL_STATS_VIEW, type StatsViewState } from './view.ts';

/**
 * The hero-phase conversation root. `data-phase` sits on the conversation root
 * itself (`[data-conversation-content]` is its inner body), so the anchor is
 * read on its own rather than combined with the content attribute.
 */
const HERO = '[data-phase="hero"]';

/** Distance kept between the greeting's lower edge and the card group. */
const GAP_PX = 20;

/** Custom property carrying that measured offset; CSS falls back to the default. */
const GAP_PROPERTY = '--ccd-stats-gap';

/**
 * Keep the card group mounted inside the hero stack.
 *
 * @param document - renderer document carrying the conversation page.
 * @param scope - cleanup scope owning the observer, the subscription and the cards.
 * @param logger - sink for observer failures; the native page stays without a group.
 * @param source - snapshot reader the statistics card redraws from.
 * @param recent - session catalog for the continue card, or null on a build without one.
 */
export function mountStatisticsCard(
  document: Document,
  scope: CleanupScope,
  logger: Logger,
  source: StatsSource,
  recent: RecentSessionsPort | null = null,
): void {
  let snapshot: StatsSnapshot | null = source.current;
  let view: StatsViewState = INITIAL_STATS_VIEW;
  let rendered: { snapshot: StatsSnapshot; view: StatsViewState; day: string; language: 'zh' | 'en' } | null = null;
  let hero: HTMLElement | null = null;
  let host: HTMLElement | null = null;
  let cards: HTMLElement | null = null;
  let grid: HTMLElement | null = null;
  let card: StatsCard | null = null;
  let rail: RecentCard | null = null;

  /** Current page language; the copy of both cards follows it. */
  const language = (): 'zh' | 'en' =>
    (document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh' : 'en');

  const detach = (): void => {
    card = null;
    if (rail !== null) {
      rail.dispose();
      rail = null;
    }
    cards?.remove();
    cards = null;
    grid = null;
    host = null;
  };

  /* The greeting's height follows its type (and its language), so the offset is
     measured rather than frozen into the stylesheet: the group's `top` is the
     greeting's own top plus its height plus the gap. */
  const measure = (): void => {
    if (cards === null) return;
    const greeting = document.querySelector<HTMLElement>(`${HERO} ${hostSelectors(document).heroRoot}`);
    if (greeting !== null) cards.style.setProperty(GAP_PROPERTY, `${greeting.offsetHeight + GAP_PX}px`);
    card?.layout();
  };

  /** Swap the statistics card inside the group; the continue card stays put. */
  function replaceCard(data: StatsSnapshot, lang: 'zh' | 'en'): void {
    if (grid === null) return;
    const next = createStatsCard(document, buildCardData(data, view, new Date(), lang), {
      onTab: tab => {
        /* Re-selecting the current view must not rebuild the card under the
           pointer that just clicked it. */
        if (tab === view.tab) return;
        view = { ...view, tab };
        sync();
      },
      onRange: (range: StatsRangeId) => {
        if (range === view.range) return;
        /* `today` has no daily chart, so the card shows the overview and the
           view state follows: switching back to a longer range must not
           resurrect a view the card could not show. */
        view = { range, tab: range === 'today' ? 'overview' : view.tab };
        sync();
      },
    }, lang);
    if (card !== null) card.element.replaceWith(next.element);
    else grid.prepend(next.element);
    card = next;
    measure();
  }

  /** Create the group for one stack. */
  function attach(stack: HTMLElement, data: StatsSnapshot, lang: 'zh' | 'en'): void {
    cards = document.createElement('div');
    cards.setAttribute(CARDS_ATTRIBUTE, 'true');
    grid = document.createElement('div');
    grid.className = 'ccd-hero-cards-grid';
    cards.append(grid);
    if (recent !== null) {
      rail = createRecentCard(document, recent, lang);
      grid.append(rail.element);
    }
    const greeting = stack.querySelector<HTMLElement>(hostSelectors(document).heroRoot);
    if (greeting?.parentElement === stack) greeting.after(cards);
    else stack.prepend(cards);
    host = stack;
    replaceCard(data, lang);
  }

  function sync(): void {
    hero = document.querySelector<HTMLElement>(HERO);
    const stack = hero?.querySelector<HTMLElement>(hostSelectors(document).heroComposerStack) ?? null;
    source.setActive(stack !== null);
    if (stack === null || snapshot === null) {
      detach();
      return;
    }
    const now = Date.now(), day = localDayKey(now), lang = language();
    if (cards === null || !cards.isConnected || host !== stack || rendered === null || rendered.language !== lang) {
      detach();
      attach(stack, snapshot, lang);
      rendered = { snapshot, view, day, language: lang };
      return;
    }
    if (!sameStatsDisplay(rendered.snapshot, snapshot) || rendered.view !== view || rendered.day !== day) {
      rendered = { snapshot, view, day, language: lang };
      replaceCard(snapshot, lang);
      return;
    }
    measure();
  }

  /* The group is a fixed 770px, so a resize only changes how many x-axis
     labels the chart can show. */
  const relayout = () => {
    card?.layout();
  };

  let observer: MutationObserver | undefined;
  /* One pass per paint: the transcript streams many batches between frames and
     the cards only have to be connected when a frame is drawn. */
  const frames = frameScheduler(() => sync(), document.defaultView);
  /**
   * Whether a batch can move the cards.
   *
   * Three things matter: the hero root the stack lives in, the greeting whose
   * height sets the group's offset, and the group itself (its own header
   * controls write inside it). A batch anywhere else — a streaming transcript
   * on the chat page, the right pane, the sidebar — cannot.
   */
  const relevant = (records: readonly MutationRecord[]): boolean => {
    if (records.some(record => record.target === document.documentElement && record.attributeName === 'lang')) return true;
    if (records.some(record => record.type === 'attributes' && record.attributeName === 'data-phase')) return true;
    if (hero !== null && recordsTouch(records, hero)) return true;
    return recordsIntroduce(records, HERO);
  };
  try {
    observer = new MutationObserver(records => {
      if (relevant(records)) frames.schedule();
    });
    /* The phase swap replaces the whole conversation body, so the cards have to
       follow it; a guarded insert keeps our own write from feeding the loop. */
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    sync();
  } catch (error) {
    frames.cancel();
    observer?.disconnect();
    source.setActive(false);
    detach();
    logger.error('statistics: card mount failed', error);
    return;
  }

  window.addEventListener('resize', relayout);
  const unsubscribe = source.subscribe(next => {
    snapshot = next;
    sync();
  });

  scope.add(() => {
    frames.cancel();
    window.removeEventListener('resize', relayout);
    observer?.disconnect();
    unsubscribe();
    source.setActive(false);
    detach();
  });
}

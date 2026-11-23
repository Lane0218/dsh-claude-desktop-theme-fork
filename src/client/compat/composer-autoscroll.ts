import type { Disposer } from '../contracts/ports.ts';

/** The transcript scrollers the host renders; either may be the visible one. */
const SCROLLERS = '.icaHSq_scroll, .ST7X_W_scrollBody';

/**
 * Follow the tail after the human sends.
 *
 * The fork hides the send control, so Enter inside the composer is the one
 * send path; the transcript is pinned to its tail right after that keystroke
 * (and once more after the layout settles). Reading history is not disturbed:
 * nothing scrolls unless a send starts in the composer.
 *
 * @param document - renderer document carrying the composer and transcript.
 * @param report - sink for listener failures; scrolling stays native.
 * @returns disposer removing the listeners.
 */
export function mountComposerAutoScroll(
  document: Document,
  report: (error: unknown) => void,
): Disposer {
  const toTail = () => {
    for (const scroller of document.querySelectorAll<HTMLElement>(SCROLLERS)) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  };
  const schedule = () => {
    /* Two passes: the user row lands in the same commit, and the assistant
       placeholder grows a frame later. */
    window.setTimeout(toTail, 0);
    window.setTimeout(toTail, 180);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.repeat) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('.yhfFVG_card') === null) return;
    schedule();
  };
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('.yhfFVG_primary') === null) return;
    schedule();
  };
  try {
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onClick, true);
  } catch (error) {
    report(error);
  }
  return () => {
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('click', onClick, true);
  };
}

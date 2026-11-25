import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

/**
 * The composer seat's quote insertion, as the Session scope injects it
 * (`uiSession.provide({ props: ['inputActions'] })` in `ui-conversation`).
 * Only the member this control calls is declared.
 */
export interface QuoteInputActions {
  /** Insert a quote node at the caret; refuses while the composer is not plain. */
  insertQuote(text: string, summary?: unknown): boolean;
}

/**
 * The props the Chat view hands its selection surface, plus the Session props
 * the scope adds. Everything is optional because this plugin cannot type the
 * slot cell it occupies: a build without one of the seats must leave a native
 * interface rather than throw inside a render.
 */
export interface QuoteActionProps {
  /** Current selection text, re-read from the live range; null once it moved. */
  readonly readText?: () => string | null;
  readonly dismiss?: () => void;
  readonly clearSelection?: () => void;
  readonly inputActions?: QuoteInputActions;
}

const COPY = Object.freeze({
  zh: { quote: '引用文本', busy: '输入框忙' },
  en: { quote: 'Quote text', busy: 'Composer busy' },
});

/** How long a refused insertion explains itself before the label returns. */
const BUSY_MS = 1600;

/** The interface's own language, matching the inline copy elsewhere in the plugin. */
function readingChinese(): boolean {
  const lang = document.documentElement.lang || document.defaultView?.navigator?.language || '';
  return lang.toLowerCase().startsWith('zh');
}

/**
 * Quote the selected passage into the Composer.
 *
 * The host admits one interaction surface per gesture, and this cell is only
 * rendered once `mountQuoteSelection` has claimed that gesture, so mounting is
 * the whole admission — no visibility decision is made here.
 *
 * @param props - the Chat view's area-local selection actions and the composer seat.
 * @returns the pill, or nothing while the selection has moved away.
 */
export function QuoteAction(props: QuoteActionProps): ReactElement {
  const { readText, dismiss, clearSelection, inputActions } = props;
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
  }, []);
  const insert = useCallback(() => {
    const text = readText?.() ?? null;
    /* The selection can collapse between the gesture and the click; the surface
       is the host's to close, so hand it back rather than insert nothing. */
    if (text === null || text.trim() === '') { dismiss?.(); return; }
    if (inputActions?.insertQuote(text) !== true) {
      setBusy(true);
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { setBusy(false); }, BUSY_MS);
      return;
    }
    clearSelection?.();
    dismiss?.();
  }, [clearSelection, dismiss, inputActions, readText]);
  const copy = readingChinese() ? COPY.zh : COPY.en;
  const label = busy ? copy.busy : copy.quote;
  return (
    <button type="button" className="ccd-quote-action" data-busy={busy ? 'true' : undefined}
      aria-label={label}
      onPointerDown={event => { event.preventDefault(); }}
      onClick={insert}>
      {label}
    </button>
  );
}

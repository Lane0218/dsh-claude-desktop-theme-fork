import type { Disposer, SidebarRightPort } from '../contracts/ports.ts';

/**
 * The right panel's idle default: collapsed.
 *
 * The panel is a dock column the reader opens for a real reason — a file link in
 * the transcript, a terminal from a tool row, the header's three view entries —
 * and the host persists whichever state a Session was last left in. A Session
 * that carries an open panel from an earlier session is therefore closed once,
 * on the first frame this module can see it, through the panel's own
 * `toggleExpanded` rather than a click on a hidden control.
 *
 * Two guards keep that from becoming a fight: it happens once per page load, and
 * a panel that is already collapsed is left alone (the host reports that by
 * dropping `data-sidebar-right-open`).
 */

const PANEL = '[data-sidebar-right-panel]';
const PANEL_OPEN = '[data-sidebar-right-panel][data-sidebar-right-open]';

/**
 * Collapse a panel the reader did not just open.
 * @param document - the renderer document.
 * @param sidebar - resolves the panel's face; undefined until the host exposes it.
 * @param report - receives observer failures so a broken sheet cannot silence
 *   the panel itself.
 * @returns the disposer that disconnects the observer and cancels the frame.
 */
export function mountRightPanelIdle(
  document: Document,
  sidebar: () => SidebarRightPort | undefined,
  report: (error: unknown) => void,
): Disposer {
  let settled = false;
  let frame = 0;

  const settle = () => {
    if (settled) return;
    if (document.querySelector(PANEL_OPEN) === null) return;
    const face = sidebar();
    /* The face can still be missing on the sweep that first sees the panel, so
       that case is retried rather than settled. */
    if (typeof face?.toggleExpanded !== 'function') return;
    settled = true;
    face.toggleExpanded();
  };

  const view = document.defaultView;
  const schedule = () => {
    if (frame !== 0) return;
    if (view === null) { settle(); return; }
    frame = view.requestAnimationFrame(() => { frame = 0; settle(); });
  };

  /* Only records that can bring the panel up are worth a sweep: the transcript
     streams outside it, and a check per frame there would be one per token. */
  const relevant = (record: MutationRecord): boolean => {
    const target = record.target;
    if (!(target instanceof Element)) return false;
    if (target.closest(PANEL) !== null || target.querySelector(PANEL) !== null) return true;
    for (const node of record.addedNodes) {
      if (node instanceof Element && (node.matches(PANEL) || node.querySelector(PANEL) !== null)) return true;
    }
    return false;
  };
  const observer = new MutationObserver(records => { if (records.some(relevant)) schedule(); });
  try {
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-sidebar-right-open', 'data-sidebar-right-panel'],
    });
    settle();
  } catch (error) {
    report(error);
  }

  return () => {
    observer.disconnect();
    if (frame !== 0 && view !== null) view.cancelAnimationFrame(frame);
    frame = 0;
  };
}

import type { Disposer } from '../contracts/ports.ts';
import { hostSelectors } from './host-dom.ts';

/** Marks the injected rule set so a re-mount replaces rather than stacks it. */
const STYLE_ATTRIBUTE = 'data-ccd-host-rules';

/**
 * Write the fork's host-side geometry rules with selectors resolved for the
 * running DSH build.
 *
 * Host CSS-module class names are hashed per build, and this fork's static
 * sheet is authored against an older one, so rules that inline those hashes
 * silently miss. Everything here is addressed through `hostSelectors`, whose
 * per-build prefix table (`host-builds.ts`) is the one place that knows the
 * live names. The resolution is retried on document changes because the shell
 * settles its build identity after this plugin boots.
 *
 * Rules:
 * - the sidebar's view-options trigger is hidden (the fork keeps the card
 *   unreachable; grouping is configuration-only);
 * - the panel list and the workspace region lose their stacking margins, so
 *   the navigation block sits closer to the first Workspace.
 *
 * @param document - renderer document carrying the sidebar.
 * @param report - sink for resolution failures; an unresolvable selector leaves
 * the native geometry in place.
 * @returns disposer removing the rule set and the observer.
 */
export function mountHostRules(
  document: Document,
  report: (error: unknown) => void,
): Disposer {
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTRIBUTE, '');
  document.head.append(style);
  let written = '';
  const apply = () => {
    let selectors;
    try {
      selectors = hostSelectors(document);
    } catch (error) {
      report(error);
      return;
    }
    const list = selectors.sidebarPanelList;
    if (list === '') return;
    /* `._prefix_panelList` → `._prefix_`, so the two sibling classes the sheet
       does not name can be addressed without another table entry. */
    const prefix = list.replace(/panelList[^]*$/, '');
    const scope = `html[data-dsh-ccd-style="true"] `;
    const rules = [
      `${scope}${selectors.viewOptionsTrigger} { display: none !important; }`,
      `${scope}${list} { margin-bottom: 2px !important; }`,
      prefix === '' ? '' : `${scope}${prefix}scrollRegion { margin-top: 0 !important; }`,
      prefix === '' ? '' : `${scope}${prefix}scrollArea { grid-template-rows: 0 max-content 0 max-content !important; }`,
      `${scope}[data-ccd-nav-hidden] { display: none !important; }`,
    ].filter(rule => rule !== '');
    const text = rules.join('\n');
    if (text === written) return;
    written = text;
    style.textContent = text;
  };
  apply();
  let observer: MutationObserver | undefined;
  try {
    observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (error) {
    report(error);
  }
  return () => {
    observer?.disconnect();
    style.remove();
  };
}

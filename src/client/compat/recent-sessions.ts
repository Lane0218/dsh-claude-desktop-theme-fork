/**
 * The hero's "continue" card reads the session catalog the browser already
 * holds.
 *
 * `ctx.sessions.list` is the same store the sidebar, the search palette and the
 * context ring read: every row carries its durable title, its last update time,
 * whether it is still a provisional blank, and whether it is a subagent child.
 * `ctx.workspaces.list` supplies the workspace name and the archive set, and
 * `uiWorkspace.openSession` is the host's own navigation. Nothing here polls,
 * fetches or keeps a copy of the list.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Disposer, RecentSession, RecentSessionsPort } from '../contracts/ports.ts';

/** Rows the card lists; the card is sized for this many two-line entries. */
export const RECENT_LIMIT = 5;

/** One row as a plain string-keyed record, so the catalog can be read structurally. */
interface CatalogRow {
  readonly displayTitle: string;
  readonly updatedAt: number;
  readonly blank: boolean;
  readonly origin?: 'subagent';
  readonly running: boolean;
}

/** The catalog faces this port reads; a build without them yields no card. */
interface Catalog {
  readonly ids: readonly string[];
  readonly byId: Readonly<Record<string, CatalogRow>>;
}

/** The workspace catalog faces the row's second line needs. */
interface WorkspaceCatalog {
  readonly items: readonly { readonly title: string; readonly sessionIds: readonly string[] }[];
  readonly archivedSessionIds: readonly string[];
}

/**
 * Build the port over the host's client-side session catalog.
 *
 * @param ctx - client context carrying the session and workspace stores.
 * @returns the port, or null when this build publishes no session list.
 */
export function createRecentSessionsPort(ctx: Context): RecentSessionsPort | null {
  const sessions = ctx.sessions?.list;
  const workspaces = ctx.workspaces?.list;
  if (typeof sessions?.getSnapshot !== 'function' || typeof sessions.subscribe !== 'function'
    || typeof workspaces?.getSnapshot !== 'function' || typeof workspaces.subscribe !== 'function') return null;

  const listeners = new Set<() => void>();
  let cache: { sessions: unknown; workspaces: unknown; value: readonly RecentSession[] } | null = null;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const read = (): readonly RecentSession[] => {
    const catalog = sessions.getSnapshot() as unknown as Catalog;
    const projects = workspaces.getSnapshot() as unknown as WorkspaceCatalog;
    if (cache !== null && cache.sessions === catalog && cache.workspaces === projects) return cache.value;

    const archived = new Set<string>(projects.archivedSessionIds);
    const owner = new Map<string, string>();
    for (const item of projects.items) for (const id of item.sessionIds) owner.set(id, item.title);

    const rows: RecentSession[] = [];
    for (const id of catalog.ids) {
      const row = catalog.byId[id];
      /* A provisional New Session has no title worth resuming, a subagent child
         is not a place to return to, and an archived session was put away. */
      if (row === undefined || row.blank || row.origin === 'subagent' || archived.has(id)) continue;
      rows.push(Object.freeze({
        id,
        title: row.displayTitle,
        workspace: owner.get(id) ?? null,
        updatedAt: row.updatedAt,
        running: row.running,
      }));
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt);
    const value = Object.freeze(rows.slice(0, RECENT_LIMIT));
    cache = { sessions: catalog, workspaces: projects, value };
    return value;
  };

  const releases: Disposer[] = [];
  const stop = (): void => {
    while (releases.length > 0) releases.pop()?.();
  };

  return {
    get: read,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size > 1) return () => { listeners.delete(listener); };
      releases.push(sessions.subscribe(notify), workspaces.subscribe(notify));
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    open(id) {
      const session = ctx.sessions;
      const target = session.subagentAddress(id as Parameters<typeof session.subagentAddress>[0]) ?? id;
      ctx.uiWorkspace.openSession(target as Parameters<typeof ctx.uiWorkspace.openSession>[0]);
    },
  };
}

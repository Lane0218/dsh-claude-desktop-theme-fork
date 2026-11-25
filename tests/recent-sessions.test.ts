import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createRecentSessionsPort, RECENT_LIMIT } from '../src/client/compat/recent-sessions.ts';
import { relativeTime } from '../src/client/features/statistics/recent.ts';
import { shortModel } from '../src/client/features/statistics/format.ts';

/** One catalog row as the client store publishes it. */
interface Row {
  displayTitle: string;
  updatedAt: number;
  blank: boolean;
  origin?: 'subagent';
  running: boolean;
}

/**
 * A fake client context with just the two catalog stores and the navigation
 * the port touches; nothing here is a real Cordis service.
 */
function fixture(rows: Record<string, Row>, archived: string[] = []) {
  const listeners = new Set<() => void>();
  const opened: string[] = [];
  let sessionSnapshot = { ids: Object.keys(rows), byId: rows };
  const workspaceSnapshot = {
    items: [{ title: 'life-workspace', sessionIds: Object.keys(rows) }],
    archivedSessionIds: archived,
  };
  const sessions = {
    list: {
      getSnapshot: () => sessionSnapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    subagentAddress: () => undefined,
  };
  const workspaces = {
    list: {
      getSnapshot: () => workspaceSnapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const ctx = {
    sessions,
    workspaces,
    uiWorkspace: { openSession: (id: string) => { opened.push(id); } },
  } as unknown as Context;
  return {
    ctx,
    opened,
    notify: () => { for (const listener of [...listeners]) listener(); },
    /* A store replacement hands out a new snapshot object, exactly like the
       host's catalog store does when a row changes. */
    replace: (next: Record<string, Row>) => { sessionSnapshot = { ids: Object.keys(next), byId: next }; },
  };
}

function row(title: string, updatedAt: number, overrides: Partial<Row> = {}): Row {
  return { displayTitle: title, updatedAt, blank: false, running: false, ...overrides };
}

test('the continue card lists the newest finished sessions only', () => {
  const f = fixture({
    newest: row('Newest', 500),
    blank: row('Empty new session', 900, { blank: true }),
    child: row('Subagent child', 800, { origin: 'subagent' }),
    old: row('Older', 100),
    middle: row('Middle', 300, { running: true }),
  }, ['archived']);
  const port = createRecentSessionsPort(f.ctx);
  assert.notEqual(port, null);
  assert.deepEqual(port!.get().map(session => session.id), ['newest', 'middle', 'old']);
  assert.equal(port!.get()[1]?.running, true);
  assert.equal(port!.get()[0]?.workspace, 'life-workspace');
});

test('archived sessions stay out, and the list is capped', () => {
  const rows: Record<string, Row> = {};
  for (let index = 0; index < RECENT_LIMIT + 3; index += 1) rows[`s${String(index)}`] = row(`S${String(index)}`, index);
  const port = createRecentSessionsPort(fixture(rows, ['s0', 's1']).ctx);
  assert.equal(port!.get().length, RECENT_LIMIT);
  assert.equal(port!.get()[0]?.id, `s${String(RECENT_LIMIT + 2)}`);
  assert.equal(port!.get().some(session => session.id === 's0'), false);
});

test('a store replacement re-reads, an identical one reuses the value', () => {
  const f = fixture({ a: row('A', 10), b: row('B', 20) });
  const port = createRecentSessionsPort(f.ctx)!;
  const first = port.get();
  assert.equal(port.get(), first, 'the same catalog instance keeps the same list');
  f.replace({ a: row('A', 10), b: row('B', 20), c: row('C', 30) });
  assert.deepEqual(port.get().map(session => session.id), ['c', 'b', 'a']);
});

test('subscribers are attached once and released with the last listener', () => {
  let attached = 0;
  const f = fixture({ a: row('A', 1) });
  const list = (f.ctx.sessions as unknown as { list: { subscribe: (listener: () => void) => () => void } }).list;
  const subscribe = list.subscribe;
  list.subscribe = (listener: () => void) => { attached += 1; return subscribe(listener); };
  const port = createRecentSessionsPort(f.ctx)!;
  const first = port.subscribe(() => {});
  const second = port.subscribe(() => {});
  assert.equal(attached, 1);
  first();
  assert.equal(attached, 1, 'the last listener keeps the subscription');
  second();
  assert.equal(attached, 1);
});

test('a row opens through the host navigation', () => {
  const f = fixture({ a: row('A', 1) });
  createRecentSessionsPort(f.ctx)!.open('a');
  assert.deepEqual(f.opened, ['a']);
});

test('a build without a session list yields no port', () => {
  assert.equal(createRecentSessionsPort({ workspaces: {} } as unknown as Context), null);
});

test('recent times use calendar days, not millisecond divisions', () => {
  const noon = new Date(2026, 8, 30, 12, 0, 0).getTime();
  assert.equal(relativeTime(noon - 5_000, noon), '刚刚');
  assert.equal(relativeTime(noon - 5 * 60_000, noon), '5 分钟前');
  assert.equal(relativeTime(noon - 3 * 3_600_000, noon), '3 小时前');
  assert.equal(relativeTime(new Date(2026, 8, 29, 20, 0).getTime(), noon), '昨天');
  assert.equal(relativeTime(new Date(2026, 8, 27, 9, 0).getTime(), noon), '3 天前');
  assert.equal(relativeTime(new Date(2026, 8, 1, 9, 0).getTime(), noon), '9月1日');
  assert.equal(relativeTime(noon - 5 * 60_000, noon, 'en'), '5 min ago');
});

test('model names drop their provider route but keep what would vanish', () => {
  assert.equal(shortModel('deepseek-account/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(shortModel('opencode-go/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(shortModel('deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(shortModel('provider/'), 'provider/');
  assert.equal(shortModel('/model'), '/model');
});

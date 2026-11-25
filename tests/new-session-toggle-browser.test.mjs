import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findChrome, withPage } from '../scripts/lib/headless-chrome.mjs';
import { aliasHostClasses, PINNED_BUILD } from '../src/client/compat/host-builds.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
let chrome;
try { chrome = findChrome(); } catch { /* Optional locally, installed in CI. */ }
const sheets = await Promise.all([
  'src/client/theme/tokens.css', 'src/client/theme/composer.css',
  'src/client/features/statistics/statistics.css', 'src/client/features/new-session/new-session.css',
].map(path => readFile(join(root, path), 'utf8')));

// Relevant native layout: the composer seat is static inside a centred,
// scrollable body. The theme must anchor its workspace row in both modes.
const host = `
body{margin:0} .ST7X_W_root{height:800px;display:flex;flex-direction:column}
.ST7X_W_body{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;
  --dsh-composer-card-max-width:770px;--dsh-composer-side-clearance:16px}
.ST7X_W_scrollBody{display:flex;flex-direction:column;flex:1;min-height:0;justify-content:center;overflow-y:auto}
.ST7X_W_composerSeat{display:flex;flex-direction:column;flex:none}
.ST7X_W_composerStack{display:flex;flex-direction:column}
.ST7X_W_composerHero{width:min(802px,100%);align-self:center;gap:8px;padding-bottom:32px}
.bocITq_root{padding:24px 16px;text-align:center}
.yhfFVG_card{height:70px}
`;
const html = `<div class="ST7X_W_root" data-phase="hero"><div class="ST7X_W_body">
<div class="ST7X_W_scrollBody"><div class="ST7X_W_composerSeat"><div class="ST7X_W_composerStack ST7X_W_composerHero">
<div class="bocITq_root"><div class="bocITq_headline">Native greeting</div></div>
<div class="ST7X_W_heroWorkspaceRow">workspace</div>
<div class="yhfFVG_root yhfFVG_hero"><div class="yhfFVG_card">Input</div><div class="yhfFVG_row">Controls</div></div>
</div></div></div></div></div>`;

test('new-session toggles retain one statistics card and keep native controls beside the input', {
  skip: chrome ? false : 'Chrome unavailable; set CHROME to run browser coverage', timeout: 20000,
}, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `
      import { mountStatisticsCard } from './src/client/features/statistics/mount.ts';
      import { CleanupScope } from './src/client/core/cleanup.ts';
      const totals = {sessions:1,messages:1,tokens:10,activeDays:1,topModel:null,models:[]};
      const source = {current:{version:3,ranges:{today:totals,'7d':totals,'30d':totals,all:totals},
        busyHours:{today:null,'7d':null,'30d':null,all:null},days:[],modelDays:[],modelIO:[],pending:0,missed:0,computedAt:1},
        subscribe:()=>()=>{},setActive:()=>{},dispose:()=>{}};
      let scope;
      window.remount = () => {
        scope?.dispose();
        scope = new CleanupScope();
        mountStatisticsCard(document, scope, {error: error => {throw error}}, source);
      };
    ` }, bundle: true, write: false, format: 'iife',
  });
  const profile = await mkdtemp(join(tmpdir(), 'ccd-new-session-toggle-'));
  try {
    await withPage({ url: 'about:blank', width: 1400, height: 800, profile }, async devtools => {
      await devtools.evaluate(`(() => {
        document.documentElement.setAttribute('data-dsh-ccd-style','true');
        document.body.innerHTML = ${JSON.stringify(html)};
        const base = document.createElement('style');
        base.textContent = ${JSON.stringify(aliasHostClasses(host + sheets.slice(0, 3).join('\n'), PINNED_BUILD))};
        const layout = document.createElement('style'); layout.id = 'new-session-layout';
        layout.textContent = ${JSON.stringify(aliasHostClasses(sheets[3], PINNED_BUILD))};
        document.head.append(base, layout);
      })()`);
      await devtools.evaluate(bundle.outputFiles[0].text);
      for (const enabled of [true, false, true, false]) {
        await devtools.evaluate(`document.querySelector('#new-session-layout').sheet.disabled = ${!enabled}; window.remount()`);
        const result = await devtools.evaluate(`(() => {
          const card = document.querySelector('[data-ccd-stats-card]');
          const box = selector => {const r = document.querySelector(selector).getBoundingClientRect();
            return {top:r.top,bottom:r.bottom,left:r.left};};
          return {count:document.querySelectorAll('[data-ccd-stats-card]').length,
            position:getComputedStyle(document.querySelector('[data-ccd-hero-cards]')).position, greeting:box('.bocITq_root'),
            stats:box('[data-ccd-stats-card]'), input:box('.yhfFVG_card'), row:box('.ST7X_W_heroWorkspaceRow')};
        })()`);
        assert.equal(result.count, 1);
        assert.equal(result.position, enabled ? 'absolute' : 'static');
        assert.ok(result.stats.top >= result.greeting.bottom, 'statistics follow greeting');
        assert.ok(result.input.top >= result.stats.bottom, 'statistics do not cover input');
        assert.ok(result.row.top >= result.input.bottom, 'workspace stays below input');
        assert.ok(result.row.top - result.input.bottom < 50, 'workspace stays with composer');
      }
    });
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('statistics demand follows the hero seat and unchanged payloads retain the card', {
  skip: chrome ? false : 'Chrome unavailable', timeout: 30000,
}, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `
      import {mountStatisticsCard} from './src/client/features/statistics/mount.ts';
      import {createStatsSource} from './src/client/features/statistics/source.ts';
      import {CleanupScope} from './src/client/core/cleanup.ts';
      const totals={sessions:1,messages:1,tokens:10,activeDays:1,topModel:null,models:[]};
      window.data={version:3,ranges:{today:totals,'7d':totals,'30d':totals,all:totals},
        busyHours:{today:null,'7d':null,'30d':null,all:null},days:[],modelDays:[],modelIO:[],pending:0,missed:0,computedAt:1};
      window.requests=[];window.errors=[];window.notices=0;
      window.fetch=(_url,options)=>new Promise(resolve=>window.requests.push({signal:options.signal,resolve}));
      window.answer=(at,overrides={})=>window.requests[at].resolve(new Response(JSON.stringify({...window.data,...overrides})));
      const source=window.source=createStatsSource({active:false,logger:{debug(){},error:(m,e)=>window.errors.push(m+String(e))}});
      const scope=new CleanupScope();
      scope.add(()=>source.dispose());
      source.subscribe(()=>window.notices++);
      mountStatisticsCard(document,scope,{error:(m,e)=>window.errors.push(m+String(e))},source);
      window.release=()=>scope.dispose();
    ` }, bundle: true, write: false, format: 'iife',
  });
  const profile = await mkdtemp(join(tmpdir(), 'ccd-statistics-demand-'));
  try {
    await withPage({ url: 'about:blank', width: 1400, height: 800, profile }, async page => {
      await page.evaluate(`document.documentElement.setAttribute('data-dsh-ccd-style','true');
        document.body.innerHTML=${JSON.stringify(html)};
        document.querySelector('[data-phase]').setAttribute('data-phase','active');
        const sheet=document.createElement('style');sheet.textContent=${JSON.stringify(aliasHostClasses(host + sheets.join('\n'), PINNED_BUILD))};document.head.append(sheet);
        window.pause=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      `);
      await page.evaluate(bundle.outputFiles[0].text);
      assert.equal(await page.evaluate('requests.length'), 0, 'opening another page does not start a statistics request');
      await page.evaluate("document.querySelector('[data-phase]').setAttribute('data-phase','hero');pause()");
      assert.equal(await page.evaluate('requests.length'), 1);
      await page.evaluate('answer(0);pause()');
      assert.equal(await page.evaluate('document.querySelectorAll("[data-ccd-stats-card]").length'), 1);
      await page.evaluate('window.originalCard=document.querySelector("[data-ccd-stats-card]");window.originalSnapshot=source.current;document.dispatchEvent(new Event("visibilitychange"));answer(1,{computedAt:2});pause()');
      assert.equal(await page.evaluate('source.current===originalSnapshot'), true);
      assert.equal(await page.evaluate('document.querySelector("[data-ccd-stats-card]")===originalCard'), true);
      assert.equal(await page.evaluate('notices'), 1);
      // Metadata matters to polling but is not a reason to replace the displayed DOM.
      await page.evaluate('document.dispatchEvent(new Event("visibilitychange"));answer(2,{computedAt:3,pending:1});pause()');
      assert.equal(await page.evaluate('source.current.pending'), 1);
      assert.equal(await page.evaluate('document.querySelector("[data-ccd-stats-card]")===originalCard'), true);
      await page.evaluate(`document.dispatchEvent(new Event('visibilitychange'));
        document.querySelector('[data-phase]').setAttribute('data-phase','active');pause()`);
      assert.equal(await page.evaluate('requests[3].signal.aborted'), true);
      assert.equal(await page.evaluate('document.querySelector("[data-ccd-stats-card]")'), null);
      await page.evaluate('answer(3,{computedAt:4,missed:9});pause()');
      assert.equal(await page.evaluate('source.current.missed'), 0, 'off-page responses cannot overwrite the retained data');
      await page.evaluate("document.querySelector('[data-phase]').setAttribute('data-phase','hero');pause()");
      assert.equal(await page.evaluate('requests.length'), 5);
      assert.equal(await page.evaluate('!!document.querySelector("[data-ccd-stats-card]")'), true, 'returning shows the retained snapshot before IO completes');
      await page.evaluate(`answer(4,{computedAt:5,ranges:Object.fromEntries(['today','7d','30d','all'].map(id=>[id,{...data.ranges[id],tokens:20}]))});pause()`);
      assert.equal(await page.evaluate('document.querySelector("[data-ccd-stats-card]")===originalCard'), false);
      // Advance only the display clock: even an equal payload must refresh the heatmap calendar.
      await page.evaluate(`window.beforeMidnight=document.querySelector('[data-ccd-stats-card]');
        const now=Date.now();Date.now=()=>now+86400000;
        document.dispatchEvent(new Event('visibilitychange'));
        answer(5,{computedAt:6,ranges:Object.fromEntries(['today','7d','30d','all'].map(id=>[id,{...data.ranges[id],tokens:20}]))});pause()`);
      assert.equal(await page.evaluate('document.querySelector("[data-ccd-stats-card]")===beforeMidnight'), false);
      await page.evaluate('window.release();pause()');
      assert.equal(await page.evaluate('document.querySelector("[data-ccd-stats-card]")'), null);
      assert.deepEqual(await page.evaluate('window.errors'), []);
    });
  } finally { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('the hero group is one 770px grid: 480 + 16 + 274, equal heights, rail collapses when narrow', {
  skip: chrome ? false : 'Chrome unavailable; set CHROME to run browser coverage', timeout: 20000,
}, async () => {
  const bundle = await build({
    stdin: { resolveDir: root, loader: 'ts', contents: `
      import { mountStatisticsCard } from './src/client/features/statistics/mount.ts';
      import { CleanupScope } from './src/client/core/cleanup.ts';
      const totals = {sessions:1,messages:1,tokens:10,activeDays:1,topModel:'p/m',models:[]};
      const now = new Date();
      const key = offset => { const d = new Date(now); d.setDate(d.getDate() - offset);
        return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
      const modelDays = [];
      for (let i = 0; i < 30; i += 1) modelDays.push([key(i), 'p/m', 1000 * (30 - i)]);
      const source = {current:{version:3,ranges:{today:totals,'7d':totals,'30d':totals,all:totals},
        busyHours:{today:null,'7d':null,'30d':null,all:null},days:[[key(0),1],[key(1),2]],modelDays,modelIO:[],pending:0,missed:0,computedAt:1},
        subscribe:()=>()=>{},setActive:()=>{},dispose:()=>{}};
      const port = {
        get: () => Array.from({length:5},(_,i)=>({id:'s'+i,title:'Session '+i,workspace:'life-workspace',
          updatedAt: Date.now() - i * 3600000, running: i === 0})),
        subscribe: () => () => {},
        open: () => {},
      };
      const scope = new CleanupScope();
      mountStatisticsCard(document, scope, {error: error => {throw error}}, source, port);
    ` }, bundle: true, write: false, format: 'iife',
  });
  const profile = await mkdtemp(join(tmpdir(), 'ccd-hero-cards-'));
  try {
    await withPage({ url: 'about:blank', width: 1400, height: 800, profile }, async devtools => {
      await devtools.evaluate(`(() => {
        document.documentElement.setAttribute('data-dsh-ccd-style','true');
        document.documentElement.lang = 'zh-CN';
        document.body.innerHTML = ${JSON.stringify(html)};
        const base = document.createElement('style');
        base.textContent = ${JSON.stringify(aliasHostClasses(host + sheets.slice(0, 3).join('\n'), PINNED_BUILD))};
        const layout = document.createElement('style'); layout.id = 'new-session-layout';
        layout.textContent = ${JSON.stringify(aliasHostClasses(sheets[3], PINNED_BUILD))};
        document.head.append(base, layout);
      })()`);
      await devtools.evaluate(bundle.outputFiles[0].text);
      const view = await devtools.evaluate(`(() => {
        const box = selector => { const node = document.querySelector(selector);
          if (node === null) return null;
          const r = node.getBoundingClientRect();
          return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}; };
        return {group: box('[data-ccd-hero-cards]'), card: box('[data-ccd-stats-card]'),
          rail: box('[data-ccd-recent-card]'), rows: document.querySelectorAll('.ccd-recent-row').length,
          title: document.querySelector('.ccd-recent-header')?.textContent ?? null};
      })()`);
      assert.notEqual(view.group, null);
      assert.notEqual(view.rail, null, 'the continue card sits beside the statistics card');
      assert.equal(Math.round(view.group.width), 770);
      assert.equal(Math.round(view.card.width), 480);
      assert.equal(Math.round(view.rail.width), 274);
      assert.equal(Math.round(view.rail.left - view.card.right), 16, 'one 16px gutter');
      assert.equal(Math.round(view.card.left), Math.round(view.group.left));
      assert.equal(Math.round(view.rail.right), Math.round(view.group.right));
      assert.equal(Math.round(view.card.height), Math.round(view.rail.height), 'both cards share one height');
      assert.equal(view.rows, 5);
      assert.equal(view.title, '继续上次');

      /* The heatmap column starts on Monday: today is marked, and the outline
         sits in the row its weekday owns. It is drawn in secondary ink, not the
         value's near-black. */
      const heat = await devtools.evaluate(`(() => {
        const cell = document.querySelector('[data-today="true"]');
        const cells = [...cell.parentElement.children];
        const values = [...document.querySelectorAll('.ccd-stats-tile .ccd-stats-value')];
        return {marked: cell !== null, row: cells.indexOf(cell),
          first: document.querySelector('.ccd-stats-heat-col').children.length,
          ring: getComputedStyle(cell).boxShadow,
          weights: values.map(node => getComputedStyle(node).fontWeight)};
      })()`);
      assert.equal(heat.marked, true);
      assert.equal(heat.first, 7);
      assert.equal(heat.row, (new Date().getDay() + 6) % 7, 'today sits in its Monday-first row');
      assert.equal(heat.ring.includes('rgb(11, 11, 11)'), false, 'the ring is not the value ink');
      assert.deepEqual([...new Set(heat.weights)], [heat.weights[0]], 'every tile value weighs the same');

      /* The chart follows the range, and the models view grows into the card
         instead of leaving a blank band under the legend. */
      const series = await devtools.evaluate(`(async () => {
        const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const click = async selector => { document.querySelector(selector).click(); await frame(); };
        await click('[data-option="30d"]');
        await click('[data-option="models"]');
        const card = document.querySelector('[data-ccd-stats-card]').getBoundingClientRect();
        const body = document.querySelector('.ccd-stats-models').getBoundingClientRect();
        const rail = document.querySelector('[data-ccd-recent-card]').getBoundingClientRect();
        const wide = document.querySelectorAll('.ccd-stats-chart-day').length;
        await click('[data-option="7d"]');
        const narrow = document.querySelectorAll('.ccd-stats-chart-day').length;
        return {wide, narrow, gap: Math.round(card.bottom - body.bottom),
          card: Math.round(card.height), rail: Math.round(rail.height)};
      })()`);
      assert.equal(series.wide, 30, 'the 30d range draws thirty days');
      assert.equal(series.narrow, 7, 'the 7d range draws seven');
      assert.ok(series.gap <= 14, `the models view reaches the card foot (${series.gap}px left)`);
      assert.equal(series.card, series.rail, 'the pair stays level in the models view');

      /* A narrower column cannot hold both cards: the rail goes away and the
         statistics card keeps the row. */
      const narrow = await devtools.evaluate(`(() => {
        document.querySelector('.ST7X_W_body').style.width = '800px';
        const group = document.querySelector('[data-ccd-hero-cards]');
        const card = document.querySelector('[data-ccd-stats-card]').getBoundingClientRect();
        const rail = document.querySelector('[data-ccd-recent-card]');
        return {width: group.getBoundingClientRect().width, card: card.width,
          rail: rail === null ? null : getComputedStyle(rail).display};
      })()`);
      assert.equal(Math.round(narrow.width), 768);
      assert.equal(narrow.rail, 'none');
      assert.equal(Math.round(narrow.card), 768);
    });
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

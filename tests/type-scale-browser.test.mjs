import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, withPage } from '../scripts/lib/headless-chrome.mjs';

/*
 * The type scale, laid out by a real engine.
 *
 * `base.css` re-derives body/muted/h1–h3 from `--dsh-content-font-size`, the
 * host's conversation size that its theme presenter paints on body. That
 * derivation only exists at used-value time, so a stylesheet reader cannot see
 * it: whether `calc(var(--dsh-content-font-size, 14px) - 1px)` lands on 14px or
 * 13px depends on a property the host writes onto body, not on this sheet. The
 * fixture therefore paints the token on body the way the host does, then reads
 * the sizes an ordinary rule would get from `var(--ccd-font-size-*)`.
 *
 * Two sizes matter. 15px is what this profile runs (General settings), and it
 * is the case that made the sidebar sit two steps under the transcript: the
 * chrome has to follow the conversation body, not the reference's 14px. 14px is
 * the reference's own body, where the ladder has to collapse back to the
 * documented 14/13 and 19/16/15; with the host token absent it must do the same.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const SHEETS = ['src/client/theme/tokens.css', 'src/client/theme/base.css']
  .map(path => readFileSync(join(root, path), 'utf8'))
  .join('\n');

let chrome;
try { chrome = findChrome(); } catch { /* Same optional browser coverage as the other sheets. */ }

const PROBE = `(() => {
  const probe = (name) => {
    const el = document.createElement('div');
    el.style.fontSize = 'var(' + name + ')';
    el.textContent = 'Ag';
    document.body.append(el);
    const size = getComputedStyle(el).fontSize;
    el.remove();
    return size;
  };
  const line = document.createElement('p');
  line.style.lineHeight = 'var(--ccd-transcript-line-height)';
  line.textContent = 'Ag';
  document.body.append(line);
  const leading = getComputedStyle(line).lineHeight;
  line.remove();
  return {
    body: probe('--ccd-font-size-body'),
    muted: probe('--ccd-font-size-muted'),
    h1: probe('--ccd-font-size-h1'),
    h2: probe('--ccd-font-size-h2'),
    h3: probe('--ccd-font-size-h3'),
    leading,
  };
})()`;

test('the type scale follows the host conversation size', {
  skip: chrome ? false : 'Chrome unavailable; set CHROME to run browser coverage', timeout: 30000,
}, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'ccd-type-scale-test-'));
  try {
    await withPage({ url: 'about:blank', width: 900, height: 700, scale: 1, profile }, async page => {
      await page.evaluate(`(() => {
        document.documentElement.setAttribute('data-dsh-ccd-style', 'true');
        const sheet = document.createElement('style');
        sheet.textContent = ${JSON.stringify(SHEETS)};
        document.head.append(sheet);
        document.body.style.margin = '0';
      })()`);

      /* This profile: the host paints 15px, so the chrome is one step under it
         (14) and the transcript ladder sits 5/2/1px above it (20/17/16). */
      await page.evaluate(`document.body.style.setProperty('--dsh-content-font-size', '15px')`);
      const at15 = await page.evaluate(PROBE);
      assert.equal(at15.body, '15px', 'the chrome body follows the host conversation size');
      assert.equal(at15.muted, '14px', 'secondary text stays one step under it, not two');
      assert.equal(at15.h1, '20px');
      assert.equal(at15.h2, '17px');
      assert.equal(at15.h3, '16px', 'h3 keeps a step over a 15px body');
      assert.equal(at15.leading, '26px', 'the transcript line is open for a 15px CJK body');

      /* The reference's own host: everything collapses back to the documented
         numbers, so the derivation is not a second scale to maintain. */
      await page.evaluate(`document.body.style.setProperty('--dsh-content-font-size', '14px')`);
      const at14 = await page.evaluate(PROBE);
      assert.equal(at14.body, '14px');
      assert.equal(at14.muted, '13px');
      assert.equal(at14.h1, '19px');
      assert.equal(at14.h2, '16px');
      assert.equal(at14.h3, '15px');
      assert.equal(at14.leading, '26px', 'the line is the transcript decision, not the host size');

      /* No host token at all: the same fallback the literals in tokens.css carry. */
      await page.evaluate(`document.body.style.removeProperty('--dsh-content-font-size')`);
      const bare = await page.evaluate(PROBE);
      assert.equal(bare.body, '14px');
      assert.equal(bare.muted, '13px');
      assert.equal(bare.h1, '19px');
      assert.equal(bare.h2, '16px');
      assert.equal(bare.h3, '15px');
    });
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
});

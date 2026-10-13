import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLibrary } from '../Application/dependencies.js';

const { chromium } = browserLibrary();
import { inspectStudy, searchStudy } from '../Application/covidence.js';
import { validateConfig } from '../Application/config.js';

const reviewUrl = 'https://app.covidence.org/reviews/123/screen';
const config = { reviewUrl, studyId: '103', headless: false, timeoutMs: 3500, selectors: {} };
const fixture = (id = '102') => `<!doctype html><input placeholder="Search studies"><article>
  <span class="study-id">#${id}</span><h2>Title ${id}</h2>
  <section>Abstract: Abstract for ${id}.</section>
  <button data-pendo-key="vote-button">Yes</button><button data-pendo-key="vote-button">No</button><button data-pendo-key="vote-button">Maybe</button>
  </article><script>window.votes=0; document.querySelectorAll('button').forEach(b=>b.onclick=()=>window.votes++);</script>`;
const titleOnlyFixture = (
  id = '89',
  extra = '',
) => `<!doctype html><input placeholder="Search studies">
  <div data-testclass="study" data-testid="Study #${id} Title ${id}">
  <p>#${id} - Hume 1973</p><h3>Title ${id}</h3><div><p>Hume, R.; Weyers, E.</p><p>Scott Med J 1973;18(1):3-7</p><p>1973</p></div>
  ${extra}<button data-pendo-key="vote-button">No</button><button data-pendo-key="vote-button">Maybe</button><button data-pendo-key="vote-button">Yes</button></div>`;

test('configuration rejects batch IDs, wrong origins and invalid browser flags', () => {
  assert.equal(validateConfig(config).studyId, '103');
  assert.equal(
    validateConfig({
      ...config,
      reviewUrl: 'https://demo.covidence.org/reviews/160676/review_studies/screen',
    }).studyId,
    '103',
  );
  assert.equal(validateConfig({ ...config, headless: true }).headless, true);
  for (const change of [
    { studyId: '103,104' },
    { reviewUrl: 'https://example.com/reviews/123' },
    { headless: 'true' },
  ]) {
    assert.throws(() => validateConfig({ ...config, ...change }));
  }
});

test('read-only browser checks', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture() }));
  await page.goto(reviewUrl);
  await t.test('waits for delayed SPA content and does not click votes', async () => {
    await page.evaluate(() => {
      document.querySelector('input').addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        document.querySelector('.study-id').textContent = '#103';
        setTimeout(() => {
          document.querySelector('h2').textContent = 'Title 103';
          document.querySelector('section').textContent = 'Abstract: Abstract for 103.';
        }, 600);
      });
    });
    const result = await searchStudy(page, config);
    assert.equal(result.studyId, '103');
    assert.equal(result.abstract, 'Abstract for 103.');
    assert.equal(await page.evaluate(() => window.votes), 0);
  });
  await t.test('rejects a wrong study even when search input contains requested ID', async () => {
    await page.goto(reviewUrl);
    await assert.rejects(
      searchStudy(page, { ...config, timeoutMs: 1000 }),
      /study #102 is displayed/,
    );
  });
  await t.test('rejects duplicate vote controls', async () => {
    await page.setContent(fixture('103'));
    await page.evaluate(() =>
      document.querySelector('article').append(document.querySelector('button').cloneNode(true)),
    );
    assert.equal((await page.evaluate(inspectStudy, {})).ready, false);
  });
  await t.test('rejects ambiguous study IDs and absent abstracts', async () => {
    await page.setContent(fixture('103'));
    await page.evaluate(() =>
      document.querySelector('article').insertAdjacentHTML('afterbegin', '<span>#104</span>'),
    );
    assert.equal((await page.evaluate(inspectStudy, {})).ready, false);
    await page.setContent(fixture('103'));
    await page.locator('section').evaluate((el) => el.remove());
    assert.equal((await page.evaluate(inspectStudy, {})).ready, false);
  });
  await t.test(
    'extracts the observed demo card structure and follows dynamic aria-controls',
    async () => {
      await page.setContent(`<div data-testclass="study" data-testid="Study #105 Test title">
      <p>#105 - Fixture 2014</p><h3><span>Test title</span></h3>
      <div><p>Fixture, A; Fixture, B</p><p>Example Journal 2014;2(4)</p><p>2014</p></div>
      <button aria-expanded="true" aria-controls="dynamic-abstract-id">Abstract</button>
      <div id="dynamic-abstract-id"><p>BACKGROUND: Text with <mark>vitamin C</mark> preserved.</p></div>
      <button data-pendo-key="vote-button">No</button><button data-pendo-key="vote-button">Maybe</button><button data-pendo-key="vote-button">Yes</button></div>`);
      const result = await page.evaluate(inspectStudy, {});
      assert.equal(result.studyId, '105');
      assert.equal(result.abstract, 'BACKGROUND: Text with vitamin C preserved.');
      assert.equal(result.author, 'Fixture, A; Fixture, B');
      assert.equal(result.year, '2014');
      await page
        .locator('[data-testclass="study"]')
        .evaluate((el) => (el.dataset.testid = 'Study #104 Test title'));
      assert.equal((await page.evaluate(inspectStudy, {})).ready, false);
    },
  );
  await t.test(
    'accepts the observed title-only card but refuses unknown, hidden, empty, ambiguous or loading content',
    async () => {
      await page.setContent(titleOnlyFixture());
      const result = await page.evaluate(inspectStudy, {});
      assert.equal(result.ready, true);
      assert.equal(result.studyId, '89');
      assert.equal(result.abstract, '');
      assert.equal(result.abstractStatus, 'not_available');
      assert.equal(result.author, 'Hume, R.; Weyers, E.');
      assert.equal(
        (await page.evaluate(inspectStudy, { abstract: '.missing-selector' })).ready,
        false,
      );
      for (const extra of [
        '<div data-testid="abstract" hidden>Hidden content</div>',
        '<div data-testid="abstract"></div>',
        '<div data-testid="abstract">First abstract</div><div data-testid="abstract">Second abstract</div>',
        '<button aria-expanded="true" aria-controls="missing-target">Abstract</button>',
        '<button>Abstract</button>',
        '<section>Abstract:</section>',
        '<div aria-busy="true">Loading</div>',
      ]) {
        await page.setContent(titleOnlyFixture('89', extra));
        assert.equal((await page.evaluate(inspectStudy, {})).ready, false, extra);
      }
      await page.setContent(titleOnlyFixture());
      await page
        .locator('[data-testclass="study"]')
        .evaluate((el) => el.setAttribute('aria-busy', 'true'));
      assert.equal((await page.evaluate(inspectStudy, {})).ready, false);
      await page.setContent(titleOnlyFixture());
      await page.locator('h3').evaluate((el) => el.remove());
      assert.match((await page.evaluate(inspectStudy, {})).reason, /title/);
      await page.setContent(titleOnlyFixture());
      await page
        .locator('[data-testclass="study"]')
        .evaluate((el) => (el.dataset.testid = 'Study #88'));
      assert.equal((await page.evaluate(inspectStudy, {})).ready, false);
    },
  );
  await t.test(
    'waits for changed title-only content without treating two empty abstracts as stale',
    async () => {
      await page.goto(reviewUrl);
      await page.setContent(titleOnlyFixture('88'));
      await page.evaluate(() => {
        document.querySelector('input').addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          document.querySelector('[data-testclass="study"]').dataset.testid = 'Study #89 Title 89';
          document.querySelector('p').textContent = '#89 - Hume 1973';
          setTimeout(() => {
            document.querySelector('h3').textContent = 'Title 89';
          }, 600);
        });
      });
      const result = await searchStudy(page, { ...config, studyId: '89' });
      assert.equal(result.title, 'Title 89');
      assert.equal(result.abstractStatus, 'not_available');
    },
  );
  await t.test('expands a collapsed abstract and never clicks a vote', async () => {
    await page.goto(reviewUrl);
    await page.setContent(
      titleOnlyFixture(
        '89',
        '<button aria-expanded="false" aria-controls="abstract-89">Abstract</button><div id="abstract-89" hidden>Actual study abstract.</div>',
      ),
    );
    await page.evaluate(() => {
      window.votes = 0;
      document
        .querySelectorAll('[data-pendo-key="vote-button"]')
        .forEach((b) => (b.onclick = () => window.votes++));
      document.querySelector('[aria-controls]').onclick = (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.getElementById('abstract-89').hidden = false;
      };
    });
    assert.equal((await page.evaluate(inspectStudy, {})).ready, false);
    const result = await searchStudy(page, { ...config, studyId: '89' });
    assert.equal(result.abstract, 'Actual study abstract.');
    assert.notEqual(result.abstractStatus, 'not_available');
    assert.equal(await page.evaluate(() => window.votes), 0);
  });
  await t.test(
    'waits for an abstract arriving after the title instead of accepting a transient empty card',
    async () => {
      await page.goto(reviewUrl);
      await page.setContent(titleOnlyFixture('88'));
      await page.evaluate(() => {
        document.querySelector('input').addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          document.querySelector('[data-testclass="study"]').dataset.testid = 'Study #89 Title 89';
          document.querySelector('p').textContent = '#89 - Hume 1973';
          document.querySelector('h3').textContent = 'Title 89';
          setTimeout(() => {
            document
              .querySelector('h3')
              .insertAdjacentHTML('afterend', '<section>Abstract: Delayed abstract.</section>');
          }, 600);
        });
      });
      const result = await searchStudy(page, { ...config, studyId: '89' });
      assert.equal(result.abstract, 'Delayed abstract.');
      assert.notEqual(result.abstractStatus, 'not_available');
    },
  );
});

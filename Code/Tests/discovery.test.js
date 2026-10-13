import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLibrary } from '../Application/dependencies.js';

const { chromium } = browserLibrary();
import { runDiscovery } from '../Application/discover.js';
import { discoverUnscreened, assertUnscreenedUrl } from '../Application/discovery.js';

const url =
  'https://demo.covidence.org/reviews/160676/review_studies/screen?filter=vote_required_from';
const config = { reviewUrl: url, configHash: 'fixture', timeoutMs: 2500 };
test('discovery rejects other reviews, conflicts and search-filtered URLs', () => {
  assertUnscreenedUrl(url, url);
  for (const u of [
    url.replace('160676', '999'),
    url.replace('vote_required_from', 'votes_in_conflict'),
    url + '&id=123',
    url.replace('demo.', 'app.'),
    url + '&filter=votes_in_conflict',
    url.replace('/screen?', '/full_text?'),
  ])
    assert.throws(() => assertUnscreenedUrl(u, url));
});
test('accepts both screening address forms for the same review, including the new demo address', () => {
  const short = 'https://demo.covidence.org/reviews/160736/screen?filter=vote_required_from';
  const long = short.replace('/screen?', '/review_studies/screen?');
  for (const candidate of [short, long, short.replace('/screen?', '/screen/?')])
    assertUnscreenedUrl(candidate, short);
  assertUnscreenedUrl(short, long);
  for (const candidate of [
    short.replace('160736', '160676'),
    short + '&query=vitamin',
    short.replace('vote_required_from', 'all'),
    short.split('?')[0],
  ])
    assert.throws(() => assertUnscreenedUrl(candidate, short));
});

function orchestrationRuntime(discover) {
  const state = {
    browserModes: [],
    closed: 0,
    events: [],
    released: 0,
    screens: [],
    storesClosed: 0,
    writtenHistory: [],
  };
  class FixtureStore {
    constructor(file) {
      assert.equal(file, 'fixture.sqlite');
    }
    close() {
      state.storesClosed++;
    }
  }
  return {
    state,
    runtime: {
      activeProfile: () => 'fixture',
      acquireWorkerLock: async (dir) => {
        assert.equal(dir, 'fixture-data');
        return async () => state.released++;
      },
      browserLibrary: () => ({ chromium: { fixture: true } }),
      browserOptions: (mode) => state.browserModes.push(mode),
      dataDir: 'fixture-data',
      databasePath: 'fixture.sqlite',
      discoverUnscreened: discover,
      existingVote: async (_config, id) => (id === '2' ? 'vote-2' : null),
      loadProfile: async () => assert.fail('The supplied fixture config should be used.'),
      openReviewBrowser: async (options) => {
        assert.equal(options.profileDir, 'fixture-profile');
        return {
          context: { close: async () => state.closed++ },
          page: { fixture: true },
        };
      },
      profileDir: 'fixture-profile',
      QueueStore: FixtureStore,
      savedDecisionIds: () => new Set(['9']),
      randomUUID: () => 'fixture-event',
      readProjectHistory: (file, reviewUrl) => ({ file, reviewUrl }),
      showScreen: (title, lines) => state.screens.push([title, lines]),
      withRecords: (file, callback) => {
        assert.equal(file, 'fixture.sqlite');
        callback({ projectEvent: (...args) => state.events.push(args) });
      },
      writeProjectLog: async (history) => state.writtenHistory.push(history),
    },
  };
}

test('discovery orchestration validates quantity and records a clean read-only result', async () => {
  const selected = { ...config, reviewUrl: url };
  const { runtime, state } = orchestrationRuntime(async (page, supplied, options) => {
    assert.equal(page.fixture, true);
    assert.equal(supplied, selected);
    assert.equal(await options.existingVote('2'), 'vote-2');
    assert.equal(options.savedDecision('9'), true);
    assert.equal(options.savedDecision('1'), false);
    assert.equal(await options.chooseCount(5), 3);
    return {
      reviewUrl: url,
      discoveredAt: '2026-09-20T00:00:00.000Z',
      total: 5,
      cancelled: false,
      studies: [{ studyId: '1' }, { studyId: '3' }, { studyId: '4' }],
      blocked: [{ studyId: '2' }],
    };
  });
  const answers = ['not a number', '3'];
  const logs = [];
  const result = await runDiscovery(
    async () => answers.shift(),
    (message) => logs.push(message),
    {
      browserMode: 'headless',
      config: selected,
      runtime,
    },
  );
  assert.equal(result.result.studies.length, 3);
  assert.deepEqual(state.browserModes, ['headless']);
  assert.equal(state.screens.filter(([title]) => title.includes('Studies to screen')).length, 2);
  assert.ok(logs.some((message) => message.includes('Enter a whole number')));
  assert.deepEqual(logs, ['Enter a whole number from 1 to 5. The current batch limit is 10,000.']);
  assert.equal(state.events[0][2], 'discovery');
  assert.equal(state.storesClosed, 1);
  assert.equal(state.closed, 1);
  assert.equal(state.released, 1);
  assert.equal(state.writtenHistory.length, 1);
});

test('discovery orchestration records failures and always releases browser and worker resources', async () => {
  const { runtime, state } = orchestrationRuntime(async () => {
    throw new Error('Synthetic discovery failure');
  });
  await assert.rejects(
    runDiscovery(
      async () => '',
      () => {},
      { config, runtime },
    ),
    /Synthetic discovery failure/,
  );
  assert.equal(state.events[0][2], 'discovery_error');
  assert.deepEqual(state.events[0][3], { error: 'Synthetic discovery failure' });
  assert.equal(state.storesClosed, 2);
  assert.equal(state.closed, 1);
  assert.equal(state.released, 1);
  assert.equal(state.writtenHistory.length, 1);
});

test('read-only unscreened discovery fixtures', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  async function scenario({
    total = 3,
    bad = false,
    duplicate = false,
    missingMore = false,
    stalled = false,
    claim = false,
    saved = false,
    chooseCount,
    screenUrl = url,
    countAfterMore = null,
    displayedTotal = total,
  } = {}) {
    const page = await browser.newPage();
    let votes = 0;
    await page.exposeFunction('voteFixture', () => votes++);
    await page.route('**/*', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
   <a href="${screenUrl}">Screen references <span>${displayedTotal}</span></a><input placeholder="Search studies"><main></main>
   <script>
   let loaded=0;window.moreClicks=0;const total=${total};
   function more(){if(${stalled}&&loaded)return;const max=Math.min(total,loaded+2);for(;loaded<max;loaded++){const id=${duplicate}?'1':String(loaded+1);const card=document.createElement('div');card.dataset.testclass='study';card.dataset.testid='Study #'+id+' Title';card.innerHTML='<p>#'+(${bad}?'99':id)+' - Author 2020</p><h3>Title '+id+'</h3>'+['Yes','No','Maybe'].map(v=>'<button data-pendo-key="vote-button" onclick="voteFixture()">'+v+'</button>').join('');document.querySelector('main').append(card);}document.querySelector('#more')?.remove();if(loaded<total&&!${missingMore}){const b=document.createElement('button');b.id='more';b.textContent='Load more';b.onclick=()=>setTimeout(more,200);document.body.append(b);}}
   const loadPage=more; more=()=>{if(loaded && ${countAfterMore !== null}) document.querySelector('a span').textContent=${JSON.stringify(countAfterMore)};loadPage();};
   more();</script>`,
      }),
    );
    try {
      await page.goto(screenUrl);
      await page.addInitScript(() =>
        document.addEventListener('click', (e) => {
          if (e.target.id === 'more') window.moreClicks++;
        }),
      );
      const result = await discoverUnscreened(
        page,
        { ...config, reviewUrl: screenUrl },
        {
          savedDecision: (id) => saved && ['1', '2'].includes(id),
          existingVote: async (id) =>
            claim && id === '2' ? { record: { status: 'uncertain' } } : null,
          chooseCount: chooseCount
            ? async (total) => {
                assert.equal(
                  await page.locator('[data-testclass="study"]').count(),
                  Math.min(total, 2),
                );
                return chooseCount(total);
              }
            : undefined,
        },
      );
      assert.equal(votes, 0);
      return { ...result, loadMoreClicks: await page.evaluate(() => window.moreClicks) };
    } finally {
      assert.equal(votes, 0);
      await page.close();
    }
  }

  await t.test('loads all pages and returns unique stable study IDs without voting', async () => {
    const r = await scenario();
    assert.equal(r.total, 3);
    assert.deepEqual(
      r.studies.map((s) => s.studyId),
      ['1', '2', '3'],
    );
  });
  await t.test(
    'discovers a new demo through its short screening address without voting',
    async () => {
      const screenUrl =
        'https://demo.covidence.org/reviews/160736/screen?filter=vote_required_from';
      const r = await scenario({ screenUrl });
      assert.equal(r.screenUrl, screenUrl);
      assert.deepEqual(
        r.studies.map((s) => s.studyId),
        ['1', '2', '3'],
      );
    },
  );
  await t.test(
    'discovers a configured real review on an intercepted local page without voting',
    async () => {
      const screenUrl =
        'https://app.covidence.org/reviews/900001/review_studies/screen?filter=vote_required_from';
      const r = await scenario({ screenUrl });
      assert.equal(r.reviewUrl, screenUrl);
      assert.deepEqual(
        r.studies.map((s) => s.studyId),
        ['1', '2', '3'],
      );
    },
  );
  await t.test('retained vote claims are reported separately and never queued', async () => {
    const r = await scenario({ claim: true });
    assert.deepEqual(
      r.studies.map((s) => s.studyId),
      ['1', '3'],
    );
    assert.equal(r.blocked[0].studyId, '2');
  });
  await t.test(
    'saved-only decisions are skipped across pages while collecting a fresh batch',
    async () => {
      const r = await scenario({ total: 5, saved: true, chooseCount: async () => 2 });
      assert.deepEqual(
        r.studies.map((s) => s.studyId),
        ['3', '4'],
      );
      assert.deepEqual(
        r.blocked.map((s) => s.studyId),
        ['1', '2'],
      );
      assert.ok(r.blocked.every((s) => s.reason.includes('saved without submission')));
    },
  );
  await t.test('zero awaiting studies returns an empty result', async () => {
    const r = await scenario({ total: 0 });
    assert.deepEqual(r.studies, []);
  });
  await t.test('card identity disagreement blocks the entire discovery', async () => {
    await assert.rejects(scenario({ bad: true }), /Ambiguous/);
  });
  await t.test('duplicate cards block discovery', async () => {
    await assert.rejects(scenario({ duplicate: true }), /duplicate/);
  });
  await t.test(
    'a stale high counter returns available studies without claiming the whole count was scanned',
    async () => {
      const result = await scenario({ missingMore: true });
      assert.deepEqual(
        result.studies.map((study) => study.studyId),
        ['1', '2'],
      );
      assert.equal(result.fullyScanned, false);
    },
  );
  await t.test('a counter that changes while loading does not stop collection', async () => {
    const result = await scenario({ countAfterMore: 4 });
    assert.deepEqual(
      result.studies.map((study) => study.studyId),
      ['1', '2', '3'],
    );
    assert.equal(result.total, 4);
  });
  await t.test('a stale low counter does not hide actual study cards', async () => {
    const result = await scenario({ total: 2, displayedTotal: 0 });
    assert.deepEqual(
      result.studies.map((study) => study.studyId),
      ['1', '2'],
    );
  });
  await t.test('an unreadable counter does not block visible studies', async () => {
    const result = await scenario({ total: 2, displayedTotal: 'not available' });
    assert.deepEqual(
      result.studies.map((study) => study.studyId),
      ['1', '2'],
    );
  });
  await t.test('stalled load-more times out without returning partial studies', async () => {
    await assert.rejects(scenario({ stalled: true }), /timed out/);
  });
  await t.test(
    '100000 pending: asks for count on the first page and does not load the entire review',
    async () => {
      const r = await scenario({
        total: 100000,
        chooseCount: async (total) => {
          assert.equal(total, 100000);
          return 1;
        },
      });
      assert.equal(r.studies.length, 1);
      assert.equal(r.loadMoreClicks, 0);
      assert.equal(r.fullyScanned, false);
    },
  );
  await t.test('loads only enough pages for the requested batch', async () => {
    const r = await scenario({ total: 100000, chooseCount: async () => 3 });
    assert.equal(r.studies.length, 3);
    assert.equal(r.loadMoreClicks, 1);
    assert.equal(r.scanned, 3);
  });
  await t.test('replaces blocked IDs while collecting the requested number', async () => {
    const r = await scenario({ total: 100000, claim: true, chooseCount: async () => 2 });
    assert.deepEqual(
      r.studies.map((s) => s.studyId),
      ['1', '3'],
    );
    assert.equal(r.blocked.length, 1);
    assert.equal(r.loadMoreClicks, 1);
  });
  await t.test('cancelling at the count prompt does not paginate or return a batch', async () => {
    const r = await scenario({ total: 100000, chooseCount: async () => null });
    assert.equal(r.cancelled, true);
    assert.equal(r.loadMoreClicks, 0);
    assert.deepEqual(r.studies, []);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { browserOptions, openReview, openReviewBrowser } from '../Application/browser-mode.js';

const config = {
  reviewUrl:
    'https://demo.covidence.org/reviews/160676/review_studies/screen?filter=vote_required_from',
  timeoutMs: 100,
};
function fixture(url = config.reviewUrl, missing = false) {
  return {
    goto: async () => {},
    setDefaultTimeout: () => {},
    url: () => url,
    getByPlaceholder: () => ({
      waitFor: async () => {
        if (missing) throw new Error('Missing screening controls');
      },
    }),
  };
}
test('browser options explicitly select visible or headless', () => {
  assert.deepEqual(browserOptions(), { headless: false });
  assert.deepEqual(browserOptions('headless'), { headless: true });
  assert.throws(() => browserOptions('invalid'), /Browser mode/);
});
test('visible mode allows login before checking review access', async () => {
  let questions = 0;
  const page = fixture('https://demo.covidence.org/sign_in');
  await openReview(page, config, 'visible', async () => {
    questions++;
    page.url = () => config.reviewUrl;
  });
  assert.equal(questions, 1);
});
test('headless mode uses saved login without an interactive readiness prompt', async () => {
  await openReview(fixture(), config, 'headless', () => {
    assert.fail('Unexpected readiness prompt');
  });
});
test('visible mode starts automatically when already logged in', async () => {
  await openReview(fixture(), config, 'visible', () => assert.fail('Unexpected readiness prompt'));
});
test('visible login returns to the chosen review after authentication', async () => {
  const page = fixture('https://demo.covidence.org/sign_in');
  const destinations = [];
  page.goto = async (url) => {
    destinations.push(url);
    if (destinations.length > 1) page.url = () => url;
  };
  await openReview(page, config, 'visible', async () => {
    page.url = () => 'https://demo.covidence.org/reviews';
  });
  assert.deepEqual(destinations, [config.reviewUrl, config.reviewUrl]);
});
test('headless mode distinguishes expired login from missing controls or the wrong review', async () => {
  await assert.rejects(
    openReview(fixture('https://demo.covidence.org/sign_in'), config, 'headless', () =>
      assert.fail('Unexpected prompt'),
    ),
    (error) => error.code === 'LOGIN_REQUIRED',
  );
  for (const page of [
    fixture(config.reviewUrl, true),
    fixture('https://demo.covidence.org/reviews/999/review_studies/screen'),
  ]) {
    await assert.rejects(
      openReview(page, config, 'headless', () => assert.fail('Unexpected prompt')),
      (error) =>
        error.code !== 'LOGIN_REQUIRED' && /Could not access|Expected review/.test(error.message),
    );
  }
});

test('a redirect to the reviews list identifies the selected review in either browser mode', async () => {
  for (const mode of ['visible', 'headless']) {
    const page = fixture('https://demo.covidence.org/reviews/active');
    page.getByPlaceholder = () =>
      assert.fail('No study controls should be used on the reviews list');
    await assert.rejects(
      openReview(page, config, mode, () => assert.fail('A reviews list is not a login page')),
      (error) => {
        assert.equal(error.code, 'REVIEW_NOT_OPEN');
        assert.match(error.message, /Review #160676 did not open/);
        assert.match(error.message, /https:\/\/demo\.covidence\.org\/reviews\/active/);
        assert.match(error.message, /Choose the saved project/);
        return true;
      },
    );
  }
});

function browserFixture(pages) {
  const launches = [],
    closed = [];
  return {
    launches,
    closed,
    chromium: {
      launchPersistentContext: async (profile, options) => {
        const index = launches.length;
        launches.push(options);
        assert.ok(pages[index], 'Unexpected browser launch');
        return {
          pages: () => [pages[index]],
          close: async () => {
            closed.push(index);
          },
        };
      },
    },
  };
}
test('an expired headless session opens a login window and continues in the same review', async () => {
  const visible = fixture('https://demo.covidence.org/sign_in');
  const f = browserFixture([fixture('https://demo.covidence.org/sign_in'), visible]);
  let questions = 0;
  const result = await openReviewBrowser({
    ...f,
    profileDir: 'fixture',
    config,
    mode: 'headless',
    question: async () => {
      questions++;
      visible.url = () => config.reviewUrl;
    },
  });
  assert.equal(result.page, visible);
  assert.equal(questions, 1);
  assert.deepEqual(f.launches, [{ headless: true }, { headless: false }]);
  assert.deepEqual(f.closed, [0]);
  await result.context.close();
  assert.deepEqual(f.closed, [0, 1]);
});
test('working saved sessions use one browser and no prompt', async () => {
  for (const mode of ['visible', 'headless']) {
    const f = browserFixture([fixture()]);
    const result = await openReviewBrowser({
      ...f,
      profileDir: 'fixture',
      config,
      mode,
      question: () => assert.fail('Unexpected prompt'),
    });
    assert.deepEqual(f.launches, [{ headless: mode === 'headless' }]);
    assert.deepEqual(f.closed, []);
    await result.context.close();
  }
});
test('page failures close the browser without retrying unrelated problems as login', async () => {
  for (const mode of ['visible', 'headless']) {
    const f = browserFixture([fixture(config.reviewUrl, true)]);
    await assert.rejects(
      openReviewBrowser({
        ...f,
        profileDir: 'fixture',
        config,
        mode,
        question: () => assert.fail('Unexpected prompt'),
      }),
      /screening/i,
    );
    assert.equal(f.launches.length, 1);
    assert.deepEqual(f.closed, [0]);
  }
});

test('unsuccessful login closes both browser sessions and never starts screening', async () => {
  const f = browserFixture([
    fixture('https://demo.covidence.org/sign_in'),
    fixture('https://demo.covidence.org/sign_in'),
  ]);
  let questions = 0;
  await assert.rejects(
    openReviewBrowser({
      ...f,
      profileDir: 'fixture',
      config,
      mode: 'headless',
      question: async () => {
        questions++;
      },
    }),
  );
  assert.equal(questions, 1);
  assert.deepEqual(f.closed, [0, 1]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLibrary } from '../Application/dependencies.js';
import { verifyResetVote } from '../Application/reset-verification.js';

const config = {
  reviewUrl:
    'https://demo.covidence.org/reviews/160676/review_studies/screen?filter=vote_required_from',
  studyId: '105',
  timeoutMs: 500,
};

test('Reset checks server-loaded exact study and account, never activates vote controls', async (t) => {
  const browser = await browserLibrary().chromium.launch();
  t.after(() => browser.close());
  async function scenario({
    rows = [],
    controls = true,
    account = 'Fixture reviewer',
    storedAccount,
    title = 'Exact study',
    historyTitle = title,
    missing = false,
    offline = false,
    laterVote = false,
    voteStatus = 'blocked_before_click',
    identityMissing = false,
    otherView = false,
    paginated = false,
  } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(500);
    let loads = 0,
      clicks = 0;
    await page.exposeFunction('voteClicked', () => clicks++);
    await page.route('**/*', async (route) => {
      loads++;
      if (offline && loads > 1) return route.abort();
      const history = laterVote && loads >= 3 ? ['You voted No'] : rows;
      const screen = otherView
        ? config.reviewUrl.replace('vote_required_from', 'awaiting_other_reviewer')
        : config.reviewUrl;
      const html = `<!doctype html>
        ${account ? `<button aria-label="Profile menu"><span role="img" aria-label="${account}">FR</span></button>` : ''}
        <a href="${screen}">Screen references 1</a><input placeholder="Search studies">
        ${
          missing
            ? ''
            : `<div data-testclass="study" data-testid="Study #105"><p>#105</p><h3>${title}</h3>
        <button id="history">History</button>${controls ? ['Yes', 'No', 'Maybe'].map((v) => `<button data-pendo-key="vote-button" onclick="voteClicked()">${v}</button>`).join('') : ''}</div>`
        }
        <script>
        document.getElementById('history')?.addEventListener('click',()=>{
          const d=document.createElement('div');d.setAttribute('role','dialog');d.setAttribute('aria-label','History');
          d.innerHTML=${JSON.stringify(`<h2>History</h2><h3>${historyTitle}</h3><ol>${history.map((r) => `<li>${r.replaceAll('\n', '<br>')}</li>`).join('')}</ol><button>Done</button>${paginated ? '<button>Load more</button>' : ''}`)};
          d.querySelector('button').onclick=()=>d.remove();document.body.append(d);
        });</script>`;
      await route.fulfill({ contentType: 'text/html', body: html });
    });
    try {
      await page.goto(
        otherView
          ? config.reviewUrl.replace('vote_required_from', 'awaiting_other_reviewer')
          : config.reviewUrl,
      );
      const result = await verifyResetVote(
        page,
        otherView
          ? {
              ...config,
              reviewUrl: config.reviewUrl.replace('vote_required_from', 'awaiting_other_reviewer'),
            }
          : config,
        {
          title: 'Exact study',
          votes: [
            {
              status: voteStatus,
              ...(!identityMissing
                ? { reviewerIdentity: { name: storedAccount || 'Fixture reviewer' } }
                : {}),
            },
          ],
        },
      );
      assert.equal(clicks, 0);
      return { result, loads };
    } finally {
      await context.close();
    }
  }
  await t.test('empty history and eligible controls prove absence twice', async () => {
    const { result, loads } = await scenario();
    assert.equal(result.outcome, 'not_voted');
    assert(loads >= 3);
  });
  await t.test(
    'existing own Yes No and Maybe retained even without a new history event',
    async () => {
      for (const vote of ['Yes', 'No', 'Maybe']) {
        const { result } = await scenario({
          rows: [`${vote} vote\nby Fixture reviewer\n25 Sep 2026`],
          controls: false,
        });
        assert.equal(result.outcome, 'voted');
        assert.equal(result.recordedVote, vote);
      }
    },
  );
  await t.test('another reviewer vote alone is not attributed to this account', async () => {
    assert.equal(
      (await scenario({ rows: ['Yes vote\nby Someone else\n25 Sep 2026'] })).result.outcome,
      'not_voted',
    );
  });
  await t.test('a vote appearing on final reload is kept', async () => {
    assert.equal((await scenario({ laterVote: true })).result.outcome, 'voted');
  });
  await t.test(
    'missing card, wrong identity/title, offline, missing controls and unclear history preserve records',
    async () => {
      for (const options of [
        { missing: true },
        { title: 'Wrong study' },
        { historyTitle: 'Wrong study' },
        { account: 'Wrong account' },
        { account: '' },
        { offline: true },
        { controls: false },
        { rows: ['Unrecognized screening event'] },
        { rows: ['You voted Yes', 'You voted No'] },
        { voteStatus: 'uncertain', identityMissing: true },
        { otherView: true },
        { paginated: true },
      ])
        assert.equal(
          (await scenario(options)).result.outcome,
          'uncertain',
          JSON.stringify(options),
        );
    },
  );
});

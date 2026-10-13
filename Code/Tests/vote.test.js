import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserLibrary } from '../Application/dependencies.js';

const { chromium } = browserLibrary();
import { createAudit, openAuditForVerification } from '../Application/audit.js';
import { decisionMap, validateVoteConfig } from '../Application/decisions.js';
import { compareHistory, runVote } from '../Application/vote.js';
import { studyHash } from '../Application/profiles.js';
import { withRecords } from '../Application/records.js';

const base = {
  dataset: 'demo-vitamin-c-common-cold',
  reviewUrl:
    'https://demo.covidence.org/reviews/160676/review_studies/screen?filter=vote_required_from',
  studyId: '105',
  headless: false,
  timeoutMs: 2000,
  decision: 'Maybe',
  expectedButton: 'Maybe',
  reviewerName: 'Example Reviewer',
  selectors: {},
};

test('vote configuration validates single IDs, button mapping and matching configured review scope', () => {
  assert.equal(decisionMap.Exclude, 'No');
  assert.throws(() => validateVoteConfig({ ...base, studyId: '105,106' }));
  assert.throws(() =>
    validateVoteConfig({ ...base, reviewUrl: base.reviewUrl.replace('demo.', 'app.') }),
  );
  assert.throws(() => validateVoteConfig({ ...base, expectedButton: 'Yes' }));
  assert.throws(() => validateVoteConfig({ ...base, dataset: 'standard' }));
  const real = {
    ...base,
    reviewUrl:
      'https://app.covidence.org/reviews/900001/review_studies/screen?filter=vote_required_from',
    profile: 'standard',
    dataset: 'standard-review',
    enabled: true,
    criteriaApproved: true,
    criteria: { inclusion: ['Vitamin C treatment'] },
  };
  assert.equal(validateVoteConfig(real).reviewId, '900001');
  assert.throws(() => validateVoteConfig({ ...real, criteriaApproved: false }), /criteria/);
  assert.throws(() => validateVoteConfig({ ...real, criteria: { inclusion: [] } }), /criteria/);
});

test('audit claims and original record text survive interruption', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-audit-'));
  const dir = path.join(folder, 'screening.sqlite');
  const record = { ...base, reviewId: '160676', title: '=A1,"quoted"\nnext line' };
  const audit = await createAudit(dir, record);
  await audit.save({ status: 'click_intent' });
  await assert.rejects(createAudit(dir, record), /already has an audit claim/);
  const saved = withRecords(dir, (store) => store.vote(audit.record.attemptId));
  assert.equal(saved.record.status, 'click_intent');
  assert.equal(saved.record.title, record.title);
  assert.deepEqual(await readdir(folder), ['screening.sqlite']);
  await assert.rejects(audit.releaseWithoutClick(), /Only an attempt/);
  const verifier = await openAuditForVerification(dir, audit.record.attemptId);
  await assert.rejects(openAuditForVerification(dir, audit.record.attemptId), /already running/);
  await verifier.save({ status: 'uncertain', reason: 'Test: missing evidence' });
  await verifier.close();
  assert.equal(
    withRecords(dir, (store) => store.vote(audit.record.attemptId).record.verificationOnly),
    true,
  );
  await assert.rejects(createAudit(dir, record), /already has an audit claim/);
  await assert.rejects(openAuditForVerification(dir, '../escape'), /valid attempt UUID/);
});

test('history comparison requires one newly recorded vote attributable to this reviewer', () => {
  const observed = 'No vote\n\nby Example Reviewer\n\n12 Sep 2026';
  assert.equal(compareHistory([], [observed], 'Example Reviewer').recordedVote, 'No');
  assert.equal(compareHistory([], [observed], 'Other Reviewer').recordedVote, null);
  assert.equal(compareHistory([], [observed]).recordedVote, null);
  assert.equal(compareHistory([observed], [observed], 'Example Reviewer').recordedVote, null);
  assert.equal(
    compareHistory([], ['Maybe vote\n\nby Example Reviewer\n\n12 Sep 2026'], 'Example Reviewer')
      .recordedVote,
    'Maybe',
  );
  assert.equal(compareHistory([], ['You voted Maybe']).recordedVote, 'Maybe');
  assert.equal(compareHistory(['You voted Maybe'], ['You voted Maybe']).recordedVote, null);
  assert.equal(compareHistory([], ['Another reviewer voted Yes']).recordedVote, null);
  assert.equal(compareHistory([], ['You voted No', 'You voted Yes']).recordedVote, null);
  assert.equal(compareHistory([], ['You clicked Maybe']).recordedVote, null);
});

test('single-vote browser workflow on isolated local fixtures', async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  async function scenario({
    decision = 'Maybe',
    confirm = async () => true,
    acceptedVote,
    historyVote = null,
    removeWithoutRecord = false,
    duplicate = false,
    afterClickFailure = false,
    ai = false,
    humanReview = null,
    staleAI = false,
    titleOnly = false,
    aiAbstract = null,
    real = false,
    reviewerName = base.reviewerName,
    namedHistory = false,
    historyOverlay = false,
    historyTitle = 'Test title',
  } = {}) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(1500);
    const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-votes-'));
    const databasePath = path.join(folder, 'screening.sqlite');
    Object.getPrototypeOf(page.locator('body')).screenshot = async () => {
      throw new Error('Screenshots must never be taken');
    };
    let clicks = 0;
    let vote = null;
    await page.exposeFunction('recordFixtureVote', (value) => {
      clicks++;
      if (!removeWithoutRecord) vote = acceptedVote || value;
    });
    await page.route('**/*', async (route) => {
      if (afterClickFailure && clicks) return route.abort();
      const button = (value) => `<button data-pendo-key="vote-button">${value}</button>`;
      const historyRow = namedHistory
        ? `${vote || historyVote} vote<br><br>by Example Reviewer<br><br>13 Sep 2026`
        : `You voted ${vote || historyVote}`;
      const body = `<!doctype html><button aria-label="Profile menu"><span role="img" aria-label="Example Reviewer">ER</span></button><input placeholder="Search studies"><div data-testclass="study" data-testid="Study #105 Test title">
      <p>#105 - Fixture 2014</p><h3>Test title</h3><div><p>Fixture, A</p><p>Example Journal</p><p>2014</p></div>${titleOnly ? '' : '<section>Abstract: Test abstract.</section>'}
      <button id="history">History</button>${vote ? `<p>You voted ${vote}</p>` : ['Yes', 'No', 'Maybe'].map(button).join('')}${duplicate ? button('Maybe') : ''}</div>
      <script>document.getElementById('history').onclick=()=>{const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-label','History');dialog.style.cssText='width:0;height:0';dialog.innerHTML='<div style="position:fixed;top:0;left:0;background:white"><h2>History</h2><h3>${historyTitle}</h3><ol>${vote || historyVote ? `<li>${historyRow}</li>` : ''}</ol><button>Done</button></div>';dialog.querySelector('button').onclick=()=>{dialog.remove();document.getElementById('pendo-base')?.remove();};document.body.append(dialog);if(${historyOverlay}){const guide=document.createElement('div');guide.id='pendo-base';guide.className='_pendo-guide-walkthrough_';guide.style.cssText='position:fixed;inset:0;z-index:9999';guide.innerHTML='<ol class="_pendo-text-list-ordered"><li>Walkthrough</li></ol>';document.body.append(guide);}};document.querySelectorAll('[data-pendo-key="vote-button"]').forEach(b=>b.onclick=async()=>{await window.recordFixtureVote(b.textContent);document.querySelector('[data-testclass="study"]').remove();});</script>`;
      await route.fulfill({ contentType: 'text/html', body });
    });
    const config = {
      ...base,
      reviewerName,
      decision,
      expectedButton: { Include: 'Yes', Exclude: 'No', Maybe: 'Maybe' }[decision],
      configHash: 'test-config-hash',
      ...(real
        ? {
            reviewUrl:
              'https://app.covidence.org/reviews/900001/review_studies/screen?filter=vote_required_from',
            profile: 'standard',
            dataset: 'standard-review',
            enabled: true,
            criteriaApproved: true,
            criteria: { inclusion: ['Vitamin C treatment'] },
          }
        : {}),
    };
    await page.goto(config.reviewUrl);
    const recommendation = ai
      ? {
          ...(humanReview ? { humanReview } : {}),
          record: {
            runId: 'test-recommendation',
            status: 'recommended',
            decision,
            dataset: config.dataset,
            reviewUrl: config.reviewUrl,
            studyId: '105',
            configHash: config.configHash,
            model: 'test-model',
            studyHash: studyHash({
              studyId: '105',
              title: 'Test title',
              abstract:
                aiAbstract ?? (staleAI ? 'Older abstract' : titleOnly ? '' : 'Test abstract.'),
              author: 'Fixture, A',
              year: '2014',
            }),
          },
        }
      : null;
    const audit = await runVote({
      page,
      config,
      databasePath,
      confirm: (record) => confirm(record, page),
      recommendation,
    });
    await context.close();
    return { audit, clicks, databasePath, config, folder };
  }
  await t.test(
    'a Pendo walkthrough over History Done permits one vote and post-vote verification',
    async () => {
      const { audit, clicks } = await scenario({ historyOverlay: true, ai: true });
      assert.equal(clicks, 1);
      assert.equal(audit.record.status, 'confirmed');
    },
  );
  await t.test('a Pendo overlay does not bypass a mismatched History title', async () => {
    const { audit, clicks } = await scenario({ historyOverlay: true, historyTitle: 'Wrong study' });
    assert.equal(clicks, 0);
    assert.equal(audit.record.status, 'blocked_before_click');
    assert.match(audit.record.error, /History title does not match/);
  });
  await t.test(
    'an overlay on a vote button still blocks submission and retains its claim',
    async () => {
      const { audit, clicks, databasePath, config } = await scenario({
        confirm: async (_, page) => {
          await page.evaluate(() => {
            const guide = document.createElement('div');
            guide.id = 'pendo-base';
            guide.style.cssText = 'position:fixed;inset:0;z-index:9999';
            document.body.append(guide);
          });
          return true;
        },
      });
      assert.equal(clicks, 0);
      assert.equal(audit.record.status, 'uncertain');
      await assert.rejects(
        createAudit(databasePath, { ...config, reviewId: '160676' }),
        /already has an audit claim/,
      );
    },
  );
  for (const decision of ['Include', 'Exclude', 'Maybe'])
    await t.test(
      `${decision}: exactly one mapped click and persistent vote confirmation`,
      async () => {
        const { audit, clicks, folder } = await scenario({ decision });
        assert.equal(clicks, 1);
        assert.equal(audit.record.status, 'confirmed');
        assert.equal(audit.record.voteComparison, 'match');
        assert.deepEqual(await readdir(folder), ['screening.sqlite']);
        assert.equal(audit.record.screenshots, undefined);
      },
    );
  await t.test(
    'saved initials do not affect voting or verification of the signed-in account',
    async () => {
      const { audit, clicks } = await scenario({ reviewerName: 'E.R.', namedHistory: true });
      assert.equal(clicks, 1);
      assert.equal(audit.record.status, 'confirmed');
    },
  );
  await t.test('full account name verifies the observed named History format', async () => {
    const { audit, clicks } = await scenario({ decision: 'Exclude', namedHistory: true });
    assert.equal(clicks, 1);
    assert.equal(audit.record.status, 'confirmed');
    assert.equal(audit.record.recordedVote, 'No');
    assert.equal(audit.record.reviewerIdentity.name, 'Example Reviewer');
  });
  await t.test(
    'account display metadata changes do not stop a clearly confirmed vote',
    async () => {
      const { audit, clicks } = await scenario({
        confirm: async (_, page) => {
          await page
            .getByRole('img')
            .evaluate((el) => el.setAttribute('aria-label', 'Another Reviewer'));
          return true;
        },
      });
      assert.equal(clicks, 1);
      assert.equal(audit.record.status, 'confirmed');
    },
  );
  await t.test(
    'missing Profile menu does not prevent voting and explicit You-vote verification',
    async () => {
      const { audit, clicks } = await scenario({
        reviewerName: '',
        confirm: async (_, page) => {
          await page
            .getByRole('button', { name: 'Profile menu', exact: true })
            .evaluate((el) => el.remove());
          return true;
        },
      });
      assert.equal(clicks, 1);
      assert.equal(audit.record.status, 'confirmed');
    },
  );
  await t.test(
    'configured real-review workflow verifies one AI-mapped vote on an intercepted local page',
    async () => {
      const { audit, clicks } = await scenario({ real: true, ai: true });
      assert.equal(clicks, 1);
      assert.equal(audit.record.status, 'confirmed');
      assert.equal(audit.record.reviewId, '900001');
      assert.equal(audit.record.dataset, 'standard-review');
    },
  );
  await t.test('cancellation clicks zero buttons and saves cancellation', async () => {
    const { audit, clicks } = await scenario({ confirm: async () => false });
    assert.equal(clicks, 0);
    assert.equal(audit.record.status, 'cancelled');
  });
  await t.test(
    'a manual vote in History prevents a replacement even if buttons remain',
    async () => {
      const { audit, clicks } = await scenario({ historyVote: 'No' });
      assert.equal(clicks, 0);
      assert.equal(audit.record.status, 'blocked_before_click');
      assert.match(audit.record.error, /already contains a vote/);
    },
  );
  await t.test('identity change during confirmation prevents submission', async () => {
    const { audit, clicks } = await scenario({
      confirm: async (_, page) => {
        await page
          .locator('[data-testclass="study"]')
          .evaluate((el) => (el.dataset.testid = 'Study #106 Other title'));
        return true;
      },
    });
    assert.equal(clicks, 0);
    assert.equal(audit.record.status, 'blocked_before_click');
  });
  await t.test('duplicate vote buttons block submission', async () => {
    const { audit, clicks } = await scenario({ duplicate: true });
    assert.equal(clicks, 0);
    assert.equal(audit.record.status, 'blocked_before_click');
  });
  await t.test('recorded vote mismatch is reported and blocks resubmission', async () => {
    const { audit, clicks, databasePath, config } = await scenario({ acceptedVote: 'No' });
    assert.equal(clicks, 1);
    assert.equal(audit.record.status, 'mismatch');
    await assert.rejects(
      createAudit(databasePath, { ...config, reviewId: '160676' }),
      /already has an audit claim/,
    );
  });
  await t.test('card disappearance alone cannot confirm a vote', async () => {
    const { audit, clicks } = await scenario({ removeWithoutRecord: true });
    assert.equal(clicks, 1);
    assert.equal(audit.record.status, 'uncertain');
  });
  await t.test('network failure after submission stays uncertain without retry', async () => {
    const { audit, clicks } = await scenario({ afterClickFailure: true });
    assert.equal(clicks, 1);
    assert.equal(audit.record.status, 'uncertain');
  });
  await t.test(
    'AI recommendation links to the vote audit and confirms the mapped button',
    async () => {
      const { audit, clicks } = await scenario({ ai: true });
      assert.equal(clicks, 1);
      assert.equal(audit.record.status, 'confirmed');
      assert.equal(audit.record.decisionSource, 'openai-recommendation');
      assert.equal(audit.record.recommendationRunId, 'test-recommendation');
    },
  );
  await t.test('an abstract changed since AI analysis blocks the vote', async () => {
    const { audit, clicks } = await scenario({ ai: true, staleAI: true });
    assert.equal(clicks, 0);
    assert.equal(audit.record.status, 'blocked_before_click');
    assert.match(audit.record.error, /changed since/);
  });
  await t.test(
    'a human-edited Maybe submits the final No choice and preserves the approval in the audit',
    async () => {
      const humanReview = {
        originalDecision: 'Maybe',
        decision: 'Exclude',
        rationale: 'Human explanation.',
        confirmationId: 'fixture-confirmation',
        confirmedAt: new Date().toISOString(),
      };
      const { audit, clicks } = await scenario({ ai: true, decision: 'Exclude', humanReview });
      assert.equal(clicks, 1);
      assert.equal(audit.record.recordedVote, 'No');
      assert.equal(audit.record.decisionSource, 'human-batch-review');
      assert.deepEqual(audit.record.humanReview, humanReview);
    },
  );
  await t.test(
    'a title-only AI decision clicks Maybe once and verifies it in History',
    async () => {
      const { audit, clicks } = await scenario({ ai: true, titleOnly: true });
      assert.equal(clicks, 1);
      assert.equal(audit.record.actualButton, 'Maybe');
      assert.equal(audit.record.recordedVote, 'Maybe');
      assert.equal(audit.record.status, 'confirmed');
    },
  );
  await t.test('an abstract added after title-only analysis blocks the vote', async () => {
    const { audit, clicks } = await scenario({ ai: true, aiAbstract: '' });
    assert.equal(clicks, 0);
    assert.equal(audit.record.status, 'blocked_before_click');
    assert.match(audit.record.error, /changed since/);
  });
  await t.test(
    'an abstract added immediately before a title-only vote blocks submission',
    async () => {
      const { audit, clicks } = await scenario({
        ai: true,
        titleOnly: true,
        confirm: async (_, page) => {
          await page
            .locator('h3')
            .evaluate((el) =>
              el.insertAdjacentHTML(
                'afterend',
                '<section>Abstract: Newly loaded abstract.</section>',
              ),
            );
          return true;
        },
      });
      assert.equal(clicks, 0);
      assert.equal(audit.record.status, 'blocked_before_click');
      assert.match(audit.record.error, /changed before voting/);
    },
  );
});

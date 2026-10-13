import { assertReview } from './covidence.js';
import { assertUnscreenedUrl } from './discovery.js';
import { readReviewer } from './reviewer.js';
import { readCard, readHistory, compareHistory, verificationLinks } from './vote.js';
import { isKnownBeforeClick } from './states.js';

const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Read-only: History/Done and search navigation are the only controls activated.
// Absence from search is never evidence of an absent vote.
export async function verifyResetVote(page, config, { title, votes = [] } = {}) {
  const observations = [];
  const uncertain = (reason) => ({ outcome: 'uncertain', reason, observations });
  try {
    assertReview(page.url(), config.reviewUrl);
    const reviewer = await readReviewer(page);
    if (!reviewer?.name) return uncertain('Cannot identify the signed-in Covidence reviewer.');
    const sameReviewer = (name) => normalize(name) === normalize(reviewer.name);
    if (votes.some((v) => v.reviewerIdentity?.name && !sameReviewer(v.reviewerIdentity.name)))
      return uncertain('The signed-in account differs from the reviewer in the saved attempt.');
    const urls = [
      ...new Set([
        ...(await verificationLinks(page, config.reviewUrl)),
        ...votes.flatMap((v) => v.verificationUrls || []),
      ]),
    ];
    let absentEvidence;
    async function inspect(url) {
      assertReview(url, config.reviewUrl);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
      assertReview(page.url(), config.reviewUrl);
      const search = page.getByPlaceholder('Search studies', { exact: true });
      await search.fill(`#${config.studyId}`, { timeout: config.timeoutMs });
      await search.press('Enter');
      let card;
      const deadline = Date.now() + Math.min(config.timeoutMs, 6000);
      while (Date.now() < deadline) {
        try {
          card = await readCard(page, config.studyId, title);
          break;
        } catch {
          await page.waitForTimeout(150);
        }
      }
      if (!card) throw new Error('Exact study not found in this view.');
      const actualTitle = await card.locator('h3:visible').innerText();
      const history = await readHistory(page, config.studyId, actualTitle, true);
      assertReview(page.url(), config.reviewUrl);
      const account = await readReviewer(page);
      if (!account?.name || !sameReviewer(account.name))
        throw new Error('Reviewer identity changed.');
      const own = history.rows
        .map((r) => compareHistory([], [r], reviewer.name).recordedVote)
        .filter(Boolean);
      const result = {
        reviewUrl: config.reviewUrl,
        studyId: config.studyId,
        title: actualTitle,
        reviewerIdentity: account,
        checkedAt: new Date().toISOString(),
        url: page.url(),
        historyRows: history.rows,
      };
      if (own.length === 1) return { ...result, outcome: 'voted', recordedVote: own[0] };
      if (own.length > 1)
        return {
          ...result,
          outcome: 'uncertain',
          reason: 'Multiple votes by this reviewer need manual review.',
        };
      // Only fully understood other-reviewer vote rows (or empty History) prove no own vote.
      // Unknown events, removed votes, pagination and changed layouts must fail closed.
      const otherVotesOnly = history.rows.every((row) => {
        const lines = row.split(/\r?\n/).map(normalize).filter(Boolean);
        return (
          /^(Yes|No|Maybe) vote$/.test(lines[0]) &&
          /^by .+/.test(lines[1]) &&
          lines[1] !== 'by You' &&
          lines[1] !== `by ${reviewer.name}`
        );
      });
      if (!otherVotesOnly)
        return {
          ...result,
          outcome: 'uncertain',
          reason: 'History contains events that cannot safely establish no vote. Records kept.',
        };
      assertUnscreenedUrl(page.url(), config.reviewUrl);
      const controls = await card.evaluate((el) => {
        const buttons = [...el.querySelectorAll('button[data-pendo-key="vote-button"]')].filter(
          (b) => b.checkVisibility(),
        );
        return (
          buttons.length === 3 &&
          ['Yes', 'No', 'Maybe'].every(
            (name) =>
              buttons.filter(
                (b) =>
                  b.innerText.trim() === name &&
                  !b.disabled &&
                  b.getAttribute('aria-disabled') !== 'true',
              ).length === 1,
          ) &&
          !/You voted|Final decision|What was the agreed final decision/i.test(el.innerText)
        );
      });
      if (!otherVotesOnly || !controls)
        throw new Error('No-vote evidence is incomplete or ambiguous.');
      if (votes.some((v) => !isKnownBeforeClick(v) && !v.reviewerIdentity?.name))
        throw new Error('A possibly submitted attempt has no recorded reviewer identity.');
      return { ...result, outcome: 'not_voted' };
    }
    for (const url of urls) {
      try {
        const result = await inspect(url);
        observations.push(result);
        if (result.outcome === 'voted') return { ...result, observations };
        if (result.outcome === 'uncertain') return { ...result, observations };
        absentEvidence ||= result;
      } catch (error) {
        observations.push({ url, reason: error.message });
      }
    }
    if (absentEvidence) {
      // Require the same result after a second server-backed load immediately before removal.
      const result = await inspect(absentEvidence.url);
      observations.push(result);
      return { ...result, observations };
    }
    return uncertain(
      'Could not verify a vote or positively establish that no vote exists. Records kept.',
    );
  } catch (error) {
    return uncertain(error.message);
  }
}

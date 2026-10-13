import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { databasePath } from './config.js';
import { reviewKey } from './project-history.js';
import { loadProject } from './projects.js';
import { hash } from './profiles.js';
import { claimKey } from './records.js';
import { finishedItem } from './states.js';
import { showScreen } from './terminal-screen.js';

export function readUnfinished(file, reviewUrl) {
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    const hidden = new Set();
    for (const event of db
      .prepare(
        "SELECT kind,data FROM project_events WHERE kind IN ('batch_cleared','batch_restored') ORDER BY rowid",
      )
      .all()) {
      const id = JSON.parse(event.data).jobId;
      if (event.kind === 'batch_cleared') hidden.add(id);
      else hidden.delete(id);
    }
    const entries = [];
    for (const job of db.prepare('SELECT * FROM jobs ORDER BY created_at,id').all()) {
      if (hidden.has(job.id) || reviewKey(job.review_url) !== reviewKey(reviewUrl)) continue;
      for (const raw of db
        .prepare('SELECT * FROM items WHERE job_id=? ORDER BY ordinal')
        .all(job.id)) {
        const item = { ...raw, data: JSON.parse(raw.data) };
        if (finishedItem(item, job.mode)) continue;
        const runId =
          item.data.recommendationRecord?.runId ||
          item.data.recommendationRef?.replace(/^recommendation:/, '') ||
          item.data.previousRecommendationId;
        const saved = runId
          ? db
              .prepare(
                'SELECT record,parsed FROM recommendations WHERE run_id=? AND study_id=? AND config_hash=?',
              )
              .get(runId, item.study_id, job.config_hash)
          : null;
        const record = saved ? JSON.parse(saved.record) : item.data.recommendationRecord;
        const parsed = saved?.parsed ? JSON.parse(saved.parsed) : null;
        const claim = db
          .prepare('SELECT attempt_id FROM vote_claims WHERE claim_key=?')
          .get(claimKey({ reviewUrl: job.review_url }, item.study_id));
        const attemptId =
          claim?.attempt_id ||
          item.data.voteRecord?.attemptId ||
          item.data.voteRef?.replace(/^vote:/, '');
        const voteRow = attemptId
          ? db.prepare('SELECT record FROM votes WHERE attempt_id=?').get(attemptId)
          : null;
        const vote = voteRow ? JSON.parse(voteRow.record) : item.data.voteRecord;
        const payload = runId
          ? db
              .prepare(
                'SELECT response IS NOT NULL AS saved FROM recommendation_payloads WHERE run_id=?',
              )
              .get(runId)
          : null;
        entries.push({
          job,
          item,
          record,
          parsed,
          vote,
          claimed: Boolean(claim),
          missingVote: Boolean(attemptId && !voteRow),
          hasResponse: Boolean(payload?.saved),
          fingerprint: hash(item),
        });
      }
    }
    db.exec('COMMIT');
    return entries;
  } finally {
    db.close();
  }
}

export async function reviewUnfinished(
  project,
  question,
  {
    databaseFile = databasePath,
    load = loadProject,
    show = showScreen,
    view,
    run,
    chooseBrowserMode,
  } = {},
) {
  let page = 0;
  while (true) {
    const entries = readUnfinished(databaseFile, project.reviewUrl);
    if (!entries.length) {
      show(`CoviPanel | ${project.name}`, ['No unfinished studies.'], '');
      await question('Press Enter to return to this project. ');
      return;
    }
    const current = await load(project.reviewUrl).catch(() => null);
    const size = 5;
    page = Math.min(page, Math.ceil(entries.length / size) - 1);
    const first = page * size;
    show(
      `CoviPanel | Unfinished studies`,
      [
        project.name,
        `Page ${page + 1}/${Math.ceil(entries.length / size)}`,
        ...entries
          .slice(first, first + size)
          .map(
            (e, i) =>
              `${first + i + 1}. Study #${e.item.study_id} | ${e.item.state} | ${e.job.config_hash === current?.configHash ? 'Current settings' : 'Older or unavailable settings'}`,
          ),
        '',
        'n = next page; p = previous page',
        '0. Back to project',
      ],
      '',
    );
    const choice = (await question('Choose a study: ')).trim().toLowerCase();
    if (!choice || choice === '0') return;
    if (choice === 'n') {
      page = Math.min(page + 1, Math.ceil(entries.length / size) - 1);
      continue;
    }
    if (choice === 'p') {
      page = Math.max(0, page - 1);
      continue;
    }
    const index = Number(choice) - 1;
    if (!/^\d+$/.test(choice) || index < first || index >= Math.min(first + size, entries.length))
      continue;
    const e = entries[index],
      d = e.item.data;
    const old = e.job.config_hash !== current?.configHash;
    const details = [
      `Study #${e.item.study_id} | ${e.item.state}`,
      e.record?.title || d.study?.title || 'Title not saved.',
      `Saved decision: ${e.record?.decision || 'Not available'}`,
      `Vote status: ${e.missingVote ? 'Audit missing' : e.vote?.status || 'No recorded vote attempt'}`,
      `Batch: ${e.job.id}`,
      `Settings: ${old ? 'Older or unavailable; normal screening will not resume this batch.' : 'Match current saved settings.'}`,
      '',
      `Stopped because: ${d.error || 'Waiting to continue.'}`,
      '',
      e.parsed?.ResponseText || e.record?.rationale || 'No saved response.',
      ...(d.reviewReason ? ['', `Review note: ${d.reviewReason}`] : []),
    ];
    show(
      `CoviPanel | Study #${e.item.study_id}`,
      [
        `Queue: ${e.item.state} | Saved decision: ${e.record?.decision || 'Not available'}`,
        `Vote status: ${e.missingVote ? 'Audit missing' : e.vote?.status || 'No recorded attempt'}`,
        old
          ? 'Older settings: normal Start / continue will not resume this batch.'
          : 'Settings match the current project.',
        '1. Read saved response and failure details',
        '2. Reset (check Covidence first)',
        '0. Back to list',
      ],
      '',
    );
    const action = (await question('Choose an action: ')).trim();
    try {
      if (action === '1') await view(details);
      else if (action === '2') {
        show(
          'CoviPanel | Reset unfinished study',
          [
            `Study #${e.item.study_id}`,
            'Already voted: keep the record; clear the warning if the vote matches.',
            'Not voted: save a backup, remove the unfinished record and recommendation, and clear the warning.',
            'Cannot confirm: delete nothing.',
          ],
          '',
        );
        if (
          (
            await question(`Type RESET ${e.item.study_id} to continue, or press Enter to cancel: `)
          ).trim() !== `RESET ${e.item.study_id}`
        )
          continue;
        const browser = await chooseBrowserMode();
        if (!browser) continue;
        const result = await run('Code/Application/worker.js', [
          'reset',
          '--job',
          e.job.id,
          '--study',
          e.item.study_id,
          '--browser',
          browser,
        ]);
        await question(
          result === 0
            ? 'Reset check finished. See the result above. Press Enter to refresh the list. '
            : 'Reset could not finish. See the reason above. Press Enter to refresh the list. ',
        );
      }
    } catch (error) {
      await question(`Stopped: ${error.message}\nPress Enter to refresh the list. `);
    }
  }
}

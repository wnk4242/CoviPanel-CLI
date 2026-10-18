import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { QueueStore } from './queue-store.js';
import { savedDecisionIds } from './saved-decisions.js';
import { hash, studyHash } from './profiles.js';
import { claimKey } from './records.js';
import { decisionMap } from './decisions.js';
import { reviewDecision, rationaleParts, reviewedResponse } from './review-decisions.js';
import { reviewBatch } from './batch-review.js';
import { createTerminal } from './terminal-input.js';
import { exportProjectHistory } from './history-export.js';

function entriesFor(store, jobIds) {
  const entries = [];
  for (const jobId of jobIds) {
    const job = store.job(jobId);
    if (job.mode !== 'review-all') throw new Error('This batch does not use review-all mode.');
    const saved = savedDecisionIds(store.db, job.review_url);
    for (const item of store.items(jobId)) {
      if (saved.has(item.study_id)) continue;
      if (['completed', 'skipped', 'saved'].includes(item.state)) continue;
      if (item.state !== 'recommended' || item.data.batchApproval)
        throw new Error(
          'Finish preparing this batch before reviewing it, or resume its confirmed submissions.',
        );
      const runId =
        item.data.recommendationRecord?.runId ||
        item.data.recommendationRef?.replace(/^recommendation:/, '');
      const row = store.db.prepare('SELECT * FROM recommendations WHERE run_id=?').get(runId || '');
      if (
        !row ||
        row.review_url !== job.review_url ||
        row.config_hash !== job.config_hash ||
        row.study_id !== item.study_id ||
        row.status !== 'recommended'
      )
        throw new Error(
          'The exact saved AI response is missing or belongs to another study/settings.',
        );
      const recommendation = {
        record: JSON.parse(row.record),
        parsed: JSON.parse(row.parsed || '{}'),
        study: JSON.parse(row.study || 'null'),
      };
      const r = recommendation.record;
      if (
        !recommendation.study ||
        r.studyHash !== studyHash(recommendation.study) ||
        r.runId !== runId ||
        r.configHash !== job.config_hash ||
        r.studyId !== item.study_id ||
        r.reviewUrl !== job.review_url
      )
        throw new Error('Saved citation or response identity changed.');
      if (
        item.data.voteRecord ||
        store.db
          .prepare('SELECT 1 FROM vote_claims WHERE claim_key=?')
          .get(claimKey({ reviewUrl: job.review_url }, item.study_id))
      )
        throw new Error(
          `Study #${item.study_id} has a vote attempt; resolve it before batch confirmation.`,
        );
      entries.push({
        jobId,
        reviewUrl: job.review_url,
        configHash: job.config_hash,
        studyId: item.study_id,
        recommendation,
        draft: reviewDecision(recommendation, item.data.batchReview),
      });
    }
  }
  const identities = entries.map((e) => `${e.reviewUrl}/${e.studyId}`);
  if (new Set(identities).size !== identities.length)
    throw new Error('A study appears in more than one batch. Review the batches separately.');
  return entries;
}

const fingerprint = (entries) =>
  hash(
    entries.map(({ jobId, reviewUrl, configHash, studyId, draft }) => ({
      jobId,
      reviewUrl,
      configHash,
      studyId,
      draft,
    })),
  );

export function readApprovalBatch(file, jobIds) {
  const store = new QueueStore(file);
  try {
    const entries = entriesFor(store, jobIds);
    return { entries, fingerprint: fingerprint(entries) };
  } finally {
    store.close();
  }
}

export function saveBatchEdit(file, target, change) {
  const store = new QueueStore(file);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const entry = entriesFor(store, [target.jobId]).find((e) => e.studyId === target.studyId);
    if (!entry || hash(entry.draft) !== hash(target.draft))
      throw new Error('The study changed while you were editing. Reopen it.');
    const draft = { ...entry.draft };
    if (change.decision !== undefined) {
      if (!Object.hasOwn(decisionMap, change.decision)) throw new Error('Choose Yes, No or Maybe.');
      draft.decision = change.decision;
    }
    if (change.rationale !== undefined) {
      const wording = change.rationale.trim();
      if (!wording) throw new Error('The rationale cannot be blank.');
      const parts = rationaleParts(draft.rationale);
      draft.rationale = parts.prefix + wording + parts.suffix;
      if (draft.rationale.length > 32760) throw new Error('The rationale is too long for Excel.');
    }
    const item = store.item(target.jobId, target.studyId);
    store.updateInTransaction(target.jobId, target.studyId, 'recommended', {
      ...item.data,
      batchReview: draft,
    });
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  } finally {
    store.close();
  }
}

// A single transaction seals every final decision, including unchanged and unvisited studies.
export function confirmBatch(file, jobIds, expectedFingerprint, currentConfig) {
  const store = new QueueStore(file);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const entries = entriesFor(store, jobIds);
    if (!entries.length || fingerprint(entries) !== expectedFingerprint)
      throw new Error('The batch changed during review. Reopen it before confirming.');
    if (
      entries.some(
        (e) => e.configHash !== currentConfig.configHash || e.reviewUrl !== currentConfig.reviewUrl,
      )
    )
      throw new Error('Project settings changed. This batch has not been confirmed.');
    const id = randomUUID(),
      confirmedAt = new Date().toISOString();
    for (const entry of entries) {
      const item = store.item(entry.jobId, entry.studyId);
      store.updateInTransaction(entry.jobId, entry.studyId, 'recommended', {
        ...item.data,
        batchReview: entry.draft,
        batchApproval: { id, confirmedAt, reviewHash: hash(entry.draft) },
      });
    }
    store.db.exec('COMMIT');
    return { confirmed: true, count: entries.length };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  } finally {
    store.close();
  }
}

// Saving ends automatic review without approving a single Covidence vote.
// Caller holds the worker lock; all entries, including unvisited studies, are saved together.
export function saveBatchWithoutSubmitting(file, jobIds, expectedFingerprint, currentConfig) {
  const store = new QueueStore(file);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const entries = entriesFor(store, jobIds);
    if (!entries.length || fingerprint(entries) !== expectedFingerprint)
      throw new Error('The batch changed during review. Reopen it before saving.');
    if (
      entries.some(
        (e) => e.configHash !== currentConfig.configHash || e.reviewUrl !== currentConfig.reviewUrl,
      )
    )
      throw new Error('Project settings changed. This batch has not been saved.');
    const keys = new Set(entries.map((e) => claimKey({ reviewUrl: e.reviewUrl }, e.studyId)));
    for (const row of store.db
      .prepare('SELECT i.data,j.review_url,i.study_id FROM items i JOIN jobs j ON j.id=i.job_id')
      .all()) {
      if (!keys.has(claimKey({ reviewUrl: row.review_url }, row.study_id))) continue;
      const data = JSON.parse(row.data);
      if (data.batchApproval || data.voteRecord || data.voteRef || data.stage === 'voting')
        throw new Error(
          'A study has confirmed decisions or a vote attempt. Resolve it before saving without submission.',
        );
    }
    for (const row of store.db.prepare('SELECT record FROM votes').all())
      if (keys.has(claimKey(JSON.parse(row.record))))
        throw new Error('A study has a vote attempt. Resolve it before saving without submission.');
    const id = randomUUID(),
      savedAt = new Date().toISOString();
    for (const entry of entries) {
      const item = store.item(entry.jobId, entry.studyId);
      store.updateInTransaction(entry.jobId, entry.studyId, 'saved', {
        ...item.data,
        batchReview: entry.draft,
        savedWithoutSubmission: { id, savedAt, reviewHash: hash(entry.draft) },
      });
    }
    store.db.exec('COMMIT');
    return { savedOnly: true, count: entries.length };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  } finally {
    store.close();
  }
}

// Caller holds the worker lock. Delete unsubmitted responses and drafts atomically.
// Keep only cancellation identifiers and activity/usage counts, never a response backup.
export function cancelBatch(file, jobIds, expectedFingerprint) {
  const store = new QueueStore(file);
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const entries = entriesFor(store, jobIds);
    if (!entries.length || fingerprint(entries) !== expectedFingerprint)
      throw new Error('The batch changed during review. Reopen it before cancelling.');
    const reviewUrl = entries[0].reviewUrl;
    if (entries.some((e) => e.reviewUrl !== reviewUrl))
      throw new Error('Cancel batches from one project at a time.');
    if (
      jobIds.some((id) =>
        store.items(id).some((i) => i.state === 'completed' || i.data.batchApproval),
      )
    )
      throw new Error('This batch has confirmed or submitted decisions. It cannot be cancelled.');
    const studyIds = new Set(entries.map((e) => e.studyId));
    const keys = new Set(entries.map((e) => claimKey({ reviewUrl }, e.studyId)));
    for (const row of store.db.prepare('SELECT record FROM votes').all()) {
      if (keys.has(claimKey(JSON.parse(row.record))))
        throw new Error(
          'A study has a vote attempt. Use Review unfinished studies to check it first.',
        );
    }
    const allItems = store.db
      .prepare('SELECT i.*,j.review_url,j.config_hash FROM items i JOIN jobs j ON j.id=i.job_id')
      .all()
      .filter((i) => keys.has(claimKey({ reviewUrl: i.review_url }, i.study_id)));
    // A cached vote reference or approval in another batch must also prevent cancellation.
    if (
      allItems.some((i) => {
        const d = JSON.parse(i.data);
        return (
          i.state === 'completed' ||
          d.batchApproval ||
          d.savedWithoutSubmission ||
          d.voteRecord ||
          d.voteRef ||
          d.stage === 'voting'
        );
      })
    )
      throw new Error('A study has confirmed decisions or a vote attempt. Records kept.');
    const settingsFor = (row) =>
      entries.some(
        (e) =>
          e.studyId === row.study_id &&
          e.reviewUrl === row.review_url &&
          e.configHash === row.config_hash,
      );
    // Delete older attempts for the same study/settings too, so the next batch
    // cannot silently reuse an older answer or block its fresh request.
    const records = store.db
      .prepare('SELECT * FROM recommendations')
      .all()
      .filter(settingsFor)
      .map((r) => JSON.parse(r.record));
    const runIds = records.map((r) => r.runId),
      removed = new Set(runIds);
    const itemKeys = allItems.filter(settingsFor).map((i) => [i.job_id, i.study_id]);
    const screenings = records
      .filter((r) => r.status === 'recommended')
      .map((r) => ({
        studyId: r.studyId,
        ref: 'recommendation:' + r.runId,
        deviceId: r.deviceId,
        screenedAt: r.reprocessedAt || r.updatedAt || r.createdAt,
      }));
    const usage = { requests: 0, reported: 0, unknown: 0, input: 0, output: 0 };
    for (const r of records.filter((r) => r.requestHash)) {
      usage.requests++;
      if (Number.isInteger(r.usage?.input_tokens) && Number.isInteger(r.usage?.output_tokens)) {
        usage.reported++;
        usage.input += r.usage.input_tokens;
        usage.output += r.usage.output_tokens;
      } else usage.unknown++;
    }
    for (const [jobId, studyId] of itemKeys) {
      store.db.prepare('DELETE FROM events WHERE job_id=? AND study_id=?').run(jobId, studyId);
      store.db.prepare('DELETE FROM items WHERE job_id=? AND study_id=?').run(jobId, studyId);
    }
    for (const runId of runIds) {
      store.db.prepare('DELETE FROM parse_attempts WHERE run_id=?').run(runId);
      store.db.prepare('DELETE FROM recommendation_payloads WHERE run_id=?').run(runId);
      store.db.prepare('DELETE FROM recommendations WHERE run_id=?').run(runId);
    }
    for (const event of store.db
      .prepare(
        "SELECT * FROM project_events WHERE kind IN ('history_rationales_edited','history_studies_edited')",
      )
      .all()) {
      const data = JSON.parse(event.data);
      const edits = data.edits.filter((e) => !removed.has(e.runId));
      if (edits.length === data.edits.length) continue;
      if (!edits.length)
        store.db.prepare('DELETE FROM project_events WHERE event_id=?').run(event.event_id);
      else
        store.db
          .prepare('UPDATE project_events SET data=? WHERE event_id=?')
          .run(JSON.stringify({ ...data, edits }), event.event_id);
    }
    store.db.prepare('INSERT INTO project_events VALUES (?,?,?,?,?)').run(
      randomUUID(),
      reviewUrl,
      new Date().toISOString(),
      'batch_cancelled',
      JSON.stringify({
        jobIds,
        studyIds: [...studyIds],
        itemKeys,
        runIds,
        screenings,
        usage,
        message:
          'Batch decisions cancelled before submission. Studies: ' +
          [...studyIds].map((id) => '#' + id).join(', ') +
          '. AI responses and draft edits deleted without a backup; these studies can be screened again.',
      }),
    );
    store.db.exec('COMMIT');
    return { cancelled: true, count: entries.length };
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  } finally {
    store.close();
  }
}

export async function reviewPendingBatch(
  name,
  file,
  jobIds,
  { input = process.stdin, output = process.stdout, folder, lock, load, view = reviewBatch } = {},
) {
  let selected,
    index = 0;
  while (true) {
    const snapshot = readApprovalBatch(file, jobIds);
    if (!snapshot.entries.length) return false;
    // Keep the initial AI Yes/Maybe group together even when the user changes its decision.
    const entries = [...snapshot.entries].sort(
      (a, b) =>
        Number(a.recommendation.record.decision === 'Exclude') -
        Number(b.recommendation.record.decision === 'Exclude'),
    );
    if (selected)
      index = Math.max(
        0,
        entries.findIndex((e) => `${e.jobId}/${e.studyId}` === selected),
      );
    const counts = Object.keys(decisionMap)
      .map((d) => `${decisionMap[d]}: ${entries.filter((e) => e.draft.decision === d).length}`)
      .join(' | ');
    const lines = entries.map((e) => [
      counts,
      `Study #${e.studyId}: ${e.recommendation.study.title}`,
      `AI: ${decisionMap[e.recommendation.record.decision]} | Your decision: ${decisionMap[e.draft.decision]}`,
      '',
      ...reviewedResponse(
        e.draft.rationale,
        e.recommendation.record.decision,
        e.draft.decision,
      ).split(/\r?\n/),
      '',
      'Abstract:',
      ...(e.recommendation.study.abstract || 'No abstract available.').split(/\r?\n/),
      '',
      `Citation: ${e.recommendation.study.author || ''} ${e.recommendation.study.year || ''}`,
    ]);
    const result = await view(name, lines, {
      input,
      output,
      startIndex: index,
      editable: true,
      approval: true,
      statusLabel: 'Review before submission',
    });
    if (!result || result === true) return result;
    let terminal;
    try {
      terminal = createTerminal({ input, output });
      if (result.saveOnlyRequested) {
        const answer = await terminal.question(
          '\r\nSave ALL ' +
            entries.length +
            ' decisions without submitting to Covidence? These previews will not return in new batches. [y/N]: ',
        );
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) continue;
        const release = await lock();
        try {
          const saved = saveBatchWithoutSubmitting(
            file,
            jobIds,
            snapshot.fingerprint,
            await load(entries[0].reviewUrl),
          );
          try {
            await exportProjectHistory(file, entries[0].reviewUrl, { folder });
          } catch (error) {
            output.write(
              '\r\nDecisions saved locally without submission; Excel was not updated. Close Excel and use Export project history. ' +
                error.message +
                '\r\n',
            );
            await terminal.question('Press Enter to return to this project. ');
          }
          return saved;
        } finally {
          await release();
        }
      }
      if (result.cancelRequested) {
        const answer = await terminal.question(
          '\r\nCancel ALL ' +
            entries.length +
            ' unsubmitted decisions and delete their AI responses and edits? No backup will be made. These abstracts can be screened again. [y/N]: ',
        );
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) continue;
        const release = await lock();
        let cancelled;
        try {
          cancelled = cancelBatch(file, jobIds, snapshot.fingerprint);
          try {
            await exportProjectHistory(file, entries[0].reviewUrl, { folder });
          } catch (error) {
            output.write(
              '\r\nBatch cancelled locally; Excel was not updated. Close Excel and use Export project history. ' +
                error.message +
                '\r\n',
            );
            await terminal.question('Press Enter to return to this project. ');
          }
        } finally {
          await release();
        }
        return cancelled;
      }
      if (result.confirmed) {
        const answer = await terminal.question(
          `\r\nConfirm ALL ${entries.length} decisions and submit votes to Covidence? [y/N]: `,
        );
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) continue;
        const release = await lock();
        try {
          return confirmBatch(file, jobIds, snapshot.fingerprint, await load(entries[0].reviewUrl));
        } finally {
          await release();
        }
      }
      index = result.editIndex ?? result.decisionIndex;
      const entry = entries[index];
      selected = `${entry.jobId}/${entry.studyId}`;
      let change;
      if (result.decision) {
        const answer = await terminal.question(
          `\r\nStudy #${entry.studyId}: change decision from ${decisionMap[entry.draft.decision]} to ${decisionMap[result.decision]}? [y/N]: `,
        );
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) continue;
        change = { decision: result.decision };
      } else {
        output.write(
          `\r\nStudy #${entry.studyId}. Current rationale:\r\n${rationaleParts(entry.draft.rationale).explanation}\r\n`,
        );
        const wording = await terminal.question('New rationale (Enter keeps current wording): ');
        if (!wording.trim()) continue;
        output.write(`\r\nNew rationale:\r\n${wording.trim()}\r\n`);
        const answer = await terminal.question(
          `Save this rationale for study #${entry.studyId}? [y/N]: `,
        );
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) continue;
        change = { rationale: wording };
      }
      const release = await lock();
      try {
        saveBatchEdit(file, entry, change);
        try {
          await exportProjectHistory(file, entry.reviewUrl, { folder });
        } catch (error) {
          throw new Error(`Your edit is saved locally; Excel was not updated. ${error.message}`, {
            cause: error,
          });
        }
      } finally {
        await release();
      }
    } catch (error) {
      terminal ||= createTerminal({ input, output });
      output.write(`\r\n${error.message}\r\n`);
      await terminal.question('Press Enter to return to review. ');
    } finally {
      if (terminal) {
        input.pause();
        await setImmediate();
        terminal.close();
      }
    }
  }
}

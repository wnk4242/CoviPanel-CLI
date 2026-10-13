import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { reviewFolder } from './config.js';
import { requiresReview } from './states.js';
import { hash } from './profiles.js';
import { reviewedResponse } from './review-decisions.js';

export function reviewKey(url) {
  const value = new URL(url),
    id = value.pathname.match(/^\/reviews\/(\d+)(?:\/|$)/)?.[1];
  if (!id) throw new Error('Invalid review address.');
  return `${value.origin}/reviews/${id}`;
}
const localTime = (value) =>
  value ? new Date(value).toLocaleString('sv-SE') : 'Time not recorded';
function batchName(job, jobs) {
  const list = jobs
    .filter((j) => reviewKey(j.review_url) === reviewKey(job.review_url))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return `Batch ${String(list.findIndex((j) => j.id === job.id) + 1).padStart(2, '0')} (${localTime(job.created_at)})`;
}
const ordered = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '');
const friendly = (value) =>
  ({
    confirmed: 'Submitted and verified',
    recommended: 'Recommendation saved; not submitted',
    saved: 'Decisions saved without submission',
    pending: 'Waiting',
    processing: 'In progress',
    completed: 'Finished',
    skipped: 'Skipped',
    needs_review: 'Needs review',
    error: 'Error',
    uncertain: 'Submission uncertain',
    mismatch: 'Recorded vote differs from AI decision',
    cancelled: 'Cancelled before submission',
    blocked_before_click: 'Stopped before submission',
    request_started: 'API request started; outcome unknown',
    response_saved: 'API response saved',
    extracting: 'Reading citation',
    click_intent: 'Submission may have started',
    click_returned: 'Vote clicked; verification pending',
  })[value] ||
  value?.replaceAll('_', ' ') ||
  'Not recorded';

// A consistent local snapshot; no browser, API client or source-file imports.
export function readProjectHistory(databasePath, reviewUrl) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const key = reviewKey(reviewUrl),
    same = (url) => reviewKey(url) === key;
  try {
    db.exec('BEGIN');
    const jobs = db
      .prepare('SELECT * FROM jobs ORDER BY created_at,id')
      .all()
      .filter((j) => same(j.review_url));
    const jobIds = new Set(jobs.map((j) => j.id));
    const items = db
      .prepare('SELECT * FROM items ORDER BY updated_at,job_id,ordinal')
      .all()
      .filter((i) => jobIds.has(i.job_id))
      .map((i) => ({ ...i, data: JSON.parse(i.data) }));
    const events = db
      .prepare('SELECT * FROM events ORDER BY created_at,id')
      .all()
      .filter((e) => jobIds.has(e.job_id))
      .map((e) => ({ ...e, data: JSON.parse(e.data) }));
    const recommendations = db
      .prepare('SELECT record,study,parsed FROM recommendations ORDER BY rowid')
      .all()
      .map((r) => ({
        record: JSON.parse(r.record),
        study: r.study ? JSON.parse(r.study) : null,
        parsed: r.parsed ? JSON.parse(r.parsed) : null,
      }))
      .filter((r) => same(r.record.reviewUrl));
    const votes = db
      .prepare('SELECT record FROM votes ORDER BY rowid')
      .all()
      .map((v) => JSON.parse(v.record))
      .filter((v) => same(v.reviewUrl));
    const prefix = `${new URL(key).hostname}-${key.split('/').at(-1)}-`;
    const claims = db
      .prepare('SELECT * FROM vote_claims ORDER BY claim_key')
      .all()
      .filter((c) => c.claim_key.startsWith(prefix));
    const hasTable = (name) =>
      Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const activity = hasTable('project_events')
      ? db
          .prepare('SELECT * FROM project_events ORDER BY created_at,event_id')
          .all()
          .filter((e) => same(e.review_url))
          .map((e) => ({ ...e, data: JSON.parse(e.data) }))
      : [];
    const settings = db
      .prepare('SELECT job_id,config FROM job_settings')
      .all()
      .filter((s) => jobIds.has(s.job_id))
      .map((s) => ({ ...s, config: JSON.parse(s.config) }));
    db.exec('COMMIT');
    return buildProjectHistory({
      key,
      jobs,
      items,
      events,
      recommendations,
      votes,
      claims,
      activity,
      settings,
    });
  } finally {
    db.close();
  }
}

export function buildProjectHistory({
  key,
  jobs,
  items,
  events,
  recommendations,
  votes,
  claims = [],
  activity = [],
  settings = [],
}) {
  jobs = [...jobs].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  events = [...events].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || (a.id ?? 0) - (b.id ?? 0),
  );
  recommendations = [...recommendations].sort((a, b) => ordered(a.record, b.record));
  votes = [...votes].sort(ordered);
  const jobOrder = new Map(jobs.map((job, index) => [job.id, index]));
  const queueOrder = new Map();
  for (const item of [...items].sort(
    (a, b) =>
      jobOrder.get(a.job_id) - jobOrder.get(b.job_id) || (a.ordinal ?? 0) - (b.ordinal ?? 0),
  )) {
    if (!queueOrder.has(item.study_id)) queueOrder.set(item.study_id, queueOrder.size);
  }
  // First recorded work, not enqueue time or the latest retry/update, fixes a study's position.
  // Event IDs preserve processing order when timestamps tie; old standalone attempts use their saved times.
  const firstWork = new Map(),
    batchWork = new Map();
  const work = [
    ...events
      .filter((e) => !['pending', 'mode_changed'].includes(e.state))
      .map((e) => ({ studyId: e.study_id, jobId: e.job_id, createdAt: e.created_at })),
    ...recommendations.map((r) => r.record),
    ...votes,
  ]
    .filter((e) => e.createdAt)
    .sort(ordered);
  for (const entry of work) {
    if (!firstWork.has(entry.studyId)) firstWork.set(entry.studyId, firstWork.size);
    if (entry.jobId) {
      const key = `${entry.jobId}/${entry.studyId}`;
      if (!batchWork.has(key)) batchWork.set(key, batchWork.size);
    }
  }
  const rank = (map, key) => map.get(key) ?? Number.MAX_SAFE_INTEGER;
  const byRun = new Map(recommendations.map((r) => [r.record.runId, r]));
  const byVote = new Map(votes.map((v) => [v.attemptId, v]));
  const groups = new Map();
  const group = (id) => {
    if (!groups.has(id)) groups.set(id, { id, items: [], recommendations: [], votes: [] });
    return groups.get(id);
  };
  for (const item of items) group(item.study_id).items.push(item);
  for (const r of recommendations) group(r.record.studyId).recommendations.push(r);
  for (const v of votes) group(v.studyId).votes.push(v);
  for (const c of claims) group(c.claim_key.split('-').at(-1)).claim = c;
  const studies = [...groups.values()]
    .sort(
      (a, b) =>
        rank(firstWork, a.id) - rank(firstWork, b.id) ||
        rank(queueOrder, a.id) - rank(queueOrder, b.id),
    )
    .map((s) => {
      s.recommendations.sort((a, b) => ordered(a.record, b.record));
      s.votes.sort(ordered);
      const retained = s.claim && byVote.get(s.claim.attempt_id);
      const vote =
        retained ||
        s.votes.filter((v) => v.status === 'confirmed').at(-1) ||
        s.votes.filter((v) => !['cancelled', 'blocked_before_click'].includes(v.status)).at(-1);
      const recommendation = vote?.recommendationRunId
        ? byRun.get(vote.recommendationRunId)
        : !vote
          ? s.recommendations.filter((r) => r.record.status === 'recommended').at(-1)
          : null;
      const r = recommendation?.record,
        latest = s.items.at(-1);
      const title =
        recommendation?.study?.title ||
        r?.title ||
        vote?.title ||
        latest?.data.study?.title ||
        s.recommendations.at(-1)?.record.title ||
        '';
      const reviewed =
        vote?.humanReview ||
        (!vote
          ? [...s.items].reverse().find((item) => item.data.batchReview?.runId === r?.runId)?.data
              .batchReview
          : null);
      const decision = vote?.decision || reviewed?.decision || r?.decision || '';
      const rationale =
        (reviewed
          ? reviewedResponse(reviewed.rationale, r?.decision, reviewed.decision)
          : r?.rationale) ||
        (vote?.decisionSource === 'explicit-test-input'
          ? 'Explicit test decision; no AI rationale was recorded.'
          : '');
      const manualVote = [...s.items]
        .reverse()
        .find((item) => item.data.savedVoteCheck?.outcome === 'voted')?.data.savedVoteCheck;
      const status =
        s.claim && !retained
          ? 'Retained vote claim needs review'
          : vote
            ? friendly(vote.status)
            : manualVote
              ? 'Covidence vote ' + manualVote.recordedVote + ' verified; saved decision retained'
              : r
                ? friendly('recommended')
                : friendly(latest?.state);
      return { ...s, title, decision, rationale, status, vote, manualVote, recommendation };
    });
  // Editorial wording belongs to the export, not the original recommendation.
  // Bind each edit to its exact source so a later screening cannot inherit it.
  const rationaleEdits = new Map();
  for (const event of [...activity].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) ||
      (a.event_id || '').localeCompare(b.event_id || ''),
  )) {
    if (
      event.kind !== 'history_rationales_edited' ||
      event.review_url !== key ||
      !Array.isArray(event.data?.edits)
    )
      continue;
    for (const edit of event.data.edits) {
      if (
        !edit ||
        typeof edit.rationale !== 'string' ||
        !edit.rationale.trim() ||
        edit.rationale.length > 32767
      )
        continue;
      rationaleEdits.set(edit.runId, edit);
    }
  }
  // Workbook imports are reporting evidence, never reusable AI answers or vote claims.
  const imports = activity.filter(
    (event) => event.kind === 'history_workbook_imported' && event.review_url === key,
  );
  const importedRows = new Map();
  for (const event of imports) {
    if (!Array.isArray(event.data?.rows)) throw new Error('Imported history rows are missing.');
    for (const row of event.data.rows) {
      if (
        !Array.isArray(row) ||
        row.length !== 4 ||
        row.some((value) => typeof value !== 'string' || value.length > 32767) ||
        !/^[1-9]\d*$/.test(row[0]) ||
        !['Include', 'Exclude', 'Maybe'].includes(row[2])
      )
        throw new Error('Invalid imported history row.');
      const previous = importedRows.get(row[0]);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error(`Conflicting imported history for study #${row[0]}.`);
      importedRows.set(row[0], row);
    }
  }
  for (const row of importedRows.values()) {
    if (groups.has(row[0])) continue;
    studies.push({
      id: row[0],
      title: row[1],
      decision: row[2],
      rationale: row[3],
      status: 'Imported spreadsheet decision; submission not verified locally',
      items: [],
      recommendations: [],
      votes: [],
      importedRow: row,
    });
  }
  const rows = [
    ['Study number', 'Title', 'Decision', 'Rationale'],
    ...studies.map((s) => {
      if (s.importedRow) return [...s.importedRow];
      const edit = rationaleEdits.get(s.recommendation?.record.runId);
      const rationale =
        edit?.studyId === s.id &&
        edit.decision === s.decision &&
        edit.sourceHash === hash({ title: s.title, rationale: s.rationale })
          ? edit.rationale
          : s.rationale;
      s.exportRationale = rationale;
      return [s.id, s.title, s.decision, rationale];
    }),
  ];
  const settingNumbers = new Map();
  for (const { config } of settings)
    if (!settingNumbers.has(config.configHash))
      settingNumbers.set(config.configHash, settingNumbers.size + 1);
  const attempted = recommendations.filter((r) => r.record.requestHash);
  const known = attempted.filter(
    (r) =>
      Number.isInteger(r.record.usage?.input_tokens) &&
      Number.isInteger(r.record.usage?.output_tokens),
  );
  const usage = {
    requests: attempted.length,
    reported: known.length,
    unknown: attempted.length - known.length,
    input: known.reduce((n, r) => n + r.record.usage.input_tokens, 0),
    output: known.reduce((n, r) => n + r.record.usage.output_tokens, 0),
  };
  for (const event of activity.filter((e) => e.kind === 'batch_cancelled')) {
    for (const key of Object.keys(usage)) usage[key] += event.data.usage?.[key] || 0;
  }
  const times = [
    ...jobs.map((j) => j.created_at),
    ...items.map((i) => i.updated_at),
    ...events.map((e) => e.created_at),
    ...recommendations.map((r) => r.record.updatedAt || r.record.createdAt),
    ...votes.map((v) => v.updatedAt || v.createdAt),
    ...activity.map((e) => e.created_at),
  ]
    .filter(Boolean)
    .sort();
  const attention = studies.filter(
    (s) =>
      (s.claim && !s.vote) ||
      (s.vote && s.vote.status !== 'confirmed') ||
      (!s.vote && requiresReview(s.items.at(-1)?.state)),
  );
  const lines = [
    'CoviPanel screening log',
    `Review: ${key}`,
    `Records through: ${localTime(times.at(-1))} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    '',
    `${studies.length} unique study numbers; ${studies.filter((s) => s.vote?.status === 'confirmed' || s.manualVote?.outcome === 'voted').length} submitted and verified.`,
    `Needs attention: ${attention.map((s) => `#${s.id} (${s.status})`).join(', ') || 'None'}.`,
    `${items.length} batch entries; ${items.length - new Set(items.map((i) => i.study_id)).size} repeated batch entries retained in history.`,
    `AI request attempts: ${usage.requests}. Reported tokens: ${usage.input} input + ${usage.output} output.`,
    `Usage unavailable for ${usage.unknown} request(s); unavailable usage is not counted as zero.`,
    'Exports use saved local records and make no AI requests.',
    'Excel has one row per study: the decision linked to its retained vote, otherwise its latest saved recommendation.',
    'Study order follows the first recorded screening activity. Waiting studies follow in queue order; retries keep the original position.',
    'The submission status below distinguishes saved recommendations from votes verified in Covidence.',
    'Repeated study numbers are consolidated only within this review. Different study numbers are not merged by title.',
    '',
    'CURRENT STUDY STATUS',
  ];
  for (const s of studies)
    lines.push(
      '',
      `Study #${s.id}: ${s.title || 'Title not yet read'}`,
      `Decision: ${s.decision || 'Not decided'}`,
      `Status: ${s.status}`,
      ...(s.manualVote
        ? [
            `Covidence manual vote: ${s.manualVote.recordedVote}. Checked: ${localTime(s.manualVote.checkedAt)}. Submission date is not known.`,
          ]
        : []),
      `Final rationale: ${s.exportRationale || s.rationale || 'Not saved'}`,
      ...(s.vote
        ? [
            `Expected / selected / recorded button: ${s.vote.expectedButton || 'Unknown'} / ${s.vote.actualButton || 'Not clicked'} / ${s.vote.recordedVote || 'Not verified'}`,
          ]
        : []),
    );
  if (imports.length) {
    lines.push(
      '',
      'IMPORTED SPREADSHEET HISTORY',
      'Imported rows retain source wording. They do not establish API usage or verified votes.',
      'Existing local study records take precedence when the same study number is present.',
    );
    for (const event of imports) {
      lines.push(
        '',
        `Imported: ${localTime(event.created_at)}`,
        `Source: ${event.data.sourceFile || 'Not recorded'}`,
        `Source SHA-256: ${event.data.sourceHash || 'Not recorded'}`,
      );
      for (const row of event.data.rows)
        lines.push(
          '',
          `Study #${row[0]}: ${row[1]}`,
          `Decision: ${row[2]}`,
          `Rationale: ${row[3]}`,
        );
    }
  }
  lines.push('', 'BATCHES');
  for (const job of jobs) {
    const batchItems = items
      .filter((i) => i.job_id === job.id)
      .sort(
        (a, b) =>
          rank(batchWork, `${job.id}/${a.study_id}`) - rank(batchWork, `${job.id}/${b.study_id}`) ||
          (a.ordinal ?? 0) - (b.ordinal ?? 0),
      );
    lines.push(
      '',
      `${batchName(job, jobs)}: ${job.mode === 'recommend-only' ? 'Recommendations only' : 'Voting'}`,
      ...batchItems.map(
        (i) =>
          `  Study #${i.study_id}: ${friendly(i.state)}${i.data.error ? ` — ${i.data.error}` : ''}`,
      ),
    );
  }
  lines.push('', 'ERRORS AND RECOVERY HISTORY');
  const problems = events.filter(
    (e) => requiresReview(e.state) || e.state === 'skipped' || e.data.error || e.data.reviewReason,
  );
  const seenProblems = new Set();
  for (const e of problems) {
    const message = e.data.error || e.data.reviewReason || friendly(e.state),
      signature = [e.job_id, e.study_id, message].join('|');
    if (seenProblems.has(signature)) continue;
    seenProblems.add(signature);
    lines.push(
      `${localTime(e.created_at)} — ${batchName(
        jobs.find((j) => j.id === e.job_id),
        jobs,
      )}, study #${e.study_id}: ${message}`,
    );
  }
  if (!problems.length) lines.push('No batch errors or recovery actions recorded.');
  lines.push('', 'BATCH REVIEW AND CONFIRMATION HISTORY');
  const reviewedEvents = new Set();
  for (const event of events) {
    if (!event.data.batchReview) continue;
    const signature = hash({
      jobId: event.job_id,
      studyId: event.study_id,
      review: event.data.batchReview,
      approval: event.data.batchApproval,
      saved: event.data.savedWithoutSubmission,
    });
    if (reviewedEvents.has(signature)) continue;
    reviewedEvents.add(signature);
    lines.push(
      '',
      `${localTime(event.created_at)} — study #${event.study_id}: ${event.data.batchApproval ? 'Batch confirmed with C' : event.data.savedWithoutSubmission ? 'Saved without submission; excluded from new batches' : 'Draft edited; not yet confirmed'}`,
      `Final decision: ${event.data.batchReview.decision}`,
      `Rationale / response: ${event.data.batchReview.rationale}`,
      ...(event.data.batchApproval ? [`Confirmation: ${event.data.batchApproval.id}`] : []),
    );
  }
  lines.push('', 'AI DECISION AND REQUEST HISTORY');
  for (const [index, r] of recommendations.entries()) {
    const v = r.record;
    lines.push(
      '',
      `AI attempt ${index + 1} — ${localTime(v.createdAt)} — study #${v.studyId}`,
      `Title: ${r.study?.title || v.title || 'Not read'}`,
      `Status: ${v.status === 'recommended' ? 'AI decision saved' : friendly(v.status)}. Model: ${v.actualModel || v.model || 'Not recorded'}. Settings: ${settingNumbers.get(v.configHash) || 'Not recorded'}.`,
      ...(r.parsed?.ResponseText
        ? [r.parsed.ResponseText]
        : [
            `Decision: ${v.decision || 'Not decided'}`,
            `Rationale: ${v.rationale || 'No validated rationale saved'}`,
          ]),
      ...(r.parsed?.Uncertainty ? [`Uncertainty: ${r.parsed.Uncertainty}`] : []),
      ...(v.error ? [`Error: ${v.error}`] : []),
      `Tokens: ${v.usage ? `${v.usage.input_tokens} input; ${v.usage.output_tokens} output` : v.requestHash ? 'Usage unavailable' : 'No request started'}`,
    );
  }
  lines.push('', 'VOTE AND VERIFICATION HISTORY');
  for (const [index, v] of votes.entries())
    lines.push(
      '',
      `Vote attempt ${index + 1} — ${localTime(v.createdAt)} — study #${v.studyId}`,
      `Decision: ${v.decision || 'Not recorded'}. Status: ${friendly(v.status)}.`,
      ...(v.humanReview
        ? [
            `Batch confirmed: ${localTime(v.humanReview.confirmedAt)}. Original AI decision: ${v.humanReview.originalDecision}.`,
            `Approved rationale: ${v.humanReview.rationale}`,
          ]
        : []),
      `Expected / selected / recorded button: ${v.expectedButton || 'Unknown'} / ${v.actualButton || 'Not clicked'} / ${v.recordedVote || 'Not verified'}`,
      ...(v.error || v.reason ? [`Detail: ${v.error || v.reason}`] : []),
      ...(v.addedRows || []).map((row) => `Covidence history: ${row.replace(/\s+/g, ' ').trim()}`),
    );
  lines.push('', 'DUPLICATES AND SAVED WORK');
  const repeats = studies.filter(
    (s) => s.items.length > 1 || s.recommendations.length > 1 || s.votes.length > 1,
  );
  for (const s of repeats)
    lines.push(
      `Study #${s.id}: ${s.items.length} batch entries, ${s.recommendations.length} saved AI attempts, ${s.votes.length} vote attempts. One Excel row.`,
    );
  if (!repeats.length) lines.push('No repeated batch entries or repeat attempts recorded.');
  const savedWork = new Set();
  for (const e of events.filter((e) => e.data.reusedRecommendation || e.data.duplicatePrevented)) {
    const signature = [
      e.job_id,
      e.study_id,
      e.data.recommendationRef,
      e.data.duplicatePrevented,
    ].join('|');
    if (savedWork.has(signature)) continue;
    savedWork.add(signature);
    lines.push(
      `${localTime(e.created_at)} — study #${e.study_id}: ${e.data.duplicatePrevented ? 'Existing vote retained; no new API call or vote.' : 'Saved recommendation reused; no new API call.'}`,
    );
  }
  for (const e of activity) {
    lines.push('', `${localTime(e.created_at)} — ${e.kind.replaceAll('_', ' ')}`);
    if (e.kind === 'discovery')
      lines.push(
        `Awaiting votes: ${e.data.total}. Requested: ${e.data.requested}. Selected: ${(e.data.studies || []).length}.`,
        `Selected studies: ${(e.data.studies || []).map((s) => `#${s.studyId}`).join(', ') || 'None'}`,
        ...(e.data.blocked || []).map(
          (s) => `Study #${s.studyId} was blocked from reprocessing: ${s.reason}`,
        ),
      );
    else lines.push(e.data.error || e.data.message || 'Event details retained in the program.');
  }
  lines.push('', 'SCREENING CRITERIA USED');
  const seenSettings = new Set();
  for (const s of settings) {
    const c = s.config;
    if (seenSettings.has(c.configHash)) continue;
    seenSettings.add(c.configHash);
    lines.push(
      '',
      `Settings ${seenSettings.size}: ${jobs
        .filter((j) => j.config_hash === c.configHash)
        .map((j) => batchName(j, jobs))
        .join(', ')}`,
      ...(c.promptSections
        ? [
            `Inclusion criteria:\n${c.promptSections.inclusion}`,
            `Exclusion criteria:\n${c.promptSections.exclusion}`,
            `Response format:\n${c.promptSections.responseFormat}`,
          ]
        : [
            `Include: ${c.criteria?.inclusion?.join(' ') || 'Not recorded'}`,
            `Exclude: ${c.criteria?.exclusion?.join(' ') || 'Not recorded'}`,
            `Interpretation: ${c.criteria?.interpretation?.join(' ') || 'Not recorded'}`,
          ]),
      `Model: ${c.openai?.model || 'Not recorded'}`,
    );
  }
  // A separate view of every study saved with S, using the exact final export text.
  // Keep one row per study and retain this provenance even if a manual vote is later verified.
  const savedOnlyIds = new Set(
    studies
      .filter((s) => s.items.some((item) => item.data.savedWithoutSubmission?.id))
      .map((s) => s.id),
  );
  const savedOnlyRows = [rows[0], ...rows.slice(1).filter((row) => savedOnlyIds.has(row[0]))];
  return { key, rows, savedOnlyRows, studies, jobs, usage, log: lines.join('\n') + '\n' };
}

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function writeProjectLog(history, folder = reviewFolder(history.key)) {
  const file = path.join(folder, 'Screening Log.txt');
  await writeAtomic(file, history.log);
  return file;
}

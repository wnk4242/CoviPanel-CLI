import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import {
  databasePath,
  projectsDir,
  reviewFolder,
  screeningAddress,
  profileForReview,
  normalizeProjectName,
} from './config.js';
import { validateProfile } from './profiles.js';
import { reviewKey } from './project-history.js';
import { finishedItem, requiresReview } from './states.js';
import { screeningDevice } from './screening-device.js';
import { savedDecisionIds, submissionCounts } from './saved-decisions.js';

export const projectLocation = (url, root = projectsDir) =>
  path.join(root, path.basename(reviewFolder(url)));

export async function readProject(url, { root = projectsDir } = {}) {
  const reviewUrl = screeningAddress(url);
  const folder = projectLocation(reviewUrl, root);
  const file = path.join(folder, 'Project settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  if (screeningAddress(settings.reviewUrl) !== reviewUrl)
    throw new Error('Saved settings belong to a different project.');
  return {
    reviewUrl,
    folder,
    file,
    settings,
    name: normalizeProjectName(settings.projectName) || path.basename(folder),
  };
}

export async function loadProject(url, options = {}) {
  const project = await readProject(url, options);
  return validateProfile(project.settings, profileForReview(project.reviewUrl), '1');
}

// Project folders are the catalog. Legacy demo/standard aliases remain
// available to old worker commands, without limiting the number of projects.
export async function listProjects({
  root = projectsDir,
  databaseFile = databasePath,
  now = new Date(),
  deviceId = screeningDevice().id,
} = {}) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const projects = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !/^(?:Demo Review|Review) [1-9]\d*$/.test(entry.name)
    )
      continue;
    const file = path.join(root, entry.name, 'Project settings.json');
    try {
      const settings = JSON.parse(await readFile(file, 'utf8'));
      const project = await readProject(settings.reviewUrl, { root });
      if (project.file !== file) throw new Error('Project folder and review address disagree.');
      projects.push({
        ...project,
        lastActivity: (await stat(file)).mtime.toISOString(),
        unfinished: 0,
        attention: 0,
      });
    } catch (error) {
      // Do not let a broken settings file silently disappear from the selector.
      const match = entry.name.match(/^(Demo Review|Review) (\d+)$/);
      const reviewUrl = screeningAddress(
        `https://${match[1] === 'Demo Review' ? 'demo' : 'app'}.covidence.org/reviews/${match[2]}`,
      );
      projects.push({
        reviewUrl,
        folder: path.dirname(file),
        file,
        name: entry.name,
        error: error.message,
        lastActivity: '',
        unfinished: 0,
        attention: 0,
      });
    }
  }
  for (const project of projects) {
    project.screened = { today: 0, total: 0 };
    project.historyTotal = 0;
    project.submittedToday = 0;
    project.screenedNotSubmitted = 0;
    project.localScreened = { today: 0, total: 0 };
    project.unassignedScreened = 0;
  }
  if (existsSync(databaseFile)) {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      db.exec('BEGIN');
      const jobs = db.prepare('SELECT * FROM jobs').all();
      const items = db.prepare('SELECT job_id,study_id,state,updated_at FROM items').all();
      // Match the history export's study groups, including pending/failed work and imports.
      // Read identifiers only; loading the menu must not load full response payloads.
      const historyEntries = db
        .prepare(
          `SELECT json_extract(record,'$.reviewUrl') AS review_url,
            json_extract(record,'$.studyId') AS study_id, 0 AS imported FROM recommendations
          UNION
          SELECT json_extract(record,'$.reviewUrl'),json_extract(record,'$.studyId'),0 FROM votes
          UNION
          SELECT e.review_url,json_extract(r.value,'$[0]'),1
          FROM project_events e, json_each(e.data,'$.rows') r
          WHERE e.kind='history_workbook_imported'`,
        )
        .all();
      const historyClaims = db.prepare('SELECT claim_key FROM vote_claims').all();
      // Read only counting metadata, not study text or response payloads.
      const screenings = db
        .prepare(
          `SELECT review_url,study_id,'recommendation:' || run_id AS ref,
            json_extract(record,'$.deviceId') AS device_id,
            COALESCE(json_extract(record,'$.reprocessedAt'),
              json_extract(record,'$.updatedAt'),json_extract(record,'$.createdAt')) AS screened_at
          FROM recommendations WHERE status='recommended'
          UNION ALL
          SELECT json_extract(record,'$.reviewUrl'),json_extract(record,'$.studyId'),
            'vote:' || attempt_id,json_extract(record,'$.deviceId'),
            COALESCE(json_extract(record,'$.clickedAt'),json_extract(record,'$.confirmedAt'),
              json_extract(record,'$.createdAt'))
          FROM votes WHERE json_extract(record,'$.status')='confirmed'
          UNION ALL
          SELECT e.review_url,COALESCE(json_extract(s.value,'$.studyId'),json_extract(e.data,'$.studyId')),json_extract(s.value,'$.ref'),
            json_extract(s.value,'$.deviceId'),json_extract(s.value,'$.screenedAt')
          FROM project_events e, json_each(e.data,'$.screenings') s WHERE e.kind IN ('study_reset','batch_cancelled')`,
        )
        .all();
      const events = db
        .prepare(
          `SELECT review_url,created_at,kind,
        CASE WHEN kind IN ('batch_cleared','batch_restored','screening_device_assignment','covidence_progress') THEN data END AS data
        FROM project_events ORDER BY rowid`,
        )
        .all();
      const hidden = new Set();
      for (const event of events) {
        if (event.kind === 'batch_cleared') hidden.add(JSON.parse(event.data).jobId);
        if (event.kind === 'batch_restored') hidden.delete(JSON.parse(event.data).jobId);
      }
      for (const project of projects) {
        const same = (url) => reviewKey(url) === reviewKey(project.reviewUrl);
        const own = new Map(jobs.filter((j) => same(j.review_url)).map((j) => [j.id, j]));
        const key = reviewKey(project.reviewUrl);
        const claimPrefix = `${new URL(key).hostname}-${key.split('/').at(-1)}-`;
        const historyIds = new Set(
          historyEntries
            .filter((entry) => (entry.imported ? entry.review_url === key : same(entry.review_url)))
            .map((entry) => entry.study_id),
        );
        for (const claim of historyClaims)
          if (claim.claim_key.startsWith(claimPrefix))
            historyIds.add(claim.claim_key.split('-').at(-1));
        const pending = new Set(),
          attention = new Set();
        for (const item of items) {
          const job = own.get(item.job_id);
          if (!job) continue;
          historyIds.add(item.study_id);
          if (!hidden.has(job.id)) {
            if (!finishedItem(item, job.mode)) pending.add(item.study_id);
            if (requiresReview(item.state)) attention.add(item.study_id);
          }
          if (item.updated_at > project.lastActivity) project.lastActivity = item.updated_at;
        }
        for (const event of events.filter(
          (e) =>
            same(e.review_url) &&
            ![
              'covidence_progress',
              'screening_device_assignment',
              'saved_decision_vote_checked',
            ].includes(e.kind),
        ))
          if (event.created_at > project.lastActivity) project.lastActivity = event.created_at;
        const ownEvents = events.filter((e) => same(e.review_url));
        const assigned = new Map();
        for (const event of ownEvents.filter((e) => e.kind === 'screening_device_assignment')) {
          const assignment = JSON.parse(event.data);
          for (const ref of assignment.refs) assigned.set(ref, assignment.deviceId);
        }
        const progress = ownEvents.filter((e) => e.kind === 'covidence_progress').at(-1);
        if (progress) project.covidenceProgress = JSON.parse(progress.data);
        Object.assign(
          project,
          submissionCounts(db, project.reviewUrl, { now, deviceId, assigned }),
        );
        project.unfinished = pending.size;
        project.attention = attention.size;
        project.historyTotal = historyIds.size;
        // Reuse, retries and a later vote do not count a study again or move its day.
        const ownScreenings = screenings
          .filter((row) => row.review_url && row.study_id && same(row.review_url))
          .map((row) => ({ ...row, device_id: row.device_id || assigned.get(row.ref) }));
        const count = (rows) => {
          const firstScreened = new Map();
          for (const row of rows) {
            const time = row.screened_at ? Date.parse(row.screened_at) : NaN;
            const previous = firstScreened.get(row.study_id);
            if (!firstScreened.has(row.study_id) || time < previous)
              firstScreened.set(row.study_id, Number.isFinite(time) ? time : Infinity);
          }
          return {
            total: firstScreened.size,
            today: [...firstScreened.values()].filter(
              (time) =>
                Number.isFinite(time) && new Date(time).toDateString() === now.toDateString(),
            ).length,
          };
        };
        project.screened = count(ownScreenings);
        project.localScreened = count(
          ownScreenings.filter((row) => deviceId && row.device_id === deviceId),
        );
        project.unassignedScreened = count(ownScreenings.filter((row) => !row.device_id)).total;
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  }
  return projects.sort(
    (a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.name.localeCompare(b.name),
  );
}

// Choosing work by project keeps the persisted queue checkpoints and request
// identities intact. A cleared legacy queue stays out of automatic resumption.
export function pendingScreenings(store, project) {
  const hidden = store.clearedBatchIds();
  const saved = savedDecisionIds(store.db, project.reviewUrl);
  return store.db
    .prepare('SELECT * FROM jobs ORDER BY created_at,rowid')
    .all()
    .filter(
      (job) => reviewKey(job.review_url) === reviewKey(project.reviewUrl) && !hidden.has(job.id),
    )
    .map((job) => {
      const items = store.items(job.id);
      return {
        job,
        config: store.settings(job.id),
        remaining: items.filter(
          (item) => !finishedItem(item, job.mode) && !saved.has(item.study_id),
        ),
        lastActivity: items.reduce(
          (latest, item) => (item.updated_at > latest ? item.updated_at : latest),
          job.created_at,
        ),
      };
    })
    .filter((work) => work.remaining.length)
    .filter((work) => {
      if (!work.config || reviewKey(work.config.reviewUrl) !== reviewKey(project.reviewUrl))
        throw new Error(
          'Saved screening settings are missing or belong to another project. Inspect the saved records before continuing.',
        );
      return true;
    });
}

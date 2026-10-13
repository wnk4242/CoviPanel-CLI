import path from 'node:path';
import os from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { QueueStore } from '../Application/queue-store.js';
import { RecordStore } from '../Application/records.js';
import { readProjectHistory } from '../Application/project-history.js';
import { exportProjectHistory } from '../Application/history-export.js';

const count = Number(process.argv[2] || 1000);
if (process.argv.length > 3 || !Number.isInteger(count) || count < 1 || count > 10000)
  throw new Error('Choose a synthetic benchmark size from 1 to 10,000.');
const folder = await mkdtemp(path.join(os.tmpdir(), 'covipanel-benchmark-'));
const database = path.join(folder, 'screening.sqlite');
const config = {
  profile: 'demo',
  dataset: 'demo-vitamin-c-common-cold',
  reviewUrl: 'https://demo.covidence.org/reviews/1/review_studies/screen?filter=vote_required_from',
  configHash: 'synthetic-benchmark',
  criteria: { inclusion: ['Synthetic benchmark only.'] },
};
const store = new QueueStore(database),
  records = new RecordStore(database);
const started = performance.now();
try {
  const ids = Array.from({ length: count }, (_, n) => String(n + 1));
  const job = store.create(config, ids, 'recommend-only');
  records.transaction(() => {
    for (const id of ids) {
      const createdAt = new Date().toISOString();
      records.saveRecommendation({
        record: {
          ...config,
          runId: randomUUID(),
          studyId: id,
          status: 'recommended',
          decision: 'Maybe',
          rationale:
            'Synthetic offline record for measuring local storage and export. No scientific inference or AI request.',
          createdAt,
          updatedAt: createdAt,
        },
        study: { studyId: id, title: `Synthetic study ${id}`, abstract: 'Synthetic source text.' },
        parsed: null,
      });
    }
  });
  const stored = performance.now();
  const history = readProjectHistory(database, config.reviewUrl);
  const read = performance.now();
  const exported = await exportProjectHistory(database, config.reviewUrl, {
    folder: path.join(folder, 'Outputs'),
  });
  const end = performance.now();
  if (
    history.studies.length !== count ||
    exported.history.studies.length !== count ||
    store.items(job.id).length !== count
  )
    throw new Error('Benchmark record-count verification failed.');
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        scope:
          'Local database and cumulative XLSX/text export only; excludes browser, API latency and screening accuracy.',
        studies: count,
        seedMs: Math.round(stored - started),
        historyReadMs: Math.round(read - stored),
        exportMs: Math.round(end - read),
        totalMs: Math.round(end - started),
        peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
        outputs: folder,
      },
      null,
      2,
    ),
  );
} finally {
  records.close();
  store.close();
}

import { databasePath, dataDir } from '../../Application/config.js';
import { QueueStore, acquireWorkerLock } from '../../Application/queue-store.js';
import { uuidPattern } from '../../Application/profiles.js';
import { reviewKey } from '../../Application/project-history.js';
import { exportProjectHistory } from '../../Application/history-export.js';

const target = process.argv[2];
if (process.argv.length !== 3 || !(uuidPattern.test(target || '') || target === '--all'))
  throw new Error(
    'Usage: export-history.mjs <batch-ID> or --all. Exports the cumulative project history locally.',
  );
const release = await acquireWorkerLock(dataDir);
let store;
try {
  store = new QueueStore(databasePath);
  const reviews =
    target === '--all'
      ? [
          ...new Set(
            store.db
              .prepare('SELECT review_url FROM jobs')
              .all()
              .map((j) => reviewKey(j.review_url)),
          ),
        ]
      : [store.job(target).review_url];
  for (const url of reviews) {
    const result = await exportProjectHistory(databasePath, url);
    console.log(
      `${result.changed ? 'Updated' : 'Already current'}: ${result.output}\nScreening log: ${result.text}\n${result.history.studies.length} unique studies. No AI calls.`,
    );
  }
} finally {
  store?.close();
  await release();
}

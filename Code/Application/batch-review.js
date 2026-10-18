import { DatabaseSync } from 'node:sqlite';
import { emitKeypressEvents } from 'node:readline';
import { setImmediate } from 'node:timers/promises';
import { finishedItem } from './states.js';
import { standardLines } from './response-format.js';
import { screenText, wrapScreenLines } from './terminal-screen.js';

// Read the exact attempts used by this batch, never a newer response for the same study.
export function readCompletedBatch(file, jobId, { details = false } = {}) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    if (!job) throw new Error('Screening batch not found.');
    const items = db.prepare('SELECT * FROM items WHERE job_id=? ORDER BY ordinal').all(jobId);
    if (!items.length || items.some((item) => !finishedItem(item, job.mode))) return [];
    return items.map((item) => {
      const data = JSON.parse(item.data);
      const runId =
        data.recommendationRecord?.runId || data.recommendationRef?.replace(/^recommendation:/, '');
      const saved = runId
        ? db
            .prepare(
              'SELECT record,parsed FROM recommendations WHERE run_id=? AND review_url=? AND study_id=? AND config_hash=?',
            )
            .get(runId, job.review_url, item.study_id, job.config_hash)
        : null;
      const record = saved ? JSON.parse(saved.record) : data.recommendationRecord || {};
      const parsed = saved?.parsed ? JSON.parse(saved.parsed) : {};
      const attemptId = data.voteRecord?.attemptId || data.voteRef?.replace(/^vote:/, '');
      const voteRow = attemptId
        ? db.prepare('SELECT record FROM votes WHERE attempt_id=?').get(attemptId)
        : null;
      const vote = voteRow ? JSON.parse(voteRow.record) : data.voteRecord;
      const lines = [
        `Study #${item.study_id} | ${item.state}`,
        record.title || 'Title not saved.',
        `AI decision: ${record.decision || parsed.Decision || 'Not available'}`,
        vote
          ? `Covidence vote: ${vote.recordedVote || 'Not verified'} | ${vote.status}`
          : 'Covidence vote: No submission recorded in this batch.',
        ...(vote?.humanReview ? [`Your confirmed decision: ${vote.humanReview.decision}`] : []),
        '',
        ...(parsed.ResponseText
          ? parsed.ResponseText.split(/\r?\n/)
          : Object.hasOwn(parsed, 'Intervention')
            ? standardLines(parsed)
            : [`Rationale: ${parsed.Rationale || record.rationale || 'No saved rationale.'}`]),
        ...(data.reviewReason ? ['', `Review note: ${data.reviewReason}`] : []),
      ];
      return details ? { lines, reviewUrl: job.review_url, studyId: item.study_id, runId } : lines;
    });
  } finally {
    db.close();
  }
}

// Own the keyboard only while reviewing; the launcher recreates its line prompt afterwards.
export async function reviewBatch(
  name,
  studies,
  {
    input = process.stdin,
    output = process.stdout,
    statusLabel = 'Batch complete',
    startIndex = 0,
    editable = false,
    decisionEditable = false,
    approval = false,
  } = {},
) {
  if (!studies.length || !input.isTTY || !output.isTTY || !input.setRawMode) return false;
  const wasRaw = Boolean(input.isRaw),
    wasPaused = input.isPaused();
  let index = Math.max(0, Math.min(startIndex, studies.length - 1)),
    offset = 0;
  const footer = approval
    ? 'C: confirm ALL and submit | S: save decisions without submitting | Y/N/M: change decision | E: change rationale | X: cancel batch | Left/Right: study | Up/Down: scroll | Esc: leave pending'
    : decisionEditable
      ? 'Y/N/M: change decision | E: edit rationale | Up/Down: scroll | Enter/Esc: back'
      : editable
        ? 'Left/Right: study | Up/Down: scroll | E: edit rationale | Enter/Esc: back'
        : 'Left/Right: study | Up/Down: scroll | Enter/Esc: back';
  const layout = () => {
    const columns = output.columns || 100,
      rows = output.rows || 30;
    return {
      columns,
      rows,
      room: Math.max(1, Math.max(6, rows) - 3 - wrapScreenLines([footer], columns).length),
      lines: wrapScreenLines(studies[index], columns),
    };
  };
  const draw = () => {
    const { columns, rows, room, lines } = layout();
    offset = Math.min(offset, Math.max(0, lines.length - room));
    output.write(
      '\x1b[2J\x1b[3J\x1b[H' +
        screenText(
          `Study ${index + 1}/${studies.length} | ${statusLabel} | ${name}`,
          lines.slice(offset, offset + room),
          footer,
          columns,
          rows,
        ).replaceAll('\n', '\r\n'),
    );
  };
  emitKeypressEvents(input);
  let onKey, onEnd, onError, onResize;
  try {
    input.setRawMode(true);
    const result = await new Promise((resolve, reject) => {
      onEnd = () => resolve();
      onError = reject;
      onResize = () => {
        try {
          draw();
        } catch (error) {
          reject(error);
        }
      };
      onKey = (_text, key = {}) => {
        if (approval && !key.ctrl && !key.meta) {
          if (key.name === 'c') {
            resolve({ confirmed: true });
            return;
          }
          if (key.name === 's') {
            resolve({ saveOnlyRequested: true });
            return;
          }
          if (key.name === 'x') {
            resolve({ cancelRequested: true });
            return;
          }
        }
        if ((approval || decisionEditable) && !key.ctrl && !key.meta) {
          const decision = { y: 'Include', n: 'Exclude', m: 'Maybe' }[key.name];
          if (decision) {
            resolve({ decisionIndex: index, decision });
            return;
          }
        }
        if (editable && key.name === 'e' && !key.ctrl && !key.meta) {
          resolve({ editIndex: index });
          return;
        }
        if (['return', 'enter', 'escape'].includes(key.name) || (key.ctrl && key.name === 'c')) {
          resolve();
          return;
        }
        const previous = index;
        if (key.name === 'left') index = Math.max(0, index - 1);
        else if (key.name === 'right') index = Math.min(studies.length - 1, index + 1);
        else if (key.name === 'up') offset = Math.max(0, offset - 1);
        else if (key.name === 'down') offset++;
        else if (key.name === 'pageup') offset = Math.max(0, offset - layout().room);
        else if (key.name === 'pagedown') offset += layout().room;
        else return;
        if (previous !== index) offset = 0;
        try {
          draw();
        } catch (error) {
          reject(error);
        }
      };
      input.on('keypress', onKey);
      input.once('end', onEnd);
      input.once('error', onError);
      output.on('resize', onResize);
      input.resume();
      draw();
    });
    return result || true;
  } finally {
    if (onKey) input.off('keypress', onKey);
    if (onEnd) input.off('end', onEnd);
    if (onError) input.off('error', onError);
    if (onResize) output.off('resize', onResize);
    // Node stops native stdin reads on the next tick after pause(). Let that
    // finish before leaving raw mode, or Windows can lose the next menu answer.
    input.pause();
    await setImmediate();
    input.setRawMode(wasRaw);
    if (!wasPaused) input.resume();
    output.write('\r\n');
  }
}

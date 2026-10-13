import { showScreen } from './terminal-screen.js';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../../Setups/package.json', import.meta.url), 'utf8'),
);

export async function chooseProject(
  question,
  projects,
  {
    show = showScreen,
    remove,
    reload,
    pageSize = Math.max(1, Math.min(5, Math.floor(((process.stdout.rows || 30) - 11) / 10))),
  } = {},
) {
  let page = 0,
    deleting = false;
  while (true) {
    const pages = Math.max(1, Math.ceil(projects.length / pageSize));
    page = Math.min(page, pages - 1);
    const first = page * pageSize;
    const visible = projects.slice(first, first + pageSize);
    show(
      deleting ? 'CoviPanel | Delete a saved project' : 'CoviPanel | Continue a saved screening',
      [
        ...(projects.length ? [`Page ${page + 1} of ${pages}`, ''] : ['No saved projects yet.']),
        ...visible.flatMap((project, index) => [
          `${first + index + 1}. ${project.name}`,
          `Review ${project.reviewUrl.match(/\/reviews\/(\d+)/)[1]} | ${new URL(project.reviewUrl).hostname}`,
          `Last activity: ${project.lastActivity ? new Date(project.lastActivity).toLocaleString() : 'Unknown'}`,
          ...(project.error ? ['Settings need attention'] : []),
          `AI decision submitted today: ${project.submittedToday || 0}`,
          `Screened but not submitted: ${project.screenedNotSubmitted || 0}`,
          project.covidenceProgress
            ? `Covidence total | ${project.covidenceProgress.total}`
            : 'Covidence total | Not synced yet',
          ...(project.covidenceProgress
            ? [`Last synced: ${new Date(project.covidenceProgress.syncedAt).toLocaleString()}`]
            : []),
          ...(project.syncError ? ['Sync unavailable; showing saved counts.'] : []),
          '',
        ]),
        '',
        ...(pages > 1 ? ['n = next page; p = previous page'] : []),
        ...(!deleting && reload ? ['R. Refresh counts'] : []),
        ...(!deleting && remove && projects.length ? ['D. Delete a saved project'] : []),
        deleting ? '0. Cancel deletion' : '0. Back to main menu',
      ],
      '',
    );
    const answer = (
      await question(deleting ? 'Choose a project to delete: ' : 'Choose a project: ')
    )
      .trim()
      .toLowerCase();
    if (!answer || answer === '0') {
      if (!deleting) return null;
      deleting = false;
      continue;
    }
    if (answer === 'd' && remove && projects.length) {
      deleting = true;
      continue;
    }
    if (answer === 'r' && !deleting && reload) {
      projects = await reload();
      continue;
    }
    if (answer === 'n' && page + 1 < pages) {
      page++;
      continue;
    }
    if (answer === 'p' && page > 0) {
      page--;
      continue;
    }
    const index = Number(answer) - 1;
    if (!/^\d+$/.test(answer) || index < first || index >= first + visible.length) continue;
    const selected = projects[index];
    if (!deleting) return selected;
    show(
      'CoviPanel | Delete this local project?',
      [
        selected.name,
        `Review ${selected.reviewUrl.match(/\/reviews\/(\d+)/)[1]} | ${new URL(selected.reviewUrl).hostname}`,
        '',
        'Permanently removes this local project, including:',
        'Settings, saved screenings, GPT responses, history and local vote records.',
        'All files in its project folder, including spreadsheets, logs and backups.',
        '',
        'The online Covidence review and its votes are unchanged.',
        'Make a separate backup first if you want to keep a copy.',
      ],
      '',
    );
    if ((await question('Type DELETE to confirm (Enter cancels): ')).trim() === 'DELETE') {
      try {
        const result = await remove(selected);
        projects = reload ? await reload() : projects.filter((p) => p !== selected);
        await question(
          result?.cleanupPending
            ? `Project removed from CoviPanel, but some files could not be deleted: ${result.cleanupPending}\nPress Enter to return to saved projects. `
            : `Deleted ${selected.name}. Press Enter to return to saved projects. `,
        );
      } catch (error) {
        await question(
          `Could not delete project: ${error.message}\nPress Enter to return to saved projects. `,
        );
      }
    }
    deleting = false;
  }
}

async function runProjectMenu(question, project, actions, { show = showScreen } = {}) {
  while (true) {
    show(
      `CoviPanel | ${project.name}`,
      [
        `Review ${project.reviewUrl.match(/\/reviews\/(\d+)/)[1]} | ${new URL(project.reviewUrl).hostname}`,
        '',
        '1. Start / continue screening',
        '2. Edit project settings',
        '3. Export project history',
        '4. Open project folder',
        '5. Back up project records',
        '6. Review unfinished studies',
        '0. Back to main menu',
      ],
      '',
    );
    const choice = (await question('Choose an option: ')).trim();
    // A trailing newline from the batch viewer must not leave the selected project.
    // Returning to the main menu requires the explicit Back option.
    if (choice === '0') return;
    const action = {
      1: 'start',
      2: 'settings',
      3: 'export',
      4: 'open',
      5: 'backup',
      6: 'unfinished',
    }[choice];
    if (!action) continue;
    try {
      const updated = await actions[action](project);
      if (action === 'settings' && updated) project = updated;
    } catch (error) {
      await question(`Stopped: ${error.message}\nPress Enter to return to this project. `);
    }
  }
}

export async function runMainMenu(question, actions, { show = showScreen } = {}) {
  while (true) {
    show(
      `CoviPanel v${version} | Screening`,
      [
        '1. Start a new screening',
        '2. Continue a saved screening',
        '3. Clean temporary files',
        '0. Exit',
      ],
      '',
    );
    const choice = (await question('Choose an option: ')).trim();
    if (choice === '0') return;
    try {
      let project;
      if (choice === '3') {
        await actions.cleanup();
        continue;
      }
      if (choice === '1') project = await actions.create();
      else if (choice === '2')
        project = await chooseProject(question, await actions.list(), {
          show,
          remove: actions.delete,
          reload: actions.list,
        });
      if (project) await runProjectMenu(question, project, actions, { show });
    } catch (error) {
      await question(`Stopped: ${error.message}\nPress Enter to return to the main menu. `);
    }
  }
}

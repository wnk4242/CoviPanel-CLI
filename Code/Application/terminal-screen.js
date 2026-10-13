const clean = (value) =>
  String(value ?? '')
    // eslint-disable-next-line no-control-regex -- Strip terminal control characters from display/pasted text.
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export function wrapScreenLines(lines, columns = 100) {
  const width = Math.max(20, columns - 1);
  return lines.flatMap((value) => {
    let rest = clean(value);
    const out = [];
    while (rest.length > width) {
      let at = rest.lastIndexOf(' ', width);
      if (at < 1) at = width;
      out.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    out.push(rest);
    return out;
  });
}

// Render one bounded screen. Full decisions and rationales remain in project history.
export function screenText(title, lines, footer, columns = 100, rows = 30) {
  const width = Math.max(20, columns - 1),
    height = Math.max(6, rows);
  const footerLines = wrapScreenLines([footer], columns).slice(0, height - 3);
  const content = [
    clean(title).slice(0, width),
    '-'.repeat(width),
    ...wrapScreenLines(lines, columns),
  ];
  const room = height - footerLines.length - 1;
  if (content.length > room) {
    content.length = room;
    content[room - 1] = 'Full details are saved in the decision history.'.slice(0, width);
  }
  while (content.length < height - footerLines.length) content.push('');
  return [...content, ...footerLines].join('\n');
}
export function showScreen(title, lines = [], footer = '') {
  if (!process.stdout.isTTY) {
    console.log(title, ...lines, footer);
    return;
  }
  process.stdout.write(
    '\x1b[2J\x1b[3J\x1b[H' +
      screenText(title, lines, footer, process.stdout.columns, process.stdout.rows).replaceAll(
        '\n',
        '\r\n',
      ),
  );
}

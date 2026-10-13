export async function readReviewer(page) {
  // Observed Covidence navigation: the Profile menu avatar's accessible name
  // contains the full account name; its visible text contains only initials.
  // Optional evidence for attributing History rows, never a settings validation
  // or a prerequisite for screening. Missing navigation is not an error.
  try {
    const menu = page.getByRole('button', { name: 'Profile menu', exact: true });
    const avatar = menu.getByRole('img');
    if ((await menu.count()) !== 1 || (await avatar.count()) !== 1) return null;
    const name = ((await avatar.getAttribute('aria-label', { timeout: 500 })) || '')
      .replace(/\s+/g, ' ')
      .trim();
    return name
      ? {
          name,
          source: 'Covidence Profile menu',
          url: page.url(),
          checkedAt: new Date().toISOString(),
        }
      : null;
  } catch {
    return null;
  }
}

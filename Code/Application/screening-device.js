import os from 'node:os';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** @type {{id:string|null, name:string}|undefined} */
let identity;

// Derive identity from this OS installation, not a file that travels with a copied project.
// Store only a one-way digest in screening records, never the raw machine identifier.
export function screeningDevice() {
  if (identity) return identity;
  let key;
  try {
    if (process.platform === 'win32') {
      const result = execFileSync(
        'reg.exe',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      key = result.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
    } else if (process.platform === 'linux') key = readFileSync('/etc/machine-id', 'utf8').trim();
  } catch {
    // An unavailable identifier must not stop screening; unassigned work stays explicit.
  }
  identity = {
    id: key
      ? createHash('sha256').update(`covipanel:${process.platform}:${key}`).digest('hex')
      : null,
    name: os.hostname(),
  };
  return identity;
}

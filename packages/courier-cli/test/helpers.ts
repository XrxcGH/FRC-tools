import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProfileSet, type BridgeProfileSet } from '@courier/bridge';

export { Workspace } from '../src/workspace.ts';
export { run } from '../src/main.ts';

/** The shipped profile set, loaded the same way the CLI loads it. */
export function loadProfilesForTest(): BridgeProfileSet {
  const url = new URL(
    '../../courier-bridge/profiles/bridge_profiles.json',
    import.meta.url,
  );
  return loadProfileSet(JSON.parse(readFileSync(fileURLToPath(url), 'utf8')));
}

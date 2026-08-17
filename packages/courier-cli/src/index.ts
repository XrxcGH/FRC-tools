/**
 * @courier/cli — the command line, exported as functions so the whole tool is
 * testable without spawning a process.
 */

export { Workspace, WorkspaceError, DEFAULT_DIR, type MeshConfig } from './workspace.ts';

export {
  init,
  status,
  joinRequest,
  grant,
  accept,
  confirm,
  ingest,
  exportBundle,
  importBundle,
  report,
  verifyStore,
  type CommandResult,
} from './commands.ts';

export { run } from './main.ts';

export { picklist, type PicklistArgs } from './picklist.ts';

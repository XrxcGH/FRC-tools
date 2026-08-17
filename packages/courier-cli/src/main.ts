#!/usr/bin/env node
/**
 * courier — the command line.
 *
 * Deliberately file-shaped. No daemon, no port, no radio: this is the tool for
 * moving scouting data by flash drive, which is what the most sophisticated
 * team in this space actually fell back to after building custom sync hardware.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProfileSet } from '@courier/bridge';
import { Workspace } from './workspace.ts';
import * as cmd from './commands.ts';
import { picklist } from './picklist.ts';

/** Parse a comma or space separated team list. Throws on anything that is not one. */
function parseTeams(text: string | undefined): number[] {
  if (!text) return [];
  return text
    .split(/[,\s]+/)
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1) throw new Error(`"${s}" is not a team number`);
      return n;
    });
}

const USAGE = `courier — move FRC scouting data between devices, by file

  courier init <event-key> <device-label>   start a new mesh on this device
  courier status                            what this device knows

  Pairing (two devices, three files, one spoken code):
  courier join-request <out>                on the JOINING device
  courier grant <request> <out>             on a device already in the mesh
  courier accept <grant> <request>          back on the joining device
  courier confirm <codeA> <codeB>           check the two codes match

  Data:
  courier ingest <scans.txt>                seal QR payloads, one per line
  courier export <out.courier>              write everything to a bundle
  courier import <in.courier>               merge a bundle from anywhere
  courier report [team]                     what has been collected
  courier verify                            re-check every signature
  courier picklist --schema <f> --field <f> --alliance <teams>
                                            rank the board from your own scouting

Options:
  --dir <path>        workspace directory (default .courier)
  --profiles <path>   bridge profile set (default: the shipped one)
`;

function defaultProfiles() {
  const url = new URL('../../courier-bridge/profiles/bridge_profiles.json', import.meta.url);
  return loadProfileSet(JSON.parse(readFileSync(fileURLToPath(url), 'utf8')));
}

function takeOption(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}

export async function run(argv: string[]): Promise<cmd.CommandResult> {
  const args = [...argv];
  const dir = takeOption(args, '--dir');
  const profilesPath = takeOption(args, '--profiles');
  const schemaPath = takeOption(args, '--schema');
  const field = takeOption(args, '--field');
  const alliance = takeOption(args, '--alliance');
  const exclude = takeOption(args, '--exclude');
  const picksBetween = takeOption(args, '--picks-between');
  const minObservations = takeOption(args, '--min-observations');
  const ws = new Workspace(dir);
  const command = args.shift();

  const need = (n: number, shape: string): void => {
    if (args.length < n) throw new Error(`usage: courier ${shape}`);
  };

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { text: USAGE, code: 0 };

    case 'init':
      need(2, 'init <event-key> <device-label>');
      return cmd.init(ws, args[0]!, args[1]!);

    case 'status':
      return cmd.status(ws);

    case 'join-request':
      need(1, 'join-request <out>');
      return cmd.joinRequest(ws, args[0]!);

    case 'grant':
      need(2, 'grant <request> <out>');
      return await cmd.grant(ws, args[0]!, args[1]!);

    case 'accept':
      need(2, 'accept <grant> <request>');
      return await cmd.accept(ws, args[0]!, args[1]!);

    case 'confirm':
      need(2, 'confirm <codeA> <codeB>');
      return cmd.confirm(args[0]!, args[1]!);

    case 'ingest': {
      need(1, 'ingest <scans.txt>');
      const profiles = profilesPath
        ? loadProfileSet(JSON.parse(readFileSync(profilesPath, 'utf8')))
        : defaultProfiles();
      return cmd.ingest(ws, args[0]!, profiles);
    }

    case 'export':
      need(1, 'export <out.courier>');
      return cmd.exportBundle(ws, args[0]!);

    case 'import':
      need(1, 'import <in.courier>');
      return cmd.importBundle(ws, args[0]!);

    case 'report':
      return cmd.report(ws, args[0] ? Number(args[0]) : undefined);

    case 'verify':
      return cmd.verifyStore(ws);

    case 'picklist': {
      if (!schemaPath || !field || !alliance) {
        return {
          text:
            'usage: courier picklist --schema <schema.json> --field <name> --alliance <teams>\n\n' +
            'The schema is YOUR description of YOUR body format. Courier never parses a body\n' +
            'in transit and does not ship a decoder for anyone else\'s app, because that would\n' +
            'be a guess about a format that varies per team.',
          code: 1,
        };
      }
      try {
        const between = picksBetween ? Number(picksBetween) : 0;
        if (!Number.isInteger(between) || between < 0) {
          return { text: '--picks-between must be a non-negative whole number', code: 1 };
        }
        const minObs = minObservations ? Number(minObservations) : undefined;
        if (minObs !== undefined && (!Number.isInteger(minObs) || minObs < 1)) {
          return { text: '--min-observations must be a positive whole number', code: 1 };
        }
        return picklist(ws, {
          schemaPath,
          field,
          alliance: parseTeams(alliance),
          exclude: parseTeams(exclude),
          picksBetween: between,
          minObservations: minObs,
        });
      } catch (err) {
        return { text: (err as Error).message, code: 1 };
      }
    }

    default:
      return { text: `unknown command "${command}"\n\n${USAGE}`, code: 1 };
  }
}

// Only run when invoked directly, so the module stays importable by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(result.text + '\n');
    process.exitCode = result.code;
  } catch (err) {
    process.stderr.write(`courier: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

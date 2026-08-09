#!/usr/bin/env node
/**
 * ledger — pull an FRC event from the official sources and write it to disk.
 */

import { readFileSync } from 'node:fs';
import { deviceKeyFromSecret } from '@courier/core';
import { fetchEvent, makeVenuePack, credentialsFromEnv, type LedgerResult } from './cli.ts';

const USAGE = `ledger — pull an FRC event from the official sources, and write files

  ledger fetch <event-key> --out <dir>
      Fetch from every source you have credentials for, reconcile them, and
      write a bulk export: NDJSON, CSV, a manifest, and an attribution file.
      Disagreements between sources are reported, never hidden.

  ledger pack <event-key> --out <file> --key <device.key> [--season-pack <id>]
      Build a signed venue pack for a pit with no internet.

Credentials, from the environment. Both are free and self-serve:
  TBA_AUTH_KEY                 thebluealliance.com/account
  FRC_API_USER, FRC_API_TOKEN  frc-events.firstinspires.org/services/API

With both, the two sources are cross-checked. With one, nothing is.
`;

function takeOption(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
}

export async function run(argv: string[]): Promise<LedgerResult> {
  const args = [...argv];
  const out = takeOption(args, '--out');
  const keyPath = takeOption(args, '--key');
  const seasonPackId = takeOption(args, '--season-pack') ?? 'unspecified';
  const command = args.shift();
  const credentials = credentialsFromEnv(process.env);

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return { text: USAGE, code: 0 };

    case 'fetch': {
      const eventKey = args[0];
      if (!eventKey || !out) return { text: 'usage: ledger fetch <event-key> --out <dir>', code: 1 };
      return await fetchEvent({ eventKey, outDir: out, credentials });
    }

    case 'pack': {
      const eventKey = args[0];
      if (!eventKey || !out || !keyPath) {
        return { text: 'usage: ledger pack <event-key> --out <file> --key <device.key>', code: 1 };
      }
      const signer = deviceKeyFromSecret(new Uint8Array(readFileSync(keyPath)));
      return await makeVenuePack({
        eventKey,
        outDir: '.',
        outFile: out,
        credentials,
        signer,
        seasonPackId,
      });
    }

    default:
      return { text: `unknown command "${command}"\n\n${USAGE}`, code: 1 };
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(result.text + '\n');
    process.exitCode = result.code;
  } catch (err) {
    process.stderr.write(`ledger: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

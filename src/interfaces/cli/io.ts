import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';

export interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  readStdin(): Promise<string>;
  confirm(message: string): Promise<boolean>;
  stdinIsTTY: boolean;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createProcessCliIo(): CliIo {
  return {
    writeOut(text) {
      stdout.write(text);
    },
    writeErr(text) {
      stderr.write(text);
    },
    readStdin: readAllStdin,
    async confirm(message) {
      const prompt = createInterface({ input: stdin, output: stderr });
      try {
        const answer = await prompt.question(`${message} [y/N] `);
        return /^(y|yes)$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    },
    stdinIsTTY: Boolean(stdin.isTTY),
  };
}

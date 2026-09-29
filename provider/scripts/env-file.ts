import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function readEnv(path: string): Record<string, string> {
  return existsSync(path) ? (parseEnv(readFileSync(path, 'utf8')) as Record<string, string>) : {};
}

/** Sets keys in a dotenv file, replacing their lines in place and leaving every other line untouched. */
export function setEnvKeys(path: string, values: Record<string, string>): void {
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  if (lines.at(-1) === '') {
    lines.pop();
  }
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(line));
    if (index >= 0) {
      lines[index] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

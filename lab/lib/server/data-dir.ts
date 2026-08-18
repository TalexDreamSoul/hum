import "server-only";

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function getDataDir(): string {
  const configured = process.env.HUM_DATA_DIR?.trim();
  const dataDir = configured ? path.resolve(configured) : path.join(process.cwd(), "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  return dataDir;
}

export function readOrCreatePrivateFile(name: string, create: () => Buffer): Buffer {
  const file = path.join(getDataDir(), name);
  try {
    const value = readFileSync(file);
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    return value;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const value = create();
  try {
    writeFileSync(file, value, { flag: "wx", mode: 0o600 });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readFileSync(file);
  }
}

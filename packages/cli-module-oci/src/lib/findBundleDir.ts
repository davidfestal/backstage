/*
 * Copyright 2026 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { join as joinPath } from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';

const BUNDLE_MARKER = '.bundle-output';

/**
 * Finds a bundle directory using a three-step cascade:
 *
 * 1. If `baseDir` itself contains the `.bundle-output` marker, use it directly.
 *    This covers the case where the user has cd'd into a bundle folder
 *    (e.g. inside a dynamic-plugins-root subdirectory).
 *
 * 2. Otherwise scan `baseDir` for child directories that contain the marker.
 *    If exactly one is found, use it. If multiple are found, error with a list.
 *
 * 3. If none are found, error with a clear message.
 */
export async function findBundleDir(baseDir: string): Promise<string> {
  if (await fs.pathExists(joinPath(baseDir, BUNDLE_MARKER))) {
    return baseDir;
  }

  const candidates: string[] = [];
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (await fs.pathExists(joinPath(baseDir, entry.name, BUNDLE_MARKER))) {
          candidates.push(entry.name);
        }
      }
    }
  } catch {
    /* directory may not exist */
  }

  if (candidates.length === 1) {
    return joinPath(baseDir, candidates[0]);
  }

  if (candidates.length > 1) {
    throw new Error(
      [
        `Multiple bundle directories found in ${chalk.cyan(baseDir)}:`,
        ...candidates.map(c => `  - ${chalk.cyan(c)}`),
        `Specify which one to use with ${chalk.cyan('--output-name')}.`,
      ].join('\n'),
    );
  }

  throw new Error(
    `No bundle directory found in ${chalk.cyan(baseDir)}.\n` +
      `Run ${chalk.cyan('backstage-cli package bundle')} first, ` +
      `or specify the bundle location with ${chalk.cyan(
        '--output-destination',
      )} ` +
      `and ${chalk.cyan('--output-name')}.`,
  );
}

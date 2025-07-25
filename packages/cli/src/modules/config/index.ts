/*
 * Copyright 2024 The Backstage Authors
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
import { createCliPlugin } from '../../wiring/factory';
import yargs from 'yargs';
import { Command } from 'commander';
import { lazy } from '../../lib/lazy';

export const configOption = [
  '--config <path>',
  'Config files to load instead of app-config.yaml',
  (opt: string, opts: string[]) => (opts ? [...opts, opt] : [opt]),
  Array<string>(),
] as const;

export default createCliPlugin({
  pluginId: 'config',
  init: async reg => {
    reg.addCommand({
      path: ['config:docs'],
      description: 'Browse the configuration reference documentation',
      execute: async ({ args }) => {
        const command = new Command();
        const defaultCommand = command
          .option(
            '--package <name>',
            'Only include the schema that applies to the given package',
          )
          .description('Browse the configuration reference documentation')
          .action(lazy(() => import('./commands/docs'), 'default'));

        await defaultCommand.parseAsync(args, { from: 'user' });
      },
    });
    reg.addCommand({
      path: ['config', 'docs'],
      description: 'Browse the configuration reference documentation',
      execute: async ({ args, info }) => {
        await new Command(info.usage)
          .option(
            '--package <name>',
            'Only include the schema that applies to the given package',
          )
          .description(info.description)
          .action(lazy(() => import('./commands/docs'), 'default'))
          .parseAsync(args, { from: 'user' });
      },
    });
    reg.addCommand({
      path: ['config:print'],
      description: 'Print the app configuration for the current package',
      execute: async ({ args, info }) => {
        const argv = await yargs
          .options({
            package: { type: 'string' },
            lax: { type: 'boolean' },
            frontend: { type: 'boolean' },
            'with-secrets': { type: 'boolean' },
            format: { type: 'string' },
            config: { type: 'string', array: true, default: [] },
          })
          .usage('$0', info.description)
          .help()
          .parse(args);
        await lazy(() => import('./commands/print'), 'default')(argv);
      },
    });
    reg.addCommand({
      path: ['config:check'],
      description:
        'Validate that the given configuration loads and matches schema',
      execute: async ({ args }) => {
        const argv = await yargs
          .options({
            package: { type: 'string' },
            lax: { type: 'boolean' },
            frontend: { type: 'boolean' },
            deprecated: { type: 'boolean' },
            strict: { type: 'boolean' },
            config: {
              type: 'string',
              array: true,
              default: [],
            },
          })
          .help()
          .parse(args);
        await lazy(() => import('./commands/validate'), 'default')(argv);
      },
    });

    reg.addCommand({
      path: ['config:schema'],
      description: 'Print the JSON schema for the given configuration',
      execute: async ({ args }) => {
        const argv = await yargs
          .options({
            package: { type: 'string' },
            format: { type: 'string' },
            merge: { type: 'boolean' },
            'no-merge': { type: 'boolean' },
          })
          .help()
          .parse(args);
        await lazy(() => import('./commands/schema'), 'default')(argv);
      },
    });

    reg.addCommand({
      path: ['config', 'schema'],
      description: 'Print the JSON schema for the given configuration',
      execute: async ({ args }) => {
        const argv = await yargs
          .options({
            package: { type: 'string' },
            format: { type: 'string' },
            merge: { type: 'boolean' },
            'no-merge': { type: 'boolean' },
          })
          .help()
          .parse(args);
        await lazy(() => import('./commands/schema'), 'default')(argv);
      },
    });
  },
});

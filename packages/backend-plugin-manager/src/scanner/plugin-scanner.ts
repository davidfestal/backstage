/*
 * Copyright 2023 The Backstage Authors
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
import { Config } from '@backstage/config';
import { ScannedPluginPackage, ScannedPluginManifest } from './types';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as url from 'url';
import { findPaths } from '@backstage/cli-common';
import { PackageRoles } from '@backstage/cli-node';

export class PluginScanner {
  private readonly config: Config;
  private readonly preferAlpha: boolean;

  constructor(config: Config, preferAlpha: boolean) {
    this.config = config;
    this.preferAlpha = preferAlpha;
    if (config.subscribe !== undefined) {
      config.subscribe(async () => {
        await this.scanRoot();
        // TODO(davidfestal): compare with installed plugins
      });
    }
  }

  async scanRoot(): Promise<ScannedPluginPackage[]> {
    const scannedPlugins: ScannedPluginPackage[] = [];

    const dynamicPlugins = this.config.getOptional('dynamicPlugins');
    if (
      typeof dynamicPlugins === 'object' &&
      dynamicPlugins !== null &&
      'rootDirectory' in dynamicPlugins &&
      typeof dynamicPlugins.rootDirectory === 'string'
    ) {
      /* eslint-disable-next-line no-restricted-syntax */
      const paths = findPaths(__dirname);

      const dynamicPluginsRootPath = path.isAbsolute(
        dynamicPlugins.rootDirectory,
      )
        ? dynamicPlugins.rootDirectory
        : paths.resolveTargetRoot(dynamicPlugins.rootDirectory);

      if (
        !path
          .dirname(path.normalize(dynamicPluginsRootPath))
          .startsWith(path.normalize(paths.targetRoot))
      ) {
        const nodePath = process.env.NODE_PATH;
        const backstageNodeModules = paths.resolveTargetRoot('node_modules');
        if (
          !nodePath ||
          !nodePath.split(path.delimiter).includes(backstageNodeModules)
        ) {
          throw new Error(
            `Dynamic plugins under '${dynamicPluginsRootPath}' cannot access backstage modules in '${backstageNodeModules}'.\n` +
              `Please add '${backstageNodeModules}' to the 'NODE_PATH' when running the backstage backend.`,
          );
        }
      }

      const userPluginsLocation = url.pathToFileURL(dynamicPluginsRootPath);
      if (!(await fs.lstat(userPluginsLocation)).isDirectory()) {
        throw new Error('Not a directory');
      }
      const pluginsDir = await fs.readdir(userPluginsLocation, {
        withFileTypes: true,
      });
      if (pluginsDir.length === 0) {
        return [];
      }
      for (const dirEnt of pluginsDir) {
        const pluginDir = dirEnt;
        const pluginHome = path.resolve(
          userPluginsLocation.pathname,
          pluginDir.name,
        );
        if (dirEnt.isSymbolicLink()) {
          if (!(await fs.lstat(await fs.readlink(pluginHome))).isDirectory()) {
            continue;
          }
        } else if (!dirEnt.isDirectory()) {
          continue;
        }

        let scannedPlugin = await this.scanDir(pluginHome);

        const platform = PackageRoles.getRoleInfo(
          scannedPlugin.manifest.backstage.role,
        ).platform;
        if (platform === 'node') {
          if (this.preferAlpha) {
            const pluginHomeAlpha = path.resolve(pluginHome, 'alpha');
            if ((await fs.lstat(pluginHomeAlpha)).isDirectory()) {
              const backstage = scannedPlugin.manifest.backstage;
              scannedPlugin = await this.scanDir(pluginHomeAlpha);
              scannedPlugin.manifest.backstage = backstage;
            }
          }
        }

        scannedPlugins.push(scannedPlugin);
      }
    }
    return scannedPlugins;
  }

  async scanDir(pluginHome: string): Promise<ScannedPluginPackage> {
    const manifestFile = path.resolve(pluginHome, 'package.json');
    const content = await fs.readFile(manifestFile);
    const manifest: ScannedPluginManifest = JSON.parse(content.toString());
    return {
      location: url.pathToFileURL(pluginHome),
      manifest: manifest,
    };
  }
}

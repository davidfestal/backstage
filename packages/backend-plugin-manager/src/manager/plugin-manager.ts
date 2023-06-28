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
import {
  BackendPluginProvider,
  BackendDynamicPlugin,
  isBackendDynamicPluginInstaller,
  DynamicPlugin,
} from './types';
import { PluginScanner } from '../scanner/plugin-scanner';
import * as url from 'url';
import { ScannedPluginPackage } from '../scanner/types';
import {
  LoggerService,
  coreServices,
  createServiceFactory,
  createServiceRef,
} from '@backstage/backend-plugin-api';
import { PackageRoles } from '@backstage/cli-node';
import { findPaths } from '@backstage/cli-common';

export class PluginManager implements BackendPluginProvider {
  static async fromConfig(
    config: Config,
    logger: LoggerService,
    preferAlpha: boolean = false,
  ): Promise<PluginManager> {
    /* eslint-disable-next-line no-restricted-syntax */
    const backstageRoot = findPaths(__dirname).targetRoot;
    const scanner = new PluginScanner(
      config,
      logger,
      backstageRoot,
      preferAlpha,
    );
    scanner.trackChanges();
    const manager = new PluginManager(logger, await scanner.scanRoot());
    scanner.subscribeToRootDirectoryChange(async () => {
      manager._scannedPlugins = await scanner.scanRoot();
    });
    manager.plugins.push(...(await manager.loadPlugins()));

    return manager;
  }

  private readonly logger: LoggerService;
  readonly plugins: DynamicPlugin[];
  private _scannedPlugins: ScannedPluginPackage[];

  private constructor(
    logger: LoggerService,
    scannedPlugins: ScannedPluginPackage[],
  ) {
    this.logger = logger;
    this.plugins = [];
    this._scannedPlugins = scannedPlugins;
  }

  get scannedPlugins(): ScannedPluginPackage[] {
    return this._scannedPlugins;
  }

  addBackendPlugin(plugin: BackendDynamicPlugin): void {
    this.plugins.push(plugin);
  }

  private async loadPlugins(): Promise<DynamicPlugin[]> {
    const loadedPlugins: DynamicPlugin[] = [];

    for (const scannedPlugin of this.scannedPlugins) {
      const platform = PackageRoles.getRoleInfo(
        scannedPlugin.manifest.backstage.role,
      ).platform;

      if (
        platform === 'node' &&
        scannedPlugin.manifest.backstage.role.includes('-plugin')
      ) {
        const plugin = await this.loadBackendPlugin(scannedPlugin);
        if (plugin !== undefined) {
          loadedPlugins.push(plugin);
        }
      } else {
        loadedPlugins.push({
          name: scannedPlugin.manifest.name,
          version: scannedPlugin.manifest.version,
          platform: 'web',
          role: scannedPlugin.manifest.backstage.role,
          // TODO(davidfestal): add required front-end plugin information here.
        });
      }
    }
    return loadedPlugins;
  }

  private async loadBackendPlugin(
    plugin: ScannedPluginPackage,
  ): Promise<BackendDynamicPlugin | undefined> {
    const path = url.fileURLToPath(
      `${plugin.location}/${plugin.manifest.main}`,
    );
    try {
      const { dynamicPluginInstaller } = await import(
        /* webpackIgnore: true */ path
      );
      if (!isBackendDynamicPluginInstaller(dynamicPluginInstaller)) {
        this.logger.error(
          `dynamic backend plugin '${plugin.manifest.name}' could not be loaded from '${plugin.location}': no exported 'dynamicPluginInstaller' field`,
        );
        return undefined;
      }
      this.logger.info(
        `loaded dynamic backend plugin '${plugin.manifest.name}' from '${plugin.location}'`,
      );
      return {
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        platform: 'node',
        role: plugin.manifest.backstage.role,
        installer: dynamicPluginInstaller,
      };
    } catch (error) {
      this.logger.error(
        `an error occured while loading dynamic backend plugin '${plugin.manifest.name}' from '${plugin.location}'`,
        error,
      );
      return undefined;
    }
  }

  backendPlugins(): BackendDynamicPlugin[] {
    return this.plugins.filter(
      (p): p is BackendDynamicPlugin => p.platform === 'node',
    );
  }
}

export const dynamicPluginsServiceRef = createServiceRef<BackendPluginProvider>(
  {
    id: 'core.dynamicplugins',
  },
);

export const dynamicPluginsServiceFactory = createServiceFactory({
  service: dynamicPluginsServiceRef,
  deps: {
    config: coreServices.config,
    logger: coreServices.logger,
  },
  async factory({ config, logger }) {
    return await PluginManager.fromConfig(config, logger, true);
  },
});

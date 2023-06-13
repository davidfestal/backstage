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

export class PluginManager implements BackendPluginProvider {
  static async fromConfig(
    config: Config,
    logger: LoggerService,
    preferAlpha: boolean = false,
  ): Promise<PluginManager> {
    const manager = new PluginManager(config, logger, preferAlpha);
    const scannedPlugins = await manager.scanner.scanRoot();
    for (const scannedPlugin of scannedPlugins) {
      const platform = PackageRoles.getRoleInfo(
        scannedPlugin.manifest.backstage.role,
      ).platform;

      if (
        platform === 'node' &&
        scannedPlugin.manifest.backstage.role.includes('-plugin')
      ) {
        const plugin = await manager.loadBackendPlugin(scannedPlugin);
        if (plugin !== undefined) {
          manager.plugins.push(plugin);
        }
      } else {
        manager.plugins.push({
          name: scannedPlugin.manifest.name,
          version: scannedPlugin.manifest.version,
          platform: 'web',
          role: scannedPlugin.manifest.backstage.role,
          // TODO(davidfestal): add required front-end plugin information here.
        });
      }
    }
    return manager;
  }

  private readonly logger: LoggerService;
  private readonly scanner: PluginScanner;
  readonly plugins: DynamicPlugin[];

  private constructor(
    config: Config,
    logger: LoggerService,
    preferAlpha: boolean,
  ) {
    this.logger = logger;
    this.scanner = new PluginScanner(config, preferAlpha);
    this.plugins = [];
  }

  addBackendPlugin(plugin: BackendDynamicPlugin): void {
    this.plugins.push(plugin);
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
        this.logger.info(
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
        `Failed while loading dynamic backend plugin '${plugin.manifest.name}' from '${plugin.location}'`,
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

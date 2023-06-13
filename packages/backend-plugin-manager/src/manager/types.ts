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

import { Logger } from 'winston';
import { Config } from '@backstage/config';
import {
  PluginCacheManager,
  PluginDatabaseManager,
  PluginEndpointDiscovery,
  TokenManager,
  UrlReader,
} from '@backstage/backend-common';
import { Router } from 'express';
import { PluginTaskScheduler, TaskRunner } from '@backstage/backend-tasks';
import { IdentityApi } from '@backstage/plugin-auth-node';
import { PermissionEvaluator } from '@backstage/plugin-permission-common';
import {
  EventBroker,
  HttpPostIngressOptions,
} from '@backstage/plugin-events-node';

import { BackendFeature } from '@backstage/backend-plugin-api';
import { PackagePlatform, PackageRole } from '@backstage/cli-node';
import { CatalogBuilder } from '@backstage/plugin-catalog-backend';
import { TemplateAction } from '@backstage/plugin-scaffolder-node';
import { IndexBuilder } from '@backstage/plugin-search-backend-node';
import { EventsBackend } from '@backstage/plugin-events-backend';
import { PermissionPolicy } from '@backstage/plugin-permission-node';

export type PluginEnvironment = {
  logger: Logger;
  cache: PluginCacheManager;
  database: PluginDatabaseManager;
  config: Config;
  reader: UrlReader;
  discovery: PluginEndpointDiscovery;
  tokenManager: TokenManager;
  permissions: PermissionEvaluator;
  scheduler: PluginTaskScheduler;
  identity: IdentityApi;
  eventBroker: EventBroker;
  pluginProvider: BackendPluginProvider;
};

export interface BackendPluginProvider {
  backendPlugins(): BackendDynamicPlugin[];
}

export interface DynamicPlugin {
  name: string;
  version: string;
  role: PackageRole;
  platform: PackagePlatform;
}

export interface FrontendDynamicPlugin extends DynamicPlugin {
  platform: 'web';
}

export interface BackendDynamicPlugin extends DynamicPlugin {
  platform: 'node';
  installer: BackendDynamicPluginInstaller;
}

export type BackendDynamicPluginInstaller =
  | LegacyBackendPluginInstaller
  | NewBackendPluginInstaller;

export interface NewBackendPluginInstaller {
  kind: 'new';

  install(): BackendFeature | BackendFeature[];
}

export interface LegacyBackendPluginInstaller {
  kind: 'legacy';

  router?: {
    pluginID: string;
    createPlugin(env: PluginEnvironment): Promise<Router>;
  };

  catalog?(builder: CatalogBuilder, env: PluginEnvironment): void;
  scaffolder?(env: PluginEnvironment): TemplateAction<any>[];
  search?(
    indexBuilder: IndexBuilder,
    schedule: TaskRunner,
    env: PluginEnvironment,
  ): void;
  events?(
    eventsBackend: EventsBackend,
    env: PluginEnvironment,
  ): HttpPostIngressOptions[];
  permissions?: {
    policy?: PermissionPolicy;
  };
}

export function isBackendDynamicPluginInstaller(
  obj: any,
): obj is BackendDynamicPluginInstaller {
  return (
    obj !== undefined &&
    'kind' in obj &&
    (obj.kind === 'new' || obj.kind === 'legacy')
  );
}

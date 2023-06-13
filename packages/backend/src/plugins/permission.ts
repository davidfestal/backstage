/*
 * Copyright 2021 The Backstage Authors
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

import { BackstageIdentityResponse } from '@backstage/plugin-auth-node';
import { createRouter } from '@backstage/plugin-permission-backend';
import {
  AuthorizeResult,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
} from '@backstage/plugin-permission-node';
import {
  DefaultPlaylistPermissionPolicy,
  isPlaylistPermission,
} from '@backstage/plugin-playlist-backend';
import { Router } from 'express';
import {
  LegacyBackendPluginInstaller,
  PluginEnvironment,
} from '@backstage/backend-plugin-manager';

class ExamplePermissionPolicy implements PermissionPolicy {
  private playlistPermissionPolicy = new DefaultPlaylistPermissionPolicy();

  async handle(
    request: PolicyQuery,
    user?: BackstageIdentityResponse,
  ): Promise<PolicyDecision> {
    if (isPlaylistPermission(request.permission)) {
      return this.playlistPermissionPolicy.handle(request, user);
    }

    return {
      result: AuthorizeResult.ALLOW,
    };
  }
}

export default async function createPlugin(
  env: PluginEnvironment,
): Promise<Router> {

  const legacyInstallersWithPolicy = env.pluginProvider
    .backendPlugins()
    .map((p) => {
      return {
        "name": p.name,
        "installer": p.installer
      }
    })
    .filter((i): i is {
      name: string;
      installer: LegacyBackendPluginInstaller;
    } => i.installer.kind === 'legacy' && i.installer.permissions?.policy !== undefined)

  if (legacyInstallersWithPolicy.length === 0) {
    throw new Error(
      'No policy module installed! Please install a policy module. If you want to allow all requests, use permissionModuleAllowAllPolicy',
    );
  }
  if (legacyInstallersWithPolicy.length > 1) {
    throw new Error(`Only one dynamic plugin should contribute to the permission policy: ${legacyInstallersWithPolicy.map(i => i.name)}`);
  }

  return await createRouter({
    config: env.config,
    logger: env.logger,
    discovery: env.discovery,
    policy: legacyInstallersWithPolicy[0].installer.permissions?.policy!,
    identity: env.identity,
  });
}

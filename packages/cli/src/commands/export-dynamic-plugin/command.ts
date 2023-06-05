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

import { OptionValues } from 'commander';
import { Output } from '../../lib/builder';
import { BackstagePackageJson, PackageRoles } from '@backstage/cli-node';
import { paths } from '../../lib/paths';
import fs from 'fs-extra';
import { productionPack } from '../../lib/packager/productionPack';
import { makeRollupConfigs } from '../../lib/builder/config';
import { rollup } from 'rollup';
import { buildPackage, formatErrorMessage } from '../../lib/builder/packager';
import { getPackages } from '@manypkg/get-packages';
import path, { basename } from 'path';
import { embedModules } from '../../lib/builder/embedPlugin';
import { Task } from '../../lib/tasks';
import { loadCliConfig } from '../../lib/config';

export async function command(opts: OptionValues): Promise<void> {
  const target = path.join(paths.targetDir, 'dist-dynamic');
  const rawPkg = await fs.readJson(paths.resolveTarget('package.json'));
  const role = PackageRoles.getRoleFromPackage(rawPkg);
  if (!role) {
    throw new Error(`Target package must have 'backstage.role' set`);
  }

  if (role !== 'backend-plugin' && role !== 'backend-plugin-module') {
    throw new Error(
      'Only packages with the "backend-plugin" or "backend-plugin-module" roles can be exported as dynamic backend plugins',
    );
  }

  if (!fs.existsSync(paths.resolveTarget('src', 'dynamic'))) {
    throw new Error(
      `package doesn't seem to support dynamic loading. It should have a ./src/dynamic folder, containing the dynamic loading entrypoints.`,
    );
  }

  const roleInfo = PackageRoles.getRoleInfo(role);

  const outputs = new Set<Output>();

  if (roleInfo.output.includes('cjs')) {
    outputs.add(Output.cjs);
  }
  if (roleInfo.output.includes('esm')) {
    outputs.add(Output.esm);
  }

  const pkgContent = await fs.readFile(
    paths.resolveTarget('package.json'),
    'utf8',
  );
  const pkg = JSON.parse(pkgContent) as BackstagePackageJson;
  if (pkg.bundled) {
    throw new Error(
      'Packages exported as dynamic backend plugins should not have the "bundled" field set to true',
    );
  }

  if (
    !pkg.files?.includes('dist-dynamic/*.*') ||
    !pkg.files?.includes('dist-dynamic/dist/**') ||
    !pkg.files?.includes('dist-dynamic/alpha/*')
  ) {
    throw new Error(
      `package doesn't seem to support dynamic loading. its "files" property should include the following entries: ["dist-dynamic/*.*", "dist-dynamic/dist/**", "dist-dynamic/alpha/*"].`,
    );
  }

  const mergeWithOutput: (string | RegExp)[] = [];

  const commonPackage = pkg.name.replace(/-backend$/, '-common');
  if (commonPackage !== pkg.name) {
    mergeWithOutput.push(commonPackage);
  }

  if (opts.embedPackage !== undefined) {
    for (const pkgToEmbed of opts.embedPackage as string[]) {
      if (pkg.dependencies === undefined || !(pkgToEmbed in pkg.dependencies)) {
        throw new Error(
          `Cannot embed package '${pkgToEmbed}': it is not part of direct dependencies.`,
        );
      }
      mergeWithOutput.push(pkgToEmbed);
      const relatedCommonPackage = pkgToEmbed.replace(/-backend$/, '-common');
      if (relatedCommonPackage !== pkgToEmbed) {
        mergeWithOutput.push(relatedCommonPackage);
      }
    }
  }

  const filter = {
    include: mergeWithOutput,
    exclude: mergeWithOutput.length !== 0 ? undefined : /.*/,
  };
  const moveToPeerDependencies: (string | RegExp)[] = [/@backstage\//];

  const rollupConfigs = await makeRollupConfigs({
    outputs,
    minify: Boolean(opts.minify),
    useApiExtractor: false,
  });

  if (rollupConfigs.length === 0) {
    throw new Error('Rollup config is missing');
  }

  const dependenciesToAdd: {
    [key: string]: string;
  } = {};

  const rollupConfig = rollupConfigs[0];
  rollupConfig.plugins?.push(
    embedModules({
      filter: filter,
      addDependency(name, version) {
        const existingVersion = dependenciesToAdd[name];
        if (existingVersion === undefined) {
          dependenciesToAdd[name] = version;
          return;
        }
        if (existingVersion !== version) {
          throw new Error(
            'several versions of the same transitive dependency of embedded modules',
          );
        }
      },
    }),
  );

  await fs.remove(paths.resolveTarget('dist'));

  try {
    const bundle = await rollup(rollupConfig);
    if (rollupConfig.output) {
      for (const output of [rollupConfig.output].flat()) {
        await bundle.generate(output);
        await bundle.write(output);
      }
    }
  } catch (error) {
    throw new Error(formatErrorMessage(error));
  }

  await fs.remove(target);

  const monoRepoPackages = await getPackages(paths.targetDir);
  await productionPack({
    packageDir: '',
    targetDir: target,
    customizeManifest: (pkgToCustomize: BackstagePackageJson) => {
      function test(str: string, expr: string | RegExp): boolean {
        if (typeof expr === 'string') {
          return str === expr;
        }
        return expr.test(str);
      }

      pkgToCustomize.name = `${pkgToCustomize.name}-dynamic`;
      (pkgToCustomize as any).bundleDependencies = true;
      pkgToCustomize.scripts = undefined;
      pkgToCustomize.types = undefined;

      pkgToCustomize.files = pkgToCustomize.files?.filter(
        f => !f.startsWith('dist-dynamic/'),
      );

      for (const dep in dependenciesToAdd) {
        if (!Object.hasOwn(dependenciesToAdd, dep)) {
          continue;
        }
        if (pkgToCustomize.dependencies === undefined) {
          pkgToCustomize.dependencies = {};
        }
        const existingVersion = pkgToCustomize.dependencies[dep];
        if (existingVersion === undefined) {
          pkgToCustomize.dependencies[dep] = dependenciesToAdd[dep];
          continue;
        }
        if (existingVersion !== dependenciesToAdd[dep]) {
          throw new Error(
            'version of an embedded module dependency conflict with main module dependency',
          );
        }
      }
      if (pkgToCustomize.dependencies) {
        for (const monoRepoPackage of monoRepoPackages.packages) {
          if (pkgToCustomize.dependencies[monoRepoPackage.packageJson.name]) {
            pkgToCustomize.dependencies[
              monoRepoPackage.packageJson.name
            ] = `^${monoRepoPackage.packageJson.version}`;
          }
        }

        for (const dep in pkgToCustomize.dependencies) {
          if (!Object.hasOwn(pkgToCustomize.dependencies, dep)) {
            continue;
          }
          let removed = false;
          for (const toRemove of mergeWithOutput) {
            if (test(dep, toRemove)) {
              delete pkgToCustomize.dependencies[dep];
              removed = true;
              break;
            }
          }
          if (removed) {
            continue;
          }

          for (const toMove of moveToPeerDependencies) {
            if (test(dep, toMove)) {
              if (pkgToCustomize.peerDependencies === undefined) {
                pkgToCustomize.peerDependencies = {};
              }
              pkgToCustomize.peerDependencies[dep] =
                pkgToCustomize.dependencies[dep];
              delete pkgToCustomize.dependencies[dep];
              break;
            }
          }
        }
      }
      pkgToCustomize.devDependencies = {};
    },
  });

  // Create an empty yarn.lock to make it clear that the exported dynamic plugin is
  // NOT part of a workspace.
  await fs.ensureFile(path.resolve(target, 'yarn.lock'));

  if (opts.install) {
    await Task.forCommand('yarn install', { cwd: target, optional: false });
    await fs.remove(paths.resolveTarget('dist-dynamic', '.yarn'));
  }

  // Remove the `dist` folder of the original plugin root folder and rebuild it,
  // since it has been compiled with dynamic-specific settings.
  await fs.remove(paths.resolveTarget('dist'));
  await buildPackage({
    outputs,
    minify: Boolean(opts.minify),
  });

  if (opts.dev) {
    if (opts.dev) {
      const { fullConfig } = await loadCliConfig({ args: [] });
      const dynamicPlugins = fullConfig.getOptional('dynamicPlugins');
      if (
        typeof dynamicPlugins === 'object' &&
        dynamicPlugins !== null &&
        'rootDirectory' in dynamicPlugins &&
        typeof dynamicPlugins.rootDirectory === 'string'
      ) {
        await fs.ensureSymlink(
          paths.resolveTarget('src'),
          path.resolve(target, 'src'),
          'dir',
        );
        const dynamicPluginsRootPath = path.isAbsolute(
          dynamicPlugins.rootDirectory,
        )
          ? dynamicPlugins.rootDirectory
          : paths.resolveTargetRoot(dynamicPlugins.rootDirectory);
        await fs.ensureSymlink(
          target,
          path.resolve(dynamicPluginsRootPath, basename(paths.targetDir)),
          'dir',
        );
      } else {
        throw new Error(
          `'dynamicPlugins.rootDirectory' should be configured in the app config in order to use the --dev option.`,
        );
      }
    }
  }
}

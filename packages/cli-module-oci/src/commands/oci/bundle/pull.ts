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

import { resolve as resolvePath, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  OciClient,
  anonymousAuth,
  basicAuth,
  bearerAuth,
  IMAGE_LAYER_GZIP_MEDIA_TYPE,
  IMAGE_LAYER_MEDIA_TYPE,
  ClientProtocol,
} from '@dfatwork/oci-client';
import type { ClientConfig, RegistryAuth } from '@dfatwork/oci-client';
import * as tar from 'tar';
import chalk from 'chalk';
import { cli } from 'cleye';
import fs from 'fs-extra';
import { targetPaths } from '@backstage/cli-common';
import { ConfigSources } from '@backstage/config-loader';
import type { CliCommandContext } from '@backstage/cli-node';

export default async ({ args, info }: CliCommandContext) => {
  const {
    _: { imageRef: positionalRef },
    flags: {
      output,
      platform: platformFlag,
      config,
      ociConfig,
      plainHttp,
      insecure,
      username,
      password,
      token,
    },
  } = cli(
    {
      help: info,
      parameters: ['<image ref>'],
      flags: {
        output: {
          type: String,
          description:
            'Local directory to extract the bundle into. ' +
            'Overrides the dynamic-plugins-root from app-config.',
        },
        platform: {
          type: String,
          description:
            'Platform to select from a multi-platform image index, ' +
            'in os/architecture format (e.g. linux/arm64). ' +
            "Defaults to the client's host platform.",
        },
        config: {
          type: [String],
          description:
            'Config files to load (same as backend --config). ' +
            'When omitted, the standard app-config cascade is used.',
          default: [],
        },
        ociConfig: {
          type: String,
          description:
            'Path to a JSON file with OCI client configuration ' +
            '(protocol, proxy settings, TLS options, etc.)',
        },
        plainHttp: {
          type: Boolean,
          description:
            'Use plain HTTP instead of HTTPS when contacting the registry',
        },
        insecure: {
          type: Boolean,
          description:
            'Allow insecure connections to the registry (skip TLS verification)',
        },
        username: {
          type: String,
          description: 'Username for Basic auth against the OCI registry',
        },
        password: {
          type: String,
          description: 'Password for Basic auth against the OCI registry',
        },
        token: {
          type: String,
          description: 'Bearer token for auth against the OCI registry',
        },
      },
    },
    undefined,
    args,
  );

  const source = positionalRef;
  if (!source) {
    throw new Error(
      `Missing image reference. ` +
        `Example: ${chalk.dim(
          'backstage-cli oci bundle pull localhost:5000/backstage/plugins/my-plugin:1.0.0',
        )}`,
    );
  }

  // Resolve output directory
  let outputDir: string;
  if (output) {
    outputDir = resolvePath(output);
  } else {
    // Load config using the same mechanism as the backend at startup
    const configSource = ConfigSources.default({
      argv: config.flatMap((c: string) => ['--config', resolvePath(c)]),
      rootDir: targetPaths.rootDir,
    });
    const appConfig = await ConfigSources.toConfig(configSource);

    const rootDirectory = appConfig.getOptionalString(
      'dynamicPlugins.rootDirectory',
    );
    if (!rootDirectory) {
      throw new Error(
        `No output directory specified and ${chalk.cyan(
          "'dynamicPlugins.rootDirectory'",
        )} is not ` +
          `configured in app-config. Either pass ${chalk.cyan(
            '--output <dir>',
          )} or set it in your app-config:\n\n` +
          `  ${chalk.dim('dynamicPlugins:')}\n` +
          `    ${chalk.dim('rootDirectory: dynamic-plugins-root')}\n`,
      );
    }

    outputDir = isAbsolute(rootDirectory)
      ? resolvePath(rootDirectory)
      : resolvePath(targetPaths.rootDir, rootDirectory);
  }

  await fs.mkdirs(outputDir);

  // Build OCI client
  let ociClientConfig: ClientConfig | undefined;
  if (ociConfig) {
    ociClientConfig = (await fs.readJson(
      resolvePath(ociConfig),
    )) as ClientConfig;
  }
  if (plainHttp) {
    ociClientConfig = {
      ...ociClientConfig,
      protocol: ClientProtocol.Http,
    };
  }
  if (insecure) {
    ociClientConfig = {
      ...ociClientConfig,
      acceptInvalidCertificates: true,
    };
  }

  let requestedPlatform: { os: string; architecture: string } | undefined;
  if (platformFlag) {
    const parts = platformFlag.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid ${chalk.cyan('--platform')} value ${chalk.cyan(
          platformFlag,
        )}. ` +
          `Expected ${chalk.dim('os/architecture')} format (e.g. ${chalk.dim(
            'linux/arm64',
          )}).`,
      );
    }
    requestedPlatform = { os: parts[0], architecture: parts[1] };
  }

  let ociAuth: RegistryAuth;
  if (username && password) {
    ociAuth = basicAuth(username, password);
  } else if (token) {
    ociAuth = bearerAuth(token);
  } else {
    ociAuth = anonymousAuth();
  }

  const client = ociClientConfig
    ? OciClient.withConfig(ociClientConfig)
    : new OciClient();

  // Pull the image. When --platform is specified we manually resolve
  // the digest from the image index because the OCI client's pull()
  // method does not honour the ClientConfig.platform filter.
  const imageRef = source.replace(/^oci:\/\//, '');
  console.log(chalk.blue(`Pulling ${chalk.cyan(imageRef)}...`));

  let resolvedRef = imageRef;
  if (requestedPlatform) {
    const raw = await client.pullManifest(imageRef, ociAuth);
    if (raw.manifest.manifestType === 'ImageIndex' && raw.manifest.imageIndex) {
      const match = raw.manifest.imageIndex.manifests.find(
        m =>
          m.platform?.os === requestedPlatform!.os &&
          m.platform?.architecture === requestedPlatform!.architecture,
      );
      if (!match) {
        const available = raw.manifest.imageIndex.manifests
          .map(m =>
            m.platform
              ? `${m.platform.os}/${m.platform.architecture}`
              : 'unknown',
          )
          .join(', ');
        throw new Error(
          `No manifest matching platform ${chalk.cyan(
            `${requestedPlatform.os}/${requestedPlatform.architecture}`,
          )} ` +
            `in the image index. Available platforms: ${chalk.cyan(available)}`,
        );
      }
      const baseRef = imageRef.replace(/:([^/]+)$/, '');
      resolvedRef = `${baseRef}@${match.digest}`;
    }
  }

  const imageData = await client.pull(resolvedRef, ociAuth, [
    IMAGE_LAYER_GZIP_MEDIA_TYPE,
    IMAGE_LAYER_MEDIA_TYPE,
  ]);

  if (imageData.layers.length === 0) {
    throw new Error(`Image ${chalk.cyan(imageRef)} has no layers.`);
  }

  const layerData = imageData.layers[0].data;
  const isGzip = imageData.layers[0].mediaType === IMAGE_LAYER_GZIP_MEDIA_TYPE;

  // Capture the top-level directory name from the archive so we can
  // report the exact extracted path.
  let extractedDir: string | undefined;
  const onEntry = (entry: tar.ReadEntry) => {
    if (!extractedDir) {
      const first = entry.path.split('/')[0];
      if (first) {
        extractedDir = first;
      }
    }
  };

  console.log(chalk.blue(`Extracting to ${chalk.cyan(outputDir)}...`));

  // The archive contains files under a mangled-name prefix which becomes
  // a subdirectory, matching the dynamic-plugins-root convention.
  await pipeline(
    Readable.from(layerData),
    tar.extract({ cwd: outputDir, gzip: isGzip, onReadEntry: onEntry }),
  );

  const extractedPath = extractedDir
    ? resolvePath(outputDir, extractedDir)
    : outputDir;

  console.log(chalk.green('Extracted bundle:'));
  console.log(extractedPath);
};

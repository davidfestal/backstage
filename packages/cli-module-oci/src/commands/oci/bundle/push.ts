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

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { createGzip } from 'node:zlib';
import { join as joinPath, normalize, resolve as resolvePath } from 'node:path';
import {
  OciClient,
  anonymousAuth,
  basicAuth,
  bearerAuth,
  IMAGE_LAYER_GZIP_MEDIA_TYPE,
  IMAGE_CONFIG_MEDIA_TYPE,
  OCI_IMAGE_MEDIA_TYPE,
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  ORG_OPENCONTAINERS_IMAGE_TITLE,
} from '@dfatwork/oci-client';
import type {
  ClientConfig,
  ImageIndex,
  ImageManifest,
  PlatformSpec,
  RegistryAuth,
} from '@dfatwork/oci-client';
import { ClientProtocol } from '@dfatwork/oci-client';
import npmPackList from 'npm-packlist';
import * as tar from 'tar';
import chalk from 'chalk';
import { cli } from 'cleye';
import fs from 'fs-extra';
import { targetPaths } from '@backstage/cli-common';
import type {
  BackstagePackageJson,
  CliCommandContext,
} from '@backstage/cli-node';

import { findBundleDir } from '../../../lib/findBundleDir';

export default async ({ args, info }: CliCommandContext) => {
  const {
    _: { registryRef: positionalDest },
    flags: {
      outputDestination,
      outputName,
      tag,
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
      parameters: ['<registry ref>'],
      flags: {
        outputDestination: {
          type: String,
          description:
            'Directory containing the bundle subdirectory. ' +
            'Defaults to the current package directory.',
        },
        outputName: {
          type: String,
          description:
            'Name of the bundle subdirectory. ' +
            'When omitted, auto-discovered via the .bundle-output marker.',
        },
        tag: {
          type: [String],
          description:
            'Additional tags to apply to the pushed image. ' +
            'Can be specified multiple times. ' +
            'Supports placeholders: {version}, {major}, {minor}, {patch}.',
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

  const destination = positionalDest;
  if (!destination) {
    throw new Error(
      `Missing registry reference. ` +
        `Example: ${chalk.dim(
          'backstage-cli oci bundle push localhost:5000/backstage/plugins',
        )}`,
    );
  }

  // Resolve bundle directory
  const baseDir = outputDestination
    ? resolvePath(outputDestination)
    : targetPaths.dir;

  let target: string;
  if (outputName) {
    target = joinPath(baseDir, outputName);
  } else {
    target = await findBundleDir(baseDir);
  }

  // Read bundle metadata
  const pkg = (await fs.readJson(
    joinPath(target, 'package.json'),
  )) as BackstagePackageJson;

  const mangledName = pkg.name.replace(/^@/, '').replace(/\//, '-');
  const role = pkg.backstage?.role;

  const pluginType: 'frontend' | 'backend' =
    role === 'frontend-plugin' || role === 'frontend-plugin-module'
      ? 'frontend'
      : 'backend';

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

  let ociAuth: RegistryAuth;
  if (username && password) {
    ociAuth = basicAuth(username, password);
  } else if (token) {
    ociAuth = bearerAuth(token);
  } else {
    ociAuth = anonymousAuth();
  }

  // Pack the bundle into a tar.gz
  const tarGzName = `${mangledName}-${pkg.version}.tgz`;
  console.log(chalk.blue(`Packing ${chalk.cyan(tarGzName)}...`));

  const filePaths = [
    ...new Set((await npmPackList({ path: target })).map(normalize)),
  ];

  // Stream tar through a hash (for the diff_id) and gzip to a temp file
  // so we don't hold the full archive in memory.
  const tarGzPath = joinPath(
    tmpdir(),
    `backstage-bundle-${mangledName}-${Date.now()}.tgz`,
  );
  const hash = createHash('sha256');
  const hashStream = new PassThrough();
  hashStream.on('data', (chunk: Buffer) => hash.update(chunk));

  const tarStream = tar.create(
    { cwd: target, prefix: mangledName, portable: true },
    filePaths,
  );
  await pipeline(
    tarStream,
    hashStream,
    createGzip(),
    fs.createWriteStream(tarGzPath),
  );

  const diffId = hash.digest('hex');
  const layerData = await fs.readFile(tarGzPath);
  await fs.remove(tarGzPath);

  const imageBase = destination.replace(/^oci:\/\//, '');
  const imageRef = `${imageBase}/${mangledName}:${pkg.version}`;

  console.log(chalk.blue(`Pushing to ${chalk.cyan(imageRef)}...`));

  const client = ociClientConfig
    ? OciClient.withConfig(ociClientConfig)
    : new OciClient();

  const layer = {
    data: layerData,
    mediaType: IMAGE_LAYER_GZIP_MEDIA_TYPE,
    annotations: {
      [ORG_OPENCONTAINERS_IMAGE_TITLE]: tarGzName,
    },
  };

  const layerDigest = `sha256:${createHash('sha256')
    .update(layerData)
    .digest('hex')}`;

  const makeConfig = (platform: PlatformSpec) =>
    JSON.stringify({
      architecture: platform.architecture,
      os: platform.os,
      created: '0001-01-01T00:00:00Z',
      history: [{ created: '0001-01-01T00:00:00Z' }],
      config: {},
      rootfs: {
        type: 'layers',
        diff_ids: [`sha256:${diffId}`],
      },
    });

  const makeManifest = (configData: Buffer): ImageManifest => ({
    schemaVersion: 2,
    mediaType: OCI_IMAGE_MEDIA_TYPE,
    config: {
      mediaType: IMAGE_CONFIG_MEDIA_TYPE,
      digest: `sha256:${createHash('sha256').update(configData).digest('hex')}`,
      size: configData.length,
    },
    layers: [
      {
        mediaType: IMAGE_LAYER_GZIP_MEDIA_TYPE,
        digest: layerDigest,
        size: layerData.length,
        annotations: {
          [ORG_OPENCONTAINERS_IMAGE_TITLE]: tarGzName,
        },
      },
    ],
  });

  const nativeFiles =
    pluginType === 'backend'
      ? filePaths.filter(
          f =>
            f.endsWith('.node') ||
            f.endsWith('/binding.gyp') ||
            f === 'binding.gyp',
        )
      : [];

  const nativePackages = [
    ...new Set(
      nativeFiles.map(f => {
        const parts = f.split('/');
        const nmIdx = parts.lastIndexOf('node_modules');
        if (nmIdx === -1 || nmIdx + 1 >= parts.length) {
          return f;
        }
        const next = parts[nmIdx + 1];
        return next.startsWith('@') && nmIdx + 2 < parts.length
          ? `${next}/${parts[nmIdx + 2]}`
          : next;
      }),
    ),
  ].sort();

  const hasNativeAddons = nativeFiles.length > 0;

  const nodeToOciArch: Record<string, string> = {
    x64: 'amd64',
    ia32: '386',
    arm64: 'arm64',
    arm: 'arm',
    ppc64: 'ppc64le',
    s390x: 's390x',
  };

  const hostArch = nodeToOciArch[process.arch] ?? process.arch;
  const hostOs = process.platform === 'win32' ? 'windows' : process.platform;
  const hostPlatform: PlatformSpec = { architecture: hostArch, os: hostOs };
  const isLinuxHost = hostOs === 'linux';

  // For non-native bundles the layer is pure JS and works on any OS/arch,
  // so we cover all common Linux architectures plus the host platform
  // (if it isn't already one of them). The registry deduplicates the
  // identical layer by digest, so only small config/manifest blobs are added.
  // For native bundles the binary is OS+arch specific so only the host
  // platform is valid.
  const linuxPlatforms: PlatformSpec[] = [
    { architecture: 'amd64', os: 'linux' },
    { architecture: 'arm64', os: 'linux' },
  ];
  const hostAlreadyCovered = linuxPlatforms.some(
    p => p.os === hostOs && p.architecture === hostArch,
  );
  const platforms: PlatformSpec[] = hasNativeAddons
    ? [hostPlatform]
    : [...(hostAlreadyCovered ? [] : [hostPlatform]), ...linuxPlatforms];

  if (hasNativeAddons) {
    const msg =
      `Native addons detected — image will be ` +
      `${chalk.cyan(
        `${hostPlatform.os}/${hostPlatform.architecture}`,
      )} only.\n` +
      `  Native packages: ${nativePackages.map(p => chalk.cyan(p)).join(', ')}`;
    if (!isLinuxHost) {
      console.log(
        chalk.yellow(
          `${msg}\n` +
            `  ${chalk.bold(
              'Warning:',
            )} These native binaries were built for ${chalk.cyan(
              hostOs,
            )} and will ` +
            `${chalk.bold('not')} work on Linux. Build on a Linux ${chalk.cyan(
              hostArch,
            )} host ` +
            `(or in CI) and re-push to add a ${chalk.cyan(
              `linux/${hostArch}`,
            )} entry to the index.`,
        ),
      );
    } else {
      console.log(
        chalk.yellow(
          `${msg}\n` +
            `  Build on other architectures and re-push to extend the index.`,
        ),
      );
    }
  }

  // Push a per-platform manifest for each target. Each manifest has
  // its own config (with the correct os/arch metadata) but they all
  // share the same layer — the registry deduplicates by digest.
  const manifests = await Promise.all(
    platforms.map(async platform => {
      const platformTag = `${platform.os}-${platform.architecture}`;
      const platformRef = `${imageBase}/${mangledName}:${pkg.version}-${platformTag}`;
      const cfgData = Buffer.from(makeConfig(platform));
      const platformManifest = makeManifest(cfgData);
      await client.push(
        platformRef,
        [layer],
        { data: cfgData, mediaType: IMAGE_CONFIG_MEDIA_TYPE },
        ociAuth,
        platformManifest,
      );
      const pulled = await client.pullImageManifest(platformRef, ociAuth);
      return { platform, digest: pulled.digest, pulled };
    }),
  );

  // If re-pushing a native plugin on a new platform, merge with any
  // existing index so previously pushed platforms are preserved.
  let existingEntries: ImageIndex['manifests'] = [];
  if (hasNativeAddons) {
    try {
      const existing = await client.pullManifest(imageRef, ociAuth);
      if (
        existing.manifest.manifestType === 'ImageIndex' &&
        existing.manifest.imageIndex
      ) {
        const newPlatformKeys = new Set(
          platforms.map(p => `${p.os}/${p.architecture}`),
        );
        existingEntries = existing.manifest.imageIndex.manifests.filter(
          e =>
            !e.platform ||
            !newPlatformKeys.has(`${e.platform.os}/${e.platform.architecture}`),
        );
      }
    } catch {
      // No existing index — first push for this image.
    }
  }

  const index: ImageIndex = {
    schemaVersion: 2,
    mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
    manifests: [
      ...existingEntries,
      ...manifests.map(m => ({
        mediaType: OCI_IMAGE_MEDIA_TYPE,
        digest: m.digest,
        size: JSON.stringify(m.pulled.manifest).length,
        platform: m.platform,
      })),
    ],
  };

  await client.pushManifestList(imageRef, ociAuth, index);

  const indexDigest = await client.fetchManifestDigest(imageRef, ociAuth);

  const platformList = index.manifests
    .map(m =>
      m.platform ? `${m.platform.os}/${m.platform.architecture}` : 'unknown',
    )
    .join(', ');
  const verb = existingEntries.length > 0 ? 'Updated' : 'Pushed';
  console.log(chalk.green(`${verb} image index (${platformList}):`));
  console.log(`${imageRef}@${indexDigest}`);

  // Apply additional tags if requested
  if (tag && tag.length > 0) {
    const [major, minor, patch] = pkg.version.split('.');
    const expandTag = (t: string) =>
      t
        .replace(/\{version\}/g, pkg.version)
        .replace(/\{major\}/g, major)
        .replace(/\{minor\}/g, minor)
        .replace(/\{patch\}/g, patch);

    for (const rawTag of tag) {
      const expanded = expandTag(rawTag);
      const tagRef = `${imageBase}/${mangledName}:${expanded}`;
      await client.pushManifestList(tagRef, ociAuth, index);
      console.log(chalk.green(`Tagged: ${chalk.cyan(tagRef)}`));
    }
  }
};

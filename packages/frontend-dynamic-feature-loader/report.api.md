## API Report File for "@backstage/frontend-dynamic-feature-loader"

> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).

```ts
import { CreateAppFeatureLoader } from '@backstage/frontend-defaults';
import { init } from '@module-federation/enhanced/runtime';

// @public
export function dynamicFrontendFeaturesLoader(
  options?: DynamicFrontendFeaturesLoaderOptions,
): CreateAppFeatureLoader;

// @public (undocumented)
export type DynamicFrontendFeaturesLoaderOptions = {
  moduleFederation: Omit<Parameters<typeof init>[0], 'name' | 'remotes'>;
};
```
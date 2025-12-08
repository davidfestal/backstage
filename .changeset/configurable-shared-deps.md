---
'@backstage/backend-dynamic-feature-service': patch
'@backstage/frontend-dynamic-feature-loader': patch
'@backstage/module-federation-common': patch
'@backstage/cli': patch
'@backstage/frontend-app-api': patch
---

Add shared dependencies configurability to module federation support.

This adds the ability to configure shared dependencies for module federation:

- CLI `--module-federation.shared-dependencies` option for building remote modules with custom shared dependencies
- `app.moduleFederation.sharedDependencies` configuration in `app-config.yaml` for the host application
- Runtime configuration support for overriding shared dependencies at application startup
- Utilities for merging configured shared dependencies with defaults

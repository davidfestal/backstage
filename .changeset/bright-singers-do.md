---
'@backstage/backend-dynamic-feature-service': patch
---

The `dynamicPluginsFeatureLoader` options related to the root logger (`transports`, `level`, `format`) now
accept a function taking a `Config` argument, in addition to direct values.
It's totally possible that the current `Config` would be required to provide the logger options.

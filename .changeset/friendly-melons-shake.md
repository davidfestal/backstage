---
'@backstage/backend-dynamic-feature-service': patch
---

Enhance the `CommonJSModuleLoader` to add support for `resolvePackagePath` calls from backend dynamic plugins, with customizable package resolution, and make the `CommonJSModuleLoader` public API.
This is important for backend dynamic plugins which use the database, since database migration scripts systemtically use `resolvePackagePath`.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch ONLY the folders the mobile bundle actually needs, NOT the whole
// monorepo. On Windows with no Watchman installed, Metro falls back to the
// Node recursive file watcher, which must finish crawling every watched root
// within metro-file-map's MAX_WAIT_TIME (240s) or it throws
// "Failed to start watch mode." and every bundle request 500s (the device
// hangs on "loading"). Watching `monorepoRoot` made it crawl all of
// apps/api, apps/portal, apps/telephony, .git, docs, and every node_modules
// tree — far more than 240s. Restricting to the app, the shared packages, and
// the hoisted root node_modules keeps resolution intact while making the crawl
// finish quickly.
config.watchFolders = [
  projectRoot,
  path.resolve(monorepoRoot, 'packages'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Tell Metro to look for node_modules in both the app and monorepo root
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Resolve @connect/shared subpath imports (e.g. "@connect/shared/webrtcBlackbox")
// to the package's TypeScript source. Metro's default resolver does not honor
// the package "exports" subpath map, so these otherwise fail to resolve. The
// shared package follows the convention "./<name>" -> "./src/<name>.ts".
const sharedSrcRoot = path.resolve(monorepoRoot, 'packages/shared/src');
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const prefix = '@connect/shared/';
  if (moduleName.startsWith(prefix)) {
    const sub = moduleName.slice(prefix.length);
    return { type: 'sourceFile', filePath: path.join(sharedSrcRoot, `${sub}.ts`) };
  }
  if (defaultResolveRequest) return defaultResolveRequest(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;

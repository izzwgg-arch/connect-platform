const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the entire monorepo so Metro can resolve packages from the root
config.watchFolders = [monorepoRoot];

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

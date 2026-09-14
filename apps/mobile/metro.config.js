const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro in an npm-workspaces monorepo.
 *
 * Two things it does not do by default and both break the build without them:
 * watch the shared packages (edits in packages/core-client would not reload),
 * and resolve modules from the workspace root (react would be hoisted where
 * Metro is not looking). The third line is the one that bites hardest —
 * disableHierarchicalLookup off would let a stray nested react-dom win.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.disableHierarchicalLookup = true;

module.exports = config;
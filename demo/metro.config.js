const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// Let Metro read files in the shared/ folder, which sits outside demo/.
config.watchFolders = [workspaceRoot];

// Keep resolving packages from demo's own node_modules.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

module.exports = config;
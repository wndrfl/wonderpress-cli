// `node -r` preload that makes this process look like Electron's Node
// (ELECTRON_RUN_AS_NODE=1): shelljs keys off `process.versions.electron`.
Object.defineProperty(process.versions, 'electron', { value: '38.0.0', enumerable: true, configurable: true });

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const distDir = path.resolve(__dirname, '..', 'dist');
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const requires = new Set();

function packageName(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:')
  ) {
    return null;
  }

  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }

  return specifier.split('/')[0];
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!entry.name.endsWith('.js')) continue;

    const source = fs.readFileSync(fullPath, 'utf8');
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const name = packageName(match[1]);
      if (name && !builtins.has(name)) requires.add(match[1]);
    }
  }
}

walk(distDir);

const missing = [];
for (const specifier of [...requires].sort()) {
  try {
    require.resolve(specifier, { paths: [path.resolve(__dirname, '..')] });
  } catch {
    missing.push(specifier);
  }
}

if (missing.length > 0) {
  console.error('Missing runtime dependencies:');
  for (const specifier of missing) console.error(`- ${specifier}`);
  process.exit(1);
}

console.log(`Runtime dependency check passed (${requires.size} imports).`);

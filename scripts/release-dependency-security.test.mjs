/**
 * Release dependency floors against the complete pnpm lock graph.
 * This does not replace the official audit or runtime reachability evidence.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, readdir as fsReaddir } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const floors = {
  effect: [3, 22, 1],
  glob: [14, 0, 2],
  minimatch: [11, 0, 1],
  'node-forge': [1, 4, 3],
  'postcss-selector-parser': [6, 1, 5],
};
const names = new Set(Object.keys(floors));
const npmExecPath = process.env.npm_execpath;
function inventory(lockOnly) {
  const args = ['-r', 'list', '--depth', 'Infinity', ...(lockOnly ? ['--lockfile-only'] : []), '--json'];
  const options = { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 120_000 };
  const output = npmExecPath?.endsWith('.cjs')
    ? execFileSync(process.execPath, [npmExecPath, ...args], options)
    : execFileSync('pnpm', args, options);
  const parsed = JSON.parse(output);
  assert.ok(Array.isArray(parsed) && parsed.length > 0, 'pnpm inventory is empty');
  return parsed;
}
function collect(inventoryData) {
  const found = new Map([...names].map((name) => [name, []]));
  const instances = new Map();
  function visit(value) {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (value && typeof value === 'object') {
      for (const [name, entry] of Object.entries(value)) {
        if (entry && typeof entry === 'object' && 'version' in entry && typeof entry.path === 'string') {
          if (!instances.has(name)) instances.set(name, []);
          instances.get(name).push(entry);
          const targetName = names.has(entry.from) ? entry.from : name;
          if (names.has(targetName)) found.get(targetName).push(entry);
        }
        visit(entry);
      }
    }
  }
  visit(inventoryData);
  return { found, instances };
}
const locked = collect(inventory(true));
const installed = collect(inventory(false));
const { instances } = installed;

function versionOf(name, entry) {
  const version = String(entry.version);
  if (!version.startsWith('link:')) return version;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = version.match(new RegExp(`^link:(?:\\.\\./)*(?:node_modules/)?\\.pnpm/${escaped}@([0-9]+\\.[0-9]+\\.[0-9]+)/node_modules/${escaped}$`));
  assert.ok(match, `Unexpected linked ${name} source: ${version}`);
  return match[1];
}

function compare(a, b) {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

// Hash every published regular file, excluding pnpm's injected nested node_modules.
// Values are SHA-256 over sorted relative path + NUL + per-file SHA-256 bytes,
// independently obtained from registry tarballs after verifying their SRI.
const publishedTrees = {
  'effect@3.22.1': '5c6d7472b082a9505b426779454e0a32886af94addad2ba3b8d2207e20748de2',
  'node-forge@1.4.3': 'f549ef71a40f2a7e2946f60b2ab4750f5e31eeb7bed6036dd496d7473e4c1c2d',
  'postcss-selector-parser@6.1.5': '06b518fc7ebaedcf258be803af32dae66f275bd519f49030400767b258e7e920',
  'minimatch@11.0.1': '31ad3d034c2987352b26f72ff0db584483fb680d5e9f657190e0dd9343c2b737',
  'glob@14.0.2': 'd169ff6760a00bea28dc8ad3af6d578baa1150ec5f58c5c92456645007ee7c2d',
  '@isaacs/nonrecursive-glob-match@1.1.0': '914a412a8f1aafa2e868f7887969cf76a1c939726ccfe2a8289c51c2e5ac663c',
  'path-scurry@3.0.0': '1b53fead85b428223954fa11b1b146be4d7ace637b17b573a3c951921a99c9aa',
};
const checkedTrees = new Set();
function installedTreeDigest(dir) {
  const files = [];
  function walk(current, prefix = '') {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) files.push([relative, absolute]);
      else throw new Error(`Unexpected installed package entry: ${relative}`);
    }
  }
  walk(dir);
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const hash = createHash('sha256');
  for (const [relative, absolute] of files) {
    hash.update(relative).update('\0').update(createHash('sha256').update(readFileSync(absolute)).digest());
  }
  return hash.digest('hex');
}
function verifyInstalled(name, version, directory) {
  let real;
  let manifest;
  try {
    real = realpathSync(directory);
    manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`Installed package missing or unreadable: ${name}@${version}`, { cause: error });
  }
  assert.equal(manifest.name, name, `Installed package name mismatch: ${name}@${version}`);
  assert.equal(manifest.version, version, `Installed package version mismatch: ${name}@${version}`);
  const expected = publishedTrees[`${name}@${version}`];
  const key = `${real}\0${name}\0${version}`;
  if (expected && !checkedTrees.has(key)) {
    assert.equal(installedTreeDigest(real), expected, `Installed package content mismatch: ${name}@${version}`);
    checkedTrees.add(key);
  }
}

function verifyEntries(name, entries, checkInstalled = false) {
  const floor = floors[name];
  assert.ok(entries.length > 0, `No ${name} instances found in inventory`);
  const official = new Set();
  for (const entry of entries) {
    const version = versionOf(name, entry);
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
    assert.ok(match, `Non-stable ${name} version: ${version}`);
    const parts = match.slice(1).map(Number);
    const unaffected = (name === 'minimatch' && parts[0] < 7) || (name === 'glob' && parts[0] < 9);
    assert.ok(unaffected || compare(parts, floor) >= 0, `Vulnerable ${name}@${version}`);
    if (checkInstalled) verifyInstalled(name, version, entry.path);
    if (!String(entry.version).startsWith('link:')) {
      const expected = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
      assert.equal(entry.resolved, expected, `Unexpected ${name}@${version} source`);
      official.add(version);
    }
  }
  for (const entry of entries) {
    if (String(entry.version).startsWith('link:')) {
      assert.ok(official.has(versionOf(name, entry)), `Uncorroborated ${name} link: ${entry.version}`);
    }
  }
}

describe('release dependency floors', () => {
  for (const name of Object.keys(floors)) {
    it(`${name} has no vulnerable or untrusted locked or installed instance`, () => {
      verifyEntries(name, locked.found.get(name));
      verifyEntries(name, installed.found.get(name), true);
    });
  }
  it('rejects vulnerable mixed versions, prereleases and non-registry sources', () => {
    const valid = { version: '3.22.1', resolved: 'https://registry.npmjs.org/effect/-/effect-3.22.1.tgz' };
    assert.throws(() => verifyEntries('effect', [valid, { version: '3.21.0', resolved: 'https://registry.npmjs.org/effect/-/effect-3.21.0.tgz' }]), /Vulnerable/);
    assert.throws(() => verifyEntries('effect', [{ version: '3.22.1-rc.1', resolved: valid.resolved }]), /Non-stable/);
    assert.throws(() => verifyEntries('effect', [{ ...valid, resolved: 'https://example.invalid/effect.tgz' }]), /Unexpected/);
  });
  it('rejects an installed package whose manifest disagrees with inventory', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'effect', version: '3.21.0' }));
    assert.throws(() => verifyEntries('effect', [{ version: '3.22.1', resolved: 'https://registry.npmjs.org/effect/-/effect-3.22.1.tgz', path: dir }], true), /Installed package/);
  });
  it('rejects installed content inconsistent with the verified registry tarball', () => {
    const dir = fixture();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'effect', version: '3.22.1' }));
    writeFileSync(join(dir, 'index.js'), 'different content');
    assert.throws(() => verifyEntries('effect', [{ version: '3.22.1', resolved: 'https://registry.npmjs.org/effect/-/effect-3.22.1.tgz', path: dir }], true), /Installed package content mismatch/);
  });
  it('verifies the two newly introduced transitive packages', () => {
    for (const [name, version] of [['@isaacs/nonrecursive-glob-match', '1.1.0'], ['path-scurry', '3.0.0']]) {
      const entries = (instances.get(name) ?? []).filter((entry) => entry.version === version);
      assert.ok(entries.length > 0, `Missing installed ${name}@${version}`);
      for (const entry of entries) verifyInstalled(name, version, entry.path);
    }
  });
  it('preserves the unaffected minimatch 5 and parser 7 branches', () => {
    for (const graph of [locked, installed]) {
      assert.ok(graph.found.get('minimatch').some((entry) => versionOf('minimatch', entry) === '5.1.9'));
      assert.ok(graph.found.get('postcss-selector-parser').some((entry) => versionOf('postcss-selector-parser', entry) === '7.1.7'));
    }
  });
});

// Resolve each parent from its actual pnpm graph instance, not a root hoist.
const ownedFixtures = [];
after(() => {
  for (const dir of ownedFixtures) rmSync(dir, { recursive: true, force: true });
});
function actualParent(name, versionPrefix) {
  const entry = (instances.get(name) ?? []).find((value) =>
    !String(value.version).startsWith('link:') && String(value.version).startsWith(versionPrefix),
  );
  assert.ok(entry, `Missing installed parent ${name}@${versionPrefix}`);
  const manifest = JSON.parse(readFileSync(join(entry.path, 'package.json'), 'utf8'));
  assert.equal(manifest.name, name);
  assert.ok(manifest.version.startsWith(versionPrefix));
  const requireFromParent = createRequire(join(entry.path, 'package.json'));
  return { module: requireFromParent(name), requireFromParent, path: entry.path };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-parent-'));
  ownedFixtures.push(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'skip'));
  writeFileSync(join(dir, 'src', 'keep.js'), 'const unused = 1;\n');
  writeFileSync(join(dir, 'src', '.hidden.js'), 'const hidden = 1;\n');
  writeFileSync(join(dir, 'skip', 'skip.js'), 'const skipped = 1;\n');
  writeFileSync(join(dir, 'ignore.txt'), 'keep');
  return dir;
}

describe('real parent glob and minimatch compatibility', () => {
  it('resolves target packages from their real parent instances', () => {
    for (const [parentName, parentVersion, target, version] of [
      ['@prisma/config', '6.19.3', 'effect', '3.22.1'],
      ['listhen', '1.10.1', 'node-forge', '1.4.3'],
      ['@tailwindcss/typography', '0.5.20', 'postcss-selector-parser', '6.1.5'],
      ['archiver-utils', '5.0.2', 'glob', '14.0.2'],
      ['editorconfig', '3.0.2', 'minimatch', '11.0.1'],
    ]) {
      const parent = actualParent(parentName, parentVersion);
      const resolved = realpathSync(parent.requireFromParent.resolve(target));
      const entries = installed.found.get(target).filter((entry) => versionOf(target, entry) === version);
      assert.ok(entries.some((entry) => resolved.startsWith(`${realpathSync(entry.path)}/`)), `${parentName} resolved unexpected ${target}: ${resolved}`);
    }
  });
  it('config-array includes and ignores expected paths', () => {
    const { ConfigArray } = actualParent('@eslint/config-array', '0.23.5').module;
    const basePath = fixture();
    const configs = new ConfigArray([{ files: ['**/*.js'], ignores: ['skip/**'] }], { basePath });
    configs.normalizeSync();
    assert.ok(configs.getConfig(join(basePath, 'src', 'keep.js')));
    assert.equal(configs.getConfig(join(basePath, 'skip', 'skip.js')), undefined);
  });
  it('editorconfig matches dot files without matching other extensions', () => {
    const editor = actualParent('editorconfig', '3.0.2').module;
    const dir = fixture();
    const sources = [{ name: join(dir, '.editorconfig'), contents: Buffer.from('root = true\n[*.js]\nindent_style = space\nindent_size = 2\n') }];
    assert.equal(editor.parseFromFilesSync(join(dir, 'src', '.hidden.js'), sources).indent_size, 2);
    assert.equal(editor.parseFromFilesSync(join(dir, 'ignore.txt'), sources).indent_size, undefined);
  });
  for (const version of ['1.', '3.']) {
    it(`readdir-glob ${version} preserves matches and ignores`, async () => {
      const scan = actualParent('readdir-glob', version).module;
      const matches = [];
      await new Promise((resolve, reject) => {
        const stream = scan(fixture(), { pattern: '**/*.js', ignore: 'skip/**', dot: true });
        stream.on('match', (entry) => matches.push(entry.relative));
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      assert.ok(matches.includes('src/keep.js'));
      assert.ok(!matches.some((item) => item.startsWith('skip/')));
      if (version === '3.') assert.ok(matches.includes('src/.hidden.js'));
    });
  }
  it('ESLint traverses files and applies ignore patterns', async () => {
    const { ESLint } = actualParent('eslint', '10.13.0').module;
    const cwd = fixture();
    const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: [
      { ignores: ['skip/**'] }, { files: ['**/*.js'], rules: { 'no-unused-vars': 'error' } },
    ] });
    const results = await eslint.lintFiles(['**/*.js']);
    assert.ok(results.some((item) => item.filePath.endsWith('/src/keep.js') && item.errorCount === 1));
    assert.ok(!results.some((item) => item.filePath.endsWith('/skip/skip.js')));
  });
  it('archiver-utils expands and excludes files', () => {
    const { file } = actualParent('archiver-utils', '5.0.2').module;
    const cwd = fixture();
    writeFileSync(join(cwd, 'src', 'drop.js'), 'drop');
    assert.deepEqual(file.expand({ cwd }, ['src/*.js']).sort(), ['src/drop.js', 'src/keep.js']);
    assert.deepEqual(file.expand({ cwd }, ['src/*.js', '!src/drop.js']), ['src/keep.js']);
  });
  it('workbox getManifest applies glob ignores', async () => {
    const workbox = actualParent('workbox-build', '7.4.1').module;
    const result = await workbox.getManifest({ globDirectory: fixture(), globPatterns: ['**/*.js'], globIgnores: ['skip/**'] });
    assert.ok(result.manifestEntries.some((entry) => entry.url === 'src/keep.js'));
    assert.ok(!result.manifestEntries.some((entry) => entry.url.startsWith('skip/')));
  });
  it('rimraf removes only matched files in an owned fixture', () => {
    const rimraf = actualParent('rimraf', '6.1.3').module;
    const dir = fixture();
    writeFileSync(join(dir, 'remove.tmp'), 'temporary');
    rimraf.rimrafSync('*.tmp', { glob: { cwd: dir } });
    assert.equal(existsSync(join(dir, 'remove.tmp')), false);
    assert.equal(existsSync(join(dir, 'ignore.txt')), true);
  });
  it('typescript-eslint project service applies its allowed-file pattern', () => {
    const parser = actualParent('@typescript-eslint/parser', '8.72.1').module;
    const dir = fixture();
    writeFileSync(join(dir, 'src', 'included.ts'), 'export const included = 1;');
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { allowJs: true }, include: ['src/**/*.ts'] }));
    const filePath = join(dir, 'scratch.js');
    writeFileSync(filePath, 'const x = 1;');
    const result = parser.parseForESLint('const x = 1;', {
      filePath, tsconfigRootDir: dir, projectService: { allowDefaultProject: ['*.js'], defaultProject: 'tsconfig.json' },
    });
    assert.equal(result.ast.type, 'Program');
    assert.ok(result.services.program);
    parser.clearCaches();
  });
  it('vercel nft traces a bounded dynamic module path', async () => {
    const nft = actualParent('@vercel/nft', '1.11.0').module;
    const dir = fixture();
    mkdirSync(join(dir, 'modules'));
    writeFileSync(join(dir, 'entry.js'), "module.exports = require('./modules/' + process.argv[2] + '.js');\n");
    writeFileSync(join(dir, 'modules', 'one.js'), 'module.exports = 1;\n');
    const result = await nft.nodeFileTrace([join(dir, 'entry.js')], { base: dir, processCwd: dir });
    assert.ok(result.fileList.has('modules/one.js'));
  });
  it('js-beautify CLI processes an owned file glob', () => {
    const parent = actualParent('js-beautify', '2.0.3');
    const dir = fixture();
    const target = join(dir, 'beautify.js');
    writeFileSync(target, 'function sample(){return 1;}');
    const bin = join(parent.path, 'js/bin/js-beautify.js');
    const out = spawnSync(process.execPath, [bin, 'beaut*.js'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    assert.equal(out.status, 0, out.stderr);
    assert.match(readFileSync(target, 'utf8'), /return 1;/);
    assert.notEqual(readFileSync(target, 'utf8'), 'function sample(){return 1;}');
  });
  it('glob resolved from archiver-utils rejects an already-aborted traversal', async () => {
    const parent = actualParent('archiver-utils', '5.0.2');
    const glob = parent.requireFromParent('glob');
    const cwd = fixture();
    let reads = 0;
    const fs = { readdir: (...args) => { reads += 1; return fsReaddir(...args); } };
    await glob.glob('**/*', { cwd, fs });
    assert.ok(reads > 0, 'the filesystem observation must detect a normal traversal');
    reads = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(glob.glob('**/*', { cwd, fs, signal: controller.signal }), (error) => error === controller.signal.reason);
    assert.equal(reads, 0, 'an already-aborted traversal must not read a directory');
  });
});

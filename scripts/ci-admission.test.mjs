import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const isolatedEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'CI fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'CI fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function stepScript(name) {
  const lines = workflow.split('\n');
  const step = lines.findIndex((line) => line.trim().replace(/^-\s+/, '') === 'name: ' + name);
  assert.notEqual(step, -1, 'Workflow step missing: ' + name);
  const script = lines.indexOf('        run: |', step + 1);
  assert.notEqual(script, -1, 'Shell body missing: ' + name);
  const out = [];
  for (const line of lines.slice(script + 1)) {
    if (line && !line.startsWith('          ')) break;
    out.push(line.slice(10));
  }
  return out.join('\n');
}

const contract = 'packages/engine-client/src/openapi.json';

function fixture(t, withBaseContract = false) {
  const dir = mkdtempSync(join(tmpdir(), 'gain-ci-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env: isolatedEnv, encoding: 'utf8' }).trim();
  const write = (path, content) => {
    const absolute = join(dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  const run = (name, env = {}) => spawnSync('bash', ['-c', stepScript(name)], {
    cwd: dir, encoding: 'utf8', env: { ...isolatedEnv, ...env },
  });
  git('init', '-q', '--template=');
  write('docs/plain.md', 'original');
  write('apps/web/example.ts', 'synthetic');
  if (withBaseContract) write(contract, '{"version":1}');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const classifyHead = (from = base, head = git('rev-parse', 'HEAD')) => {
    const output = join(dir, 'output');
    const result = run('Detect docs-only pull requests', {
      EVENT_NAME: 'pull_request',
      BASE_SHA: from,
      HEAD_SHA: head,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
    });
    return { ...result, output };
  };
  const classify = (from = base) => {
    git('add', '-A');
    git('commit', '-qm', 'change', '--allow-empty');
    const result = classifyHead(from);
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(result.output, 'utf8').trim();
  };
  return { dir, base, classify, classifyHead, run, write, git };
}

for (const [name, setup, expected] of [
  ['plain Markdown', ({ write }) => write('docs/plain.md', 'updated'), 'true'],
  ['empty diff', () => {}, 'false'],
  ['machine-read evidence', ({ write }) => write('docs/evidence/receipt.json', '{}'), 'false'],
  ['deleted documentation', ({ dir }) => rmSync(join(dir, 'docs/plain.md')), 'false'],
  ['renamed code into docs', ({ dir }) => {
    renameSync(join(dir, 'apps/web/example.ts'), join(dir, 'docs/example.md'));
  }, 'false'],
  ['symlink', ({ dir }) => symlinkSync('../apps/web/example.ts', join(dir, 'docs/link.md')), 'false'],
  ['executable Markdown', ({ dir, write }) => {
    write('docs/plain.md', 'synthetic');
    chmodSync(join(dir, 'docs/plain.md'), 0o755);
  }, 'false'],
  ['mixed change', ({ write }) => {
    write('docs/plain.md', 'updated');
    write('apps/web/example.ts', 'new code');
  }, 'false'],
]) {
  test('classifies ' + name, (t) => {
    const env = fixture(t);
    setup(env);
    assert.equal(env.classify(), 'docs_only=' + expected);
  });
}

for (const [name, setup] of [
  ['symlink', (path) => {
    rmSync(path);
    symlinkSync('../apps/web/example.ts', path);
  }],
  ['executable', (path) => chmodSync(path, 0o755)],
]) {
  test('requires full checks when a base ' + name + ' becomes ordinary Markdown', (t) => {
    const f = fixture(t);
    const path = join(f.dir, 'docs/plain.md');
    setup(path);
    f.git('add', '-A');
    f.git('commit', '-qm', 'base document type');
    const base = f.git('rev-parse', 'HEAD');
    rmSync(path);
    f.write('docs/plain.md', 'ordinary Markdown');
    assert.equal(f.classify(base), 'docs_only=false');
  });
}

test('requires the fixed contract from the exact PR base', (t) => {
  const f = fixture(t);
  f.git('commit', '-qm', 'tested change', '--allow-empty');
  const result = f.run('Fetch base engine contract（仅 PR）', { BASE_SHA: f.base, TESTED_SHA: f.git('rev-parse', 'HEAD'), GITHUB_ENV: join(f.dir, 'env') });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /base engine contract unavailable/i);
});

test('reports only a real difference from the base contract', (t) => {
  const f = fixture(t, true);
  const output = join(f.dir, 'env');
  const env = () => ({ BASE_SHA: f.base, TESTED_SHA: f.git('rev-parse', 'HEAD'), GITHUB_ENV: output });
  f.git('commit', '-qm', 'unchanged contract', '--allow-empty');
  const same = f.run('Fetch base engine contract（仅 PR）', env());
  assert.equal(same.status, 0, same.stderr);
  assert.equal(existsSync(output), false);

  f.git('switch', '-qc', 'changed-contract', f.base);
  f.write(contract, '{"version":2}');
  f.git('commit', '-qam', 'changed contract');
  const changed = f.run('Fetch base engine contract（仅 PR）', env());
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(readFileSync(output, 'utf8').trim(), 'ENGINE_CONTRACT_CHANGED=1');
});

test('refuses an accessible but unrelated base for the tested contract', (t) => {
  const f = fixture(t, true);
  f.git('commit', '-qm', 'other base', '--allow-empty');
  f.git('commit', '-qm', 'tested change', '--allow-empty');
  const result = f.run('Fetch base engine contract（仅 PR）', {
    BASE_SHA: f.base,
    TESTED_SHA: f.git('rev-parse', 'HEAD'),
    GITHUB_ENV: join(f.dir, 'env'),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /first parent does not match/i);
});

test('classifies the merge checkout and rejects a drifted PR base or checkout', (t) => {
  const f = fixture(t);
  const baseBranch = f.git('branch', '--show-current');
  f.git('switch', '-qc', 'change');
  f.write('docs/plain.md', 'proposed');
  f.git('commit', '-qam', 'proposal');
  const proposal = f.git('rev-parse', 'HEAD');
  f.git('switch', '-q', baseBranch);
  f.git('merge', '-q', '--no-ff', '--no-edit', 'change');

  const matched = f.classifyHead();
  assert.equal(matched.status, 0, matched.stderr);
  assert.equal(readFileSync(matched.output, 'utf8').trim(), 'docs_only=true');
  assert.notEqual(f.classifyHead(proposal).status, 0, 'A different base must not authorize the fast path');
  assert.notEqual(f.classifyHead(f.base, proposal).status, 0, 'A different checkout must not authorize the fast path');
});

test('rechecks the current head when a breaking-change approval label is changed', () => {
  assert.match(workflow, /pull_request:\s*\n\s+types: \[[^\n]*\blabeled\b[^\n]*\bunlabeled\b[^\n]*\]/);
});

test('cancellation selects a failing step and skips the normal admission step', (t) => {
  assert.match(workflow, /name: Reject cancelled workflow\n\s+if: \$\{\{ cancelled\(\) \}\}/);
  assert.match(workflow, /name: Validate CI results\n\s+if: \$\{\{ !cancelled\(\) \}\}/);
  const result = fixture(t).run('Reject cancelled workflow');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Cancelled workflows cannot admit a merge/);
});

const success = { CLASSIFY: 'success', SECRET_SCAN: 'success', BUILD_TEST: 'success', E2E: 'success', DOCS_ONLY: 'false' };
for (const [name, overrides, expected] of [
  ['all applicable checks pass', {}, 0],
  ['only the docs fast path may skip E2E', { DOCS_ONLY: 'true', E2E: 'skipped' }, 0],
  ['code cannot skip E2E', { E2E: 'skipped' }, 1],
  ['docs cannot skip secret scanning', { DOCS_ONLY: 'true', E2E: 'skipped', SECRET_SCAN: 'skipped' }, 1],
  ['cancelled build blocks', { BUILD_TEST: 'cancelled' }, 1],
  ['failed classification blocks', { CLASSIFY: 'failure' }, 1],
  ['missing classification output blocks', { DOCS_ONLY: '' }, 1],
]) {
  test('admission when ' + name, (t) => {
    const f = fixture(t);
    const result = f.run('Validate CI results', { ...success, ...overrides });
    assert.equal(result.status, expected, result.stdout + result.stderr);
  });
}

/**
 * Unit coverage for the plugin ZIP path validator.
 *
 * The bug this exists to catch: an organization plugin upload rejects the
 * archive with "Zip file contains path with invalid characters" when any path
 * segment leaves the ASCII letter/digit/dot/underscore/hyphen set. Zipping the
 * repo root always fails, because the SvelteKit fixtures under
 * tests/framework-fixtures/ must be named +page.svelte / +layout.svelte for
 * the framework to route them. `scripts/build-plugin-zip.mjs` packages only
 * plugin/ and refuses to write an archive that would be rejected, so the
 * failure surfaces at build time with the offending character named.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { describePathProblem, sortedEntries } from '../scripts/build-plugin-zip.mjs';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

describe('describePathProblem', () => {
  test('accepts the shapes the plugin subtree actually uses', () => {
    for (const safe of [
      '.claude-plugin/plugin.json',
      '.grok-plugin/plugin.json',
      'hooks/hooks.json',
      'agents/impeccable-asset-producer.md',
      'skills/impeccable/SKILL.md',
      'skills/impeccable/scripts/lib/artifact-schema.mjs',
      'skills/impeccable/reference/audit.native.md',
    ]) {
      expect(describePathProblem(safe)).toBeNull();
    }
  });

  test('names the offending character for a SvelteKit route file', () => {
    const problem = describePathProblem('src/routes/+page.svelte');
    expect(problem).toContain('+page.svelte');
    expect(problem).toContain('"+"');
  });

  test('rejects the other characters an uploader refuses', () => {
    // Each of these has shown up in a real repo tree: npm scopes, macOS
    // Finder artifacts, spaces from hand-copied assets, and non-ASCII names.
    for (const unsafe of [
      'node_modules/@scope/pkg/index.js',
      'docs/design notes.md',
      'assets/logo#2.png',
      'docs/guía.md',
      'skills/impeccable/emoji-🎨.md',
    ]) {
      expect(describePathProblem(unsafe)).toContain('invalid character');
    }
  });

  test('rejects traversal, absolute, and backslash paths', () => {
    expect(describePathProblem('../escape.json')).toContain('".." segment');
    expect(describePathProblem('skills/./SKILL.md')).toContain('"." segment');
    expect(describePathProblem('/etc/passwd')).toBe('absolute path');
    expect(describePathProblem('skills\\impeccable\\SKILL.md')).toBe('contains a backslash');
    expect(describePathProblem('skills//SKILL.md')).toBe('contains an empty path segment');
    expect(describePathProblem('')).toBe('empty path');
  });
});

describe('sortedEntries', () => {
  test('orders by archive path regardless of input order', () => {
    // Both root archives are tracked in git, so an unstable entry order means
    // a fresh 1.6 MB blob in history on every rebuild even when nothing moved.
    const entries = [
      { abs: '/tmp/b', archive: 'skills/impeccable/SKILL.md' },
      { abs: '/tmp/a', archive: '.claude-plugin/plugin.json' },
      { abs: '/tmp/c', archive: 'agents/impeccable-documenter.md' },
    ];
    expect(sortedEntries(entries).map((e) => e.archive)).toEqual([
      '.claude-plugin/plugin.json',
      'agents/impeccable-documenter.md',
      'skills/impeccable/SKILL.md',
    ]);
  });

  test('does not mutate the caller\'s array', () => {
    const entries = [{ abs: '/b', archive: 'b' }, { abs: '/a', archive: 'a' }];
    sortedEntries(entries);
    expect(entries.map((e) => e.archive)).toEqual(['b', 'a']);
  });
});

describe('the committed plugin subtree', () => {
  test('carries no path an uploader would reject', () => {
    const pluginDir = path.join(REPO_ROOT, 'plugin');
    if (!fs.existsSync(pluginDir)) return; // Not built yet; the build gate covers this.

    const offenders = [];
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.DS_Store') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const problem = describePathProblem(rel);
        if (problem) offenders.push(`${rel}: ${problem}`);
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      }
    };
    walk(pluginDir);
    expect(offenders).toEqual([]);
  });
});

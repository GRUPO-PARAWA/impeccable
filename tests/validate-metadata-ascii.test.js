/**
 * Unit coverage for the non-ASCII frontmatter guard.
 *
 * The bug this exists to catch: the generated SKILL.md's `argument-hint` joined
 * command groups with a middle dot (U+00B7), the only non-ASCII character in any
 * frontmatter across a 169-file upload payload. Organization upload validators
 * parse metadata strictly and reject characters `claude plugin validate`
 * accepts, and the server's real validation_errors get swallowed behind a
 * generic message, so the rejection never names the field. Nothing in the build
 * looked at metadata encoding, so it went four upload attempts unnoticed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectNonAsciiFrontmatterFindings,
  describeNonAscii,
  extractFrontmatter,
} from '../scripts/lib/validate-metadata-ascii.js';

const REPO_ROOT = path.resolve(import.meta.dir, '..');

describe('extractFrontmatter', () => {
  test('returns the block between the fences', () => {
    expect(extractFrontmatter('---\nname: a\nversion: 1\n---\nBody.\n')).toBe('name: a\nversion: 1');
  });

  test('returns null when there is no frontmatter or no closing fence', () => {
    expect(extractFrontmatter('# Just a heading\n')).toBeNull();
    expect(extractFrontmatter('---\nname: a\nnever closed\n')).toBeNull();
  });
});

describe('describeNonAscii', () => {
  test('reports the middle dot that caused this guard to exist', () => {
    const hit = describeNonAscii('argument-hint: "[shape · audit|critique]"');
    expect(hit.chars).toEqual(['·']);
    expect(hit.codes).toEqual(['U+00B7']);
  });

  test('deduplicates repeats and reports every distinct character', () => {
    const hit = describeNonAscii('description: a — b — c → d');
    expect(hit.chars).toEqual(['—', '→']);
    expect(hit.codes).toEqual(['U+2014', 'U+2192']);
  });

  test('passes plain ASCII, including the separator that replaced the dot', () => {
    expect(describeNonAscii('argument-hint: "[shape / audit|critique] [target]"')).toBeNull();
    expect(describeNonAscii('allowed-tools:')).toBeNull();
    expect(describeNonAscii('')).toBeNull();
  });
});

describe('collectNonAsciiFrontmatterFindings', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-ascii-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (rel, contents) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  };

  test('flags a non-ASCII frontmatter field and locates it', () => {
    write('plugin/skills/impeccable/SKILL.md', '---\nname: impeccable\nargument-hint: "[a · b]"\n---\nBody.\n');
    const findings = collectNonAsciiFrontmatterFindings(root);
    expect(findings).toHaveLength(1);
    expect(findings[0].relPath).toBe(path.join('plugin', 'skills', 'impeccable', 'SKILL.md'));
    expect(findings[0].line).toBe(2);
    expect(findings[0].codes).toEqual(['U+00B7']);
  });

  test('ignores non-ASCII in the body, which prose legitimately uses', () => {
    write('plugin/skills/impeccable/reference/audit.md', '---\nname: audit\n---\nUse an arrow → here, and an em dash — too.\n');
    expect(collectNonAsciiFrontmatterFindings(root)).toEqual([]);
  });

  test('ignores markdown with no frontmatter at all', () => {
    write('plugin/README.md', 'No frontmatter, just a · middle dot.\n');
    expect(collectNonAsciiFrontmatterFindings(root)).toEqual([]);
  });

  test('scans agents as well as skills, and reports each offending line', () => {
    write('plugin/agents/one.md', '---\nname: one\ndescription: clean\n---\nBody.\n');
    write('plugin/agents/two.md', '---\nname: two\ndescription: has a · dot\nmodel: a — b\n---\nBody.\n');
    const findings = collectNonAsciiFrontmatterFindings(root);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line)).toEqual([2, 3]);
  });

  test('returns nothing when the subtree does not exist', () => {
    expect(collectNonAsciiFrontmatterFindings(root)).toEqual([]);
  });
});

describe('the committed plugin subtree', () => {
  test('has ASCII-only frontmatter', () => {
    if (!fs.existsSync(path.join(REPO_ROOT, 'plugin'))) return; // Not built yet.
    expect(collectNonAsciiFrontmatterFindings(REPO_ROOT)).toEqual([]);
  });
});

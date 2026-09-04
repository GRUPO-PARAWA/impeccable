/**
 * Non-ASCII frontmatter guard for the uploadable plugin subtree.
 *
 * The bug this exists to catch: the generated SKILL.md's `argument-hint` joined
 * command groups with a middle dot (U+00B7), which made it the only frontmatter
 * field in a 169-file payload carrying a non-ASCII character. Organization
 * upload validators parse metadata fields strictly and reject characters the
 * CLI accepts (claude-code #63081 rejects angle brackets in a description that
 * `claude plugin validate` passes), and #56376 shows the server's real
 * validation_errors getting swallowed behind a generic message. So a rejection
 * does not have to name the offending field, or even the right cause, which is
 * exactly why this has to be a build gate rather than something to notice.
 *
 * Scoped to frontmatter on purpose. Reference prose legitimately uses arrows and
 * typographic quotes; a metadata field read by a machine has no such excuse.
 */

import fs from 'fs';
import path from 'path';

/**
 * Extract the frontmatter block from markdown, or null when there is none.
 * @param {string} text
 * @returns {string|null}
 */
export function extractFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return text.slice(4, end);
}

/**
 * Describe the non-ASCII characters in a single line, or null when it is clean.
 * @param {string} line
 * @returns {{chars: string[], codes: string[]}|null}
 */
export function describeNonAscii(line) {
  const chars = [...new Set([...line].filter((ch) => ch.codePointAt(0) > 127))];
  if (chars.length === 0) return null;
  return {
    chars,
    codes: chars.map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`),
  };
}

/**
 * Collect every non-ASCII frontmatter line under a directory of markdown.
 * @param {string} rootDir - Repo root.
 * @param {string} [subtree] - Directory to scan, relative to rootDir.
 * @returns {{relPath: string, line: number, text: string, chars: string[], codes: string[]}[]}
 */
export function collectNonAsciiFrontmatterFindings(rootDir, subtree = 'plugin') {
  const scanDir = path.join(rootDir, subtree);
  if (!fs.existsSync(scanDir)) return [];

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.md')) files.push(abs);
    }
  };
  walk(scanDir);

  const findings = [];
  for (const file of files) {
    const frontmatter = extractFrontmatter(fs.readFileSync(file, 'utf-8'));
    if (frontmatter == null) continue;
    for (const [index, line] of frontmatter.split('\n').entries()) {
      const hit = describeNonAscii(line);
      if (!hit) continue;
      findings.push({
        relPath: path.relative(rootDir, file),
        line: index + 1,
        text: line.trim(),
        chars: hit.chars,
        codes: hit.codes,
      });
    }
  }
  return findings;
}

/**
 * Plugin ZIP packager for organization-managed plugin uploads.
 *
 * Why this exists: zipping the whole repository and uploading it is rejected
 * with "Zip file contains path with invalid characters". The offenders are the
 * SvelteKit test fixtures, whose framework-mandated filenames contain `+`
 * (`tests/framework-fixtures/<fixture>/files/src/routes/+page.svelte`). Those files
 * cannot be renamed without breaking SvelteKit's routing convention, and a
 * plugin has no business shipping the test suite anyway.
 *
 * So this packages only the `plugin/` subtree, which is exactly what a plugin
 * consumer needs (manifest + skill + agents + hooks), and refuses to produce an
 * archive at all if any entry path would trip a strict path validator.
 *
 * Two upload targets need two archive shapes, so the mode is explicit:
 *
 *   plugin (default) - `.claude-plugin/plugin.json` at the zip root, plus
 *     skills/, agents/, and hooks/. This is what a plugin upload expects.
 *   skill (--skill)  - a single `impeccable/` directory holding SKILL.md,
 *     reference/, and scripts/. This is what a skill upload expects, and it
 *     reproduces the hand-made `impeccable-skill.zip` at the repo root.
 *
 * Usage:
 *   node scripts/build-plugin-zip.mjs                 # dist/impeccable-plugin.zip
 *   node scripts/build-plugin-zip.mjs --skill         # dist/impeccable-skill.zip
 *   node scripts/build-plugin-zip.mjs --out <path>    # custom destination
 *   node scripts/build-plugin-zip.mjs --wrap          # nest under <name>/ (plugin mode)
 *   node scripts/build-plugin-zip.mjs --check-only    # validate paths, write nothing
 *   node scripts/build-plugin-zip.mjs --scan-repo     # also report repo-wide offenders
 */

import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import { ZipArchive } from 'archiver';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT_DIR, 'plugin');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// Entries never worth shipping, and the ones most likely to be introduced by a
// macOS Finder "Compress" pass rather than by this script.
const EXCLUDED_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', '__MACOSX']);
const EXCLUDED_RELATIVE = new Set([
  path.join('.impeccable', 'hook.cache.json'),
  path.join('.impeccable', 'hook.pending.json'),
]);

// The conservative intersection of what plugin-upload path validators accept:
// ASCII letters, digits, dot, underscore, hyphen. Anything else (`+`, spaces,
// `@`, `#`, `:`, accented characters, emoji) is a rejection risk, so it is an
// error here rather than a surprise at upload time.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Both root archives are tracked in git, so identical content must produce
// identical bytes. Without a fixed entry timestamp archiver stamps each file's
// mtime and every rebuild is a fresh 1.6 MB blob in history, whether or not
// anything changed. The value is arbitrary; only its stability matters.
const FIXED_ENTRY_DATE = new Date('2020-01-01T00:00:00Z');

/**
 * Explain why a single archive path is unsafe, or return null when it is fine.
 * @param {string} relPath - Archive-relative path, POSIX separators.
 * @returns {string|null}
 */
export function describePathProblem(relPath) {
  if (relPath === '') return 'empty path';
  if (relPath.startsWith('/')) return 'absolute path';
  if (relPath.includes('\\')) return 'contains a backslash';
  for (const segment of relPath.split('/')) {
    if (segment === '' ) return 'contains an empty path segment';
    if (segment === '.' || segment === '..') return `contains a "${segment}" segment`;
    if (!SAFE_SEGMENT.test(segment)) {
      const bad = [...segment].filter((ch) => !SAFE_SEGMENT.test(ch));
      const shown = [...new Set(bad)].map((ch) => JSON.stringify(ch)).join(', ');
      return `segment "${segment}" has invalid character(s): ${shown}`;
    }
  }
  return null;
}

/**
 * Order archive entries by path so the output does not depend on read order.
 * @param {{abs: string, archive: string}[]} entries
 * @returns {{abs: string, archive: string}[]}
 */
export function sortedEntries(entries) {
  return [...entries].sort((a, b) => (a.archive < b.archive ? -1 : a.archive > b.archive ? 1 : 0));
}

/**
 * Collect files under a directory as archive-relative POSIX paths.
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function collectFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDED_BASENAMES.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (EXCLUDED_RELATIVE.has(rel.split('/').join(path.sep))) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(abs, rel));
    else if (entry.isFile()) out.push(rel);
    // Symlinks are skipped: a plugin archive should be self-contained, and a
    // dangling link inside the consumer's plugin cache is worse than a gap.
  }
  return out;
}

/**
 * Report repo paths that would break a full-repository zip. Informational only:
 * this script never packages the repo root, so these are not fatal.
 * @returns {{relPath: string, problem: string}[]}
 */
function scanRepo() {
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.astro', 'tmp']);
  const offenders = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (prefix === '' && skip.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const problem = describePathProblem(rel);
      if (problem) offenders.push({ relPath: rel, problem });
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(ROOT_DIR);
  return offenders;
}

function parseArgs(argv) {
  const opts = { out: null, wrap: false, checkOnly: false, scanRepo: false, skill: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg.startsWith('--out=')) opts.out = arg.slice('--out='.length);
    else if (arg === '--wrap') opts.wrap = true;
    else if (arg === '--skill') opts.skill = true;
    else if (arg === '--check-only') opts.checkOnly = true;
    else if (arg === '--scan-repo') opts.scanRepo = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const manifestPath = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Missing ${path.relative(ROOT_DIR, manifestPath)}. Run \`bun run build:release\` first so the plugin subtree is generated.`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const pluginName = manifest.name || 'plugin';

  // Skill mode packages the skill directory alone, always wrapped in its own
  // name: a skill upload identifies the skill by that top-level directory, so
  // an unwrapped SKILL.md at the archive root has no name to install under.
  const sourceDir = opts.skill ? path.join(PLUGIN_DIR, 'skills', pluginName) : PLUGIN_DIR;
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing ${path.relative(ROOT_DIR, sourceDir)}. Run \`bun run build:release\` first.`);
  }
  const wrapDir = opts.skill || opts.wrap ? `${pluginName}/` : '';

  const files = collectFiles(sourceDir);
  if (files.length === 0) throw new Error(`No files found under ${path.relative(ROOT_DIR, sourceDir)}.`);

  const entries = files.map((rel) => ({
    abs: path.join(sourceDir, rel.split('/').join(path.sep)),
    archive: `${wrapDir}${rel}`,
  }));

  const problems = entries
    .map((entry) => ({ relPath: entry.archive, problem: describePathProblem(entry.archive) }))
    .filter((p) => p.problem);

  if (problems.length > 0) {
    console.error(`\n❌ ${problems.length} path(s) would be rejected by the plugin uploader:\n`);
    for (const { relPath, problem } of problems) console.error(`   ${relPath}\n     ${problem}`);
    console.error('\nRename or exclude these before packaging.\n');
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ ${entries.length} path(s) validated under ${path.relative(ROOT_DIR, sourceDir)} (safe set: A-Z a-z 0-9 . _ -)`,
  );

  if (opts.scanRepo) {
    const offenders = scanRepo();
    if (offenders.length === 0) {
      console.log('✅ Repository-wide scan found no unsafe paths.');
    } else {
      console.log(`\nℹ️  ${offenders.length} path(s) elsewhere in the repo would break a full-repo zip:`);
      for (const { relPath, problem } of offenders) console.log(`   ${relPath}\n     ${problem}`);
      console.log('   These stay out of the plugin archive, so they do not affect this upload.\n');
    }
  }

  if (opts.checkOnly) return;

  const defaultName = `${pluginName}-${opts.skill ? 'skill' : 'plugin'}.zip`;
  const outPath = path.resolve(ROOT_DIR, opts.out || path.join(DIST_DIR, defaultName));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.rmSync(outPath, { force: true });

  let entryCount = 0;
  await new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('entry', () => { entryCount += 1; });
    archive.pipe(output);
    // Buffers, not paths, and in sorted order. `archive.file()` reads from disk
    // asynchronously and emits entries as those reads complete, so a handful of
    // entries swap places between runs and the archive bytes differ even when
    // every file is identical. Appending buffers removes the race, which is
    // what makes the tracked artifacts reproducible. The whole payload is
    // ~1.6 MB, so holding it in memory costs nothing worth optimizing.
    for (const entry of sortedEntries(entries)) {
      archive.append(fs.readFileSync(entry.abs), { name: entry.archive, date: FIXED_ENTRY_DATE });
    }
    archive.finalize();
  });

  if (entryCount !== entries.length) {
    throw new Error(`Expected ${entries.length} archive entries, wrote ${entryCount}.`);
  }
  const { size } = fs.statSync(outPath);
  if (size === 0) throw new Error(`Wrote ${path.relative(ROOT_DIR, outPath)} but it is 0 bytes.`);

  console.log(
    `📦 ${path.relative(ROOT_DIR, outPath)} (${(size / 1024).toFixed(1)} KB, ${entryCount} files, v${manifest.version})`,
  );
  const rootEntry = opts.skill ? `${wrapDir}SKILL.md` : `${wrapDir}.claude-plugin/plugin.json`;
  console.log(`   Mode: ${opts.skill ? 'skill' : 'plugin'}. Identifying entry: ${rootEntry}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-plugin-zip.mjs')) {
  main().catch((err) => {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  });
}

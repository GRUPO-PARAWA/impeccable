/**
 * Zip upload diagnostic.
 *
 * Point this at the exact file you are uploading. It reports everything a
 * strict path validator could object to, so "Zip file contains path with
 * invalid characters" stops being a guessing game.
 *
 * It checks more than `build-plugin-zip.mjs` does, because that script
 * validates what it is about to write while this one inspects an archive of
 * unknown provenance: the file's own name, entry name encoding, dot-prefixed
 * segments, control characters, depth and length, traversal, and the archive
 * shape (plugin vs skill vs repository export).
 *
 * Usage:
 *   node scripts/check-zip.mjs impeccable-plugin.zip
 *   node scripts/check-zip.mjs ~/Downloads/whatever-you-uploaded.zip
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// What a conservative uploader accepts inside a path segment.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function listEntries(zipPath) {
  // `unzip -Z1` reads the central directory, which is what any zip reader
  // treats as authoritative. Preferred over a hand-rolled parser here.
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

function badChars(str) {
  return [...new Set([...str].filter((ch) => !SAFE_SEGMENT.test(ch) && ch !== '/'))];
}

function show(list, limit = 15) {
  for (const line of list.slice(0, limit)) console.log(`     ${line}`);
  if (list.length > limit) console.log(`     ... and ${list.length - limit} more`);
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/check-zip.mjs <path-to-zip>');
    process.exit(2);
  }
  const zipPath = path.resolve(target);
  if (!fs.existsSync(zipPath)) {
    console.error(`Not found: ${zipPath}`);
    process.exit(2);
  }

  const base = path.basename(zipPath);
  const { size } = fs.statSync(zipPath);
  console.log(`\nFile:  ${base}`);
  console.log(`Path:  ${zipPath}`);
  console.log(`Size:  ${(size / 1024 / 1024).toFixed(2)} MB\n`);

  let problems = 0;

  // 1. The archive's own filename. A second download becomes "name (1).zip"
  // or "name-1.zip"; the parenthesized form carries a space and brackets.
  const nameBad = badChars(base);
  if (nameBad.length > 0) {
    problems += 1;
    console.log(`❌ The FILE NAME itself has characters a validator may reject: ${nameBad.map((c) => JSON.stringify(c)).join(', ')}`);
    console.log(`   Rename it to something like impeccable-plugin.zip and retry.\n`);
  } else {
    console.log('✅ File name is clean.\n');
  }

  const entries = listEntries(zipPath);
  const files = entries.filter((e) => !e.endsWith('/'));
  console.log(`Entries: ${entries.length} (${files.length} files, ${entries.length - files.length} directory records)\n`);

  // 2. Characters outside the safe set. This is the check that matches the
  // error message most directly.
  const unsafe = entries
    .map((e) => ({ e, chars: badChars(e) }))
    .filter((r) => r.chars.length > 0);
  if (unsafe.length > 0) {
    problems += 1;
    console.log(`❌ ${unsafe.length} path(s) contain characters outside [A-Za-z0-9._-]:`);
    show(unsafe.map((r) => `${r.e}   <- ${r.chars.map((c) => JSON.stringify(c)).join(', ')}`));
    console.log('');
  } else {
    console.log('✅ Every path is inside [A-Za-z0-9._-].\n');
  }

  // 3. Absolute paths, traversal, backslashes. Rejected as unsafe extraction
  // rather than as bad characters, but the message is often the same.
  const structural = entries.filter(
    (e) => e.startsWith('/') || e.includes('\\') || e.split('/').some((s) => s === '..' || s === '.'),
  );
  if (structural.length > 0) {
    problems += 1;
    console.log(`❌ ${structural.length} path(s) are absolute, traverse upward, or use backslashes:`);
    show(structural);
    console.log('');
  } else {
    console.log('✅ No absolute, traversing, or backslash paths.\n');
  }

  // 4. Non-ASCII bytes in entry names, which survive a naive char check when
  // the tooling decodes them but fail a byte-level validator.
  const nonAscii = entries.filter((e) => [...e].some((ch) => ch.codePointAt(0) > 127));
  const control = entries.filter((e) => [...e].some((ch) => ch.codePointAt(0) < 32));
  if (nonAscii.length || control.length) {
    problems += 1;
    console.log(`❌ ${nonAscii.length} path(s) with non-ASCII and ${control.length} with control characters:`);
    show([...nonAscii, ...control]);
    console.log('');
  } else {
    console.log('✅ All entry names are printable ASCII.\n');
  }

  // 5. Dot-prefixed segments. The packager allows these because the plugin
  // format requires `.claude-plugin/plugin.json`, but a validator that treats
  // hidden entries as invalid would flag exactly these and nothing else. If
  // this is the only section with output, that is the answer.
  const dotted = entries.filter((e) => e.split('/').some((s) => s.startsWith('.') && s !== '.' && s !== '..'));
  if (dotted.length > 0) {
    console.log(`⚠️  ${dotted.length} path(s) have a dot-prefixed (hidden) segment:`);
    show([...new Set(dotted.map((e) => e.split('/').filter((s) => s.startsWith('.'))[0]))]);
    console.log('   The plugin format requires .claude-plugin/plugin.json, so these are');
    console.log('   expected in a plugin archive. Flagged only because a validator that');
    console.log('   rejects hidden entries would object here and nowhere else.\n');
  } else {
    console.log('✅ No dot-prefixed segments.\n');
  }

  // 6. macOS Finder residue. Not invalid characters, but it means the archive
  // was made by compressing a folder rather than by the packager.
  const macCruft = entries.filter((e) => e.startsWith('__MACOSX') || e.endsWith('.DS_Store') || e.includes('/._'));
  if (macCruft.length > 0) {
    console.log(`⚠️  ${macCruft.length} macOS Finder artifact(s) (__MACOSX, .DS_Store, ._ forks).`);
    console.log('   This archive was compressed by Finder, not by build:upload-zips.\n');
  }

  // 7. Depth and length, in case the receiving end caps either.
  const depth = Math.max(...entries.map((e) => e.split('/').length));
  const longest = entries.reduce((a, b) => (b.length > a.length ? b : a), '');
  console.log(`Deepest path: ${depth} segments. Longest: ${longest.length} chars (${longest})\n`);

  // 8. Archive shape, so a wrong-form upload is obvious.
  const roots = [...new Set(entries.map((e) => e.split('/')[0]))];
  const hasPluginManifest = files.some((f) => f === '.claude-plugin/plugin.json');
  const nestedPluginManifest = files.find((f) => /^[^/]+\/\.claude-plugin\/plugin\.json$/.test(f));
  const skillRoot = files.find((f) => /^[^/]+\/SKILL\.md$/.test(f));

  console.log('Shape:');
  console.log(`   Top-level entries: ${roots.slice(0, 8).join(', ')}${roots.length > 8 ? `, ... (${roots.length} total)` : ''}`);
  if (hasPluginManifest) {
    console.log('   -> PLUGIN archive. .claude-plugin/plugin.json is at the root. Correct for the plugin form.');
  } else if (skillRoot) {
    console.log(`   -> SKILL archive. ${skillRoot} defines the skill. Correct for the skill form.`);
  } else if (nestedPluginManifest) {
    console.log(`   -> Manifest is nested at ${nestedPluginManifest}, not at the root.`);
    console.log('      A plugin form that reads the root will not find it. This is what a');
    console.log('      GitHub "Code -> Download ZIP" of the repository looks like.');
    problems += 1;
  } else {
    console.log('   -> Neither a plugin manifest nor a SKILL.md was found. This is not an');
    console.log('      installable archive, whatever the path validator says.');
    problems += 1;
  }
  if (files.some((f) => f.includes('tests/framework-fixtures/'))) {
    console.log('   -> Contains tests/framework-fixtures/, so this is a repository export,');
    console.log('      not a packaged upload. Use build:upload-zips output instead.');
  }

  console.log(problems === 0 ? '\n✅ Nothing here explains a path rejection.\n' : `\n❌ ${problems} blocking problem(s) above.\n`);
  process.exitCode = problems === 0 ? 0 : 1;
}

main();

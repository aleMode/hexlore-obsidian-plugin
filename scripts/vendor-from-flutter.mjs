// Copy the contract from the Flutter repository into vendor/.
//
// The Flutter repo is the source of truth for the format, the conformance
// fixtures, the shared render spec and the variant ids. This plugin keeps a
// plain copy of each, and vendor/SOURCE records the Flutter commit it came
// from. Never edit vendor/ by hand: change Flutter, then re-run this.
//
// Usage: npm run vendor [-- path-to-flutter-repo]
//        (default: $HEXLORE_FLUTTER, else the repository this folder sits in
//        while the plugin lives in obsidian-plugin/, else ../software_hexlore)
//
// Node, not sh: `npm run` uses cmd.exe on Windows, which cannot run a shell
// script, and Windows has no `sh` on its PATH by default.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fallback = existsSync(join(here, '..', 'hexlore_flutter')) ? join(here, '..') : join(here, '..', 'software_hexlore');
const src = resolve(process.argv[2] ?? process.env.HEXLORE_FLUTTER ?? fallback);
const app = join(src, 'hexlore_flutter');

if (!existsSync(join(app, 'pubspec.yaml'))) {
	console.error(`not a HexLore Flutter repo: ${src}`);
	process.exit(1);
}

const git = (...args) => execFileSync('git', ['-C', src, ...args], { encoding: 'utf8' }).trim();

const paths = [
	'hexlore_flutter/test/fixtures/conformance',
	'docs/format-2.md',
	'docs/converter.md',
	'hexlore_flutter/test/fixtures/converter',
	'hexlore_flutter/assets/player',
	'hexlore_flutter/tool/variant_ids.lock',
];

// Vendoring uncommitted files would record a commit they are not in.
let dirty = '';
if (git('status', '--porcelain', '--', ...paths)) {
	console.warn('warning: the Flutter repo has uncommitted changes in the vendored paths;');
	console.warn('         vendor/SOURCE will say so.');
	dirty = ' (dirty)';
}

const out = join(here, 'vendor');
rmSync(out, { recursive: true, force: true });
for (const d of ['conformance', 'docs', 'player']) mkdirSync(join(out, d), { recursive: true });

const conformance = join(app, 'test/fixtures/conformance');
for (const f of readdirSync(conformance)) {
	if (f.endsWith('.json') || f === 'README.md') cpSync(join(conformance, f), join(out, 'conformance', f));
}
for (const f of ['format-2.md', 'converter.md']) cpSync(join(src, 'docs', f), join(out, 'docs', f));
cpSync(join(app, 'test/fixtures/converter'), join(out, 'converter'), { recursive: true });
for (const f of readdirSync(join(app, 'assets/player'))) cpSync(join(app, 'assets/player', f), join(out, 'player', f));
cpSync(join(app, 'tool/variant_ids.lock'), join(out, 'variant_ids.lock'));

const head = git('rev-parse', 'HEAD');
writeFileSync(join(out, 'SOURCE'), `${head}${dirty}\n${git('log', '-1', '--format=%cI %s')}\n`);
console.log(`vendored from ${head}${dirty}`);

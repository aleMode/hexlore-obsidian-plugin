import { existsSync, readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

// The Obsidian community directory's rules (docs.obsidian.md, Reference →
// Manifest; obsidian-developer-docs, Community directory → Developer
// policies and Submission requirements for plugins; checked 2026-11-14,
// design V9). Its automated review rejects a release that breaks them.

const json = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const manifest = json('manifest.json');
const pkg = json('package.json');
const versions = json('versions.json');

describe('the community directory rules', () => {
	it('has a valid id', () => {
		const id = manifest.id as string;
		expect(id).toMatch(/^[a-z-]+$/);
		expect(id).not.toMatch(/plugin$/);
		expect(id).not.toContain('obsidian');
	});

	it('has a valid name', () => {
		const name = manifest.name as string;
		expect(name).toMatch(/^[A-Za-z0-9 ()+-]+$/);
		expect(name.toLowerCase()).not.toMatch(/obsi|sidian|plugin/);
	});

	it('has a description to the rules', () => {
		const d = manifest.description as string;
		expect(d.length).toBeLessThanOrEqual(250);
		expect(d).toMatch(/\.$/);
		expect(d).not.toMatch(/^this is a plugin/i);
		// An action statement: starts with a verb, capitalised.
		expect(d).toMatch(/^[A-Z][a-z]+ /);
		expect(d).toMatch(/^[\x20-\x7E]+$/); // no emoji or special characters
		expect(d.toLowerCase()).not.toContain('obsidian');
	});

	it('is desktop only, since it uses Node.js modules', () => {
		expect(readFileSync('src/desktop.ts', 'utf8')).toContain('nodeModule');
		expect(manifest.isDesktopOnly).toBe(true);
	});

	it('keeps manifest, package and versions.json in step', () => {
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(pkg.version).toBe(manifest.version);
		expect(versions[manifest.version as string]).toBe(manifest.minAppVersion);
		for (const k of ['id', 'name', 'version', 'minAppVersion', 'description', 'author', 'isDesktopOnly']) expect(manifest).toHaveProperty(k);
		// fundingUrl only when donations are accepted (none are).
		expect(manifest).not.toHaveProperty('fundingUrl');
	});

	it('has a LICENSE matching package.json', () => {
		expect(existsSync('LICENSE')).toBe(true);
		expect(readFileSync('LICENSE', 'utf8')).toContain('GNU GENERAL PUBLIC LICENSE');
		expect(pkg.license).toBe('GPL-3.0-or-later');
	});

	it('discloses network use and files outside the vault in the README', () => {
		const readme = readFileSync('README.md', 'utf8');
		expect(readme).toMatch(/## Network use and files outside the vault/);
		expect(readme).toMatch(/## License/);
	});

	it('never puts the plugin id in a command id, nor a default hotkey', () => {
		const main = readFileSync('src/main.ts', 'utf8');
		const ids = [...main.matchAll(/addCommand\(\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) expect(id).not.toContain(manifest.id as string);
		expect(main).not.toMatch(/hotkeys\s*:/);
	});
});

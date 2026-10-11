import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { MapModel } from '../src/core/map';
import { fingerprint, planFlutterExport, type VaultNote } from '../src/convert/flutter_export';
import { folderProblem, folderState, renameRetrying, writeFlutterCampaign } from '../src/convert/write';
import { parseHexList, parseLinks, readSections, REGIONS } from '../src/storage/hexmap_index';
import { applyFile, fileKeyOf } from '../src/storage/map_codec';
import { parseFrontmatter, readTree, resolver } from './helpers/vault_folder';

// The plugin → Flutter direction (plan item 2.7, docs/converter.md §5). Its
// input is the Flutter → plugin fixture's OUTPUT, so the pair is a round
// trip: HexLore → vault → HexLore. HEXLORE_WRITE_CONVERTER=1 writes the
// expected folder into the Flutter repository (then `npm run vendor`).
const VENDOR = 'vendor/converter';
const FLUTTER_PAIR = '../hexlore_flutter/test/fixtures/converter/plugin_to_flutter/expected';

function exportVault(dir: string) {
	const tree = readTree(dir);
	const indexPath = [...tree.keys()].find((p) => p.endsWith('.hexmap.md'))!;
	const index = tree.get(indexPath)!;
	const fm = parseFrontmatter(index)!;
	const data = fm.data as string;
	const model = new MapModel();
	for (const [p, text] of tree) {
		if (!p.startsWith(`${data}/`)) continue;
		const key = fileKeyOf(p.slice(data.length + 1));
		if (key) applyFile(model, key, text, 'Fixture');
	}
	const notes = new Map<string, VaultNote>();
	for (const [p, text] of tree) if (p.endsWith('.md') && p !== indexPath) notes.set(p, { path: p, text, frontmatter: parseFrontmatter(text) });
	return planFlutterExport({
		model,
		indexPath,
		hexLinks: parseHexList(index).hexes,
		regionLinks: parseLinks(index, REGIONS).links,
		sections: readSections(fm) ?? [],
		notes,
		resolve: resolver([...notes.keys()]),
	});
}

describe('plugin → Flutter (docs/converter.md §5)', () => {
	const plan = exportVault(`${VENDOR}/flutter_to_plugin/expected`);
	const json = (p: string) => JSON.parse(plan.files.get(p)!) as Record<string, unknown>;

	it('matches the fixture pair', () => {
		if (process.env.HEXLORE_WRITE_CONVERTER === '1') {
			fs.rmSync(FLUTTER_PAIR, { recursive: true, force: true });
			for (const [p, text] of plan.files) {
				fs.mkdirSync(path.dirname(`${FLUTTER_PAIR}/${p}`), { recursive: true });
				fs.writeFileSync(`${FLUTTER_PAIR}/${p}`, text);
			}
			fs.rmSync(`${VENDOR}/plugin_to_flutter`, { recursive: true, force: true });
			fs.cpSync(path.dirname(FLUTTER_PAIR), `${VENDOR}/plugin_to_flutter`, { recursive: true });
		}
		const want = readTree(`${VENDOR}/plugin_to_flutter/expected`);
		expect([...plan.files.keys()].sort()).toEqual([...want.keys()].sort());
		for (const [p, text] of want) expect(plan.files.get(p), p).toBe(text);
	});

	it('hex pages, region pages, prep, entries', () => {
		expect(plan.files.get('pages/hexes/Base Culto.md')).toContain('Home of the [[Hermit]]. See [[North]], [[Ash Cult]] and [[Old Mill]].');
		expect(plan.files.get('pages/regions/North.md')).toContain('## Encounters');
		expect(plan.files.get('pages/prep/Todo.md')).toBe('Visit [[Tower]] and talk to [[Hermit|the hermit]].\n');
		const entries = json('entries.json') as { tabs: { name: string }[]; entries: Record<string, { name: string; tab: string; page_file: string | null; npc_id: string | null }> };
		expect(entries.tabs.map((t) => t.name)).toEqual(['NPC', 'Unsorted', 'Factions']);
		const byName = Object.values(entries.entries).map((e) => `${e.tab}:${e.name}:${e.page_file}:${e.npc_id}`);
		expect(byName).toContain('Factions:Ash Cult:factions/Ash Cult.md:null');
		expect(byName).toContain('Unsorted:Loose:unsorted/Loose.md:null');
		expect(byName).toContain('NPC:Hermit:npc/Hermit.md:npc_001');
	});

	it('NPCs and quests come back with their fields and ids', () => {
		const hermit = json('npcs/npc_001.json');
		expect(hermit).toMatchObject({ name: 'Hermit', hex_id: 'q0_r0', role: 'sage', attitude: 'friendly', description: 'Old and kind.', secret: 'Leads the cult.', tags: ['cult'], linked_npc_ids: ['npc_002'], linked_quest_ids: ['quest_001'], notes_file: 'npc/Hermit.md', is_secret: false });
		expect(json('npcs/npc_002.json')).toMatchObject({ name: 'Wanderer', hex_id: 'q3_r3', is_secret: true, mood: 'grim' });
		expect(plan.files.get('pages/npc/Hermit.md')).toBe('Met in session 2.\n\n# Role\nsage\n\n# Attitude\nfriendly\n\n# Description\nOld and kind.\n\n# Secret\nLeads the cult.\n\n# Habits\nTea at dawn.\n');
		expect(json('quests/quest_001.json')).toMatchObject({ title: 'Find the relic', hex_id: 'q0_r0', linked_hex_ids: ['q2_r1'], status: 'active', objectives: ['Reach the tower', 'Open the vault'], reward: '100 gp', gm_notes: 'Ask at [[Base Culto]].', linked_npc_ids: ['npc_001'] });
		expect(json('adventures/manifest.json')).toEqual([{ id: 'adv_001', title: 'Act One', order: 1 }]);
		expect(plan.files.get('adventures/adv_001.md')).toBe('Start at [[Base Culto#Gate]].\n');
	});

	it('the round-trip manifest fingerprints what was written', () => {
		const m = json('roundtrip.json') as { converter: number; files: { flutter: string; vault: string; fingerprint: string }[] };
		expect(m.converter).toBe(1);
		const base = m.files.find((f) => f.flutter === 'pages/hexes/Base Culto.md')!;
		expect(base.vault).toBe('Places/Base Culto.md');
		expect(base.fingerprint).toBe(fingerprint(plan.files.get('pages/hexes/Base Culto.md')!));
		expect(fingerprint('HexLore')).toBe('36d3677e');
	});
});

describe('writing the Flutter folder', () => {
	it('refuses the vault itself (but not a dot-folder in it), and relative paths', () => {
		expect(folderProblem('/home/me/vault/Exports', '/home/me/vault')).toMatch(/inside the vault/);
		expect(folderProblem('/home/me/vault', '/home/me/vault')).toMatch(/inside the vault/);
		expect(folderProblem('/home/me/vault/.hexlore/purezza', '/home/me/vault')).toBeNull();
		expect(folderProblem('/home/me/purezza (HexLore)', '/home/me/vault')).toBeNull();
		expect(folderProblem('C:\\Users\\me\\purezza', 'C:/Users/me/vault')).toBeNull();
		expect(folderProblem('purezza', '/home/me/vault')).toMatch(/full path/);
		// A drive root would have its pages/, npcs/, … swept.
		expect(folderProblem('C:\\', null)).toMatch(/root of a drive/);
		expect(folderProblem('C:', null)).toMatch(/root of a drive/);
		expect(folderProblem('/', null)).toMatch(/root of a drive/);
	});

	it('writes, and sets aside (never deletes) what an earlier export left in the folders it owns', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlore-export-'));
		const backup = `${dir} (replaced test)`;
		try {
			expect(folderState(fs, dir)).toBe('empty');
			const first = await writeFlutterCampaign(fs, dir, new Map([['roundtrip.json', '{}'], ['pages/hexes/A.md', 'a'], ['pages/hexes/B.md', 'b']]), backup);
			expect(first).toEqual({ written: 3, setAside: 0, backupDir: null });
			expect(fs.existsSync(backup)).toBe(false);
			fs.mkdirSync(`${dir}/sync`);
			fs.writeFileSync(`${dir}/sync/state.json`, 'mine');
			expect(folderState(fs, dir)).toBe('export');
			const second = await writeFlutterCampaign(fs, dir, new Map([['roundtrip.json', '{}'], ['pages/hexes/A.md', 'a2']]), backup);
			expect(second).toEqual({ written: 2, setAside: 1, backupDir: backup });
			expect(fs.readFileSync(`${dir}/pages/hexes/A.md`, 'utf8')).toBe('a2');
			expect(fs.existsSync(`${dir}/pages/hexes/B.md`)).toBe(false);
			// B was perhaps edited in HexLore since: moved aside, not lost.
			expect(fs.readFileSync(`${backup}/pages/hexes/B.md`, 'utf8')).toBe('b');
			expect(fs.readFileSync(`${dir}/sync/state.json`, 'utf8')).toBe('mine');
			fs.rmSync(`${dir}/roundtrip.json`);
			expect(folderState(fs, dir)).toBe('other');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(backup, { recursive: true, force: true });
		}
	});

	it('rides out a briefly locked rename, and gives up on a lasting one', async () => {
		let refusals = 2;
		const flaky: typeof fs = {
			...fs,
			renameSync: (a: fs.PathLike, b: fs.PathLike) => {
				if (refusals-- > 0) throw Object.assign(new Error('locked'), { code: 'EPERM' });
				fs.renameSync(a, b);
			},
		};
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexlore-export-'));
		try {
			await writeFlutterCampaign(flaky, dir, new Map([['campaign.json', '{}']]));
			expect(fs.readFileSync(`${dir}/campaign.json`, 'utf8')).toBe('{}');
			refusals = 99;
			await expect(renameRetrying(flaky, `${dir}/campaign.json`, `${dir}/x.json`)).rejects.toThrow('locked');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

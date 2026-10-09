// Port of Flutter's lib/core/npc_page.dart (the parts the converter needs):
// an NPC page is plain Markdown whose level-1 headings `# Role`,
// `# Attitude`, `# Description`, `# Secret` hold the NPC's text fields. Pure.

export const NPC_SECTIONS: readonly (readonly [field: NpcTextField, heading: string])[] = [
	['role', 'Role'],
	['attitude', 'Attitude'],
	['description', 'Description'],
	['secret', 'Secret'],
];

export type NpcTextField = 'role' | 'attitude' | 'description' | 'secret';
export type NpcText = Record<NpcTextField, string>;

const HEADING = /^#(?!#)[ \t]*(.+?)[ \t]*$/gm;
const KNOWN = new Map(NPC_SECTIONS.map(([f, h]) => [h.toLowerCase(), f]));

/** [preamble, known section bodies (trimmed), unknown [heading, body]]. */
export function parseSections(text: string): [string, Partial<NpcText>, [string, string][]] {
	const matches = [...text.matchAll(HEADING)];
	const preamble = (matches.length ? text.slice(0, matches[0]!.index) : text).trimEnd();
	const known: Partial<NpcText> = {};
	const unknown: [string, string][] = [];
	matches.forEach((m, i) => {
		const end = i + 1 < matches.length ? matches[i + 1]!.index : text.length;
		const heading = m[1]!;
		const body = text.slice(m.index + m[0].length, end).trim();
		const field = KNOWN.get(heading.toLowerCase());
		if (field && !(field in known)) known[field] = body;
		else unknown.push([heading, body]);
	});
	return [preamble, known, unknown];
}

/** The canonical page: preamble, the four sections, unknown sections. */
export function renderNpcPage(npc: NpcText, preamble = '', unknown: [string, string][] = []): string {
	const parts: string[] = [];
	if (preamble.trim()) parts.push(preamble.trimEnd());
	for (const [field, heading] of NPC_SECTIONS) {
		const body = npc[field].trim();
		parts.push(body ? `# ${heading}\n${body}` : `# ${heading}`);
	}
	for (const [heading, raw] of unknown) {
		const body = raw.trim();
		parts.push(body ? `# ${heading}\n${body}` : `# ${heading}`);
	}
	return `${parts.join('\n\n')}\n`;
}

/** [pageText] with the four known sections patched from [npc]. */
export function updatePageFromNpc(pageText: string, npc: NpcText): string {
	const [preamble, , unknown] = parseSections(pageText);
	return renderNpcPage(npc, preamble, unknown);
}

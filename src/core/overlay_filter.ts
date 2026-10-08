// Port of Flutter's lib/core/overlay_filter.dart: the Display & overlays
// panel lists threads by COLOUR group (decision 27), biggest first.

import type { Thread } from './thread';

export interface ColorGroup {
	key: string;
	count: number;
	names: string[];
}

export function threadColorGroups(threads: Iterable<Thread>): ColorGroup[] {
	const counts = new Map<string, number>();
	const names = new Map<string, Set<string>>();
	for (const t of threads) {
		const key = t.colorKey;
		counts.set(key, (counts.get(key) ?? 0) + 1);
		const name = t.color ? 'custom' : t.status === 'resolved' ? 'resolved' : t.type;
		let set = names.get(key);
		if (!set) names.set(key, (set = new Set()));
		set.add(name);
	}
	const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
	return [...counts.keys()]
		.sort((a, b) => counts.get(b)! - counts.get(a)! || cmp(a, b))
		.map((k) => ({ key: k, count: counts.get(k)!, names: [...names.get(k)!].sort(cmp) }));
}

import { describe, expect, it } from 'vitest';
import { RenameLog, linkPathOf, withLinkPath } from '../src/notes/link_renames';

describe('RenameLog', () => {
	it('follows a renamed note from a basename or a path link', () => {
		const log = new RenameLog();
		log.record('Places/Fort.md', 'Places/Old fort.md');
		expect(log.follow('Fort')).toBe('Places/Old fort.md');
		expect(log.follow('Places/Fort|the fort')).toBe('Places/Old fort.md');
		expect(log.follow('Tower')).toBeNull();
	});

	it('chains renames, and follows a renamed folder', () => {
		const log = new RenameLog();
		log.record('Places/Fort.md', 'Places/Keep.md');
		log.record('Places', 'Sites');
		log.record('Sites/Keep.md', 'Sites/Castle.md');
		expect(log.follow('Fort')).toBe('Sites/Castle.md');
		const folder = new RenameLog();
		folder.record('Campaign/Places', 'Campaign/Sites');
		expect(folder.follow('Places/Fort')).toBe('Campaign/Sites/Fort.md');
		expect(folder.follow('Campaign/Places/Fort')).toBe('Campaign/Sites/Fort.md');
	});

	it('keeps a link’s heading and alias', () => {
		expect(linkPathOf('Fort#Gate|the fort')).toBe('Fort');
		expect(withLinkPath('Fort#Gate|the fort', 'Old fort')).toBe('Old fort#Gate|the fort');
	});
});

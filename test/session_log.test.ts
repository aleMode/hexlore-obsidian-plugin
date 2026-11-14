import { describe, expect, it } from 'vitest';
import { appendToLog } from '../src/notes/session_log';

describe('the session log', () => {
	it('creates the section at the end of the note', () => {
		expect(appendToLog('# Session 4\n\nPlans.\n', ['- 20:15 · Rolled'])).toBe('# Session 4\n\nPlans.\n\n## Session log\n\n- 20:15 · Rolled\n');
		expect(appendToLog('', ['- a'])).toBe('## Session log\n\n- a\n');
	});

	it('appends at the end of the section, before the next heading', () => {
		const note = '# S\n\n## Session log\n\n- 20:00 · first\n\n## After\n\ntext\n';
		expect(appendToLog(note, ['- 20:05 · second', '    - detail'])).toBe('# S\n\n## Session log\n\n- 20:00 · first\n- 20:05 · second\n    - detail\n\n## After\n\ntext\n');
	});

	it('keeps sub-headings inside the section, and finds an empty section', () => {
		const note = '## Session log\n### Day 1\n- a\n';
		expect(appendToLog(note, ['- b'])).toBe('## Session log\n### Day 1\n- a\n- b\n');
		expect(appendToLog('## Session log\n\n## Next\n', ['- a'])).toBe('## Session log\n\n- a\n\n## Next\n');
	});
});

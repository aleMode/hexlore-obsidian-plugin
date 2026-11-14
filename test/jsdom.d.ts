// jsdom ships no types and @types/jsdom is not installed: what the tests use.
declare module 'jsdom' {
	export class JSDOM {
		constructor(
			html?: string,
			options?: {
				runScripts?: 'dangerously' | 'outside-only';
				pretendToBeVisual?: boolean;
				url?: string;
				beforeParse?: (window: Window & typeof globalThis) => void;
			},
		);
		readonly window: Window & typeof globalThis;
	}
}

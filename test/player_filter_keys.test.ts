import { describe, expect, it } from 'vitest';
import { filterCampaignForPlayer } from '../src/core/player_filter';
import { fixtureMap } from './helpers/fixture_map';

// An ALLOW-LIST, not a deny-list: a key added to a served hex must be added
// here on purpose. `tags` once rode along unseen (player.js never drew them)
// and gave hidden features away. Same test as Flutter's filter_test.dart.
describe('the player payload', () => {
	it('carries exactly the keys the player map draws', () => {
		const m = fixtureMap();
		m.revealed.add('q1_r0'); // the hidden well, tagged 'oasis'
		const payload = filterCampaignForPlayer(m);
		expect(Object.keys(payload).sort()).toEqual(['campaign_name', 'grid', 'hexes', 'rivers', 'routes']);
		const hexes = payload.hexes as Record<string, unknown>[];
		expect(hexes.length).toBe(2);
		for (const h of hexes) {
			expect(Object.keys(h).sort()).toEqual(
				['color', 'display_id', 'feature', 'feature_variant', 'id', 'name', 'q', 'r', 'terrain', 'terrain_variant'],
			);
		}
		expect(JSON.stringify(payload)).not.toContain('oasis');
	});
});

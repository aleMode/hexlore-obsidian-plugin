// Port of Flutter's lib/core/travel_votes.dart (decision 17): party travel
// votes, "where does the group go next?". Each player holds ONE standing
// vote; casting again replaces it. SESSION state, not campaign data: it
// lives in the running player server and dies with it, nothing touches the
// vault, and the map payload is untouched (votes have their own endpoint).

/** Hard caps: the endpoint is reachable by anyone on the GM's LAN. */
export const MAX_VOTERS = 64;
export const MAX_VOTER_NAME_LENGTH = 24;
export const MAX_VOTER_ID_LENGTH = 64;

/** A display name trimmed to something safe to render, or null if blank.
 *  Whitespace is collapsed so a name can't smuggle in layout. */
export function sanitizeVoterName(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const name = raw.replace(/\s+/g, ' ').trim();
	if (!name) return null;
	return name.length <= MAX_VOTER_NAME_LENGTH ? name : name.slice(0, MAX_VOTER_NAME_LENGTH);
}

export interface TravelVote {
	/** Opaque, client-generated: never shown to anyone. */
	voterId: string;
	voterName: string;
	/** Canonical hex id. */
	hexId: string;
	at: number;
}

export interface HexVotes {
	hexId: string;
	/** In the order the votes were cast. */
	voterNames: string[];
	/** When this hex first drew a vote: the tiebreak for equal counts. */
	firstAt: number;
}

export class VoteTally {
	private readonly byVoter = new Map<string, TravelVote>();

	get voterCount(): number {
		return this.byVoter.size;
	}

	get isEmpty(): boolean {
		return this.byVoter.size === 0;
	}

	voteOf(voterId: string): TravelVote | undefined {
		return this.byVoter.get(voterId);
	}

	/** Record [voterId]'s vote, replacing an earlier one. False (and nothing
	 *  changes) for an unusable id, or a NEW voter when the tally is full —
	 *  an existing voter can always change their mind. */
	cast(voterId: string, hexId: string, voterName?: unknown, at = Date.now()): boolean {
		if (!voterId || voterId.length > MAX_VOTER_ID_LENGTH || !hexId) return false;
		const known = this.byVoter.get(voterId);
		if (!known && this.byVoter.size >= MAX_VOTERS) return false;
		this.byVoter.set(voterId, {
			voterId,
			voterName: sanitizeVoterName(voterName) ?? known?.voterName ?? 'Player',
			hexId,
			at,
		});
		return true;
	}

	/** Withdraw [voterId]'s vote. True if there was one. */
	clearVoter(voterId: string): boolean {
		return this.byVoter.delete(voterId);
	}

	clear(): void {
		this.byVoter.clear();
	}

	/** Per hex, most-voted first; ties by which hex drew its first vote
	 *  earlier, then by id. */
	results(): HexVotes[] {
		const grouped = new Map<string, TravelVote[]>();
		for (const v of this.byVoter.values()) {
			let list = grouped.get(v.hexId);
			if (!list) grouped.set(v.hexId, (list = []));
			list.push(v);
		}
		const out: HexVotes[] = [];
		for (const [hexId, votes] of grouped) {
			votes.sort((a, b) => a.at - b.at);
			out.push({ hexId, voterNames: votes.map((v) => v.voterName), firstAt: votes[0]!.at });
		}
		out.sort((a, b) => b.voterNames.length - a.voterNames.length || a.firstAt - b.firstAt || (a.hexId < b.hexId ? -1 : a.hexId > b.hexId ? 1 : 0));
		return out;
	}

	/** Hex id → vote count, for the GM map's badges. */
	counts(): Map<string, number> {
		const out = new Map<string, number>();
		for (const v of this.byVoter.values()) out.set(v.hexId, (out.get(v.hexId) ?? 0) + 1);
		return out;
	}

	/** What the player panel and the GM read. Voter ids are never emitted;
	 *  [forVoter] adds `your_hex` so a reloaded page recovers its pick. */
	toJson(forVoter?: string | null): Record<string, unknown> {
		const out: Record<string, unknown> = {
			voters: this.voterCount,
			tally: this.results().map((r) => ({ hex: r.hexId, count: r.voterNames.length, names: r.voterNames })),
		};
		if (forVoter !== undefined && forVoter !== null) out.your_hex = this.byVoter.get(forVoter)?.hexId ?? null;
		return out;
	}
}

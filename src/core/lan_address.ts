// Which of this machine's IPv4 addresses to put in the player link (Flutter's
// lib/core/lan_address.dart, mirrored; its test cases are shared).
//
// "The first non-internal interface" is wrong on a typical GM laptop: the OS
// lists a VPN (Tailscale's 100.64/10, WireGuard) or a virtual switch
// (Hyper-V's `vEthernet`, WSL, Docker, VirtualBox) ahead of the Wi-Fi, and
// players on the table's network get a link they cannot open.

const VIRTUAL_NAME =
	/tailscale|zerotier|wireguard|\bwg\d|vpn|vethernet|hyper-v|wsl|virtualbox|vbox|vmware|vmnet|docker|\bbr-|utun|\btun|\btap|hamachi|loopback/i;
const PHYSICAL_NAME = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d/i;

function octets(address: string): number[] | null {
	const parts = address.split('.');
	if (parts.length !== 4) return null;
	const out = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
	return out.some((o) => o < 0 || o > 255) ? null : out;
}

/** How good [address] on interface [name] is as the player link; null when
 *  it can never be (loopback, link-local, not IPv4). */
export function lanAddressScore(name: string, address: string): number | null {
	const o = octets(address);
	if (!o || o[0] === 127 || (o[0] === 169 && o[1] === 254)) return null;
	const a = o[0]!,
		b = o[1]!;
	const isPrivate = a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
	const cgnat = a === 100 && b >= 64 && b <= 127; // Tailscale et al.
	let score = isPrivate ? 3 : cgnat ? 0 : 1;
	if (VIRTUAL_NAME.test(name)) score -= 2;
	if (PHYSICAL_NAME.test(name)) score += 1;
	return score;
}

/** The best address among [candidates] ([interface name, IPv4 address], in
 *  the OS's order, which breaks ties), or null when none qualifies. */
export function pickLanAddress(candidates: readonly (readonly [string, string])[]): string | null {
	let best: string | null = null;
	let bestScore: number | null = null;
	for (const [name, address] of candidates) {
		const score = lanAddressScore(name, address);
		if (score === null) continue;
		if (bestScore === null || score > bestScore) {
			best = address;
			bestScore = score;
		}
	}
	return best;
}

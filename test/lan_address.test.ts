import { describe, expect, it } from 'vitest';
import { pickLanAddress } from '../src/core/lan_address';

// The same cases as Flutter's test/lan_address_test.dart (real machines'
// interface lists, in the order the OS gives them).
describe('the player link address', () => {
	it('picks the Wi-Fi over Tailscale and Hyper-V listed before it', () => {
		expect(pickLanAddress([['Tailscale', '100.64.0.7'], ['Wi-Fi', '192.168.1.20'], ['vEthernet (Default Switch)', '172.23.128.1']])).toBe('192.168.1.20');
	});
	it('picks a wired adapter on 10/8 over docker and WSL bridges', () => {
		expect(pickLanAddress([['docker0', '172.17.0.1'], ['vEthernet (WSL)', '172.29.16.1'], ['eth0', '10.0.0.12']])).toBe('10.0.0.12');
	});
	it('picks en0 over a utun VPN on macOS', () => {
		expect(pickLanAddress([['utun3', '10.8.0.2'], ['en0', '192.168.1.20']])).toBe('192.168.1.20');
	});
	it('takes a lone VPN address rather than nothing', () => {
		expect(pickLanAddress([['Tailscale', '100.64.0.7']])).toBe('100.64.0.7');
	});
	it('never takes loopback, link-local or non-IPv4', () => {
		expect(pickLanAddress([['lo', '127.0.0.1'], ['Ethernet 2', '169.254.10.3'], ['Wi-Fi', 'fe80::1']])).toBeNull();
	});
	it('keeps the OS order on a tie', () => {
		expect(pickLanAddress([['Ethernet', '192.168.1.5'], ['Wi-Fi', '192.168.1.6']])).toBe('192.168.1.5');
	});
});

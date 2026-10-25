//! CIDR lists and client-IP resolution.
//!
//! The client IP is the TCP peer address, unless the peer is itself inside the trusted-proxy list
//! (`RECON_TRUSTED_PROXY_CIDRS`). Only then is `X-Forwarded-For` read, and only its right-most entry that is not
//! itself a trusted proxy counts (entries further left are attacker-controlled). From any other peer the header is
//! ignored completely, so a client cannot choose its own address.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::str::FromStr;

/// The address the request's limits and allowlists apply to; `None` when the transport gave no peer address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientIp(pub Option<IpAddr>);

/// An IPv4 or IPv6 network (`10.0.0.0/8`, `::1/128`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    network: IpAddr,
    prefix: u8,
}

fn mask_v4(prefix: u8) -> u32 {
    u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0)
}

fn mask_v6(prefix: u8) -> u128 {
    u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0)
}

impl Cidr {
    /// Whether `ip` lies in this network. Address families never match each other; IPv4-mapped IPv6 addresses
    /// are first reduced to IPv4.
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.network, ip.to_canonical()) {
            (IpAddr::V4(n), IpAddr::V4(a)) => u32::from(n) == u32::from(a) & mask_v4(self.prefix),
            (IpAddr::V6(n), IpAddr::V6(a)) => u128::from(n) == u128::from(a) & mask_v6(self.prefix),
            _ => false,
        }
    }
}

impl FromStr for Cidr {
    type Err = String;

    /// `addr/prefix`; the prefix is mandatory (`10.0.0.1` alone is rejected so a typo cannot widen access).
    fn from_str(s: &str) -> Result<Self, String> {
        let bad = || format!("`{s}` is not a CIDR such as 10.0.0.0/8 or ::1/128");
        let (addr, prefix) = s.split_once('/').ok_or_else(bad)?;
        let addr: IpAddr = addr.parse().map_err(|_| bad())?;
        let prefix: u8 = prefix.parse().map_err(|_| bad())?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        if prefix > max {
            return Err(bad());
        }
        let network = match addr {
            IpAddr::V4(a) => IpAddr::V4(Ipv4Addr::from(u32::from(a) & mask_v4(prefix))),
            IpAddr::V6(a) => IpAddr::V6(Ipv6Addr::from(u128::from(a) & mask_v6(prefix))),
        };
        Ok(Self { network, prefix })
    }
}

/// Parse a comma-separated CIDR list. Empty input gives an empty list; an empty element is an error.
pub fn parse_cidr_list(s: &str) -> Result<Vec<Cidr>, String> {
    if s.trim().is_empty() {
        return Ok(Vec::new());
    }
    s.split(',').map(|p| p.trim().parse()).collect()
}

/// Whether `ip` is inside any of `list`.
pub fn in_any(list: &[Cidr], ip: IpAddr) -> bool {
    list.iter().any(|c| c.contains(ip))
}

/// Resolve the client address. `xff` holds the values of every `X-Forwarded-For` header, in order.
pub fn resolve_client_ip(
    peer: Option<SocketAddr>,
    xff: &[&str],
    trusted_proxies: &[Cidr],
) -> Option<IpAddr> {
    let peer = peer?.ip().to_canonical();
    if !in_any(trusted_proxies, peer) {
        return Some(peer);
    }
    let hops: Vec<&str> = xff.iter().flat_map(|v| v.split(',')).map(str::trim).collect();
    let mut leftmost = None;
    for hop in hops.iter().rev() {
        // An entry we cannot parse is not evidence of a client: fall back to the proxy's own address.
        let Some(ip) = parse_hop(hop) else {
            return Some(peer);
        };
        if !in_any(trusted_proxies, ip) {
            return Some(ip);
        }
        leftmost = Some(ip);
    }
    // No header, or every hop is a trusted proxy: the left-most hop is the origin of the chain.
    Some(leftmost.unwrap_or(peer))
}

fn parse_hop(s: &str) -> Option<IpAddr> {
    s.parse::<IpAddr>()
        .or_else(|_| s.parse::<SocketAddr>().map(|a| a.ip()))
        .ok()
        .map(|ip| ip.to_canonical())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }
    fn sock(s: &str) -> Option<SocketAddr> {
        Some(format!("{s}:4000").parse().unwrap_or_else(|_| format!("[{s}]:4000").parse().unwrap()))
    }
    fn cidrs(s: &str) -> Vec<Cidr> {
        parse_cidr_list(s).unwrap()
    }

    #[test]
    fn cidr_membership_v4_and_v6() {
        let c = cidrs("10.1.0.0/16,192.168.5.7/32,::1/128,2001:db8::/32");
        assert!(in_any(&c, ip("10.1.200.9")));
        assert!(!in_any(&c, ip("10.2.0.1")));
        assert!(in_any(&c, ip("192.168.5.7")));
        assert!(!in_any(&c, ip("192.168.5.8")));
        assert!(in_any(&c, ip("::1")));
        assert!(in_any(&c, ip("2001:db8:ffff::1")));
        assert!(!in_any(&c, ip("2001:db9::1")));
        // a v4-mapped peer (dual-stack socket) is judged as the v4 address
        assert!(in_any(&c, ip("::ffff:10.1.0.4")));
        assert!(!in_any(&cidrs("::1/128"), ip("127.0.0.1")));
    }

    #[test]
    fn prefix_zero_matches_the_whole_family_and_masks_apply() {
        assert!(in_any(&cidrs("0.0.0.0/0"), ip("203.0.113.9")));
        assert!(!in_any(&cidrs("0.0.0.0/0"), ip("::1")));
        assert!(in_any(&cidrs("10.1.2.3/8"), ip("10.200.0.1"))); // host bits in the config are ignored
    }

    #[test]
    fn malformed_lists_are_rejected() {
        for bad in ["10.0.0.1", "10.0.0.0/33", "::/129", "x/8", "10.0.0.0/8,", ",10.0.0.0/8", "10.0.0.0/-1"] {
            assert!(parse_cidr_list(bad).is_err(), "{bad}");
        }
        assert!(parse_cidr_list("").unwrap().is_empty());
        assert!(parse_cidr_list("  ").unwrap().is_empty());
    }

    #[test]
    fn untrusted_peer_cannot_choose_its_address() {
        let trusted = cidrs("10.0.0.0/8");
        assert_eq!(
            resolve_client_ip(sock("203.0.113.9"), &["127.0.0.1"], &trusted),
            Some(ip("203.0.113.9"))
        );
        assert_eq!(resolve_client_ip(sock("203.0.113.9"), &[], &[]), Some(ip("203.0.113.9")));
    }

    #[test]
    fn trusted_proxy_yields_the_rightmost_untrusted_hop() {
        let trusted = cidrs("10.0.0.0/8");
        // the client prepended a fake hop; the proxy appended the real one
        assert_eq!(
            resolve_client_ip(sock("10.0.0.5"), &["1.1.1.1, 198.51.100.7, 10.0.0.9"], &trusted),
            Some(ip("198.51.100.7"))
        );
        // several header lines count as one list
        assert_eq!(
            resolve_client_ip(sock("10.0.0.5"), &["1.1.1.1", "198.51.100.7"], &trusted),
            Some(ip("198.51.100.7"))
        );
        assert_eq!(
            resolve_client_ip(sock("10.0.0.5"), &["198.51.100.7:5555"], &trusted),
            Some(ip("198.51.100.7"))
        );
        assert_eq!(resolve_client_ip(sock("10.0.0.5"), &[], &trusted), Some(ip("10.0.0.5")));
        assert_eq!(
            resolve_client_ip(sock("10.0.0.5"), &["10.0.0.7, 10.0.0.6"], &trusted),
            Some(ip("10.0.0.7"))
        );
    }

    #[test]
    fn garbage_in_the_forwarded_chain_falls_back_to_the_proxy() {
        let trusted = cidrs("10.0.0.0/8");
        assert_eq!(
            resolve_client_ip(sock("10.0.0.5"), &["198.51.100.7, not-an-ip"], &trusted),
            Some(ip("10.0.0.5"))
        );
    }

    #[test]
    fn no_peer_means_no_address() {
        assert_eq!(resolve_client_ip(None, &["1.2.3.4"], &[]), None);
    }
}

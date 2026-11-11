import ipaddress
import re

import psutil

# Windows machines tend to carry several virtual adapters (WSL, Hyper-V, VirtualBox,
# Docker) whose addresses a phone on the Wi-Fi can't reach.
_VIRTUAL = re.compile(r"vethernet|wsl|virtualbox|vmware|docker|hyper-v|loopback|tailscale|zerotier|utun|bridge", re.I)


def lan_addresses() -> list[str]:
    """IPv4 addresses of this machine a phone on the LAN might open, best guess first."""
    candidates: list[tuple[int, str]] = []
    for name, entries in psutil.net_if_addrs().items():
        for entry in entries:
            if entry.family.name != "AF_INET":
                continue
            address = entry.address
            if ipaddress.ip_address(address).is_loopback:
                continue
            candidates.append((score_address(name, address), address))
    candidates.sort(key=lambda c: -c[0])
    return list(dict.fromkeys(address for _, address in candidates))


def score_address(interface: str, address: str) -> int:
    score = 0 if _VIRTUAL.search(interface) else 10
    if address.startswith("192.168."):
        score += 3
    elif address.startswith("10."):
        score += 2
    elif re.match(r"^172\.(1[6-9]|2\d|3[01])\.", address):
        score += 1
    elif address.startswith("169.254."):
        score -= 10
    return score

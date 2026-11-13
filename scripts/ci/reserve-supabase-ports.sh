#!/usr/bin/env bash
# Reserve the host ports in a Supabase config.toml so the kernel never hands
# them out as ephemeral ports. They sit inside Linux's default ephemeral range
# (32768-60999): an outbound connection, such as an image pull during
# `supabase start`, can take one, and publishing it then fails with "address
# already in use". Prints the reserved ports. Run as root.
#
#   sudo bash scripts/ci/reserve-supabase-ports.sh supabase/config.toml
set -euo pipefail

ports="$(sed -nE 's/^[[:space:]]*[a-z_]*port[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' "$1" | sort -n)"
reserved="$(sysctl -n net.ipv4.ip_local_reserved_ports)"
sysctl -qw net.ipv4.ip_local_reserved_ports="${reserved:+$reserved,}$(paste -sd, - <<<"$ports")"
printf '%s\n' $ports

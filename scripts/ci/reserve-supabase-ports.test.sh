#!/usr/bin/env bash
# Every host port in supabase/config.toml is reserved: with the ephemeral range
# narrowed to that one port, an outbound connection is never given it. Runs in
# its own network namespace, so the host's settings are untouched. Needs sudo.
#
#   bash scripts/ci/reserve-supabase-ports.test.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "${IN_NETNS:-}" != 1 ]; then
    exec sudo unshare -n env IN_NETNS=1 bash "$0"
fi

ip link set lo up
ports="$(bash scripts/ci/reserve-supabase-ports.sh supabase/config.toml)"

python3 -I - $ports <<'EOF'
import errno, socket, sys

ports = [int(p) for p in sys.argv[1:]]
if not ports:
    sys.exit("no ports read from supabase/config.toml")

server = socket.socket()
server.bind(("127.0.0.1", 0))
server.listen()

handed_out = []
for port in ports:
    with open("/proc/sys/net/ipv4/ip_local_port_range", "w") as f:
        f.write(f"{port} {port}")
    client = socket.socket()
    try:
        client.connect(server.getsockname())
        handed_out.append(client.getsockname()[1])
    except OSError as e:
        if e.errno != errno.EADDRNOTAVAIL:
            raise
    finally:
        client.close()

if handed_out:
    sys.exit(f"FAIL: handed out as ephemeral ports: {handed_out}")
print(f"ok: {len(ports)} ports reserved: {ports}")
EOF

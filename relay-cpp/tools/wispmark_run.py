#!/usr/bin/env python3
"""WispMark's method without its harness (no sudo on the host, no kill-by-port): one Docker container
(6 CPUs, loopback only), tokio's echo-tcp on 6002, each server on 6001, wispmark's clients (wisp-js
client.mjs; epoxy-tls simple-wisp-client -s 10 -p 50) with 10 streams per WebSocket, 1 or 5 WebSockets.
Bandwidth = iftop's cumulative bytes on port 6002 over the test (both directions, as wispmark counts).
Also server CPU (utime+stime) and peak RSS (VmHWM). Median of --reps runs of --duration seconds.
The Mac's 1-minute load is recorded per cell; cells measured at load >= 8 are marked noisy.

  python3 -I tools/wispmark_run.py --wm DIR --pkgs DIR [--reps 3] [--duration 8] [--only a,b]

DIR (wm) holds the built tools (epoxy-tls, tokio, client/js, server/js with node_modules);
pkgs is a copy of packages/ with wisp-cpp built for Linux in build-linux/.
"""
import argparse, json, os, re, signal, statistics, subprocess, sys, time

IMG = 'wispmark-iso'
NAME = 'wispmark-run'


def wait_load(limit=15.0):
    """Benchmark cells start only while the Mac's 1-minute load is under `limit` (cells >= 8 are marked noisy)."""
    while os.getloadavg()[0] >= limit:
        time.sleep(5)


signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # so `finally` removes the containers

# wisp-cpp budgets descriptors and pool shares per connection (AUDIT A-4/A-8), so it gets a
# realistic connection cap (the benchmark opens at most 5 WebSockets) instead of 100000
RELAX_NODE = ("--bind 127.0.0.1 --port 6001 --origin '*' --host-allow 127.0.0.1 --port-allow 6002 --allow-private --no-block-local "
              "--max-kbps 0 --max-streams 1024 --max-connects-per-minute 100000 --max-conns-per-ip 100000 --max-connections 100000 "
              "--scan-hosts-per-minute 100000 --scan-failures-per-minute 100000 --max-concurrent-lookups 1000 --log 0")
SERVERS = {
    'wisp-js': 'cd /wm/server/js && exec node server.mjs 6001',
    '@rvwasm/wisp': 'mkdir -p /pk/node_modules/@rvwasm && ln -sfn ../../relay-guard /pk/node_modules/@rvwasm/relay-guard; '
                    f'exec node /pk/wisp/bin/rvwasm-wisp-server.js {RELAX_NODE}',
    'epoxy (single)': 'cd /tmp && printf \'[server]\\nbind = ["tcp", "127.0.0.1:6001"]\\nruntime = "singlethread"\\n\' > es.toml && exec /wm/epoxy-tls/target/release/epoxy-server es.toml',
    'epoxy (multi)': 'cd /tmp && printf \'[server]\\nbind = ["tcp", "127.0.0.1:6001"]\\nruntime = "multithread"\\n\' > em.toml && exec /wm/epoxy-tls/target/release/epoxy-server em.toml',
    'wisp-cpp 1t': f'exec /pk/wisp-cpp/build-linux/wisp-server --threads 1 {RELAX_NODE} --max-connections 64 --max-handshakes 64',
    'wisp-cpp 2t': f'exec /pk/wisp-cpp/build-linux/wisp-server --threads 2 {RELAX_NODE} --max-connections 64 --max-handshakes 64',
}
CLIENTS = [
    ('wisp-js (10)', 'js', 1), ('wisp-js (5x10)', 'js', 5), ('wisp-mux (10)', 'mux', 1), ('wisp-mux (5x10)', 'mux', 5),
]


def dex(cmd, timeout=120, detach=False):
    args = ['docker', 'exec'] + (['-d'] if detach else []) + [NAME, 'bash', '-c', cmd]
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


PATTERN = {'wisp-js': 'node server.mjs', '@rvwasm/wisp': 'rvwasm-wisp-server', 'epoxy (single)': 'epoxy-server', 'epoxy (multi)': 'epoxy-server',
           'wisp-cpp 1t': 'build-linux/wisp-server', 'wisp-cpp 2t': 'build-linux/wisp-server'}


def server_pid(sname):
    out = dex(f'pgrep -n -f "{PATTERN[sname]}"').stdout.split()
    return out[0] if out else None


def stats(pid):
    o = dex(f'cat /proc/{pid}/stat | cut -d" " -f14,15; grep VmHWM /proc/{pid}/status; getconf CLK_TCK').stdout.split()
    try:
        return (int(o[0]) + int(o[1])) / int(o[-1]), int(o[3])
    except Exception:
        return None, None


def wait_port(port, t=10):
    end = time.time() + t
    while time.time() < end:
        if dex(f'exec 3<>/dev/tcp/127.0.0.1/{port} && echo up', timeout=5).stdout.strip() == 'up':
            return True
        time.sleep(0.3)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--wm', required=True)
    ap.add_argument('--pkgs', required=True)
    ap.add_argument('--reps', type=int, default=3)
    ap.add_argument('--duration', type=int, default=8)
    ap.add_argument('--only', default='')
    ap.add_argument('--out', default='wispmark.json')
    a = ap.parse_args()
    subprocess.run(['docker', 'rm', '-f', NAME], capture_output=True)
    subprocess.run(['docker', 'run', '-d', '--name', NAME, '--cpus', '6', '--network', 'none', '--cap-add', 'NET_RAW', '--cap-add', 'NET_ADMIN',
                    '--security-opt', 'seccomp=unconfined', '-v', f'{a.wm}:/wm', '-v', f'{a.pkgs}:/pk', IMG, 'sleep', 'infinity'], check=True, capture_output=True)
    results = {}
    try:
        dex('(nohup /wm/tokio/target/release/examples/echo-tcp 127.0.0.1:6002 > /tmp/echo.log 2>&1 &)')
        assert wait_port(6002), 'echo did not start'
        for sname, scmd in SERVERS.items():
            if a.only and sname not in a.only.split(','):
                continue
            results[sname] = {}
            for cname, kind, inst in CLIENTS:
                for rep in range(a.reps):
                    wait_load()
                    load0 = os.getloadavg()[0]
                    dex('pkill -f "server.mjs|rvwasm-wisp-server|epoxy-server|wisp-server|client.mjs|simple-wisp-client"; sleep 0.5')
                    subprocess.run(['docker', 'exec', '-i', NAME, 'bash', '-c', 'cat > /tmp/s.sh'], input=scmd, text=True, check=True)
                    dex('(nohup bash /tmp/s.sh > /tmp/server.log 2>&1 &)')
                    if not wait_port(6001):
                        results[sname].setdefault(cname, []).append({'err': 'server did not start: ' + dex('tail -3 /tmp/server.log').stdout})
                        continue
                    pid = server_pid(sname)
                    for _ in range(inst):
                        if kind == 'js':
                            dex('cd /wm/client/js && (nohup node client.mjs 6001 6002 10 > /dev/null 2>&1 &)')
                        else:
                            dex('cd /wm/epoxy-tls/simple-wisp-client && (nohup /wm/epoxy-tls/target/release/simple-wisp-client -w ws://127.0.0.1:6001/ '
                                '-t 127.0.0.1:6002 -s 10 -p 50 > /tmp/client.log 2>&1 &)')
                    time.sleep(1)
                    load = max(load0, os.getloadavg()[0])
                    c0, _ = stats(pid) if pid else (None, None)
                    # iftop sometimes printed nothing under heavy host load (7 empty cells on 2026-10-23,
                    # all on servers that relayed fine when re-checked): one retry, and keep its stderr
                    for attempt in range(2):
                        c0, _ = stats(pid) if pid else (None, None)
                        it = dex(f'timeout {a.duration * 2} iftop -i lo -f "port 6002" -t -s {a.duration} -B', timeout=a.duration * 3)
                        out = it.stdout
                        if re.search(r'Cumulative', out):
                            break
                    c1, hwm = stats(pid) if pid else (None, None)
                    m = re.findall(r'Cumulative.+?:.+?([\d.]+)([A-Z]+)\n', out)
                    mult = {'B': 1, 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3}
                    r = {'load': round(max(load, os.getloadavg()[0]), 1)}
                    if m:
                        amount, unit = m[0]
                        total = float(amount) * mult.get(unit, 1)
                        r['mibps'] = round(total / a.duration / 1024 ** 2, 1)
                        if c0 is not None and c1 is not None and total:
                            r['cpu_s_per_gib'] = round((c1 - c0) / (total / 1024 ** 3), 3)
                            r['cores'] = round((c1 - c0) / (a.duration + 0.0), 2)
                        r['rss_mib'] = round(hwm / 1024, 1) if hwm else None
                    else:
                        r['err'] = 'no iftop total: ' + out[-200:] + ' | client: ' + dex('tail -c 300 /tmp/client.log; tail -c 300 /tmp/server.log').stdout
                    alive = dex(f'kill -0 {pid} && echo y').stdout.strip() == 'y' if pid else False
                    r['server_alive'] = alive
                    results[sname].setdefault(cname, []).append(r)
                    print(f'{sname:15} {cname:16} rep{rep} {json.dumps(r)}', flush=True)
        with open(a.out, 'w') as f:
            json.dump(results, f, indent=1)
        print('\nmedian of', a.reps, '(MiB/s, both directions; ratio to epoxy single; server s/GiB; cores; peak RSS MiB)')
        ref = {}
        for cname, _, _ in CLIENTS:
            rs = [r['mibps'] for r in results.get('epoxy (single)', {}).get(cname, []) if r.get('mibps')]
            if rs:
                ref[cname] = statistics.median(rs)
        for sname, cells in results.items():
            row = [sname]
            for cname, _, _ in CLIENTS:
                rs = [r for r in cells.get(cname, []) if r.get('mibps')]
                if not rs:
                    row.append('-'); continue
                med = lambda k: statistics.median([r.get(k) or 0 for r in rs])
                ratio = f" ({med('mibps') / ref[cname]:.2f}x)" if ref.get(cname) else ''
                noisy = ' noisy' if any(r['load'] >= 8 for r in rs) else ''
                row.append(f"{med('mibps'):.0f}{ratio} {med('cpu_s_per_gib'):.2f} s/GiB {med('cores'):.2f}c {med('rss_mib'):.0f}M{noisy}")
            print(' | '.join(row))
    finally:
        subprocess.run(['docker', 'rm', '-f', NAME], capture_output=True)


if __name__ == '__main__':
    main()

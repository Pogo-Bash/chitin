#!/usr/bin/env python3
"""Linux benchmarks in containers (OrbStack/Docker on the Mac): the server in its own container with a
CPU and memory budget (like the 2-vCPU VPS, or 1 CPU / 16 MiB), the load generator and the sites in a
second container, both on an internal network (no internet). Reports MiB/s, requests/s, streams/s,
p50/p99, server cores used, server peak RSS.

  python3 -I tools/bench_linux.py --src DIR [--reps 3] [--duration 8]

DIR is a copy of packages/ (wisp-cpp built inside the container on first use).
"""
import argparse, json, os, signal, statistics, subprocess, sys, time

IMG = 'wispmark-iso'
NET = 'wispbench-internal'


def wait_load(limit=15.0):
    """Benchmark cells start only while the Mac's 1-minute load is under `limit` (cells >= 8 are marked noisy)."""
    while os.getloadavg()[0] >= limit:
        time.sleep(5)


signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # so `finally` removes the containers


def sh(*a, check=True, capture=True):
    r = subprocess.run(list(a), capture_output=capture, text=True)
    if check and r.returncode:
        raise RuntimeError(f'{a}: {r.stderr[-400:]}')
    return r.stdout.strip() if capture else ''


def dex(name, cmd, timeout=120):
    return subprocess.run(['docker', 'exec', name, 'bash', '-c', cmd], capture_output=True, text=True, timeout=timeout)


def server_stats(name):
    # utime+stime of the server process (pid 1's child) in clock ticks, and its peak RSS
    out = dex(name, 'p=$(pgrep -f "wisp-server|rvwasm-wisp" | head -1); cat /proc/$p/stat | cut -d" " -f14,15; grep VmHWM /proc/$p/status; getconf CLK_TCK').stdout.split()
    try:
        ticks = int(out[0]) + int(out[1]); hwm_kib = int(out[3]); hz = int(out[-1])
        return ticks / hz, hwm_kib
    except Exception:
        return None, None


SERVERS = {
    # name: (container limits, command)
    'cpp-1t-epoll': (['--cpus', '2', '--memory', '1g'], 'build/wisp-server --threads 1'),
    'cpp-2t-epoll': (['--cpus', '2', '--memory', '1g'], 'build/wisp-server --threads 2'),
    'cpp-2t-uring': (['--cpus', '2', '--memory', '1g'], 'build-uring/wisp-server --threads 2 --io-uring'),
    'node': (['--cpus', '2', '--memory', '1g'], 'node ../wisp/bin/rvwasm-wisp-server.js'),
    'cpp-1cpu-16m': (['--cpus', '1', '--memory', '16m', '--memory-swap', '16m'], 'build/wisp-server --threads 1 --pool-mib 8 --max-connections 4 --max-handshakes 32'),
}
RELAX = ("--bind 0.0.0.0 --port 8101 --origin '*' --host-allow '*' --port-allow 6002,6003,6004,"
         + ','.join(str(p) for p in range(6012, 6028)) +
         " --allow-private --no-block-local --max-kbps 0 --max-streams 1024 --max-connects-per-minute 1000000"
         " --max-conns-per-ip 100000 --scan-hosts-per-minute 4096 --scan-failures-per-minute 1000000 --max-concurrent-lookups 1000 --log 0")
RELAX_NODE_EXTRA = ' --max-connections 100000'
# production rules: every limit at its default (bandwidth 8 MiB/s per WebSocket, stream/connect/scan/IP caps,
# timeouts, byte caps); only what the bench network needs: its private addresses and ports
PROD = ("--bind 0.0.0.0 --port 8101 --origin '*' --host-allow '*' --port-allow 6002,6003,6004,"
        + ','.join(str(p) for p in range(6012, 6028)) + " --allow-private --log 0")
CASES = [
    ('down 10x10 16KiB', '--target 6004 --conns 10 --streams 10 --size 16384 --mode down'),
    ('up 1x1 16KiB', '--target 6003 --conns 1 --streams 1 --size 16384 --mode up'),
    ('echo 1x10 16KiB', '--target 6002 --conns 1 --streams 10 --size 16384'),
    ('rr 10x10 64B', '--target 6002 --conns 10 --streams 10 --size 64 --latency'),
    ('churn 10x10', '--target 6012 --spread 16 --conns 10 --parallel 10 --size 64 --mode streams'),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--reps', type=int, default=3)
    ap.add_argument('--duration', type=float, default=8)
    ap.add_argument('--only', default='')
    ap.add_argument('--rules', choices=['relaxed', 'prod'], default='relaxed')
    a = ap.parse_args()
    subprocess.run(['docker', 'network', 'create', '--internal', NET], capture_output=True)
    client = 'wispbench-client'
    subprocess.run(['docker', 'rm', '-f', client], capture_output=True)
    sysctl = ['--sysctl', 'net.ipv4.tcp_tw_reuse=1', '--sysctl', 'net.ipv4.ip_local_port_range=1024 65535']
    sh('docker', 'run', '-d', '--name', client, '--network', NET, '--cpus', '6', *sysctl, '-v', f'{a.src}:/work', IMG, 'sleep', 'infinity')
    results = {}
    try:
        # build once (both backends), then start the sites
        b = dex(client, 'cd /work/wisp-cpp && nice -n 15 make -j4 CXX=g++ build/wisp-server build/wisp-bench >/dev/null 2>&1 && '
                        'nice -n 15 make -j4 CXX=g++ IO_URING=1 BUILD=build-uring build-uring/wisp-server >/dev/null 2>&1; echo built $?', timeout=900)
        print(b.stdout.strip(), b.stderr[-300:], flush=True)
        dex(client, 'cd /work/wisp-cpp && (nohup build/wisp-bench echo --port 6002 --dest 0.0.0.0 > /tmp/echo.log 2>&1 &)')
        cip = sh('docker', 'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', client)
        for name, (limits, cmd) in SERVERS.items():
            if a.only and name not in a.only.split(','):
                continue
            results[name] = {}
            for rep in range(a.reps):
                srv = f'wispbench-{name}'
                subprocess.run(['docker', 'rm', '-f', srv], capture_output=True)
                extra = RELAX_NODE_EXTRA if name == 'node' else ' --max-handshakes 1000' if '16m' not in name else ''
                full = f'cd /work/wisp-cpp && exec {cmd} {RELAX}{extra}' if a.rules == 'relaxed' else f'cd /work/wisp-cpp && exec {cmd} {PROD}'
                if name == 'node':
                    full = 'mkdir -p /work/node_modules/@rvwasm && ln -sfn ../../relay-guard /work/node_modules/@rvwasm/relay-guard; ' + full
                sh('docker', 'run', '-d', '--name', srv, '--network', NET, *limits, *sysctl, '-v', f'{a.src}:/work', IMG, 'bash', '-c', full)
                sip = sh('docker', 'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', srv)
                for _ in range(60):  # a container can take seconds to start under host load: wait for the port
                    if dex(client, f'exec 3<>/dev/tcp/{sip}/8101 && echo up', timeout=5).stdout.strip() == 'up':
                        break
                    time.sleep(0.5)
                for label, args in CASES:
                    wait_load()
                    load0 = os.getloadavg()[0]
                    c0, _ = server_stats(srv)
                    try:
                        r = dex(client, f'cd /work/wisp-cpp && timeout -s KILL {a.duration + 30} build/wisp-bench run --host {sip} --port 8101 --dest {cip} {args} --duration {a.duration}',
                                timeout=a.duration + 60)
                    except subprocess.TimeoutExpired:
                        r = subprocess.CompletedProcess([], 1, '', 'docker exec timed out')
                    c1, hwm = server_stats(srv)
                    try:
                        res = json.loads(r.stdout.strip().splitlines()[-1])
                    except Exception:
                        res = {'ok': False, 'err': (r.stdout + r.stderr)[-300:] + ' | server: ' + sh('docker', 'logs', '--tail', '5', srv, check=False)}
                    res['load'] = round(max(load0, os.getloadavg()[0]), 1)  # the Mac's load: >= 8 means noisy
                    alive = sh('docker', 'inspect', '-f', '{{.State.Running}}', srv, check=False)
                    res['server_alive'] = alive == 'true'
                    if c0 is not None and c1 is not None:
                        res['cores'] = round((c1 - c0) / (a.duration + 1), 2)
                    res['rss_peak_mib'] = round(hwm / 1024, 1) if hwm else None
                    results[name].setdefault(label, []).append(res)
                    print(f'{name:14} rep{rep} {label:18} {json.dumps(res)}', flush=True)
                    if not res['server_alive']:
                        print(name, 'server died:', sh('docker', 'logs', '--tail', '5', srv, check=False), flush=True)
                        subprocess.run(['docker', 'start', srv], capture_output=True)
                        time.sleep(1.5)
                subprocess.run(['docker', 'rm', '-f', srv], capture_output=True)
        print('\nmedian of', a.reps)
        for name, cells in results.items():
            row = [name]
            for label, _ in CASES:
                rs = [r for r in cells.get(label, []) if r.get('per_s') or r.get('mibps')]
                if not rs:
                    row.append(f'{label}: -'); continue
                med = lambda k: statistics.median([r.get(k) or 0 for r in rs])
                noisy = ' (noisy)' if any((r.get('load') or 0) >= 8 for r in rs) else ''
                if label.startswith(('rr', 'churn')):
                    row.append(f'{label}: {med("per_s"):.0f}/s p50 {med("p50_us")/1000:.2f} ms p99 {med("p99_us")/1000:.2f} ms, {med("cores"):.2f} cores, RSS {med("rss_peak_mib")} MiB{noisy}')
                else:
                    row.append(f'{label}: {med("mibps"):.0f} MiB/s, {med("cores") / max(med("mibps"), 1e-9) * 1024:.2f} CPU-s/GiB, {med("cores"):.2f} cores, RSS {med("rss_peak_mib")} MiB{noisy}')
            print(' | '.join(row))
        with open(os.path.join(a.src, 'wisp-cpp', f'bench-linux-{a.rules}.json'), 'w') as f:
            json.dump(results, f, indent=1)
    finally:
        subprocess.run(['docker', 'rm', '-f', client] + [f'wispbench-{n}' for n in SERVERS], capture_output=True)


if __name__ == '__main__':
    main()

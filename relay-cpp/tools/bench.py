#!/usr/bin/env python3
"""Benchmark matrix for Wisp relays: throughput, latency, server CPU per GiB, memory per connection.

  python3 -I tools/bench.py [--reps 3] [--duration 8] [--only NAME,NAME] [--threads N] [--out FILE]

Servers: the Node server (packages/wisp) and the C++ server in five cumulative stages:
  a  single thread, malloc per buffer, scalar unmasking, one write per frame
  b  + buffer pools
  c  + thread per core (--threads N)
  d  + SIMD unmasking
  e  + writev batching (= the default build)
Limits are relaxed to what the load generator needs (as in packages/wisp's README); the bandwidth
limit is off (max-kbps 0). The client is build/wisp-bench (honours Wisp credit), the site its echo.
Machine load (1-minute average) is recorded per cell; cells measured with load >= 8 are marked noisy.
"""
import argparse, json, os, re, signal, socket, statistics, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
BUILD = os.path.join(PKG, 'build')
BENCH = os.path.join(BUILD, 'wisp-bench')
NODE_BIN = os.path.join(PKG, '..', 'wisp', 'bin', 'rvwasm-wisp-server.js')
ECHO_PORT = 6002

RELAXED_NODE = ['--origin', '*', '--host-allow', '127.0.0.1', '--port-allow', ','.join(str(ECHO_PORT + k) for k in [0, 1, 2] + list(range(10, 26))), '--allow-private', '--no-block-local',
                '--max-kbps', '0', '--max-streams', '1024', '--max-connects-per-minute', '100000', '--max-conns-per-ip', '100000',
                '--max-connections', '100000', '--scan-hosts-per-minute', '100000', '--scan-failures-per-minute', '100000',
                '--max-concurrent-lookups', '1000', '--log', '0']
RELAXED_CPP = list(RELAXED_NODE)
RELAXED_CPP += ['--max-handshakes', '100000']


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def wait_port(port, timeout=10):
    t = time.time()
    while time.time() - t < timeout:
        try:
            socket.create_connection(('127.0.0.1', port), 0.2).close(); return True
        except OSError:
            time.sleep(0.05)
    return False


def cpu_seconds(pid):
    out = subprocess.run(['ps', '-o', 'time=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    if not out:
        return None
    parts = out.replace('-', ':').split(':')
    sec = 0.0
    for p in parts:
        sec = sec * 60 + float(p)
    return sec


def rss_kib(pid):
    out = subprocess.run(['ps', '-o', 'rss=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    return int(out) if out else None


def load1():
    return os.getloadavg()[0]


def servers(threads):
    cpp = os.path.join(BUILD, 'wisp-server')
    hooks = os.path.join(BUILD, 'wisp-server-hooks')
    base = [cpp, '--bind', '127.0.0.1'] + RELAXED_CPP
    # production rules: defaults everywhere (ports 80/443, private ranges refused, interface
    # addresses blocked, 120 connects/min, 8 MiB/s), destination "bench.example" resolved by
    # wisp-bench's name server to a public address, connect redirected to the echo (test hook)
    prod = lambda port, extra=(): [hooks, '--bind', '127.0.0.1', '--port', str(port), '--origin', '*', '--host-allow', 'bench.example',
                                   '--dns-server', f'127.0.0.1:{DNS_PORT}', '--test-egress', f'127.0.0.1:{ECHO_PORT}', '--log', '0',
                                   '--threads', str(threads)] + list(extra)
    unlimited = ['--max-kbps', '0', '--max-connects-per-minute', '1000000', '--max-streams', '1024', '--scan-hosts-per-minute', '4096',
                 '--scan-failures-per-minute', '1000000', '--max-conns-per-ip', '1000', '--max-connections', '1000']
    P = {'dest': 'bench.example', 'target': 443}
    return {
        'node': (lambda port: ['node', NODE_BIN, '--bind', '127.0.0.1', '--port', str(port)] + RELAXED_NODE, {}),
        'cpp-a': (lambda port: base + ['--port', str(port), '--threads', '1', '--malloc-buffers', '--no-simd', '--no-writev'], {}),
        'cpp-b': (lambda port: base + ['--port', str(port), '--threads', '1', '--no-simd', '--no-writev'], {}),
        'cpp-c': (lambda port: base + ['--port', str(port), '--threads', str(threads), '--no-simd', '--no-writev'], {}),
        'cpp-d': (lambda port: base + ['--port', str(port), '--threads', str(threads), '--no-writev'], {}),
        'cpp-e': (lambda port: base + ['--port', str(port), '--threads', str(threads)], {}),
        'cpp-1t': (lambda port: base + ['--port', str(port), '--threads', '1'], {}),
        'cpp-2t': (lambda port: base + ['--port', str(port), '--threads', '2'], {}),
        'cpp-checks': (lambda port: prod(port, unlimited), P),      # all destination checks, rate caps raised
        'cpp-prod': (lambda port: prod(port), P),                    # shipped defaults, nothing relaxed
    }


DNS_PORT = 15353
E, UP, DOWN = ECHO_PORT, ECHO_PORT + 1, ECHO_PORT + 2
CASES = [
    ('1x10', E, ['--conns', '1', '--streams', '10', '--size', '16384']),
    ('3x10', E, ['--conns', '3', '--streams', '10', '--size', '16384']),
    ('5x10', E, ['--conns', '5', '--streams', '10', '--size', '16384']),
    ('1x10 v1', E, ['--conns', '1', '--streams', '10', '--size', '16384', '--v1']),
    ('up 3x10', UP, ['--conns', '3', '--streams', '10', '--size', '16384', '--mode', 'up']),
    ('down 3x10', DOWN, ['--conns', '3', '--streams', '10', '--size', '16384', '--mode', 'down']),
    ('rr 16x32 64B', E, ['--conns', '16', '--streams', '32', '--size', '64', '--latency']),
    # streams: Linux only (macOS keeps closed connections' ephemeral ports in TIME_WAIT globally;
    # ~16k of them exhaust the range in seconds)
    ('streams 4x16', E + 10, ['--conns', '4', '--parallel', '16', '--size', '64', '--mode', 'streams', '--spread', '16']),
]


def run_case(port, pid, target, args, duration, over):
    l = load1()
    c0 = cpu_seconds(pid)
    extra = ['--dest', over['dest']] if 'dest' in over else []
    target = over.get('target', target)
    r = subprocess.run(['nice', '-n', '10', BENCH, 'run', '--port', str(port), '--target', str(target), '--duration', str(duration)] + extra + args,
                       capture_output=True, text=True, timeout=duration + 30)
    c1 = cpu_seconds(pid)
    try:
        res = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        res = {'ok': False, 'mibps': 0, 'err': r.stderr[-200:]}
    # warm-up second included in CPU: count bytes over duration+warmup at the measured rate
    gib = res['mibps'] * (duration + 1) / 1024 if res.get('mibps') else 0
    # server CPU seconds per GiB echoed (one direction counted, as the MiB/s figure; the relay moved twice that)
    res['cpu_s_per_gib'] = round((c1 - c0) / gib, 3) if gib and c0 is not None and c1 is not None else None
    if res.get('per_s') and c0 is not None and c1 is not None and res.get('mibps', 0) == 0 or '--latency' in args:
        ops = (res.get('per_s') or 0) * (duration + 1)
        res['cpu_us_per_op'] = round((c1 - c0) / ops * 1e6, 2) if ops else None
    res['load'] = round(l, 1)
    return res


def mem_per_conn(port, pid, n=500):
    base = rss_kib(pid)
    p = subprocess.Popen([BENCH, 'idle', '--port', str(port), '--conns', str(n), '--hold', '4'], stdout=subprocess.PIPE, text=True)
    line = p.stdout.readline()
    time.sleep(1)
    peak = rss_kib(pid)
    p.wait()
    opened = json.loads(line).get('open', 0) if line.strip() else 0
    return round((peak - base) * 1024 / max(1, opened)) if opened else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--reps', type=int, default=3)
    ap.add_argument('--duration', type=float, default=8)
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--only', default='')
    ap.add_argument('--cases', default='')
    ap.add_argument('--out', default=os.path.join(BUILD, 'bench-results.json'))
    a = ap.parse_args()
    echo = subprocess.Popen([BENCH, 'echo', '--port', str(ECHO_PORT)], stdout=subprocess.DEVNULL)
    dns = subprocess.Popen([BENCH, 'dns', '--port', str(DNS_PORT), '--dest', '93.184.216.34'], stdout=subprocess.DEVNULL)
    procs = [echo, dns]

    def cleanup(*_):
        for p in procs:
            try: p.kill()
            except Exception: pass
    signal.signal(signal.SIGTERM, lambda *_: (cleanup(), sys.exit(1)))
    results = {}
    try:
        wait_port(ECHO_PORT)
        names = [n for n in servers(a.threads) if not a.only or n in a.only.split(',')]
        cases = [c for c in CASES if not a.cases or any(k == c[0] for k in a.cases.split(','))]
        for name in names:
            results[name] = {}
            for rep in range(a.reps):
                port = free_port()
                cmd, over = servers(a.threads)[name]
                srv = subprocess.Popen(cmd(port), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                procs.append(srv)
                if not wait_port(port):
                    print(name, 'did not start', file=sys.stderr); srv.kill(); continue
                time.sleep(0.3)
                for label, target, args in cases:
                    if over and target not in (E, E + 10):
                        continue  # the production runs redirect every connect to the echo
                    r = run_case(port, srv.pid, target, args, a.duration, over)
                    results[name].setdefault(label, []).append(r)
                    print(f'{name:6} rep{rep} {label:18} {json.dumps(r)}', flush=True)
                if rep == 0:
                    results[name]['mem_per_conn_bytes'] = mem_per_conn(port, srv.pid)
                    print(f'{name:6} memory per idle connection: {results[name]["mem_per_conn_bytes"]} bytes', flush=True)
                srv.send_signal(signal.SIGINT); srv.wait(timeout=10); procs.remove(srv)
        with open(a.out, 'w') as f:
            json.dump(results, f, indent=1)
        # summary: medians
        print('\nmedian of', a.reps)
        for name, cells in results.items():
            row = [name]
            for label, _, _ in cases:
                rs = [r for r in cells.get(label, []) if r.get('ok')]
                if not rs:
                    row.append(f'{label}: -'); continue
                if label.startswith('rr') or label.startswith('streams'):
                    cu = [r['cpu_us_per_op'] for r in rs if r.get('cpu_us_per_op')]
                    row.append(f'{label}: {statistics.median(r["per_s"] for r in rs):.0f}/s {statistics.median(cu) if cu else 0:.1f} us CPU/op p50 {statistics.median(r["p50_us"] for r in rs):.0f} us p99 {statistics.median(r["p99_us"] for r in rs):.0f} us')
                else:
                    mib = statistics.median(r['mibps'] for r in rs)
                    cpu = [r['cpu_s_per_gib'] for r in rs if r['cpu_s_per_gib']]
                    noisy = any(r['load'] >= 8 for r in rs)
                    row.append(f'{label}: {mib:.0f} MiB/s, {statistics.median(cpu) if cpu else 0:.2f} s/GiB{" (noisy)" if noisy else ""}')
            row.append(f'mem/conn {cells.get("mem_per_conn_bytes")} B')
            print(' | '.join(row))
    finally:
        cleanup()


if __name__ == '__main__':
    main()

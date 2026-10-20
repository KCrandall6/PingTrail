#!/usr/bin/env python3
"""Isolated Docker health/persistence smoke test. Build pingtrail:phase4a first.
Uses disposable credentials and a disposable named volume. No ports or host paths.
"""
import json
import os
import secrets
import subprocess
import time

suffix = secrets.token_hex(5)
container = f'pingtrail-smoke-{suffix}'
volume = f'pingtrail-smoke-{suffix}'
image = os.environ.get('PINGTRAIL_TEST_IMAGE', 'pingtrail:phase4a')

def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'Docker {args[0]} failed: {result.stderr[:1000]}')
    return result.stdout.strip()

def request(route, method='GET', body=None, authenticated=True):
    # The token stays in the container environment and is never returned/logged.
    source = '''
    const [route, method, body, auth] = process.argv.slice(1);
    fetch('http://127.0.0.1:3000'+route, {method,
      headers:{'content-type':'application/json', ...(auth==='true'?{Authorization:'Bearer '+process.env.PINGTRAIL_API_TOKEN}:{})},
      ...(body==='null'?{}:{body}), signal:AbortSignal.timeout(5000)})
      .then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))
      .catch(()=>process.exit(1));
    '''
    return json.loads(docker('exec', container, 'node', '-e', source, route, method, json.dumps(body), str(authenticated).lower()))

def ready():
    deadline = time.monotonic()+30
    while time.monotonic()<deadline:
        try:
            if request('/api/health', authenticated=False)['status']==200:
                return
        except RuntimeError:
            pass
        time.sleep(.5)
    raise AssertionError('Container did not become ready')

try:
    docker('volume', 'create', volume)
    docker('run', '-d', '--name', container, '--network', 'none', '--read-only',
           '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
           '--sysctl', 'net.ipv4.ping_group_range=0 2147483647',
           '--mount', f'type=volume,source={volume},target=/data',
           '-e', f'PINGTRAIL_API_TOKEN={secrets.token_urlsafe(36)}',
           '-e', 'PINGTRAIL_ROUTER_TARGET=192.0.2.1',
           '-e', 'PINGTRAIL_AUTO_SPEED_TESTS=false', '-e', 'PINGTRAIL_PING_COUNT=1',
           '-e', 'PINGTRAIL_PING_TIMEOUT_MS=1000', image)
    ready()
    assert docker('exec', container, 'id', '-u')=='1000'
    docker('exec', container, 'ping', '-n', '-c', '1', '127.0.0.1')
    assert request('/api/state', authenticated=False)['status']==401
    first=request('/api/state')['body']['session']['id']
    marker=request('/api/problems','POST',{'note':'Disposable container persistence smoke test'})
    assert marker['status']==201
    docker('restart', '--time', '160', container)
    ready()
    state=request('/api/state')['body']
    assert state['active'] and state['session']['id']==first
    assert any(p['note']=='Disposable container persistence smoke test' for p in state['problems'])
    assert request('/api/monitor/stop','POST')['status']==200
    docker('restart', '--time', '160', container)
    ready()
    assert request('/api/state')['body']['active'] is False
    assert request('/api/monitor/start','POST')['status']==201
    deadline=time.monotonic()+45
    while time.monotonic()<deadline:
        status=docker('inspect','--format','{{.State.Health.Status}}',container)
        if status=='healthy':
            break
        time.sleep(1)
    assert status=='healthy'
    assert docker('port',container)==''
    assert request('/api/storage')['body']['databaseBytes']>0
    print('PASS: non-root datagram ping, health check, API auth, private ports, session continuity, marker persistence and durable pause across restarts')
    print('Network-none smoke test intentionally does not validate home-router reachability or live bandwidth.')
finally:
    subprocess.run(['docker','rm','-f',container],capture_output=True)
    subprocess.run(['docker','volume','rm',volume],capture_output=True)

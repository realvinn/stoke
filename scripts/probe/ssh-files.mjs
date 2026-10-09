// Disposable fixtures on the CI probe's Mac/Linux SSH execution host. Never
// run against the developer's SSH configuration or a real user's folder.
import { spawnSync } from 'node:child_process'

const python = `import json, os, shutil, sys, tempfile
req = json.load(sys.stdin)
if req['operation'] == 'create':
    scope = tempfile.mkdtemp(prefix='stoke-probe-files-')
    root = os.path.join(scope, 'root')
    os.mkdir(root)
    name = 'café-日本語 & $(printf unsafe).bin'
    with open(os.path.join(root, name), 'wb') as f: f.write(bytes(range(256)) * 4096)
    with open(os.path.join(root, 'empty.bin'), 'wb'): pass
    with open(os.path.join(root, '.hidden'), 'wb') as f: f.write(b'hidden')
    with open(os.path.join(scope, 'outside.bin'), 'wb') as f: f.write(b'bystander')
    os.symlink(os.path.join(scope, 'outside.bin'), os.path.join(root, 'escape.bin'))
    os.symlink(os.path.join(root, name), os.path.join(root, 'inside-link.bin'))
    print(json.dumps({'scope': scope, 'root': root, 'name': name, 'size': 1048576}))
elif req['operation'] == 'clean':
    scope = os.path.realpath(req['scope'])
    if os.path.dirname(scope) != os.path.realpath(tempfile.gettempdir()) or not os.path.basename(scope).startswith('stoke-probe-files-'):
        raise ValueError('not a disposable fixture')
    shutil.rmtree(scope)
    print(json.dumps({'removed': True}))
else:
    raise ValueError('unknown fixture operation')
`
const command = `python3 -I -c "import base64;exec(base64.b64decode('${Buffer.from(python).toString('base64')}'))"`
function run(alias, request) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('SSH file fixtures are CI-only')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(alias)) throw new Error('Invalid probe SSH alias')
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, command], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024
  })
  if (result.error || result.status !== 0) throw new Error(`SSH file fixture failed: ${result.error?.message ?? result.stderr ?? result.status}`)
  return JSON.parse(result.stdout)
}
export function createSshFileFixture(alias) { return run(alias, { operation: 'create' }) }
export function removeSshFileFixture(alias, scope) { return run(alias, { operation: 'clean', scope }) }

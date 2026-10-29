import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'native/qianniu-hook');
const output = resolve(root, 'resources/qianniu-native/JuDeskQianniuHook.exe');
mkdirSync(dirname(output), { recursive: true });
// Reproducible cross-build using Zig 0.14.1; the toolchain is only a build dependency.
const zig = process.env.JUDESK_ZIG || 'zig';
function run(args, executable = zig) {
  const result = spawnSync(executable, args, { cwd: source, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const temporary = mkdtempSync(resolve(tmpdir(), 'judesk-qianniu-build-'));
try {
  let resource = 'app.rc';
  if (process.platform === 'darwin') {
    // Zig 0.14's implicit host resource compiler cannot link on macOS 26.
    // Compile the same bundled compiler with a supported deployment target.
    const environment = spawnSync(zig, ['env'], { encoding: 'utf8' });
    if (environment.status !== 0) throw new Error('Unable to locate the Zig compiler libraries.');
    const library = JSON.parse(environment.stdout).lib_dir;
    const rc = resolve(temporary, 'resinator');
    run([
      'build-exe',
      '-target',
      `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-macos.13.0`,
      '-O',
      'ReleaseFast',
      '-lc',
      '--dep',
      'aro',
      `-Mroot=${resolve(library, 'compiler/resinator/main.zig')}`,
      `-Maro=${resolve(library, 'compiler/aro/aro.zig')}`,
      `-femit-bin=${rc}`,
    ]);
    resource = resolve(temporary, 'app.obj');
    run([library, '/:no-preprocess', '/:target', 'x86_64', '/fo', resource, 'app.rc'], rc);
  }
  run([
    'build-exe',
    '-target',
    'x86_64-windows-gnu',
    '-O',
    'ReleaseSmall',
    '-fstrip',
    '-municode',
    '--subsystem',
    'windows',
    '-lc',
    '-ladvapi32',
    '-lshell32',
    '-cflags',
    '-Wall',
    '-Wextra',
    '-Werror',
    '--',
    'main.c',
    'remote-loader.S',
    resource,
    `-femit-bin=${output}`,
  ]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
const binary = readFileSync(output);
if (
  !binary.includes(Buffer.from('level="asInvoker"')) ||
  binary.includes(Buffer.from('requireAdministrator'))
)
  throw new Error('Qianniu helper must use an asInvoker manifest.');
const header = binary.readUInt32LE(0x3c);
if (binary.readUInt16LE(header + 4) !== 0x8664 || binary.readUInt16LE(header + 24 + 68) !== 2)
  throw new Error('Qianniu helper must be an x64 Windows GUI executable.');
console.log(`Built ${output}`);

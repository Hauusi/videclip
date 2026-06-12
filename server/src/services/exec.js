import { spawn } from 'child_process';

export function runCommand(cmd, args, opts = {}) {
  const useShell = opts.shell ?? false;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      ...opts,
      shell: useShell,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `${cmd} exited ${code}`));
    });
    if (opts.input != null) {
      proc.stdin?.write(String(opts.input));
      proc.stdin?.end();
    }
  });
}

export async function commandExists(cmd) {
  try {
    const test = process.platform === 'win32' ? ['where', cmd] : ['which', cmd];
    await runCommand(test[0], [test[1] || cmd]);
    return true;
  } catch {
    return false;
  }
}

import { spawn } from 'child_process';

/**
 * Run a child process and capture stdout/stderr.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts standard spawn options, plus:
 * @param {number} [opts.timeout] kill the process after this many ms.
 *   Sends SIGTERM first, SIGKILL 5s later if the process ignores it.
 * @param {string} [opts.input] written to stdin, then stdin is closed.
 */
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
    let timedOut = false;
    let timeoutHandle = null;
    let killHandle = null;

    if (opts.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        // Escalate if the process ignores SIGTERM.
        killHandle = setTimeout(() => proc.kill('SIGKILL'), 5000);
      }, opts.timeout);
    }

    const clearTimers = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
    };

    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (typeof opts.onStderr === 'function') {
        opts.onStderr(chunk);
      }
    });

    proc.on('error', (err) => {
      clearTimers();
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimers();
      if (timedOut) {
        reject(
          new Error(`${cmd} timed out after ${Math.round(opts.timeout / 1000)}s`),
        );
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `${cmd} exited ${code}`));
      }
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
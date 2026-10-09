/** Executed only in the disposable Windows CI app's main-process inspector.
 * The fixture has no real accounts or browser logins. Reports stay in the
 * job artifact, with network submission disabled. No production switch. */
export function nativeCrashScript(directory) {
  return `(() => {
    const builtins = process.getBuiltinModule('module');
    const electron = builtins.createRequire(process.cwd() + '/probe-diagnostics.cjs')('electron');
    const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
    const directory = ${JSON.stringify(directory)};
    fs.mkdirSync(directory, { recursive: true });
    electron.app.setPath('crashDumps', directory);
    electron.crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: true, compress: false });
    const phases = path.join(directory, 'lifecycle.jsonl');
    const note = (event) => {
      try { fs.appendFileSync(phases, JSON.stringify({ event, pid: process.pid, at: Date.now(), electron: process.versions.electron, arch: process.arch }) + '\\n'); }
      catch { /* a diagnostic cannot prevent the app from quitting */ }
    };
    note('installed');
    electron.app.once('before-quit', () => note('before-quit'));
    electron.app.once('will-quit', () => note('will-quit'));
    process.once('exit', code => note('exit:' + code));
    return { directory: electron.app.getPath('crashDumps'), uploads: electron.crashReporter.getUploadToServer(), installed: true };
  })()`
}

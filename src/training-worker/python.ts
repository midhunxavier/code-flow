import { exec } from "./files.js";
/** Check the interpreter before package imports can obscure an incompatible version. */
export async function pythonVersion(python: string, env: NodeJS.ProcessEnv): Promise<string> {
  let version: string;
  try {
    const { stdout } = await exec(python, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { timeout: 10000, maxBuffer: 4000, env });
    version = stdout.trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Python executable ${python} could not be checked${code ? ` (${code})` : ""}. Choose a Python 3.12 executable in Python settings.`);
  }
  if (!/^3\.12\.\d+$/.test(version)) throw new Error(`${python} reports ${/^\d+\.\d+\.\d+$/.test(version) ? `Python ${version}` : "an unrecognized Python version"}; this recipe needs Python 3.12. Choose a Python 3.12 executable in Python settings.`);
  return version;
}

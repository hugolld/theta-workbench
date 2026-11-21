import { isAbsolute, join, resolve } from "path";

/**
 * The research project's notebook target, from a notebook route's `cwd`
 * query parameter (M7b-1 tickets #3–#4): the project root, its `.theta`
 * directory, and the notebook file inside it. `null` when the parameter
 * is missing or empty — the routes answer 400. One home for the shape
 * both notebook routes guard with, so the path derivation cannot fork
 * between the snapshot read and the live tail.
 */
export function notebookTargetFromCwd(
  cwd: string | null | undefined,
): { projectRoot: string; thetaDir: string; notebookPath: string } | null {
  const trimmed = cwd?.trim() ?? "";
  if (!trimmed) return null;
  const projectRoot = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
  const thetaDir = join(projectRoot, ".theta");
  return { projectRoot, thetaDir, notebookPath: join(thetaDir, "notebook.jsonl") };
}

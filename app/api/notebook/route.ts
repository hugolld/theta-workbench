import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { notebookTargetFromCwd } from "@/lib/notebook-path";
import { notebookLines, notebookViewModel } from "@/lib/notebook";

export const dynamic = "force-dynamic";

// GET /api/notebook?cwd=<project root>
// The research project's notebook, read once and served as the pane's
// view-model (M7b-1 ticket #3): the pane draws it in theta-agent's
// `/notebook` grammar — lib/notebook.ts is the grammar's one home here.
// The response also carries the notebook's complete lines raw (`lines`,
// ticket #4): the pane's live buffer starts from the same bytes the watch
// stream appends to, so a delta can never disagree with the picture it
// amends. The path rides the fork's allowed-roots guard like any file
// surface: authorized lexically first, then — the file existing — through
// the symlink-resolving check, so a link inside an allowed root cannot
// name the notebook outside it. A project without a notebook (or an
// unreadable one) is an absence — `{ notebook: null }`, never an error;
// the pane carries the absence wording. Read-only by construction: this
// route has no mutation method.
export async function GET(req: Request) {
  const target = notebookTargetFromCwd(new URL(req.url).searchParams.get("cwd"));
  if (!target) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  const { notebookPath } = target;
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(notebookPath, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    await stat(notebookPath);
  } catch {
    return NextResponse.json({ notebook: null });
  }
  if (!isExistingFilePathAllowed(notebookPath, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  let content: string;
  try {
    content = await readFile(notebookPath, "utf8");
  } catch {
    return NextResponse.json({ notebook: null });
  }
  return NextResponse.json({ notebook: notebookViewModel(content), lines: notebookLines(content) });
}

import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { isAbsolute, join, resolve } from "path";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";
import { notebookViewModel } from "@/lib/notebook";

// GET /api/notebook?cwd=<project root>
// The research project's notebook, read once and served as the pane's
// view-model (M7b-1 ticket #3): the pane draws it in theta-agent's
// `/notebook` grammar — lib/notebook.ts is the grammar's one home here.
// The path rides the fork's allowed-roots guard like any file surface.
// A project without a notebook (or an unreadable one) is an absence —
// `{ notebook: null }`, never an error; the pane carries the absence
// wording. Read-only by construction: this route has no mutation method.
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd")?.trim() ?? "";
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  const projectRoot = isAbsolute(cwd) ? cwd : resolve(cwd);
  const notebookPath = join(projectRoot, ".theta", "notebook.jsonl");
  if (!isFilePathAllowed(notebookPath, await getAllowedFileRoots())) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  let content: string;
  try {
    content = await readFile(notebookPath, "utf8");
  } catch {
    return NextResponse.json({ notebook: null });
  }
  return NextResponse.json({ notebook: notebookViewModel(content) });
}

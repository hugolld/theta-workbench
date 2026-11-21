import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import fs from "node:fs";
import { isAbsolute, join, resolve } from "path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { newNotebookLines } from "@/lib/notebook";
import { FILE_WATCH_HEARTBEAT_MS } from "@/lib/file-version";

export const dynamic = "force-dynamic";

// GET /api/notebook/watch?cwd=<project root> - SSE stream of the project
// notebook's appended lines (M7b-1 ticket #4). The house pattern is the file
// watch (app/api/files/[...path]/route.ts, `?type=watch`): fs.watch on the
// notebook's directory, named events, heartbeat, cleanup on abort and cancel.
// Deltas are the appended lines' raw bytes (lib/notebook.ts): malformed lines
// and duplicates ride along — the pane's render gate judges them, and line
// bytes being the identity, re-sends dedupe. `reset` names every non-append
// (the file rewritten, shrunk, emptied or deleted): the pane re-reads. A
// project without `.theta` yet watches the project root and re-arms on its
// creation, so a first recording still lands live. Each stream holds its own
// picture of the file — a second tab on the same project is another watcher,
// never a lock. Read-only by construction: this route has no mutation method.
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd")?.trim() ?? "";
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  const projectRoot = isAbsolute(cwd) ? cwd : resolve(cwd);
  const notebookPath = join(projectRoot, ".theta", "notebook.jsonl");
  const thetaDir = join(projectRoot, ".theta");
  const allowedRoots = await getAllowedFileRoots();
  try {
    await stat(notebookPath);
    if (!isExistingFilePathAllowed(notebookPath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
  } catch {
    // Absent now is fine — a first recording must still land live. The
    // symlink-resolving check then names the deepest existing ancestor:
    // `.theta` when it exists (the notebook may appear inside it), else
    // the project root.
    let dirExists = false;
    try {
      dirExists = (await stat(thetaDir)).isDirectory();
    } catch {
      dirExists = false;
    }
    if (!isExistingFilePathAllowed(dirExists ? thetaDir : projectRoot, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
  }

  let watcher: fs.FSWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (eventName: string, data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        if (watcher !== null) {
          try { watcher.close(); } catch { /* already closed */ }
          watcher = null;
        }
        try { controller.close(); } catch { /* already closed */ }
      };

      // The stream's picture of the file: raw content as of the last look.
      // Opening with the file already there seeds the picture only — the
      // pane's own GET covers the backfill, so the pre-existing notebook
      // never rides the stream twice.
      let lastRaw = "";
      let hasPicture = false;
      try {
        lastRaw = await readFile(notebookPath, "utf8");
        hasPicture = true;
      } catch {
        lastRaw = "";
        hasPicture = false;
      }

      const check = async () => {
        if (closed) return;
        let content: string;
        try {
          content = await readFile(notebookPath, "utf8");
        } catch {
          if (!hasPicture) return; // still absent, nothing to reset
          hasPicture = false;
          lastRaw = "";
          send("reset", {});
          return;
        }
        const delta = newNotebookLines(hasPicture ? lastRaw : "", content);
        hasPicture = true;
        lastRaw = content;
        if (delta === null) send("reset", {});
        else if (delta.length > 0) send("append", { lines: delta });
      };

      const watch = (directory: string, onEvent: (changedName: string | null) => void) => {
        const next = fs.watch(directory, (_eventType, changedName) => onEvent(changedName?.toString() ?? null));
        next.on("error", () => cleanup());
        return next;
      };

      const armThetaWatcher = () => {
        watcher = watch(thetaDir, (changedName) => {
          if (changedName !== null && changedName !== "notebook.jsonl") return;
          void check();
        });
        void check(); // the file may have appeared before the watcher did
      };

      try {
        let thetaDirExists = false;
        try {
          thetaDirExists = (await stat(thetaDir)).isDirectory();
        } catch {
          thetaDirExists = false;
        }
        if (thetaDirExists) {
          armThetaWatcher();
        } else {
          // No `.theta` yet: watch the project root and re-arm on its
          // creation, so the first recording lands live. Any event may be
          // that creation, so the name filters nothing here.
          watcher = watch(projectRoot, () => {
            void (async () => {
              if (watcher === null || closed) return;
              let nowExists = false;
              try {
                nowExists = (await stat(thetaDir)).isDirectory();
              } catch {
                nowExists = false;
              }
              if (!nowExists) return;
              try { watcher.close(); } catch { /* already closed */ }
              watcher = null;
              armThetaWatcher();
            })();
          });
        }
      } catch {
        send("error", { message: "Failed to watch the project notebook" });
        cleanup();
        return;
      }

      const onAbort = () => cleanup();
      if (req.signal.aborted) {
        cleanup();
        return;
      }
      req.signal.addEventListener("abort", onAbort, { once: true });

      heartbeat = setInterval(() => send("ping", {}), FILE_WATCH_HEARTBEAT_MS);
      // The pane reads its snapshot (GET /api/notebook) after this event, so
      // the watcher exists before the picture it amends.
      send("connected", {});
    },
    cancel() {
      if (heartbeat !== null) clearInterval(heartbeat);
      if (watcher !== null) {
        try { watcher.close(); } catch { /* already closed */ }
        watcher = null;
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

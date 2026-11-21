import { NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import fs from "node:fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { notebookTargetFromCwd } from "@/lib/notebook-path";
import { newNotebookLines } from "@/lib/notebook";
import { FILE_WATCH_HEARTBEAT_MS } from "@/lib/file-version";
import { registerFileWatch } from "@/lib/file-watch-registry";

export const dynamic = "force-dynamic";

// GET /api/notebook/watch?cwd=<project root> - SSE stream of the project
// notebook's appended lines (M7b-1 ticket #4). The house pattern is the file
// watch (app/api/files/[...path]/route.ts, `?type=watch`): fs.watch on the
// notebook's directory, named events, heartbeat, cleanup on abort and cancel,
// and a place in the debug panel's open-watch count. Deltas are the appended
// lines' raw bytes (lib/notebook.ts): malformed lines and duplicates ride
// along — the pane's render gate judges them, and line bytes being the
// identity, re-sends dedupe. `reset` names every non-append (the file
// rewritten, shrunk, emptied or deleted): the pane re-reads. A project
// without `.theta` yet watches the project root and re-arms on its creation,
// so a first recording still lands live. Each stream holds its own picture
// of the file — a second tab on the same project is another watcher, never a
// lock. Read-only by construction: this route has no mutation method.
export async function GET(req: Request) {
  const target = notebookTargetFromCwd(new URL(req.url).searchParams.get("cwd"));
  if (!target) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }
  const { projectRoot, thetaDir, notebookPath } = target;
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
  // The debug panel's count of open watches (the files route's own); released
  // when the watcher fails or the client cancels or goes.
  let releaseWatch: (() => void) | null = null;
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
        releaseWatch?.();
        releaseWatch = null;
        try { controller.close(); } catch { /* already closed */ }
      };

      // The stream's picture of the file: raw content as of the last look.
      // Opening with the file already there seeds the picture only — the
      // pane reconciles from its own GET (on `connected`, reconnects
      // included), so the pre-existing notebook never rides the stream
      // twice.
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
          // The watched directory itself gone is a dead inode (macOS keeps
          // the watcher alive on it, deaf to a recreated directory):
          // closing the stream makes the client reconnect onto the new one.
          if (await watchDirGone(thetaDir)) cleanup();
          else send("reset", {});
          return;
        }
        const delta = newNotebookLines(hasPicture ? lastRaw : "", content);
        hasPicture = true;
        lastRaw = content;
        if (delta === null) send("reset", {});
        else if (delta.length > 0) send("append", { lines: delta });
      };

      // A watched directory that stopped existing leaves a dead watch —
      // on inotify it errors, on FSEvents it keeps emitting events for the
      // deleted inode while a recreated directory is a new inode it will
      // never report. Closing the stream is the recovery: the client's
      // EventSource reconnects and the fresh stream re-arms on what exists.
      const watchDirGone = async (directory: string): Promise<boolean> => {
        try {
          return !(await stat(directory)).isDirectory();
        } catch {
          return true;
        }
      };

      const watch = (directory: string, onEvent: (changedName: string | null) => void) => {
        const next = fs.watch(directory, (_eventType, changedName) => onEvent(changedName?.toString() ?? null));
        next.on("error", () => cleanup());
        return next;
      };

      const armThetaWatcher = () => {
        watcher = watch(thetaDir, (changedName) => {
          void (async () => {
            if (closed) return;
            // Any event may be the deletion of the watched directory
            // itself — macOS reports it under the directory's own name —
            // so existence is checked before the name filter.
            if (await watchDirGone(thetaDir)) {
              cleanup();
              return;
            }
            if (changedName !== null && changedName !== "notebook.jsonl") return;
            await check();
          })();
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
              if (await watchDirGone(projectRoot)) {
                cleanup();
                return;
              }
              let nowExists = false;
              try {
                nowExists = (await stat(thetaDir)).isDirectory();
              } catch {
                nowExists = false;
              }
              if (!nowExists) return;
              try { watcher.close(); } catch { /* already closed */ }
              watcher = null;
              // `.theta` can vanish again between the stat above and the
              // watch below: a throw here must not strand the stream
              // watcher-less with a live heartbeat — the client's
              // watchdog only ever sees pings, so it would not reopen.
              try {
                armThetaWatcher();
              } catch {
                cleanup();
              }
            })();
          });
        }
        releaseWatch = registerFileWatch();
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
      // The watcher exists; the pane now reads its snapshot (GET
      // /api/notebook) — and re-reads on every `connected`, so a
      // reconnect reconciles whatever was appended while it was gone.
      send("connected", {});
    },
    cancel() {
      if (heartbeat !== null) clearInterval(heartbeat);
      if (watcher !== null) {
        try { watcher.close(); } catch { /* already closed */ }
        watcher = null;
      }
      releaseWatch?.();
      releaseWatch = null;
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

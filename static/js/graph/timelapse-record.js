// Record a canvas to a WebM file with captureStream() + MediaRecorder (used by the time-lapse "Record" button).

/** True when this browser can record a canvas at all. */
export function canRecordCanvas() {
  return typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";
}

/** Start recording `canvas`. Returns { started, stop() -> Promise<Blob>, cancel() } or null when unsupported. */
export function startCanvasRecording(canvas, fps = 30) {
  if (!canRecordCanvas()) return null;
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } });
  if (!mime) return null;
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks = [];
  let discard = false, done;
  const finished = new Promise((res) => { done = res; });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    done(discard ? null : new Blob(chunks, { type: "video/webm" }));
  };
  rec.onerror = () => { discard = true; try { rec.stop(); } catch {} };
  rec.start(500);
  const halt = () => { if (rec.state !== "inactive") { try { rec.stop(); } catch { done(null); } } };
  return {
    started: performance.now(),
    stop() { halt(); return finished; },
    cancel() { discard = true; halt(); return finished; },
  };
}

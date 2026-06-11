import { stage1IngestFrames } from "./stage1-ingest.js";

export async function recordStage1FrameSource({
  frameSource,
  maxFrames = Infinity,
  manifestMeta = {},
  ...ingestArgs
} = {}) {
  if (!frameSource || typeof frameSource[Symbol.asyncIterator] !== "function") {
    throw new Error("frameSource must be an async iterable of Coinbase WS frame payloads");
  }
  const frames = [];
  for await (const frame of frameSource) {
    frames.push(frame);
    if (frames.length >= maxFrames) break;
  }
  const result = await stage1IngestFrames({
    ...ingestArgs,
    frames,
    manifestMeta: {
      offlineOnly: true,
      networkTouched: false,
      keyedClientImplemented: false,
      liveWsFlowObserved: false,
      ...manifestMeta
    }
  });
  return {
    ...result,
    framesRead: frames.length,
    recorder: {
      sourceType: "async-iterable",
      maxFrames: Number.isFinite(maxFrames) ? maxFrames : null
    }
  };
}

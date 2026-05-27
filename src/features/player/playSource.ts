// DEPRECATED. Superseded by the PlayRequest backend boundary in
// ./playRequest.ts. The old `playSourceWithMpv` built an external-MPV payload
// directly; playback now goes through buildPlayRequest() + dispatchPlayRequest()
// so source URL ownership is explicit and backend-tagged. Re-exported here only
// so any stray import keeps working; prefer importing from "./playRequest.js".

export {
  buildPlayRequest,
  dispatchPlayRequest,
  type DispatchOptions,
  type DispatchResult,
} from "./playRequest.js";

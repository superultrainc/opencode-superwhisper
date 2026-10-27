import { server } from "./v1.js"

// OpenCode 1.0–1.2 calls every export of the package root as a plugin, so this
// entry exports nothing else. Newer OpenCode loads ./server (see server.ts).
export default server

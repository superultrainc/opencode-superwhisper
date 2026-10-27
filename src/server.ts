import { PLUGIN_ID } from "./types.js"
import { server } from "./v1.js"
import { setup } from "./v2.js"

// OpenCode 1.3+ reads `server`; OpenCode 2 reads `setup`. Each ignores the other.
export default { id: PLUGIN_ID, server, setup }

// ValkeyModule is NOT re-exported here: it imports AppConfigModule (eager env
// validation). Importing the VALKEY_CLIENT token must not drag that in. The
// worker composition root imports ValkeyModule directly from ./valkey.module.js.
export { VALKEY_CLIENT } from "./valkey.tokens.js";
// Pure — no Nest decorators, no config — so tracking can share it with the
// shared client without either dragging in the other's module.
export { ConnectionErrorLog } from "./connection-log.js";

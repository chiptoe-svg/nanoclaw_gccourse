/**
 * Admin-handler barrel.
 *
 * Each admin tool (auth/model/provider) installs as a side-effect import
 * here. Trunk's telegram.ts imports this barrel once near startup; admin
 * handler files self-register via `registerTelegramCommand(...)` at module
 * scope. When no admin tools are installed this file is empty and the
 * import is a no-op.
 *
 * Add an admin tool: write the handler file at `./<name>.ts`, append
 * `import './<name>.js';` here. The `/add-admintools` skill does this for
 * the user when they install one.
 */

import './auth.js';
import './model.js';
import './provider.js';

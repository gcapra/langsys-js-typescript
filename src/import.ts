/**
 * `langsys-js-typescript/import`: the one-time import of an app's existing
 * translations (MIG-9), for Node. It sends requests with a write key, so it
 * belongs in a script or a build step, never in code that reaches the browser.
 * The `langsys-import` command runs it from the terminal.
 */
export {
    buildLegacyImport,
    importLegacyTranslations,
    type LegacyImportItem,
    type LegacyImportOptions,
    type LegacyImportPlan,
    type LegacyImportResult,
    type LegacyImportSkip,
    type LegacyImportSkipReason,
} from './legacy-import.js';
export { LegacyFormatError, type LegacyKeyFile } from './legacy-keys.js';

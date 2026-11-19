/**
 * langsys-import: send the translations an app already has to Langsys, once,
 * before its other languages' files are deleted (MIG-9).
 *
 *   npx langsys-import --source src/locales/en.json --format i18next \
 *       --target es-es=src/locales/es.json --target fr-fr=src/locales/fr.json
 *
 * The project id and a key that can write come from --project and --key, or
 * from LANGSYS_PROJECT_ID and LANGSYS_API_KEY.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { importLegacyTranslations, type LegacyImportResult } from '../legacy-import.js';
import { LegacyFormatError, type LegacyKeyFile } from '../legacy-keys.js';
import type { LegacyFormat } from '../legacy-value.js';

const USAGE = `Usage: langsys-import --source <file> --target <locale>=<file> [--target ...] [options]

Sends each key's source value with its translation in every target file to Langsys,
stored as human translations, so they show at once and are never machine translated.
Run it once, before deleting the target files.

Options:
  --source <file>           A source-language file, as legacyKeys takes it (repeatable)
  --target <locale>=<file>  A target locale's file, e.g. es-es=src/locales/es.json (repeatable)
  --format <format>         i18next, vue-i18n or plain (default: plain)
  --project <id>            The project id (or LANGSYS_PROJECT_ID)
  --key <key>               A key that can write (or LANGSYS_API_KEY)
  --api-url <url>           The API (or LANGSYS_API_URL; default https://api.langsys.dev/api)
  --dry-run                 Show what would be sent, and send nothing
  --json                    Print the whole result as JSON
  --help                    Show this help`;

function fail(message: string, code = 2): never {
    process.stderr.write(`langsys-import: ${message}\n`);
    process.exit(code);
}

function readFile(path: string, format: LegacyFormat): LegacyKeyFile {
    let data: unknown;
    try {
        data = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        fail(`cannot read ${path} as JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { name: basename(path), format, data: data as Record<string, unknown> };
}

function report(result: LegacyImportResult, dryRun: boolean): void {
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`${dryRun ? 'Would send' : 'Sent'} ${result.phrases} phrases with ${result.translations} translations.`);
    if (!dryRun) {
        out(`Saved as human translations: ${result.human_translations_saved}.`);
        if (result.human_translations_skipped > 0) {
            out(`Skipped for the plan's human-translation word limit: ${result.human_translations_skipped}. Langsys leaves them for machine translation.`);
        }
    }
    if (result.skipped.length > 0) {
        out(`Not sent (${result.skipped.length}):`);
        for (const skip of result.skipped) out(`  ${skip.locale}  ${skip.key}  ${skip.reason.replace('_', ' ')}`);
    }
}

async function main(): Promise<void> {
    let values: Record<string, string | boolean | string[] | undefined>;
    try {
        ({ values } = parseArgs({
            options: {
                source: { type: 'string', multiple: true },
                target: { type: 'string', multiple: true },
                format: { type: 'string', default: 'plain' },
                project: { type: 'string' },
                key: { type: 'string' },
                'api-url': { type: 'string' },
                'dry-run': { type: 'boolean', default: false },
                json: { type: 'boolean', default: false },
                help: { type: 'boolean', default: false },
            },
        }));
    } catch (error) {
        fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    }

    if (values.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }

    const sources = (values.source as string[] | undefined) ?? [];
    const targetArgs = (values.target as string[] | undefined) ?? [];
    if (sources.length === 0) fail(`--source is required.\n\n${USAGE}`);
    if (targetArgs.length === 0) fail(`at least one --target is required.\n\n${USAGE}`);

    const format = values.format as LegacyFormat;
    const dryRun = values['dry-run'] === true;
    const projectid = (values.project as string | undefined) ?? process.env.LANGSYS_PROJECT_ID;
    const key = (values.key as string | undefined) ?? process.env.LANGSYS_API_KEY;
    if (!dryRun && (!projectid || !key)) fail('a project id and a key are required: --project and --key, or LANGSYS_PROJECT_ID and LANGSYS_API_KEY.');

    const targets: Record<string, LegacyKeyFile[]> = {};
    for (const arg of targetArgs) {
        const separator = arg.indexOf('=');
        if (separator <= 0 || separator === arg.length - 1) fail(`--target takes <locale>=<file>, not "${arg}".`);
        (targets[arg.slice(0, separator)] ??= []).push(readFile(arg.slice(separator + 1), format));
    }

    let result: LegacyImportResult;
    try {
        result = await importLegacyTranslations({
            projectid: projectid ?? '',
            key: key ?? '',
            source: sources.map((path) => readFile(path, format)),
            targets,
            apiUrl: (values['api-url'] as string | undefined) ?? process.env.LANGSYS_API_URL,
            dryRun,
        });
    } catch (error) {
        if (error instanceof LegacyFormatError) fail(error.message);
        throw error;
    }

    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else report(result, dryRun);

    if (!result.success) fail(result.reason ?? 'the import failed', 1);
}

main().catch((error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error), 1));

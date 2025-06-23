import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';

export const OPTIONS_SCHEMA = z.object({
    entry: z.union([z.string().default('src/main.ts'), z.undefined()]),
    tsProject: z.union([z.string().default('tsconfig.json'), z.undefined()]),
    workDir: z.union([z.string().default(process.cwd()), z.undefined()]),
});

export type Options = z.infer<typeof OPTIONS_SCHEMA>;

export class Builder {
    protected readonly options = OPTIONS_SCHEMA.parse(this.inputOptions);
    protected config: ts.ParsedCommandLine;
    protected entryFilePath: string;
    protected entryDirPath: string;
    protected virtualEntryFileName: string;
    protected entryFileContent: string;
    protected virtualEntryImportLiteral: string;

    public constructor(private readonly inputOptions: Options) {
        const configPath = ts.findConfigFile(this.options.workDir!, ts.sys.fileExists, 'tsconfig.json');

        if (!configPath) throw new Error('Could not find a valid tsconfig.json.');

        const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

        if (configFile.error) {
            throw new Error(
                ts.formatDiagnosticsWithColorAndContext([configFile.error], {
                    getCanonicalFileName: (f) => f,
                    getCurrentDirectory: ts.sys.getCurrentDirectory,
                    getNewLine: () => ts.sys.newLine,
                }),
            );
        }

        this.config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
        this.entryFilePath = path.resolve(this.options.workDir!, this.options.entry!);
        this.entryDirPath = path.dirname(this.entryFilePath);
        this.virtualEntryFileName = path.basename(this.entryFilePath).split('.ts')[0] + '.entry.ts';
        this.entryFileContent = fs.readFileSync(this.entryFilePath).toString();
        this.virtualEntryImportLiteral = `./${this.virtualEntryFileName.split('.ts')[0]}`;
    }

    public compile() {
        const host = ts.createCompilerHost(this.config.options);
        const originalGetSourceFile = host.getSourceFile;
        host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
            if (path.resolve(this.options.workDir!, fileName) === this.entryFilePath) {
                return ts.createSourceFile(
                    fileName,
                    [`import ENTRY from '${this.virtualEntryImportLiteral}';`, `\nENTRY?.test?.();`].join('\n'),
                    languageVersion,
                    true,
                );
            }

            if (
                path.resolve(path.dirname(this.entryFilePath), this.virtualEntryFileName) ===
                path.resolve(this.entryDirPath, this.virtualEntryFileName)
            ) {
                return ts.createSourceFile(fileName, this.entryFileContent, languageVersion, true);
            }

            return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        };
        host.resolveModuleNameLiterals = (
            moduleLiterals, // ts.StringLiteralLike[]
            containingFile,
            redirectedReference,
            options,
        ) => {
            return moduleLiterals.map((literal) => {
                if (literal.text === this.virtualEntryImportLiteral) {
                    return {
                        resolvedModule: {
                            resolvedFileName: path.resolve(this.entryDirPath, this.virtualEntryFileName),
                            extension: ts.Extension.Ts,
                            isExternalLibraryImport: false,
                        },
                    };
                }
                // fallback to default resolver
                const result = ts.resolveModuleName(literal.text, containingFile, options, ts.sys);
                return result;
            });
        };
        ts.createProgram([this.options.entry!], this.config.options, host).emit(
            undefined,
            undefined,
            undefined,
            false,
            {
                // before: []
            },
        );
    }
}

import { Schema } from '@open-norantec/utilities/dist/schema-util.class';
import * as ts from 'typescript';
import * as path from 'node:path';
// import * as fs from 'fs-extra';
import * as _ from 'lodash';
import reflectDeclarationTransformer from '../transformers/reflect-declaration';
import * as esbuild from 'esbuild';
import * as requireFromString from 'require-from-string';
import { AttemptUtil } from '@open-norantec/utilities';
import { Client } from '../create';
import { z } from 'zod';

const OPTIONS_SCHEMA = z.object({
  entry: z.string(),
  outputFile: z.string(),
  group: z.string().optional(),
});

export class ClientUtil {
  public constructor(
    private readonly inputOptions: z.infer<typeof OPTIONS_SCHEMA>,
    private readonly onFile: (filePath: string, content: string) => void,
    private readonly onLog: (level: Schema.LogLevel, message?: string) => void,
  ) {}

  protected readonly options = OPTIONS_SCHEMA.parse(this.inputOptions);

  public async generateClientCode() {
    const configPath = ts.findConfigFile('.', ts.sys.fileExists, 'tsconfig.json')!;
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
    parsed.options.configFilePath = configPath;
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    const outputMap = new Map<string, string>();
    const outputFile = _.attempt(() =>
      ts
        .getOutputFileNames(parsed, path.relative(process.cwd(), path.resolve(this.options.entry)), false)
        .find((filePath) => filePath.endsWith('.js')),
    );

    if (outputFile instanceof Error) {
      this.onLog?.('error', `Failed to determine output file: ${outputFile.message}`);
      return;
    }

    if (typeof outputFile === 'undefined') {
      this.onLog?.('error', 'Failed to determine output file: No .js output file found');
      return;
    }

    program.emit(
      undefined,
      (fileName, data) => {
        const absolutePath = path.resolve(fileName);
        outputMap.set(absolutePath, data);
        this.onLog?.('info', `Compiled ${absolutePath}`);
      },
      undefined,
      false,
      {
        before: [reflectDeclarationTransformer(program)],
      },
    );

    const esbuildResult = await AttemptUtil.execPromise(
      esbuild.build({
        entryPoints: [path.resolve(outputFile)],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        plugins: [
          {
            name: 'tsconfig-paths',
            setup: (build) => {
              build.onResolve({ filter: /.*/ }, (args) => {
                const hasMatchingPath = Object.keys(parsed.options?.paths || {}).some((path) =>
                  new RegExp(path.replace('*', '\\w*')).test(args.path),
                );

                if (!hasMatchingPath) {
                  return null;
                }

                const { resolvedModule } = ts.nodeModuleNameResolver(
                  args.path,
                  args.importer,
                  parsed.options || {},
                  ts.sys,
                );

                if (!resolvedModule) {
                  return null;
                }

                const { resolvedFileName } = resolvedModule;

                if (!resolvedFileName || resolvedFileName.endsWith('.d.ts')) {
                  return null;
                }

                const resolved = ts.sys.resolvePath(resolvedFileName);

                this.onLog?.('info', `Resolved file using TypeScript paths: ${args.path} -> ${resolved})`);

                return {
                  path: resolved,
                };
              });
            },
          },
          {
            name: 'vfs',
            setup: (build) => {
              build.onResolve({ filter: /.*/ }, (args) => {
                let fullPath = path.resolve(path.dirname(args.importer), args.path);

                if (!fullPath.endsWith('.js')) fullPath += '.js';

                if (outputMap.has(fullPath)) {
                  return { path: fullPath, namespace: 'vfs' };
                }

                return { path: args.path, external: true };
              });

              build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
                const contents = outputMap.get(args.path);
                return {
                  contents,
                  loader: 'js',
                };
              });
            },
          },
        ],
      }),
    );

    if (esbuildResult instanceof Error) {
      this.onLog?.('error', `Failed to build client code: ${esbuildResult.message}`);
      return;
    }

    if (esbuildResult.errors.length > 0) {
      this.onLog('error', `Builder built with error: ${esbuildResult.errors[0].text}`);
      return;
    }

    const text = esbuildResult.outputFiles[0].text;
    let client: Client | undefined = undefined;

    try {
      const requireResult = requireFromString(text, { appendPaths: [path.resolve(process.cwd())] });
      client = requireResult;
      if (!(client instanceof Client)) client = (client as unknown as { default: Client })?.default;
    } catch {}

    if (!(client instanceof Client)) {
      this.onLog?.('error', 'Failed to load client code');
      return;
    }

    const clientCode = _.attempt(() => client!.generateClientSourceFile(this.options.group));

    if (clientCode instanceof Error) {
      this.onLog?.('error', `Failed to generate client code: ${clientCode.message}`);
      return;
    }

    const absoluteOutputFile = path.resolve(this.options.outputFile);

    this.onFile(absoluteOutputFile, clientCode);
  }
}

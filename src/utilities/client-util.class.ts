import { Schema } from '@open-norantec/utilities/dist/schema-util.class';
import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'fs-extra';
import * as _ from 'lodash';
import reflectDeclarationTransformer from '../transformers/reflect-declaration';
import * as esbuild from 'esbuild';
import * as requireFromString from 'require-from-string';
import { AttemptUtil } from '@open-norantec/utilities';
import { Client } from '../create';
import { z } from 'zod';
import { init, parse } from 'es-module-lexer';
import * as babel from '@babel/core';
import * as module from 'node:module';

const OPTIONS_SCHEMA = z.object({
  entry: z.string(),
  outputFile: z.string(),
  group: z.string().optional(),
});

async function maybeESModule(code: string) {
  await init;
  const [imports, exports] = parse(code);
  return imports.length > 0 || exports.length > 0;
}

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
        loader: {
          '.node': 'base64',
        },
        logLevel: 'silent',
        packages: 'external',
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

                if (!resolvedModule) return null;

                const { resolvedFileName } = resolvedModule;

                if (!resolvedFileName || resolvedFileName.endsWith('.d.ts')) return null;

                const resolved = ts.sys.resolvePath(resolvedFileName);

                this.onLog?.('info', `Resolved file using TypeScript paths: ${args.path} -> ${resolved})`);

                return { path: resolved };
              });
            },
          },
          {
            name: 'herbal',
            setup: (build) => {
              build.onResolve({ filter: /.*/ }, async (args) => {
                if (
                  args.path.startsWith('node:') ||
                  module.builtinModules.some(
                    (moduleName) => args.path.startsWith(moduleName) || args.path.startsWith(`${moduleName}/`),
                  )
                ) {
                  return { path: args.path, external: true };
                }

                if (outputMap.has(args.path)) return { path: args.path, namespace: 'vfs' };

                if (outputMap.has(args.importer)) {
                  const targetPaths: string[] = [];
                  const absoluteImportPath = path.resolve(path.dirname(args.importer), args.path);

                  if (!['.js', '.cjs'].includes(path.extname(absoluteImportPath))) {
                    targetPaths.push(absoluteImportPath + '.js');
                    targetPaths.push(absoluteImportPath + '.cjs');
                    targetPaths.push(path.resolve(absoluteImportPath, 'index.js'));
                    targetPaths.push(path.resolve(absoluteImportPath, 'index.cjs'));
                  } else {
                    targetPaths.push(absoluteImportPath);
                  }

                  for (const targetPath of targetPaths) {
                    if (outputMap.has(targetPath)) {
                      return { path: targetPath, namespace: 'vfs' };
                    }
                  }
                }

                const requiredPath = _.attempt(() =>
                  require.resolve(args.path, {
                    paths: [
                      ...(() => {
                        const result: string[] = [];
                        let currentDir = path.dirname(args.importer);

                        result.push(currentDir);

                        while (currentDir !== path.dirname(currentDir)) {
                          result.push(path.dirname(currentDir));
                          currentDir = path.dirname(currentDir);
                        }

                        return result;
                      })(),
                      ...(require.resolve.paths('') || []),
                    ],
                  }),
                );

                if (!(requiredPath instanceof Error)) {
                  return { path: requiredPath, namespace: outputMap.has(requiredPath) ? 'vfs' : undefined };
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

              build.onLoad({ filter: /node_modules\/.*.(mjs|js)$/ }, async (args) => {
                const code = fs.readFileSync(args.path, { encoding: 'utf-8' });
                if (await maybeESModule(code)) {
                  const transformed = babel.transformSync(code, {
                    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
                  });
                  return {
                    contents: transformed?.code || code,
                    loader: 'js',
                  };
                }
                return {
                  contents: code,
                  loader: 'js',
                };
              });

              build.onLoad({ filter: /.*/, namespace: 'json' }, (args) => {
                const contents = fs.readJsonSync(args.path, { encoding: 'utf-8' });
                return {
                  contents: `module.exports = ${JSON.stringify(contents)}`,
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

    fs.writeFileSync(path.resolve('dist/test.js'), text, { encoding: 'utf-8' });

    try {
      const requireResult = requireFromString(text, { appendPaths: [path.resolve(process.cwd())] });
      client = requireResult;
      if (!(client instanceof Client)) client = (client as unknown as { default: Client })?.default;
    } catch (error) {
      if (error instanceof Error) {
        this.onLog?.('error', `Failed to load client code: ${error.message}`);
      }
    }

    console.log('LENCONDA:test', client instanceof Client);

    if (!(typeof client?.generateClientSourceFile === 'function')) {
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

/* eslint-disable @typescript-eslint/no-this-alias */
import * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { z } from 'zod';
import * as webpack from 'webpack';
import TerserPlugin = require('terser-webpack-plugin');
import VirtualModulesPlugin = require('webpack-virtual-modules');
import * as winston from 'winston';
import { StringUtil } from '@open-norantec/utilities/dist/string-util.class';
import * as _ from 'lodash';
import * as memfs from 'memfs';
import { Worker } from 'node:worker_threads';
import * as chokidar from 'chokidar';
import * as ignore from 'ignore';
import * as readline from 'node:readline';
import * as chalk from 'chalk';

function renderProgressBar(percent, message, file) {
    const barLength = 40;
    const filledLength = Math.round((percent / 100) * barLength);
    const bar = `${'█'.repeat(filledLength)}${'-'.repeat(barLength - filledLength)}`;

    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(
        `${chalk.green(`[${bar}]`)} ${chalk.yellow(`${percent}%`)} ${chalk.gray(message)} ${chalk.cyan(file)}`,
    );

    if (percent === 100) {
        process.stdout.write('\n');
    }
}

class CatchNotFoundPlugin {
    public constructor(private logger?: winston.Logger) {}
    public apply(resolver: webpack.Resolver) {
        const resolve = resolver.resolve;
        const logger = this.logger;
        resolver.resolve = function (context: Record<string, any>, currentPath, request, resolveContext, callback) {
            const self = this;
            resolve.call(self, context, currentPath, request, resolveContext, (error, innerPath, result) => {
                const notfoundPathname = path.resolve(__dirname, '../../preserved/@@notfound.js') + `?${request}`;
                if (result) {
                    return callback(null, innerPath, result);
                }
                if (error && !error.message.startsWith("Can't resolve")) {
                    return callback(error);
                }
                // Allow .js resolutions to .tsx? from .tsx?
                if (
                    request.endsWith('.js') &&
                    context.issuer &&
                    (context.issuer.endsWith('.ts') || context.issuer.endsWith('.tsx'))
                ) {
                    return resolve.call(
                        self,
                        context,
                        currentPath,
                        request.slice(0, -3),
                        resolveContext,
                        (error1, innerPath, result) => {
                            if (result) return callback(null, innerPath, result);
                            if (error1 && !error1.message.startsWith("Can't resolve")) return callback(error1);
                            // make not found errors runtime errors
                            callback(null, notfoundPathname, {
                                path: result,
                                context,
                            });
                        },
                    );
                }
                logger?.warn?.(`Notfound '${context.issuer}' from '${request}', skipping...`);
                // make not found errors runtime errors
                callback(null, notfoundPathname, {
                    path: result,
                    context,
                });
            });
        };
    }
}

class CleanNonJSFilePlugin {
    public apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap(CleanNonJSFilePlugin.name, (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: CleanNonJSFilePlugin.name,
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                (assets) => {
                    Object.keys(assets).forEach((key) => {
                        if (!key?.endsWith?.('.js')) {
                            _.unset(assets, key);
                        }
                    });
                },
            );
        });
    }
}

class VirtualFilePlugin {
    public constructor(private readonly volume: memfs.IFs) {}

    public apply(compiler: webpack.Compiler) {
        compiler.outputFileSystem = this.volume as webpack.OutputFileSystem;
    }
}

class ForceWriteBundlePlugin {
    public constructor(private readonly outputPath: string) {}

    public apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap(ForceWriteBundlePlugin.name, (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: ForceWriteBundlePlugin.name,
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                (assets) => {
                    Object.entries(assets).forEach(([pathname, asset]) => {
                        const absolutePath = path.resolve(this.outputPath, pathname);
                        _.attempt(() => {
                            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
                        });
                        fs.writeFileSync(absolutePath, asset?.buffer?.());
                    });
                },
            );
        });
    }
}

interface AutoRunPluginOptions {
    logger?: winston.Logger;
    parallel?: boolean;
    onAfterStart?: (worker: Worker) => void | Promise<void>;
    onBeforeStart?: () => void | Promise<void>;
}

class AutoRunPlugin {
    public constructor(
        private readonly options: AutoRunPluginOptions = {},
        private readonly volume: memfs.IFs,
    ) {}

    public apply(compiler: webpack.Compiler) {
        const logger = this?.options?.logger;
        compiler.hooks.beforeCompile.tapAsync('AutoRunPlugin', async (compilationParams, callback) => {
            if (this.options.onBeforeStart) {
                await this.options?.onBeforeStart?.();
            }
            callback();
        });
        compiler.hooks.afterEmit.tapAsync('AutoRunPlugin', async (compilation: webpack.Compilation, callback) => {
            const assets = compilation.getAssets();

            if (assets.length === 0) {
                logger?.warn?.('No output file was found, skipping...');
                callback();
                return;
            }

            const bundledScriptFile = assets?.find?.((item) => item?.name?.endsWith?.('.js'))?.name;

            if (StringUtil.isFalsyString(bundledScriptFile)) {
                logger?.warn?.('No output file was found, skipping...');
                callback();
                return;
            }

            const outputPath = path.resolve(compilation.options.output.path!, bundledScriptFile!);

            logger?.info?.(`Prepared to run file: ${outputPath}`);

            const worker = new Worker(this.volume.readFileSync(outputPath).toString(), {
                eval: true,
            });

            if (this.options.onAfterStart) {
                await this.options?.onAfterStart?.(worker);
            }

            worker.on('exit', (code) => {
                if (code !== 0) {
                    logger?.error?.(`Process exited with code: ${code}`);
                }
                if (!this.options?.parallel) {
                    callback();
                }
            });
            worker.on('error', (error) => {
                logger?.error?.('Worker error:');
                logger?.error?.(error?.message);
                logger?.error?.(error?.stack);
                if (!this.options?.parallel) {
                    callback();
                }
            });

            if (this.options?.parallel) {
                callback();
            }
        });
    }
}

class RunOncePlugin {
    public constructor(private readonly logger: winston.Logger) {}

    public apply(compiler: webpack.Compiler) {
        compiler.hooks.compilation.tap(RunOncePlugin.name, (compilation) => {
            compilation.hooks.processAssets.tapAsync(
                {
                    name: RunOncePlugin.name,
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                (assets, callback) => {
                    const targetAsset = Object.entries(assets)?.find?.(([pathname]) => pathname?.endsWith?.('.js'));

                    if (!targetAsset) {
                        throw new Error('Not found any JS bundle file, exitting...');
                    }

                    this.logger.info(`Found bundle file: ${targetAsset?.[0]}, executing...`);

                    const worker = new Worker(targetAsset?.[1]?.buffer?.()?.toString?.(), {
                        eval: true,
                    });

                    worker.on('exit', (code) => {
                        if (code !== 0) {
                            this.logger?.error?.(`Process exited with code: ${code}`);
                        }
                        callback();
                    });

                    worker.on('error', (error) => {
                        this?.logger?.error?.('Worker error:');
                        this?.logger?.error?.(error?.message);
                        this?.logger?.error?.(error?.stack);
                        callback(error);
                    });
                },
            );
        });
    }
}

export const OPTIONS_SCHEMA = z.object({
    clean: z.boolean().optional().default(true),
    entry: z.union([z.string().default('main.ts'), z.undefined()]),
    outputDir: z.union([z.string().default('dist'), z.undefined()]),
    outputName: z.union([z.string().default('main'), z.undefined()]),
    outputNameFormat: z.union([z.string().default('[name].js'), z.undefined()]),
    sourceDir: z.union([z.string().default('src'), z.undefined()]),
    tsProject: z.union([z.string().default('tsconfig.json'), z.undefined()]),
    workDir: z.union([z.string().default(process.cwd()), z.undefined()]),
});

const COMPILER_GENERATION_TYPE = z.enum(['build', 'client', 'watch']);

type CompilerGenerationType = z.infer<typeof COMPILER_GENERATION_TYPE>;

export type BuilderOptions = z.infer<typeof OPTIONS_SCHEMA>;

export class Builder {
    protected readonly logger = winston.createLogger({
        level: 'verbose',
        format: winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss',
            }),
            winston.format.printf(
                (info) =>
                    `${info.timestamp} - ${info.level}: ${info.message}` +
                    (info.splat !== undefined ? `${info.splat}` : ' '),
            ),
        ),
        transports: [new winston.transports.Console()],
    });
    protected options: BuilderOptions;
    protected tsConfig: ts.ParsedCommandLine;
    protected entryFilePath: string;
    protected entryDirPath: string;
    protected outputPath: string;
    protected virtualEntryFilePath: string;

    public constructor(private readonly inputOptions: BuilderOptions) {
        this.options = OPTIONS_SCHEMA.parse(this.inputOptions);
        const configPath = ts.findConfigFile(this.options.workDir!, ts.sys.fileExists, this.options.tsProject!);

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

        this.tsConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
        this.entryFilePath = path.resolve(this.options.workDir!, this.options.sourceDir!, this.options.entry!);
        this.entryDirPath = path.dirname(this.entryFilePath);
        this.outputPath = path.resolve(this.options.workDir!, this.options.outputDir!);
        this.virtualEntryFilePath = path.resolve(
            this.entryDirPath,
            `virtual_${Math.random().toString(32).slice(2)}.ts`,
        );
    }

    public run(inputType: CompilerGenerationType, debug = false) {
        const type = COMPILER_GENERATION_TYPE.parse(inputType);
        let name: string;

        switch (type) {
            case 'watch':
            case 'build': {
                name = this.options.outputName!;
                break;
            }
            case 'client': {
                name = `index_${Math.random().toString(32).slice(2)}`;
                break;
            }
            default:
                name = '';
                break;
        }

        if (StringUtil.isFalsyString(name)) throw new Error(`Invalid generate type`);

        let currentWorker: Worker | null = null;
        const compiler = webpack({
            cache: false,
            optimization: {
                minimize: false,
                minimizer: [
                    new TerserPlugin({
                        terserOptions: {
                            keep_classnames: true,
                            keep_fnames: true,
                        },
                    }),
                ],
            },
            entry: {
                [name!]: this.virtualEntryFilePath,
            },
            target: 'node',
            mode: (() => {
                switch (type) {
                    case 'watch':
                        return 'development';
                    default:
                        return 'production';
                }
            })(),
            output: {
                devtoolModuleFilenameTemplate: '[absolute-resource-path]',
                filename: (() => {
                    switch (type) {
                        case 'client':
                            return '[name].js';
                        default:
                            return this.options.outputNameFormat;
                    }
                })(),
                path: this.outputPath,
                libraryTarget: 'commonjs',
            },
            resolve: {
                extensions: ['.js', '.cjs', '.mjs', '.ts', '.tsx'],
                alias: {
                    src: path.resolve(this.options.workDir!, this.options.sourceDir!),
                    UNKNOWN: false,
                },
                plugins: [new CatchNotFoundPlugin(this.logger)],
            },
            module: {
                rules: [
                    {
                        test: /\.ts$/,
                        use: {
                            loader: require.resolve('ts-loader'),
                            options: {
                                compiler: require.resolve('ts-patch/compiler', {
                                    paths: [__dirname, process.cwd()],
                                }),
                                configFile: path.resolve(this.options.workDir!, this.options.tsProject!),
                            },
                        },
                        exclude: /node_modules/,
                    },
                ],
            },
            plugins: [
                new webpack.ProgressPlugin((percentage, message, ...args) => {
                    renderProgressBar(Math.floor(percentage * 100), message, args[0] || '');
                }),
                ...(() => {
                    const result: any[] = [];

                    result.push(
                        new CleanNonJSFilePlugin(),
                        new VirtualModulesPlugin({
                            [this.virtualEntryFilePath]: (() => {
                                switch (type) {
                                    case 'build':
                                    case 'watch': {
                                        return [
                                            "import 'reflect-metadata';",
                                            "import { NestFactory } from '@nestjs/core';",
                                            "import { ModelUtil } from '@open-norantec/herbal/dist/utilities/model-util.class';",
                                            "import { LoggerService } from '@open-norantec/herbal/dist/modules/logger/logger.service';",
                                            `import ENTRY from '${this.entryFilePath}';`,
                                            '\nasync function bootstrap() {',
                                            '    const entryOptions = ENTRY?.options;',
                                            '    await entryOptions?.onBeforeBootstrap?.();',
                                            '    const app = await NestFactory.create(entryOptions?.Module, {',
                                            '        ...entryOptions?.factoryOptions,',
                                            '    });',
                                            '',
                                            '    if (entryOptions?.cors !== false) {',
                                            '        app.enableCors({',
                                            "            origin: '*',",
                                            "            methods: '*',",
                                            "            allowedHeaders: '*',",
                                            '            credentials: false,',
                                            '            ...(entryOptions?.cors ?? {}),',
                                            '        });',
                                            '    }',
                                            '',
                                            '    if (Array.isArray(entryOptions?.globalFilters) && entryOptions?.globalFilters?.length > 0) {',
                                            '        app.useGlobalFilters(entryOptions?.globalFilters);',
                                            '    }',
                                            '',
                                            '    if (Array.isArray(entryOptions?.globalGuards) && entryOptions?.globalGuards?.length > 0) {',
                                            '        app.useGlobalFilters(entryOptions?.globalGuards);',
                                            '    }',
                                            '',
                                            '    if (Array.isArray(entryOptions?.globalInterceptors) && entryOptions?.globalInterceptors?.length > 0) {',
                                            '        app.useGlobalFilters(entryOptions?.globalInterceptors);',
                                            '    }',
                                            '',
                                            '    if (Array.isArray(entryOptions?.globalPipes) && entryOptions?.globalPipes?.length > 0) {',
                                            '        app.useGlobalFilters(entryOptions?.globalPipes);',
                                            '    }',
                                            '',
                                            '    if (!!entryOptions?.websocketAdapter) {',
                                            '        app.useWebsocketAdapter(entryOptions?.useWebsocketAdapter);',
                                            '    }',
                                            '',
                                            '    if (Array.isArray(entryOptions?.uses)) {',
                                            '        entryOptions.uses.forEach((middleware) => {',
                                            '            app.use(middleware);',
                                            '        });',
                                            '    }',
                                            '',
                                            '    const resolver = (Class) => app.resolve(Class);',
                                            '    const listenPort = await entryOptions?.getListenPort?.(resolver);',
                                            '    const loggerService = await app.resolve(LoggerService);',
                                            '    const finalListenPort = listenPort > 0 ? listenPort : 8080;',
                                            '',
                                            '    await entryOptions?.onBeforeListen?.(app);',
                                            '    await app.listen(finalListenPort, () => {',
                                            '        loggerService.log(`Listening on port: ${finalListenPort}`);',
                                            '        entryOptions?.callback?.(resolver);',
                                            '    });',
                                            '}',
                                            '\nbootstrap();',
                                        ].join('\n');
                                    }
                                    case 'client': {
                                        return [
                                            "import 'reflect-metadata';",
                                            `import ENTRY from '${this.entryFilePath}';`,
                                            "import * as fs from 'node:fs';",
                                            "import * as path from 'node:path';",
                                            '\nasync function bootstrap() {',
                                            `    const outputDirPath = '${this.outputPath}';`,
                                            `    const outputFilePath = path.resolve(outputDirPath, '${this.options.outputName}.ts');`,
                                            '    await ENTRY?.options?.onBeforeBootstrap?.();',
                                            '    try {',
                                            '        fs.rmSync(outputFilePath, {',
                                            '            recursive: true,',
                                            '            force: true,',
                                            '        });',
                                            '    } catch {}',
                                            '    try {',
                                            '        if (!fs.statSync(path.dirname(outputDirPath)).isDirectory()) {',
                                            '            fs.rmSync(path.dirname(outputDirPath), {',
                                            '                recursive: true,',
                                            '                force: true,',
                                            '            });',
                                            '        }',
                                            '    } catch {}',
                                            '    try {',
                                            '        fs.mkdirSync(outputDirPath, { recursive: true });',
                                            '    } catch {}',
                                            '    fs.writeFileSync(',
                                            '        outputFilePath,',
                                            '        ENTRY?.generateClientSourceFile?.({',
                                            '            Module: ENTRY?.options?.Module,',
                                            '        }),',
                                            '    );',
                                            '}',
                                            '\nbootstrap();',
                                        ].join('\n');
                                    }
                                }
                            })(),
                        }),
                    );

                    if (!(['client', 'watch'] as CompilerGenerationType[]).includes(type) || debug) {
                        result.push(new ForceWriteBundlePlugin(this.outputPath));
                        if (debug) return result;
                    }

                    if (type === 'client') {
                        result.push(new RunOncePlugin(this.logger));
                    }

                    if (type === 'watch') {
                        const volume = new memfs.Volume() as memfs.IFs;
                        result.push(
                            new VirtualFilePlugin(volume),
                            new AutoRunPlugin(
                                {
                                    logger: this.logger,
                                    parallel: true,
                                    onAfterStart: (worker) => {
                                        currentWorker = worker;
                                    },
                                    onBeforeStart: () => {
                                        _.attempt(() => {
                                            currentWorker!.terminate();
                                        });
                                    },
                                },
                                volume,
                            ),
                        );
                    }

                    return result;
                })(),
            ],
        });

        const runCompiler = () => {
            compiler.run((error) => {
                if (error) {
                    this.logger.error('Builder finished with error:', error);
                }
            });
        };
        const watchHandler = () => {
            _.attempt(() => currentWorker!.terminate());
            currentWorker = null;
            _.attempt(() => {
                compiler.close(() => {
                    runCompiler();
                });
            });
        };

        if (type === 'watch') {
            const ig = ignore().add(
                (() => {
                    const gitIgnorePath = path.resolve('.gitignore');
                    if (fs.existsSync(gitIgnorePath) && fs.statSync(gitIgnorePath).isFile()) {
                        return fs.readFileSync(gitIgnorePath).toString();
                    }
                    return '';
                })(),
            );
            const watcher = chokidar.watch(process.cwd(), {
                persistent: true,
                ignoreInitial: true,
                ignored: (pathname) => {
                    const relativePath = path.relative(process.cwd(), pathname);
                    if (StringUtil.isFalsyString(relativePath)) return false;
                    if (relativePath.startsWith('.git')) return true;
                    return ig.ignores(relativePath);
                },
            });
            watcher.on('change', watchHandler);
            watcher.on('add', watchHandler);
            watcher.on('unlink', watchHandler);
        }

        if (this.options?.clean) {
            this.logger?.info?.(`Cleaning output directory: ${this.outputPath}`);
            _.attempt(() => fs.rmSync(this.outputPath, { recursive: true, force: true }));
            this.logger?.info?.('Output directory cleaned');
        }

        runCompiler();
    }
}

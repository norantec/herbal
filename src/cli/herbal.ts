#!/usr/bin/env node

import { Command } from 'commander';
import { createForgeCommand, CreateForgeCommandOptions } from '@open-norantec/forge';
import { Schema } from '@open-norantec/utilities/dist/schema-util.class';

const command = new Command('herbal');

const getEntryFileContent: CreateForgeCommandOptions['getEntryFileContent'] = ({ entryFilePath }) => {
    return [
        "import 'reflect-metadata';",
        "import { NestFactory } from '@nestjs/core';",
        "import { ModelUtil } from '@open-norantec/herbal/dist/utilities/model-util.class';",
        "import { LoggerService } from '@open-norantec/herbal/dist/modules/logger/logger.service';",
        `import ENTRY from '${entryFilePath}';`,
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
        '        app.useGlobalFilters(...entryOptions?.globalFilters);',
        '    }',
        '',
        '    if (Array.isArray(entryOptions?.globalGuards) && entryOptions?.globalGuards?.length > 0) {',
        '        app.useGlobalGuards(...entryOptions?.globalGuards);',
        '    }',
        '',
        '    if (Array.isArray(entryOptions?.globalInterceptors) && entryOptions?.globalInterceptors?.length > 0) {',
        '        app.useGlobalInterceptors(...entryOptions?.globalInterceptors);',
        '    }',
        '',
        '    if (Array.isArray(entryOptions?.globalPipes) && entryOptions?.globalPipes?.length > 0) {',
        '        app.useGlobalPipes(...entryOptions?.globalPipes);',
        '    }',
        '',
        '    if (!!entryOptions?.websocketAdapter) {',
        '        app.useWebSocketAdapter(entryOptions?.websocketAdapter);',
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
        '    await app.listen(finalListenPort, () => {',
        '        loggerService.log(`Listening on port: ${finalListenPort}`);',
        '        entryOptions?.callback?.(resolver);',
        '    });',
        '}',
        '\nbootstrap();',
    ].join('\n');
};

const getGenerateClientEntryFileContent: CreateForgeCommandOptions['getEntryFileContent'] = ({
    entryFilePath,
    outputPath,
    options,
}) => {
    return [
        "import 'reflect-metadata';",
        `import ENTRY from '${entryFilePath}';`,
        "import * as fs from 'node:fs';",
        "import * as path from 'node:path';",
        '\nasync function bootstrap() {',
        `    const outputDirPath = '${outputPath}';`,
        `    const outputFilePath = path.resolve(outputDirPath, '${options.outputName}.ts');`,
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
};

const handleLog = (level: Schema.LogLevel, message?: string) => {
    console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
};

command
    .addCommand(
        createForgeCommand({
            onLog: handleLog,
            getEntryFileContent,
            hideOptions: ['--after-emit-action', '--ts-compiler'],
            afterEmitAction: 'none',
        }).name('build'),
    )
    .addCommand(
        createForgeCommand({
            onLog: handleLog,
            getEntryFileContent,
            hideOptions: ['--after-emit-action', '--ts-compiler'],
            afterEmitAction: 'watch',
        }).name('watch'),
    )
    .addCommand(
        createForgeCommand({
            onLog: handleLog,
            getEntryFileContent: getGenerateClientEntryFileContent,
            hideOptions: ['--after-emit-action', '--ts-compiler'],
            afterEmitAction: 'run-once',
            tsCompiler: require.resolve('ts-patch/compiler', {
                paths: [__dirname, process.cwd()],
            }),
        }).name('generate-client'),
    );

command.parse(process.argv);

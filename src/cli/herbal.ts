#!/usr/bin/env node

import { Command } from 'commander';
import { createForgeCommand, CreateForgeCommandOptions } from '@open-norantec/forge';
import { Schema } from '@open-norantec/utilities/dist/schema-util.class';

const command = new Command('herbal');

const getEntryFileContent: CreateForgeCommandOptions['getEntryFileContent'] = ({ entryFilePath }) => {
  return [
    "import 'reflect-metadata';",
    "import { ModelUtil, NestFactory } from '@open-norantec/herbal';",
    "import { LoggerService } from '@open-norantec/herbal/dist/modules/logger/logger.service';",
    "import { Worker, isMainThread, workerData } from 'node:worker_threads';",
    `import ENTRY from '${entryFilePath}';`,
    '\nasync function bootstrap() {',
    '  const entryOptions = ENTRY?.options;',
    '  await entryOptions?.onBeforeBootstrap?.();',
    "\n  if (!!workerData?.['__herbal_worker']) {",
    "    entryOptions?.worker?.(workerData?.['__herbal_worker']);",
    '    return;',
    '  }',
    '  const app = await NestFactory.create(entryOptions?.Module, {',
    '    ...entryOptions?.factoryOptions,',
    '  });',
    '\n  if (entryOptions?.cors !== false) {',
    '    app.enableCors({',
    "       origin: '*',",
    "       methods: '*',",
    "       allowedHeaders: '*',",
    '       credentials: false,',
    '       ...(entryOptions?.cors ?? {}),',
    '    });',
    '  }',
    '\n  if (Array.isArray(entryOptions?.globalFilters) && entryOptions?.globalFilters?.length > 0) {',
    '    app.useGlobalFilters(...entryOptions?.globalFilters);',
    '  }',
    '\n  if (Array.isArray(entryOptions?.globalGuards) && entryOptions?.globalGuards?.length > 0) {',
    '    app.useGlobalGuards(...entryOptions?.globalGuards);',
    '  }',
    '\n  if (Array.isArray(entryOptions?.globalInterceptors) && entryOptions?.globalInterceptors?.length > 0) {',
    '    app.useGlobalInterceptors(...entryOptions?.globalInterceptors);',
    '  }',
    '\n  if (Array.isArray(entryOptions?.globalPipes) && entryOptions?.globalPipes?.length > 0) {',
    '    app.useGlobalPipes(...entryOptions?.globalPipes);',
    '  }',
    '\n  if (!!entryOptions?.websocketAdapter) {',
    '    app.useWebSocketAdapter(entryOptions?.websocketAdapter);',
    '  }',
    '\n  if (Array.isArray(entryOptions?.uses)) {',
    '    entryOptions.uses.forEach((middleware) => {',
    '      app.use(middleware);',
    '    });',
    '  }',
    '\n  const resolver = (Class) => app.resolve(Class);',
    '  const listenPort = await entryOptions?.getListenPort?.(resolver);',
    '  const loggerService = await app.resolve(LoggerService);',
    '  const finalListenPort = listenPort > 0 ? listenPort : 8080;',
    "\n  if (typeof entryOptions?.worker === 'function' && __filename?.toString?.() !== '[worker eval]') {",
    '    new Worker(__filename, { workerData: { __herbal_worker: { port: finalListenPort } } });',
    '  }',
    '\n  await app.listen(finalListenPort, () => {',
    '    loggerService.log(`Listening on port: ${finalListenPort}`);',
    '    entryOptions?.callback?.(finalListenPort, app);',
    '  });',
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
    `  const outputDirPath = '${outputPath}';`,
    `  const outputFilePath = path.resolve(outputDirPath, '${options.outputName}.ts');`,
    '  await ENTRY?.options?.onBeforeBootstrap?.();',
    '  try {',
    '    fs.rmSync(outputFilePath, {',
    '      recursive: true,',
    '      force: true,',
    '    });',
    '  } catch {}',
    '  try {',
    '    if (!fs.statSync(path.dirname(outputDirPath)).isDirectory()) {',
    '      fs.rmSync(path.dirname(outputDirPath), {',
    '        recursive: true,',
    '        force: true,',
    '      });',
    '    }',
    '  } catch {}',
    '  try {',
    '    fs.mkdirSync(outputDirPath, { recursive: true });',
    '  } catch {}',
    '  fs.writeFileSync(',
    '    outputFilePath,',
    '    ENTRY?.generateClientSourceFile?.(),',
    '  );',
    '}',
    '\nbootstrap();',
  ].join('\n');
};

const handleLog = (level: Schema.LogLevel, message?: string) => {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
  switch (level) {
    case 'error':
      process.exit(1);
    default:
      break;
  }
};

command
  .addCommand(
    createForgeCommand({
      onLog: handleLog,
      getEntryFileContent,
      hideOptions: ['--after-emit-action', '--ts-compiler', '--mode'],
      mode: 'production',
      afterEmitAction: 'none',
    }).name('build'),
  )
  .addCommand(
    createForgeCommand({
      onLog: handleLog,
      getEntryFileContent,
      hideOptions: ['--after-emit-action', '--ts-compiler'],
      mode: 'development',
      afterEmitAction: 'watch',
    }).name('watch'),
  )
  .addCommand(
    createForgeCommand({
      onLog: handleLog,
      getEntryFileContent: getGenerateClientEntryFileContent,
      hideOptions: ['--after-emit-action', '--ts-compiler', '--mode'],
      mode: 'production',
      afterEmitAction: 'run-once',
      tsCompiler: require.resolve('ts-patch/compiler', {
        paths: [__dirname, process.cwd()],
      }),
    }).name('generate-client'),
  );

command.parse(process.argv);

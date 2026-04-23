#!/usr/bin/env node

import { Command } from 'commander';
import { createCommand } from '@open-norantec/forge';
import { Schema } from '@open-norantec/utilities/dist/schema-util.class';
import * as _ from 'lodash';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { Forge } from '@open-norantec/forge';
import * as requireFromString from 'require-from-string';
import { transformer as transformReflectDeclaration } from '../transformers/reflect-declaration';

const command = new Command('herbal');

const log = (level: Schema.LogLevel, ...messages: string[]) => {
  console.log(`[${new Date().toISOString()}] -${level}- ${messages?.join?.(' ') ?? ''}`);
  switch (level) {
    case 'error':
      process.exit(1);
    default:
      break;
  }
};

const handleGetVirtualEntryFileContent: ConstructorParameters<typeof Forge>[0]['getVirtualEntryFileContent'] = (
  buildEntryFilePath,
) => {
  return [
    "import 'reflect-metadata';",
    "import { ModelUtil, NestFactory, isApplication } from '@open-norantec/herbal';",
    "import { LoggerService } from '@open-norantec/herbal/dist/modules/logger/logger.service';",
    "import { Worker, isMainThread, workerData } from 'node:worker_threads';",
    `import ENTRY from '${buildEntryFilePath}';`,
    '\nasync function bootstrap() {',
    '  if (!isApplication(ENTRY)) {',
    '    console.log(`The entry file must export an application or a function that returns an application.`);',
    '    process.exit(1);',
    '  }',
    '  const entryOptions = ENTRY?.options;',
    '  await entryOptions?.onBeforeBootstrap?.();',
    "\n  if (!!workerData?.['__herbal_worker']) {",
    "    entryOptions?.worker?.(workerData?.['__herbal_worker']);",
    '    return;',
    '  }',
    '  const app = await NestFactory.create(entryOptions?.Module, {',
    '    ...entryOptions?.factoryOptions,',
    '    bodyParser: false,',
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

const handleGetFileContent: ConstructorParameters<typeof Forge>[0]['onGetFileContent'] = (filePath) => {
  const content = _.attempt(() => fs.readFileSync(filePath, 'utf-8'));
  if (content instanceof Error) {
    log('error', `Failed to read file content for ${filePath}:`, content.message);
    return '';
  }
  return content;
};

const handleGetWatcher: ConstructorParameters<typeof Forge>[0]['getWatcher'] = (callback) => {
  const watcher = fs.watch(process.cwd(), { recursive: true }, (eventType, filename) => {
    callback(path.resolve(filename));
  });
  return { close: watcher.close.bind(watcher) };
};

const createHandleOutputFile: (disableWriteFile: boolean) => ConstructorParameters<typeof Forge>[0]['onOutputFile'] =
  (disableWriteFile) => (filePath, content) => {
    if (!disableWriteFile) {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        _.attempt(() => fs.removeSync(dir));
        _.attempt(() => fs.mkdirpSync(dir));
      }
      _.attempt(() => fs.writeFileSync(filePath, content, 'utf-8'));
      log('info', `Generated file: ${filePath}`);
    }
  };

command
  .addCommand(
    createCommand({
      name: 'build',
      hiddenOptions: ['--watch', '--execute-after-build'],
      onLog: log,
      defaultOptions: (source, output, options) => ({
        getWatcher: handleGetWatcher,
        getVirtualEntryFileContent: handleGetVirtualEntryFileContent,
        onGetFileContent: handleGetFileContent,
        onOutputFile: createHandleOutputFile(!!options?.disableWriteFile),
      }),
    })!,
  )
  .addCommand(
    createCommand({
      name: 'watch',
      hiddenOptions: [
        '--watch',
        '--execute-after-build',
        '--obfuscate',
        '--obfuscator-config-file <string>',
        '--disable-write-file',
      ],
      onLog: log,
      defaultOptions: () => ({
        watch: true,
        executeAfterBuild: true,
        obfuscate: false,
        getWatcher: handleGetWatcher,
        getVirtualEntryFileContent: handleGetVirtualEntryFileContent,
        onGetFileContent: handleGetFileContent,
        onOutputFile: createHandleOutputFile(true),
      }),
    })!,
  )
  .addCommand(
    createCommand({
      name: 'generate-client',
      onLog: log,
      hiddenOptions: [
        '--watch',
        '--execute-after-build',
        '--obfuscate',
        '--obfuscator-config-file <string>',
        '--disable-write-file',
      ],
      defaultOptions: () => ({
        watch: false,
        executeAfterBuild: false,
        obfuscate: false,
        customTransformers: (program) => {
          return {
            before: [transformReflectDeclaration(program)],
          };
        },
        getWatcher: handleGetWatcher,
        onGetFileContent: handleGetFileContent,
        onOutputFile: createHandleOutputFile(false),
        getVirtualEntryFileContent: (buildEntryFilePath) => {
          return [
            `const entry = require(\'${buildEntryFilePath}\')`,
            "const { isClient } = require(\'@open-norantec/herbal\')",
            'module.exports = () => {',
            '  let client = entry;',
            '  if (!isClient(client)) { client = entry?.default; }',
            "  if (!isClient(client)) return '';",
            "  try { return client.instance.generateClientSourceFile() ?? ''; } catch (error) { throw error; }",
            '};',
          ].join('\n');
        },
        rewriteOutputFile: (code) => {
          try {
            const generateCodeMethod = requireFromString(code);
            if (typeof generateCodeMethod !== 'function') return '';
            return generateCodeMethod() as string;
          } catch {
            return '';
          }
        },
      }),
    })!,
  );

command.parse(process.argv);

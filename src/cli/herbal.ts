#!/usr/bin/env node

import { Command } from 'commander';
import { createForgeCommand, CreateForgeCommandOptions } from '@open-norantec/forge';
import { Schema } from '@open-norantec/utilities/dist/schema-util.class';
import { ClientUtil } from '../utilities';
import * as _ from 'lodash';
import * as fs from 'fs-extra';
import * as path from 'node:path';
import { AttemptUtil } from '@open-norantec/utilities/dist/attempt-util.class';

const command = new Command('herbal');

const getEntryFileContent: CreateForgeCommandOptions['getEntryFileContent'] = ({ entryFilePath }) => {
  return [
    "import 'reflect-metadata';",
    "import { ModelUtil, NestFactory, isApplication } from '@open-norantec/herbal';",
    "import { LoggerService } from '@open-norantec/herbal/dist/modules/logger/logger.service';",
    "import { Worker, isMainThread, workerData } from 'node:worker_threads';",
    `import ENTRY from '${entryFilePath}';`,
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
    (() => {
      const subCommand = new Command('generate-client');

      subCommand
        .requiredOption(
          '--entry <entry>',
          'The entry file path of the application. It must export an instance generated with `createClient` to default.',
        )
        .requiredOption('--output-file <path>', 'The output file path of the generated client source file.')
        .option(
          '--group <group>',
          'The group name of the generated client. It is used to distinguish different clients when there are multiple clients in the same application.',
        )
        .action(async (options) => {
          const clientUtil = _.attempt(
            () =>
              new ClientUtil(
                options,
                (absoluteOutputFile, content) => {
                  const absoluteOutputDir = path.dirname(absoluteOutputFile);
                  if (!fs.existsSync(absoluteOutputDir) || !fs.statSync(absoluteOutputDir).isDirectory()) {
                    _.attempt(() => fs.removeSync(absoluteOutputDir));
                    _.attempt(() => fs.mkdirpSync(absoluteOutputDir));
                  }
                  const writeResult = AttemptUtil.exec(() =>
                    fs.writeFileSync(absoluteOutputFile, content, { encoding: 'utf-8' }),
                  );
                  if (writeResult instanceof Error) {
                    handleLog?.('error', `Failed to write client code: ${writeResult.message}`);
                    return;
                  }
                  handleLog?.('info', `Client code generated successfully at ${absoluteOutputFile}`);
                },
                handleLog,
              ),
          );

          if (clientUtil instanceof Error) {
            handleLog('error', `Failed to initialize the client utility: ${clientUtil.message}`);
            return;
          }

          await clientUtil.generateClientCode();
        });

      return subCommand;
    })(),
  );

command.parse(process.argv);

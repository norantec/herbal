#!/usr/bin/env node

import * as _ from 'lodash';
import { Command } from 'commander';
import { Builder, BuilderOptions } from '../builder';

const command = new Command('herbal');

command
    .argument('<type>', 'Run type, e.g. build/client/watch')
    .argument('<entry>', 'Entry path relative to work-dir and source-dir, e.g. main.ts')
    .option('--clean', 'Clean legacy output', true)
    .option('--work-dir <string>', 'Work directory path', process.cwd())
    .option('--source-dir <string>', 'Source directory path', 'src')
    .option('--output-dir <string>', 'Output directory path', 'dist')
    .option('--output-name <string>', 'Output file name', 'main')
    .option('--output-name-format <string>', 'Ouptput file name format', '[name].js')
    .option('--ts-project <string>', 'Path for TypeScript config file', 'tsconfig.json')
    .option('--debug', 'Debug mode', false)
    .action((type, entry, options) => {
        new Builder({
            entry,
            ..._.omit(options, ['debug']),
        } as unknown as BuilderOptions).run(type, options?.debug ?? false);
    });

command.parse(process.argv);

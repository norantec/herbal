const _ = require('lodash');
const path = require('path');
const spawn = require('child_process').spawn;
const statSync = require('node:fs').statSync;
const StringUtil = require('@open-norantec/utilities').StringUtil;
const Command = require('commander').Command;

const command = new Command();

command.action(async () => {
  const findParentProjectPath = (currentPath) => {
    let result = currentPath;
    let hasNodeModules = false;

    while (!hasNodeModules) {
      const newResult = path.resolve(result, '..');
      if (newResult === result) break;
      result = newResult;
      hasNodeModules = _.attempt(() => statSync(path.join(result, 'node_modules')).isDirectory()) === true;
    }

    return hasNodeModules ? result : undefined;
  };

  let cwd = findParentProjectPath(__dirname);

  console.log('Process cwd:', process.cwd());

  if (StringUtil.isFalsyString(cwd)) {
    console.log('Warning: not a Node.js project path, nothing to patch, exitting...');
    process.exit(0);
  }

  while (true) {
    console.log(`Patching: ${cwd}`);

    await new Promise((resolve) => {
      const childProcess = spawn(
        'npx',
        ['patch-package', `--patch-dir=${path.relative(process.cwd(), path.resolve(__dirname, '../patches'))}`],
        {
          stdio: 'inherit',
          cwd,
        },
      );
      childProcess.on('exit', () => {
        resolve(undefined);
      });
    });

    const newCwd = findParentProjectPath(cwd);

    if (StringUtil.isFalsyString(newCwd)) break;

    cwd = newCwd;
  }
});

command.parse(process.argv);

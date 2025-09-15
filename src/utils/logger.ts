import chalk from 'chalk';
import { Logger } from '../types';

export class ConsoleLogger implements Logger {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  info(message: string): void {
    console.log(chalk.blue('[INFO]'), message);
  }

  success(message: string): void {
    console.log(chalk.green('[SUCCESS]'), message);
  }

  warning(message: string): void {
    console.log(chalk.yellow('[WARNING]'), message);
  }

  error(message: string): void {
    console.log(chalk.red('[ERROR]'), message);
  }

  step(message: string): void {
    console.log(chalk.magenta('[STEP]'), message);
  }

  debug(message: string): void {
    if (this.verbose) {
      console.log(chalk.cyan('[DEBUG]'), message);
    }
  }
}

export const createLogger = (verbose: boolean = false): Logger => {
  return new ConsoleLogger(verbose);
};

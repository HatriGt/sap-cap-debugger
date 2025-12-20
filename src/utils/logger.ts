import chalk from 'chalk';
import { Logger } from '../types';

class Spinner {
  private interval: NodeJS.Timeout | null = null;
  private message: string = '';
  private frames: string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex: number = 0;

  start(message: string): void {
    this.message = message;
    this.frameIndex = 0;
    
    // Clear any existing interval
    this.stop();
    
    // Write initial frame
    process.stdout.write(`\r${chalk.blue(this.frames[this.frameIndex])} ${this.message}`);
    
    // Start animation
    this.interval = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      process.stdout.write(`\r${chalk.blue(this.frames[this.frameIndex])} ${this.message}`);
    }, 100);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Clear the line
    process.stdout.write('\r\x1b[K');
  }

  update(message: string): void {
    this.message = message;
  }
}

export class ConsoleLogger implements Logger {
  private verbose: boolean;
  private spinner: Spinner;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
    this.spinner = new Spinner();
  }

  info(message: string): void {
    this.spinner.stop();
    console.log(chalk.blue('[INFO]'), message);
  }

  success(message: string): void {
    this.spinner.stop();
    console.log(chalk.green('[SUCCESS]'), message);
  }

  warning(message: string): void {
    this.spinner.stop();
    console.log(chalk.yellow('[WARNING]'), message);
  }

  error(message: string): void {
    this.spinner.stop();
    console.log(chalk.red('[ERROR]'), message);
  }

  step(message: string): void {
    this.spinner.stop();
    console.log(chalk.magenta('[STEP]'), message);
  }

  debug(message: string): void {
    if (this.verbose) {
      this.spinner.stop();
      console.log(chalk.cyan('[DEBUG]'), message);
    }
  }

  loading(message: string): void {
    this.spinner.start(message);
  }

  stopLoading(): void {
    this.spinner.stop();
  }

  update(message: string): void {
    this.spinner.update(message);
  }
}

export const createLogger = (verbose: boolean = false): Logger => {
  return new ConsoleLogger(verbose);
};

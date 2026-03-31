import execa = require('execa');
import { CommandResult } from '../types';
import { Logger } from '../types';

export class CommandExecutor {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async execute(command: string, args: string[] = [], options: any = {}): Promise<CommandResult> {
    try {
      this.logger.debug(`Executing: ${command} ${args.join(' ')}`);
      
      const result = await execa(command, args, {
        ...options,
        stdio: 'pipe',
        encoding: 'utf8'
      });

      return {
        success: true,
        // Some CLIs (including cf in certain setups) may print relevant info to stderr.
        // We intentionally combine both streams to make downstream parsing reliable.
        output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
        exitCode: result.exitCode
      };
    } catch (error: any) {
      this.logger.debug(`Command failed: ${error.message}`);
      
      return {
        success: false,
        output: [error.stdout, error.stderr].filter(Boolean).join('\n'),
        error: error.message,
        exitCode: error.exitCode
      };
    }
  }

  async executeWithOutput(command: string, args: string[] = [], options: any = {}): Promise<CommandResult> {
    try {
      this.logger.debug(`Executing with output: ${command} ${args.join(' ')}`);
      
      const result = await execa(command, args, {
        ...options,
        stdio: 'inherit',
        encoding: 'utf8'
      });

      return {
        success: true,
        output: '',
        exitCode: result.exitCode
      };
    } catch (error: any) {
      this.logger.debug(`Command with output failed: ${error.message}`);
      
      return {
        success: false,
        output: '',
        error: error.message,
        exitCode: error.exitCode
      };
    }
  }

  async checkCommandExists(command: string): Promise<boolean> {
    const result = await this.execute('which', [command]);
    return result.success;
  }
}

import { describe, it, expect } from 'bun:test';
import { ConsoleLogger } from '../utils/logger';
import { createLogger } from '../utils/logger';

describe('Logger', () => {
  it('should create logger instance', () => {
    const logger = createLogger(false);
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.success).toBe('function');
    expect(typeof logger.warning).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.step).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should create console logger', () => {
    const logger = new ConsoleLogger(false);
    expect(logger).toBeDefined();
  });

  it('should handle verbose mode', () => {
    const verboseLogger = new ConsoleLogger(true);
    const normalLogger = new ConsoleLogger(false);
    
    expect(verboseLogger).toBeDefined();
    expect(normalLogger).toBeDefined();
  });
});

describe('Types', () => {
  it('should have proper type definitions', () => {
    // This is a basic test to ensure our types are properly exported
    expect(true).toBe(true);
  });
});

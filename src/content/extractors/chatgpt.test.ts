import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractChatGPT } from './chatgpt';

describe('extractChatGPT Layer 1 Extractor', () => {
  beforeEach(() => {
    // Clear the document body before each test
    document.body.innerHTML = '';
  });

  it('should extract messages from a stable ChatGPT DOM', () => {
    const html = readFileSync(resolve(__dirname, '../../../tests/fixtures/chatgpt-stable.html'), 'utf-8');
    document.body.innerHTML = html;

    const result = extractChatGPT();

    expect(result).not.toBeNull();
    expect(result?.messages.length).toBe(4);
    
    expect(result?.messages[0].role).toBe('user');
    expect(result?.messages[0].content).toBe('What is the capital of France?');
    
    expect(result?.messages[1].role).toBe('assistant');
    expect(result?.messages[1].content).toBe('The capital of France is Paris.');

    // Confidence should be high for stable extraction
    expect(result?.diagnostics.confidence).toBeGreaterThan(0.9);
    expect(result?.diagnostics.warnings.length).toBe(0);
  });

  it('should filter out garbage content, single characters, and unknown roles', () => {
    const html = readFileSync(resolve(__dirname, '../../../tests/fixtures/chatgpt-garbage.html'), 'utf-8');
    document.body.innerHTML = html;

    const result = extractChatGPT();

    // Since we filtered out almost everything except "Hello", and we have < 2 messages,
    // the extractor returns null
    expect(result).toBeNull();
  });

  it('should return null when structural role elements are completely missing', () => {
    const html = readFileSync(resolve(__dirname, '../../../tests/fixtures/chatgpt-broken.html'), 'utf-8');
    document.body.innerHTML = html;

    const result = extractChatGPT();

    expect(result).toBeNull();
  });
});

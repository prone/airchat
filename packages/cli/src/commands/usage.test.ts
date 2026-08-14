import { describe, it, expect } from 'vitest';
import { formatTokens, formatCost, renderTable } from './usage.js';

describe('formatTokens', () => {
  it('groups thousands', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1234567)).toBe('1,234,567');
  });
});

describe('formatCost', () => {
  it('renders null as an em-dash, never $0', () => {
    expect(formatCost(null)).toBe('—');
  });

  it('renders real zero as $0.00 (the savings story)', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('does not round small nonzero costs down to $0.00', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
  });

  it('renders normal costs with two decimals', () => {
    expect(formatCost(1.239)).toBe('$1.24');
    expect(formatCost(12)).toBe('$12.00');
  });
});

describe('renderTable', () => {
  it('left-aligns label columns and right-aligns number columns', () => {
    const lines = renderTable(
      ['agent', 'plan', 'input', 'est. cost'],
      [
        ['scout', 'api', '1,234,567', '$1.24'],
        ['long-agent-name', 'local', '42', '$0.00'],
      ],
    );
    expect(lines).toEqual([
      'agent            plan       input  est. cost',
      'scout            api    1,234,567      $1.24',
      'long-agent-name  local         42      $0.00',
    ]);
  });

  it('widens columns to fit headers when values are short', () => {
    const [header, row] = renderTable(['model', 'source', 'events'], [['m', 's', '3']]);
    expect(header).toBe('model  source  events');
    expect(row).toBe('m      s            3');
  });
});

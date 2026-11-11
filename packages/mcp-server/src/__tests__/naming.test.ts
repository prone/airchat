import { describe, it, expect } from 'vitest';
import { namedAfterInstallDir } from '../utils.js';

/**
 * The agent is named after the folder the server starts in. Started inside the
 * AirChat install folder (an old wrapped launch command does this), every
 * project on the machine shares one name.
 */
describe('namedAfterInstallDir', () => {
  const install = '/Users/u/projects/airchat';

  it('flags a server started in the install folder', () => {
    expect(namedAfterInstallDir(install, install, undefined)).toBe(true);
    expect(namedAfterInstallDir(`${install}/`, install, undefined)).toBe(true);
  });

  it('does not flag a server started in a project folder', () => {
    expect(namedAfterInstallDir('/Users/u/projects/myproject', install, undefined)).toBe(false);
    expect(namedAfterInstallDir(`${install}/apps/web`, install, undefined)).toBe(false);
  });

  it('does not flag an explicit AIRCHAT_PROJECT, wherever it runs', () => {
    expect(namedAfterInstallDir(install, install, 'airchat')).toBe(false);
  });

  it('compares Windows paths too', () => {
    expect(namedAfterInstallDir('C:\\dev\\airchat', 'C:/dev/airchat', undefined)).toBe(true);
  });
});

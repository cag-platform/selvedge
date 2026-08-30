import { describe, expect, it } from 'vitest';
import { workspaceRequirementsFor } from '../../src/server/workspace/requirements.js';

describe('workspace machine selection', () => {
  it('routes explicit SwiftUI and native iOS work to an Apple workspace', () => {
    expect(workspaceRequirementsFor('Build a single-screen iOS app in SwiftUI').platform).toBe('apple');
    expect(workspaceRequirementsFor('Add this feature', 'Native Swift application using UIKit').platform).toBe('apple');
  });

  it('does not mistake ordinary web copy mentioning an iPhone for a native project', () => {
    expect(workspaceRequirementsFor('Make the pricing page look good on an iPhone')).toMatchObject({ platform: 'linux', preview: 'web' });
    expect(workspaceRequirementsFor('Build an app for scheduling deliveries')).toMatchObject({ platform: 'linux' });
  });
});

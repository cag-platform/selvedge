/** The machine class a project needs, independent of which agent works in it. */
export type WorkspacePlatform = 'linux' | 'apple';

export type WorkspaceRequirements = {
  platform: WorkspacePlatform;
  tools: Array<'browser' | 'xcode' | 'ios-simulator'>;
  preview: 'web' | 'ios-simulator';
};

export const WEB_WORKSPACE_REQUIREMENTS: WorkspaceRequirements = {
  platform: 'linux',
  tools: ['browser'],
  preview: 'web',
};

export const APPLE_WORKSPACE_REQUIREMENTS: WorkspaceRequirements = {
  platform: 'apple',
  tools: ['xcode', 'ios-simulator'],
  preview: 'ios-simulator',
};

/**
 * Detect only explicit Apple-native work. A product mentioning an iPhone in
 * its copy is not automatically an iOS app; native framework/tool words are
 * the high-confidence signal that choosing Linux would be a lie.
 */
export function workspaceRequirementsFor(text: string, stackSummary = ''): WorkspaceRequirements {
  const evidence = `${text}\n${stackSummary}`;
  const appleNative = /\b(?:swiftui|uikit|xcode|xcodeproj|xcworkspace)\b/i.test(evidence)
    || (/\b(?:ios|ipados|watchos|visionos|macos)\b/i.test(evidence) && /\b(?:swift|native|app|application)\b/i.test(evidence));
  return appleNative ? APPLE_WORKSPACE_REQUIREMENTS : WEB_WORKSPACE_REQUIREMENTS;
}

export function appleWorkspaceUnavailableLine(): string {
  return "This needs an Apple workspace with macOS, Xcode, and an iPhone Simulator. Selvedge's Apple runtime isn't connected yet, so I didn't send it to the web workshop or pretend it was built. Nothing was changed or shipped.";
}

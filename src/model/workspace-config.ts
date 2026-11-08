export interface WorkspaceConfig {
  enabled?: boolean;
}

export interface WorkspaceConfiguration {
  path: string;
  present: boolean;
  enabled: boolean;
  error?: string;
}

export interface AuthConfig {
  registrationEnabled: boolean;
  emailVerificationEnabled: boolean;
  turnstileEnabled: boolean;
  siteKey: string;
  secretKey?: string;
  hostnames: string;
}

export interface SMTPConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
}

export interface UploadConfig {
  maxFileSize: number;
  fileTypeMode: 'blacklist' | 'whitelist';
  fileTypeFilter: string;
}

export interface AuthStatus {
  registrationEnabled: boolean;
  emailVerificationEnabled: boolean;
  turnstileEnabled: boolean;
  siteKey: string;
}

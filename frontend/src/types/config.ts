export interface AuthConfig {
  registrationEnabled: boolean;
  emailVerificationEnabled: boolean;
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
  allowedFileTypes: string;
}

export interface AuthStatus {
  registrationEnabled: boolean;
  emailVerificationEnabled: boolean;
  hasSuperAdmin: boolean;
}

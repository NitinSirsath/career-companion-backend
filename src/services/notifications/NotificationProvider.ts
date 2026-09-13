export interface NotificationPayload {
  actionId: string;
  companyName: string;
  jobTitle?: string | null;
  actionRequested: string; // The specific action e.g. "Send thank you note"
  actionType: string;
  deadline?: string | null;
}

export interface NotificationResult {
  success: boolean;
  retryable: boolean;
  errorCategory?: string;
  errorDetails?: string;
}

export interface NotificationProvider {
  send(payload: NotificationPayload): Promise<NotificationResult>;
}

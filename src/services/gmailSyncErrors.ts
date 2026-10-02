export class SyncInProgressError extends Error {
  readonly code = 'SYNC_IN_PROGRESS';
  constructor(message = 'A sync is already in progress') {
    super(message);
    this.name = 'SyncInProgressError';
  }
}
export class SyncBusyError extends SyncInProgressError {
  constructor() {
    super();
    this.name = 'SyncBusyError';
  }
}
export class SyncSupersededError extends Error {
  constructor() {
    super('Sync superseded or disconnected');
    this.name = 'SyncSupersededError';
  }
}
export class SyncDeadlineError extends Error {
  constructor() {
    super('Sync time budget reached; resume on next sync');
    this.name = 'SyncDeadlineError';
  }
}
export class GmailAuthError extends Error {
  readonly code = 'GMAIL_AUTH_FAILED';
  constructor(message = 'Gmail authorization expired; reconnect Gmail') {
    super(message);
    this.name = 'GmailAuthError';
  }
}
export class SyncQueueError extends Error {
  readonly code = 'QUEUE_UNAVAILABLE';
  constructor() {
    super('Sync could not be started. Try again in a moment.');
    this.name = 'SyncQueueError';
  }
}

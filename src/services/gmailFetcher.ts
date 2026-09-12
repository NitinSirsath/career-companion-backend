import { google, gmail_v1 } from 'googleapis';
import { prisma } from '../db/prisma';
import { decryptToken, encryptToken } from '../utils/gmailTokenEncryption';
// html-entities not used

function createOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function extractTextFromParts(parts: gmail_v1.Schema$MessagePart[]): string {
  let htmlText = '';

  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      const text = Buffer.from(part.body.data, 'base64').toString('utf8');
      if (text.trim()) return text;
    }
    if (part.mimeType === 'text/html' && part.body?.data) {
      const html = Buffer.from(part.body.data, 'base64').toString('utf8');
      // basic stripping of unsafe/unnecessary markup
      const stripped = html.replace(/<style[^>]*>.*?<\/style>/gis, '')
                           .replace(/<script[^>]*>.*?<\/script>/gis, '')
                           .replace(/<[^>]+>/g, ' ')
                           .replace(/\s+/g, ' ')
                           .trim();
      if (stripped && !htmlText) {
        htmlText = stripped;
      }
    }
    if (part.parts && part.parts.length > 0) {
      const childText = extractTextFromParts(part.parts);
      if (childText) return childText;
    }
  }
  
  return htmlText;
}

function extractBody(message: gmail_v1.Schema$Message): string {
  if (message.payload?.parts) {
    return extractTextFromParts(message.payload.parts);
  } else if (message.payload?.body?.data) {
    const raw = Buffer.from(message.payload.body.data, 'base64').toString('utf8');
    if (message.payload.mimeType === 'text/html') {
      return raw.replace(/<style[^>]*>.*?<\/style>/gis, '')
                .replace(/<script[^>]*>.*?<\/script>/gis, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
    }
    return raw;
  }
  return '';
}

export class GmailFetcherService {
  
  static async fetchMessageMetadata(userId: string, gmailMessageId: string): Promise<{ labelIds: string[] | null, snippet: string | null }> {
    const connection = await prisma.gmailConnection.findUnique({
      where: { userId },
    });

    if (!connection || connection.status !== 'CONNECTED') {
      throw new Error('Gmail is not connected or revoked');
    }

    const oauth2Client = createOAuth2Client();
    const accessToken = decryptToken(connection.accessToken);
    let refreshToken: string | null = null;
    if (connection.refreshToken) {
      refreshToken = decryptToken(connection.refreshToken);
    }

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    let message;
    try {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: gmailMessageId,
        format: 'metadata',
      });
      message = res.data;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 401 && refreshToken) {
        // Try to refresh token
        try {
          const { credentials } = await oauth2Client.refreshAccessToken();
          if (credentials.access_token) {
            await prisma.gmailConnection.update({
              where: { userId },
              data: {
                accessToken: encryptToken(credentials.access_token),
                ...(credentials.refresh_token ? { refreshToken: encryptToken(credentials.refresh_token) } : {})
              }
            });
            oauth2Client.setCredentials(credentials);
            const res = await gmail.users.messages.get({
              userId: 'me',
              id: gmailMessageId,
              format: 'metadata',
            });
            message = res.data;
          }
        } catch (refreshErr) {
          throw new Error('Failed to refresh Gmail token', { cause: refreshErr });
        }
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`Gmail API request failed: ${errorMsg}`, { cause: err });
      }
    }

    if (!message) {
      throw new Error('Message not found');
    }

    return { labelIds: message.labelIds || null, snippet: message.snippet || null };
  }

  static async fetchMessageBody(userId: string, gmailMessageId: string): Promise<string> {
    const connection = await prisma.gmailConnection.findUnique({
      where: { userId },
    });

    if (!connection || connection.status !== 'CONNECTED') {
      throw new Error('Gmail is not connected or revoked');
    }

    const oauth2Client = createOAuth2Client();
    const accessToken = decryptToken(connection.accessToken);
    let refreshToken: string | null = null;
    if (connection.refreshToken) {
      refreshToken = decryptToken(connection.refreshToken);
    }

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    let message;
    try {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: gmailMessageId,
        format: 'full',
      });
      message = res.data;
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 401 && refreshToken) {
        // Try to refresh token
        try {
          const { credentials } = await oauth2Client.refreshAccessToken();
          if (credentials.access_token) {
            await prisma.gmailConnection.update({
              where: { userId },
              data: {
                accessToken: encryptToken(credentials.access_token),
                ...(credentials.refresh_token ? { refreshToken: encryptToken(credentials.refresh_token) } : {})
              }
            });
            oauth2Client.setCredentials(credentials);
            const res = await gmail.users.messages.get({
              userId: 'me',
              id: gmailMessageId,
              format: 'full',
            });
            message = res.data;
          }
        } catch (refreshErr) {
          throw new Error('Failed to refresh Gmail token', { cause: refreshErr });
        }
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`Gmail API request failed: ${errorMsg}`, { cause: err });
      }
    }

    if (!message) {
      throw new Error('Message not found');
    }

    let rawText = extractBody(message);

    // Bound to 8000 characters
    if (rawText.length > 8000) {
      rawText = rawText.substring(0, 8000);
    }

    return rawText;
  }
}

import * as dotenv from 'dotenv';
dotenv.config();
import { GeminiProvider } from './src/services/ai/gemini/GeminiProvider';

async function main() {
  const provider = GeminiProvider.getInstance();
  try {
    const result = await provider.classifyRelevance({
      sender: 'News from Google <thekeyword-noreply@google.com>',
      subject: 'Android 17: new screen reactions, security upgrades & more',
      labels: [],
      snippet: 'New stuff in Android 17'
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('Error name:', err.name);
    console.error('Error message:', err.message);
    if (err.validationErrors) {
      console.error('Validation errors:', JSON.stringify(err.validationErrors, null, 2));
    }
  }
}

main();

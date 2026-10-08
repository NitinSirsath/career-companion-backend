import { GoogleGenAI } from '@google/genai';
async function run() {
  const client = new GoogleGenAI({ apiKey: 'fake-key' });
  try {
    await client.models.get({ model: 'gemini-2.5-flash' });
  } catch (err) {
    console.error("Caught error:", err);
  }
}
run();

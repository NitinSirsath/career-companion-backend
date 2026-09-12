/**
 * COM-26/27 Placeholder
 * 
 * This stub represents the AI processing pipeline boundary.
 * Currently, it takes the bounded email body and immediately returns, 
 * representing a successful (but empty) AI processing step.
 * In COM-27, this will be replaced with actual Google Gemini API calls 
 * to classify the email and extract structured job information.
 */
export class AIProcessorStub {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static async processEmailBody(userId: string, emailId: string, boundedBody: string): Promise<void> {
    // Intentionally empty stub
    // The boundedBody is never persisted, just passed in memory to this layer
    return;
  }
}

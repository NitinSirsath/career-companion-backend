/**
 * AI Processor Boundary
 * 
 * In COM-26 we establish the interfaces.
 * The actual pipeline orchestration will be built here in COM-27.
 */
export class AIProcessorStub {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static async processEmailBody(_userId: string, _emailId: string, _boundedBody: string): Promise<void> {
    // Pipeline will look like this in COM-27:
    // const provider = new GeminiProvider();
    // const relevance = await provider.classifyRelevance(_boundedBody);
    // if (relevance.data.isJobSearchRelated) {
    //   const extracted = await provider.extractJobData(_boundedBody);
    //   // Save to DB...
    // }
    
    // Intentionally empty stub for COM-26
    return;
  }
}

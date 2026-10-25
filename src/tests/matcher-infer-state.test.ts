import { describe, expect, it } from 'vitest';
import { AIProcessingResult, ApplicationStatus } from '@prisma/client';
import { aiStatusFromEvidence, inferState } from '../services/matcher';

/** An AI result with every field empty, plus the given ones. */
function result(fields: Partial<AIProcessingResult>): AIProcessingResult {
  return {
    id: 'result',
    emailId: 'email',
    provider: 'openrouter',
    model: 'model',
    contractVersion: 'extraction/v2',
    processingStatus: 'COMPLETED',
    relevanceDecision: 'RELEVANT',
    category: null,
    confidence: null,
    deterministic: false,
    companyName: null,
    jobTitle: null,
    recruiterName: null,
    recruiterEmail: null,
    interviewStage: null,
    interviewType: null,
    interviewDate: null,
    interviewTime: null,
    assessmentInfo: null,
    assessmentDeadline: null,
    offerInfo: null,
    rejectionInfo: null,
    actionRequired: null,
    requestedAction: null,
    actionDeadline: null,
    followUpRequired: null,
    followUpDate: null,
    fakeOfferWarning: null,
    askKind: null,
    replyChoices: [],
    scheduleCandidates: null,
    extractionConfidence: null,
    provenance: null,
    errorCategory: null,
    errorDetails: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...fields,
  };
}

// As written by the AI in the 17 Oct 2026 full-flow test.
const codingAssessment = result({
  category: 'ASSESSMENT',
  interviewStage: 'Assessment',
  interviewType: 'Online',
  assessmentInfo: 'Online coding assessment (90 minutes, 3 problems)',
  actionDeadline: 'Friday, 30 October 2026, 11:59 PM IST',
});
const recruiterFirstMail = result({
  category: 'RECRUITER',
  interviewStage: 'Initial Screening',
  interviewType: 'Phone',
  recruiterName: 'Riya Kapoor',
});
const technicalInterview = result({
  category: 'INTERVIEW',
  interviewStage: 'Technical Interview',
  interviewType: 'Video',
  interviewDate: 'Friday, 6 November 2026',
});

describe('inferState: a stage name alone', () => {
  it('does not make an assessment an interview', () => {
    expect(inferState(codingAssessment)).toBe(ApplicationStatus.ASSESSMENT);
  });

  it("does not make a recruiter's first call an interview", () => {
    expect(inferState(recruiterFirstMail)).toBe(ApplicationStatus.RECRUITER_CONTACT);
  });

  it('still makes an interview with the type INTERVIEW', () => {
    expect(inferState(result({ category: 'INTERVIEW', interviewStage: 'Final round' }))).toBe(
      ApplicationStatus.INTERVIEW,
    );
  });

  it('still makes an interview with an interview date, whatever the type', () => {
    const dated = result({ ...codingAssessment, interviewDate: 'Friday, 6 November 2026' });
    expect(inferState(dated)).toBe(ApplicationStatus.INTERVIEW);
  });

  it('still makes an interview with no type or another type, as before', () => {
    expect(inferState(result({ interviewStage: 'Final round' }))).toBe(ApplicationStatus.INTERVIEW);
    expect(inferState(result({ category: 'FOLLOW_UP', interviewStage: 'Final round' }))).toBe(
      ApplicationStatus.INTERVIEW,
    );
  });

  it('moves an application from the assessment to the interview that follows', () => {
    expect(aiStatusFromEvidence([codingAssessment])).toBe(ApplicationStatus.ASSESSMENT);
    expect(aiStatusFromEvidence([codingAssessment, technicalInterview])).toBe(
      ApplicationStatus.INTERVIEW,
    );
  });
});

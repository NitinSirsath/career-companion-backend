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
    bulkMail: false,
    saysNoReply: false,
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

// As the AI read them on the owner's real mails (27 Nov 2026).
const recruiterPitch = result({
  category: 'RECRUITER',
  companyName: 'Meridial by Invisible',
  recruiterName: 'Ishan Patnaik',
  assessmentInfo:
    'Complete a language fluency introduction with two recorded responses and a JSON Skills Assessment.',
});
const pitchWithPay = result({
  category: 'RECRUITER',
  companyName: 'Turing',
  assessmentInfo: 'Candidates must complete and pass the Astra assessment before onboarding.',
  offerInfo:
    'A remote, part-time role (20-40 hours per week) for 16 weeks, paying $19-$25 per hour.',
});
const confirmation = result({
  category: 'FOLLOW_UP',
  companyName: 'Genpact',
  assessmentInfo: 'Assessments will only be triggered for specific positions.',
});

describe('inferState: a confirmation or a recruiter mail only describes the job', () => {
  it("does not make a recruiter's test steps an assessment", () => {
    expect(inferState(recruiterPitch)).toBe(ApplicationStatus.RECRUITER_CONTACT);
  });

  it("does not make the pay of a recruiter's role an offer", () => {
    expect(inferState(pitchWithPay)).toBe(ApplicationStatus.RECRUITER_CONTACT);
  });

  it('keeps a confirmation that names tests as applied', () => {
    expect(inferState(confirmation)).toBe(ApplicationStatus.APPLIED);
    expect(inferState(result({ category: 'FOLLOW_UP', offerInfo: 'Salary: 20 LPA' }))).toBe(
      ApplicationStatus.APPLIED,
    );
  });

  it('still ends the job on a no, and still moves on to an interview', () => {
    expect(inferState(result({ ...recruiterPitch, rejectionInfo: 'Not moving forward' }))).toBe(
      ApplicationStatus.REJECTED,
    );
    expect(inferState(result({ ...confirmation, interviewDate: 'Monday, 30 November 2026' }))).toBe(
      ApplicationStatus.INTERVIEW,
    );
  });

  it('still takes the details as a step on any other mail, and the type always', () => {
    expect(inferState(result({ assessmentInfo: 'Take-home task, due Friday' }))).toBe(
      ApplicationStatus.ASSESSMENT,
    );
    expect(inferState(result({ offerInfo: 'Offer letter attached' }))).toBe(
      ApplicationStatus.OFFER,
    );
    expect(inferState(result({ category: 'OFFER' }))).toBe(ApplicationStatus.OFFER);
    expect(inferState(codingAssessment)).toBe(ApplicationStatus.ASSESSMENT);
  });

  it('lets a real test after the confirmation move the application on', () => {
    expect(aiStatusFromEvidence([confirmation])).toBe(ApplicationStatus.APPLIED);
    expect(aiStatusFromEvidence([confirmation, codingAssessment])).toBe(
      ApplicationStatus.ASSESSMENT,
    );
  });
});

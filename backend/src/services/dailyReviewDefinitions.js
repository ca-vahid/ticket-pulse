export const DAILY_REVIEW_OUTCOMES = {
  success: 'success',
  partialSuccess: 'partial_success',
  failure: 'failure',
  unresolved: 'unresolved',
};

export const DAILY_REVIEW_PRIMARY_TAGS = {
  successfulTopPick: 'successful_top_pick',
  approvedNonTopPick: 'approved_non_top_pick',
  rejectedReassigned: 'rejected_reassigned',
  rebounded: 'rebounded',
  pipelineBypassed: 'pipeline_bypassed',
  stillOpen: 'still_open',
  awaitingReview: 'awaiting_review',
  missingRecommendation: 'missing_recommendation',
};

export function isClosedLikeStatus(status) {
  return ['Closed', 'Resolved', 'Deleted', 'Spam'].includes(status);
}

export function classifyDailyReviewCase({
  finalTechId,
  recommendationPoolIds = [],
  topRecommendationId = null,
  hasRebound = false,
  isPendingReview = false,
}) {
  const tags = [];

  if (hasRebound) {
    tags.push(DAILY_REVIEW_PRIMARY_TAGS.rebounded);
  }

  if (isPendingReview) {
    tags.push(DAILY_REVIEW_PRIMARY_TAGS.awaitingReview);
    return {
      outcome: DAILY_REVIEW_OUTCOMES.unresolved,
      primaryTag: DAILY_REVIEW_PRIMARY_TAGS.awaitingReview,
      tags,
    };
  }

  if (!topRecommendationId || recommendationPoolIds.length === 0) {
    tags.push(DAILY_REVIEW_PRIMARY_TAGS.missingRecommendation);
    return {
      outcome: DAILY_REVIEW_OUTCOMES.unresolved,
      primaryTag: DAILY_REVIEW_PRIMARY_TAGS.missingRecommendation,
      tags,
    };
  }

  if (!finalTechId) {
    tags.push(DAILY_REVIEW_PRIMARY_TAGS.stillOpen);
    return {
      outcome: DAILY_REVIEW_OUTCOMES.unresolved,
      primaryTag: DAILY_REVIEW_PRIMARY_TAGS.stillOpen,
      tags,
    };
  }

  if (hasRebound) {
    return {
      outcome: DAILY_REVIEW_OUTCOMES.failure,
      primaryTag: DAILY_REVIEW_PRIMARY_TAGS.rebounded,
      tags,
    };
  }

  if (finalTechId === topRecommendationId) {
    tags.push(DAILY_REVIEW_PRIMARY_TAGS.successfulTopPick);
    return {
      outcome: DAILY_REVIEW_OUTCOMES.success,
      primaryTag: DAILY_REVIEW_PRIMARY_TAGS.successfulTopPick,
      tags,
    };
  }

  if (recommendationPoolIds.includes(finalTechId)) {
    tags.push(DAILY_REVIEW_PRIMARY_TAGS.approvedNonTopPick);
    return {
      outcome: DAILY_REVIEW_OUTCOMES.partialSuccess,
      primaryTag: DAILY_REVIEW_PRIMARY_TAGS.approvedNonTopPick,
      tags,
    };
  }

  tags.push(DAILY_REVIEW_PRIMARY_TAGS.rejectedReassigned);
  return {
    outcome: DAILY_REVIEW_OUTCOMES.failure,
    primaryTag: DAILY_REVIEW_PRIMARY_TAGS.rejectedReassigned,
    tags,
  };
}

import { healthResponseSchema } from '@club-registration/shared';
import type { HealthResponse } from '@club-registration/shared';

const SERVICE_UNAVAILABLE = 503;

export const fetchHealth = async (): Promise<HealthResponse> => {
  const response = await fetch('/api/health');
  // 503 is a valid answer here: the API is up and is reporting that the database is not.
  if (!response.ok && response.status !== SERVICE_UNAVAILABLE) {
    throw new Error(`Unexpected status ${response.status}`);
  }
  return healthResponseSchema.parse(await response.json());
};

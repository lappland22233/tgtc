import { HttpException } from '@nestjs/common';
import { PublicMediaAdmissionService } from './public-media-admission.service';

describe('PublicMediaAdmissionService', () => {
  it('bounds active public media responses process-wide and releases slots idempotently', () => {
    const service = new PublicMediaAdmissionService();
    const admissions = Array.from({ length: 128 }, () => service.acquire());

    expect(service.getActiveResponses()).toBe(128);
    expect(() => service.acquire()).toThrow(HttpException);
    expect(service.getActiveResponses()).toBe(128);

    admissions[0].release();
    admissions[0].release();
    expect(service.getActiveResponses()).toBe(127);
    const replacement = service.acquire();
    expect(service.getActiveResponses()).toBe(128);

    replacement.release();
    for (const admission of admissions.slice(1)) admission.release();
    expect(service.getActiveResponses()).toBe(0);
  });
});
